import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, apply } from "../lib/index.js";

/**
 * 集成测试：用最小 fake ctx 直接驱动 apply() 注册的 /billing 路由，
 * 覆盖记账、目录刷新与免费模型一键应用（0 费率 + 历史重估）全链路。
 */

/** 本地目录服务（模拟 models.dev + OpenRouter；host 头分流）。 */
async function startCatalogServer() {
  const modelsDev = {
    zai: { models: { "glm-5.1": { cost: { input: 1.4, output: 4.4, cache_read: 0.26 } } } },
    nvidia: { models: { "nvidia/nemotron-nano-9b-v2": { cost: { input: 0, output: 0, cache_read: 0 } } } }
  };
  const openrouter = {
    data: [{ id: "z-ai/glm-4.6", pricing: { prompt: "0.0000005", completion: "0.000002", input_cache_read: "0.0000001" } }]
  };
  const hits = { modelsDev: 0, openrouter: 0 };
  const server = createServer((req, res) => {
    const url = String(req.url ?? "");
    if (url.includes("modelsdev")) {
      hits.modelsDev += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(modelsDev));
      return;
    }
    hits.openrouter += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(openrouter));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    hits,
    modelsDevUrl: `http://127.0.0.1:${port}/modelsdev.json`,
    openrouterUrl: `http://127.0.0.1:${port}/openrouter.json`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** 最小 fake ctx：捕获 webServer handler / session 事件 / effect 清理。 */
function makeCtx() {
  const state = { handler: null, handlers: {}, effects: [] };
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    get: () => void 0,
    on: (event, handler) => {
      state.handlers[event] = handler;
    },
    effect: (fn) => {
      // cordis 语义：effect 回调立即执行，返回值作为清理函数。
      const dispose = fn();
      const teardown = typeof dispose === "function" ? dispose : () => {};
      state.effects.push(teardown);
      return teardown;
    },
    webServer: {
      register: (definition) => {
        state.handler = definition.handler;
        return () => {
          state.handler = null;
        };
      }
    }
  };
  return { ctx, state };
}

/** 伪造请求（POST body 用 async iterable 模拟流）。 */
function makeReq(method, url, body, headers = {}) {
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      if (body !== void 0) yield body;
    }
  };
}

/** 伪造响应（收集 status/body）。 */
function makeRes(req) {
  const res = {
    req,
    status: 0,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk) {
      if (chunk !== void 0) this.body = String(chunk);
    }
  };
  return res;
}

/** 调 /billing 路由并解析 JSON。 */
async function call(handler, method, tail, body, headers) {
  const req = makeReq(method, `/billing${tail}`, body, headers);
  const res = makeRes(req);
  await handler(req, res);
  try {
    return { status: res.status, json: res.body === "" ? null : JSON.parse(res.body) };
  } catch {
    return { status: res.status, json: null, raw: res.body };
  }
}

/** 发一条带 usage 的 assistant 消息事件。 */
function emitMessage(state, sessionId, messageId, provider, model, time, usage) {
  state.handlers["session/event"]({ id: sessionId }, {
    type: "assistant/message",
    seq: 1,
    time,
    data: {
      usage,
      message: { id: messageId, source: { provider, model } }
    }
  });
}

let dir;
let catalogServer;
let disposers = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dsh-billing-api-"));
  catalogServer = await startCatalogServer();
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) {
    try { await dispose(); } catch { /* 忽略 */ }
  }
  await catalogServer.close();
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 装配插件（默认：目录启用+指向本地服务、余额关、启动刷新关）。 */
async function setup(overrides = {}, catalogOverrides = {}) {
  const { ctx, state } = makeCtx();
  const config = Config({
    persistPath: join(dir, "ledger.json"),
    balance: { enabled: false },
    catalog: {
      enabled: true,
      refreshOnStartup: false,
      modelsDevUrl: catalogServer.modelsDevUrl,
      openrouterUrl: catalogServer.openrouterUrl,
      ...catalogOverrides
    },
    ...overrides
  });
  apply(ctx, config);
  // 等待初始 reprice/异步 flush 落定。
  await new Promise((resolve) => setTimeout(resolve, 20));
  const callApi = (method, tail, body, headers) => call(state.handler, method, tail, body, headers);
  callApi.state = state;
  callApi.ctx = ctx;
  return callApi;
}

describe("GET /billing/state", () => {
  it("exposes catalog snapshot, promo counts and zeroCostDisplay", async () => {
    const api = await setup();
    const { status, json } = await api("GET", "/state");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.catalog).toHaveProperty("onlineModels");
    expect(json.catalog).toHaveProperty("fresh");
    expect(json.zeroCostDisplay).toBe("show");
    // 免费集合只下发计数（5s 轮询不带全表）。
    expect(json.promoCounts).toBeDefined();
    expect(json.promoCounts.bai).toBe(1);
    expect(json.promos).toBeUndefined();
  });

  it("records session events with policy pricing", async () => {
    const api = await setup();
    emitMessage(api.state, "s1", "m1", "deepseek", "deepseek-v4-flash", Date.parse("2026-10-01T10:00:00+08:00"), {
      inputTokens: 1_000_000,
      cacheReadTokens: 0,
      outputTokens: 0
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const { json } = await api("GET", "/state?range=all");
    expect(json.totals.calls).toBe(1);
    expect(json.totals.cost).toBeCloseTo(3, 6); // 高峰 input ¥3/1M × 1M
    const session = await api("GET", "/session/s1");
    expect(session.json.models).toBeDefined();
  });
});

describe("catalog endpoints", () => {
  it("GET /billing/catalog returns snapshot with free sets", async () => {
    const api = await setup();
    const { status, json } = await api("GET", "/catalog");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.enabled).toBe(true);
    // 未刷新时仅内置快照（含 pricing.js 手写合并的 bai 条目）。
    expect(json.freeModels.bai).toContain("deepseek-v4-flash");
    expect(json.freeModels.nvidia.length).toBeGreaterThan(0);
    expect(json.online).toBe(false);
  });

  it("POST /billing/catalog/refresh fetches, persists and reprices on change", async () => {
    const api = await setup();
    const before = await api("GET", "/catalog");
    // 从未拉取 → 非 force 也真实抓取。
    const forced = await api("POST", "/catalog/refresh", "{}");
    expect(forced.status).toBe(200);
    expect(forced.json.fromCache).toBe(false);
    expect(catalogServer.hits.modelsDev).toBe(1);
    expect(forced.json.onlineModels).toBeGreaterThan(0);
    // 内容与上次快照不同（之前从未拉取）→ 已触发重估标记。
    expect(forced.json.repriced).toBe(true);
    expect(before.json.hash).not.toBe(forced.json.hash);
    // TTL 内：force=false 直接复用（零网络）。
    const cached = await api("POST", "/catalog/refresh", "{}");
    expect(cached.json.fromCache).toBe(true);
    expect(catalogServer.hits.modelsDev).toBe(1);
    // 再次 force：内容相同 → 不再重估。
    const again = await api("POST", "/catalog/refresh", JSON.stringify({ force: true }));
    expect(again.json.repriced).toBe(false);
  });

  it("rejects refresh when catalog is disabled", async () => {
    const api = await setup({}, { enabled: false });
    const { status, json } = await api("POST", "/catalog/refresh", "{}");
    expect(status).toBe(400);
    expect(json.error).toBe("catalog-disabled");
  });
});

describe("free-model endpoints", () => {
  it("GET /billing/free-models lists effective sets and applied state", async () => {
    const api = await setup();
    const { json } = await api("GET", "/free-models");
    expect(json.ok).toBe(true);
    expect(json.freeModels.bai).toContain("deepseek-v4-flash");
    expect(json.applied).toEqual({});
  });

  it("POST refresh recomputes sets from fresh catalogs", async () => {
    const api = await setup();
    const { status, json } = await api("POST", "/free-models/refresh", "{}");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.freeModels.nvidia).toContain("nvidia/nemotron-nano-9b-v2");
    // $0.5/1M 非零价 → 不得进入免费集合（内置 openrouter 免费表仍然存在）。
    expect(json.freeModels.openrouter ?? []).not.toContain("z-ai/glm-4.6");
    expect(json.freeModels.zai).toBeUndefined(); // glm-5.1 是付费模型
    expect(json.summary.fetchedAt).toBeTruthy();
  });

  it("apply add bills the provider's selected models at 0 and reprices history", async () => {
    const api = await setup();
    // 先按量记两笔（deepseek 官方 + nvidia 免费-候选模型按目录价）。
    emitMessage(api.state, "s1", "m1", "nvidia", "nvidia/nemotron-nano-9b-v2", Date.now(), {
      inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const before = await api("GET", "/state?range=all");
    expect(before.json.totals.cost).toBeGreaterThan(0); // 目录价（input $1 → ¥7.2）
    // 一键按 0 计费。
    const applied = await api("POST", "/free-models/apply", JSON.stringify({
      provider: "nvidia",
      models: ["nvidia/nemotron-nano-9b-v2"],
      action: "add"
    }));
    expect(applied.status).toBe(200);
    expect(applied.json.ok).toBe(true);
    expect(applied.json.mode).toBe("usage-free");
    // 历史重估：该模型白嫖 → cost 0、节省=名义价值。
    const after = await api("GET", "/state?range=all");
    expect(after.json.totals.cost).toBeCloseTo(0, 6);
    expect(after.json.totals.savings).toBeGreaterThan(0);
    expect(Object.values(after.json.byProviderModel)[0].source).toBe("free");
    // metering 已持久化（GET free-models 的 applied 反映用户选中集）。
    const free = await api("GET", "/free-models");
    expect(free.json.applied.nvidia).toEqual(["nvidia/nemotron-nano-9b-v2"]);
  });

  it("apply remove restores usage billing", async () => {
    const api = await setup();
    await api("POST", "/free-models/apply", JSON.stringify({
      provider: "nvidia",
      models: ["nvidia/nemotron-nano-9b-v2"],
      action: "add"
    }));
    emitMessage(api.state, "s1", "m1", "nvidia", "nvidia/nemotron-nano-9b-v2", Date.now(), {
      inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const zero = await api("GET", "/state?range=all");
    expect(zero.json.totals.cost).toBeCloseTo(0, 6);
    const removed = await api("POST", "/free-models/apply", JSON.stringify({
      provider: "nvidia",
      models: ["nvidia/nemotron-nano-9b-v2"],
      action: "remove"
    }));
    expect(removed.status).toBe(200);
    expect(removed.json.mode).toBe("usage"); // 清空 → 回到按量
    const billed = await api("GET", "/state?range=all");
    expect(billed.json.totals.cost).toBeGreaterThan(0);
  });

  it("validates provider/models input", async () => {
    const api = await setup();
    const bad = await api("POST", "/free-models/apply", JSON.stringify({ provider: "", models: [] }));
    expect(bad.status).toBe(400);
  });
});

describe("request guards", () => {
  it("rejects cross-origin POST (origin mismatch)", async () => {
    const api = await setup();
    const { status, json } = await api("POST", "/free-models/apply", JSON.stringify({
      provider: "nvidia", models: ["m"], action: "add"
    }), { origin: "https://evil.example", host: "127.0.0.1:3080" });
    expect(status).toBe(403);
    expect(json.error).toBe("origin-mismatch");
  });

  it("rejects non-loopback clients when loopbackOnly", async () => {
    const api = await setup();
    const req = makeReq("GET", "/billing/state", void 0);
    req.socket = { remoteAddress: "192.168.1.5" };
    const res = makeRes(req);
    await api.state.handler(req, res);
    expect(res.status).toBe(403);
  });
});
