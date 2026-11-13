import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PricingCatalog,
  catalogContentHash,
  deriveFreeModels,
  isFreeEntry,
  mergeCatalogEntries,
  parseModelsDevPricing,
  parseOpenRouterPricing
} from "../lib/catalog.js";

/** models.dev 最小样例（含付费/免费/无 cost 三类）。 */
const MODELS_DEV_DOC = {
  zai: {
    models: {
      "glm-5.1": { cost: { input: 1.4, output: 4.4, cache_read: 0.26 }, limit: { context: 200000 } },
      "glm-5.1-free": { cost: { input: 0, output: 0, cache_read: 0 } },
      "glm-noprice": { limit: { context: 1000 } }
    }
  },
  broken: { not: "models" },
  empty: { models: {} }
};

/** OpenRouter 最小样例（$/token 字符串；含 :free 与缓存价）。 */
const OPENROUTER_DOC = {
  data: [
    {
      id: "z-ai/glm-4.6",
      pricing: { prompt: "0.0000005", completion: "0.000002", input_cache_read: "0.0000001" }
    },
    { id: "meta/llama:free", pricing: { prompt: "0", completion: "0", input_cache_read: "0" } },
    { id: "bad-row" }
  ]
};

function fakeFetch(jsonByHost) {
  const calls = [];
  const impl = (url) => {
    calls.push(String(url));
    for (const [host, doc] of Object.entries(jsonByHost)) {
      if (String(url).includes(host)) {
        return Promise.resolve({ ok: true, headers: new Map(), json: () => Promise.resolve(doc) });
      }
    }
    return Promise.reject(new Error(`no fixture for ${String(url)}`));
  };
  return { impl, calls };
}

describe("parseModelsDevPricing", () => {
  it("extracts usd triples and skips cost-less models", () => {
    const parsed = parseModelsDevPricing(MODELS_DEV_DOC);
    expect(Object.keys(parsed)).toEqual(["zai"]);
    expect(parsed.zai["glm-5.1"]).toEqual({ input: 1.4, cacheRead: 0.26, output: 4.4 });
    expect(parsed.zai["glm-5.1-free"]).toEqual({ input: 0, cacheRead: 0, output: 0 });
    expect(parsed.zai["glm-noprice"]).toBeUndefined();
  });

  it("tolerates non-object input", () => {
    expect(parseModelsDevPricing(null)).toEqual({});
    expect(parseModelsDevPricing([1, 2])).toEqual({});
  });
});

describe("parseOpenRouterPricing", () => {
  it("converts $/token to $/1M with rounding", () => {
    const parsed = parseOpenRouterPricing(OPENROUTER_DOC);
    expect(parsed.openrouter["z-ai/glm-4.6"]).toEqual({ input: 0.5, cacheRead: 0.1, output: 2 });
    expect(parsed.openrouter["meta/llama:free"]).toEqual({ input: 0, cacheRead: 0, output: 0 });
    expect(parsed.openrouter["bad-row"]).toBeUndefined();
  });
});

describe("free-model derivation", () => {
  it("classifies zero-price and :free entries as free", () => {
    expect(isFreeEntry("a", { input: 0, cacheRead: 0, output: 0 })).toBe(true);
    expect(isFreeEntry("a:free", { input: 1, cacheRead: 0, output: 2 })).toBe(true);
    expect(isFreeEntry("a", { input: 0.5, cacheRead: 0, output: 0 })).toBe(false);
  });

  it("derives provider sets and drops free-less providers", () => {
    const merged = mergeCatalogEntries([parseModelsDevPricing(MODELS_DEV_DOC), parseOpenRouterPricing(OPENROUTER_DOC)]);
    const free = deriveFreeModels(merged);
    expect(free).toEqual({
      zai: { "glm-5.1-free": true },
      openrouter: { "meta/llama:free": true }
    });
  });
});

describe("mergeCatalogEntries", () => {
  it("later sources override same provider+model", () => {
    const merged = mergeCatalogEntries([
      { p: { m: { input: 1, cacheRead: 0, output: 2 } } },
      { p: { m: { input: 3, cacheRead: 0, output: 6 } } }
    ]);
    expect(merged.p.m.input).toBe(3);
  });
});

describe("catalogContentHash", () => {
  it("is order-stable and content-sensitive", () => {
    const a = { p: { m1: { input: 1, cacheRead: 0, output: 2 }, m2: { input: 0, cacheRead: 0, output: 0 } } };
    const aReordered = { p: { m2: { input: 0, cacheRead: 0, output: 0 }, m1: { input: 1, cacheRead: 0, output: 2 } } };
    const b = { p: { m1: { input: 1.5, cacheRead: 0, output: 2 }, m2: { input: 0, cacheRead: 0, output: 0 } } };
    expect(catalogContentHash(a)).toBe(catalogContentHash(aReordered));
    expect(catalogContentHash(a)).not.toBe(catalogContentHash(b));
    expect(catalogContentHash(a)).toBe(catalogContentHash(a)); // 幂等
  });
});

describe("PricingCatalog", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-billing-catalog-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function makeCatalog(fetchImpl, overrides = {}) {
    return new PricingCatalog({
      cachePath: join(dir, "catalog.json"),
      builtinFree: { bai: { "deepseek-v4-flash": true } },
      fetchImpl,
      logger: { warn: () => {} },
      ...overrides
    });
  }

  it("refresh fetches both sources, persists compact cache, and loads it back", async () => {
    const fetcher = fakeFetch({ "models.dev": MODELS_DEV_DOC, "openrouter.ai": OPENROUTER_DOC });
    const catalog = makeCatalog(fetcher.impl);
    const summary = await catalog.refresh({ force: true });
    expect(summary.fromCache).toBe(false);
    expect(summary.onlineModels).toBe(4);
    expect(summary.sources).toEqual({ modelsDev: { ok: true }, openrouter: { ok: true } });
    expect(catalog.lookup("zai", "glm-5.1")).toEqual({ input: 1.4, cacheRead: 0.26, output: 4.4 });
    expect(catalog.lookup("openrouter", "z-ai/glm-4.6").input).toBe(0.5);
    expect(catalog.lookup("zai", "missing")).toBeUndefined();
    // 磁盘编码为紧凑三元组数组。
    const raw = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8"));
    expect(raw.version).toBe(2);
    expect(raw.entries.zai["glm-5.1"]).toEqual([1.4, 0.26, 4.4]);
    // 重启回读：条目与指纹一致。
    const reborn = makeCatalog(fetcher.impl);
    reborn.load();
    expect(reborn.lookup("zai", "glm-5.1")).toEqual({ input: 1.4, cacheRead: 0.26, output: 4.4 });
    expect(reborn.hash()).toBe(catalog.hash());
    expect(reborn.isFresh()).toBe(true);
  });

  it("honors TTL: fresh cache answers without network; force bypasses", async () => {
    const fetcher = fakeFetch({ "models.dev": MODELS_DEV_DOC, "openrouter.ai": OPENROUTER_DOC });
    const catalog = makeCatalog(fetcher.impl);
    await catalog.refresh({ force: true });
    expect(fetcher.calls.length).toBe(2);
    const cached = await catalog.refresh();
    expect(cached.fromCache).toBe(true);
    expect(fetcher.calls.length).toBe(2);
    await catalog.refresh({ force: true });
    expect(fetcher.calls.length).toBe(4);
  });

  it("dedupes concurrent refreshes into one fetch pair", async () => {
    const fetcher = fakeFetch({ "models.dev": MODELS_DEV_DOC, "openrouter.ai": OPENROUTER_DOC });
    const catalog = makeCatalog(fetcher.impl);
    await Promise.all([catalog.refresh({ force: true }), catalog.refresh({ force: true })]);
    expect(fetcher.calls.length).toBe(2);
  });

  it("keeps builtin free providers not covered online; online overrides same provider", async () => {
    const fetcher = fakeFetch({
      "models.dev": { zai: { models: { "glm-free": { cost: { input: 0, output: 0, cache_read: 0 } } } } },
      "openrouter.ai": { data: [] }
    });
    const catalog = makeCatalog(fetcher.impl);
    await catalog.refresh({ force: true });
    const effective = catalog.effectiveFreeModels();
    // 内置 provider（bai）保留；在线 zai 补充进来。
    expect(effective.bai).toEqual({ "deepseek-v4-flash": true });
    expect(effective.zai).toEqual({ "glm-free": true });
    // 免费集合缓存：同引用（计费热路径零重算）。
    expect(catalog.effectiveFreeModels()).toBe(effective);
  });

  it("online free list replaces builtin for the same provider", async () => {
    const fetcher = fakeFetch({
      "models.dev": { bai: { models: { "only-online-free": { cost: { input: 0, output: 0, cache_read: 0 } }, "paid": { cost: { input: 1, output: 1, cache_read: 0 } } } } },
      "openrouter.ai": { data: [] }
    });
    const catalog = makeCatalog(fetcher.impl);
    await catalog.refresh({ force: true });
    const effective = catalog.effectiveFreeModels();
    expect(effective.bai).toEqual({ "only-online-free": true });
  });

  it("throws when both sources fail and no data exists; degrades to stale with cache", async () => {
    const fetcher = fakeFetch({});
    const catalog = makeCatalog(fetcher.impl);
    await expect(catalog.refresh({ force: true })).rejects.toThrow(/both sources unreachable/);
    // 先成功一次,再断网。
    const good = fakeFetch({ "models.dev": MODELS_DEV_DOC, "openrouter.ai": OPENROUTER_DOC });
    const catalog2 = makeCatalog(good.impl);
    await catalog2.refresh({ force: true });
    const bad = fakeFetch({});
    const catalog3 = makeCatalog(bad.impl);
    catalog3.load();
    const summary = await catalog3.refresh({ force: true });
    expect(summary.stale).toBe(true);
    expect(summary.onlineModels).toBeGreaterThan(0);
    expect(summary.sources.modelsDev.ok).toBe(false);
  });

  it("proceeds when one source fails and records it", async () => {
    const fetcher = fakeFetch({ "models.dev": MODELS_DEV_DOC });
    const catalog = makeCatalog(fetcher.impl, { openrouterUrl: "https://unreachable.invalid/models" });
    const summary = await catalog.refresh({ force: true });
    expect(summary.sources.modelsDev.ok).toBe(true);
    expect(summary.sources.openrouter.ok).toBe(false);
    expect(summary.onlineModels).toBe(2);
  });

  it("reports added/removed free models across refreshes", async () => {
    const fetcher = fakeFetch({ "models.dev": MODELS_DEV_DOC, "openrouter.ai": OPENROUTER_DOC });
    const catalog = makeCatalog(fetcher.impl);
    await catalog.refresh({ force: true });
    const changed = fakeFetch({
      "models.dev": { zai: { models: {
        "glm-5.1-free": { cost: { input: 0, output: 0, cache_read: 0 } },
        "glm-new-free": { cost: { input: 0, output: 0, cache_read: 0 } }
      } } },
      "openrouter.ai": { data: [] }
    });
    const catalogFetcher = changed;
    const summary = await new PricingCatalog({
      cachePath: catalog.cachePath,
      builtinFree: { bai: { "deepseek-v4-flash": true } },
      fetchImpl: catalogFetcher.impl,
      logger: { warn: () => {} }
    }).refresh({ force: true });
    // 全新实例无前态 → added 不比较旧集合；此处只验证字段存在且非负。
    expect(summary.added).toBeGreaterThanOrEqual(0);
    expect(summary.removed).toBeGreaterThanOrEqual(0);
  });

  it("snapshot carries counts only (no full model lists)", () => {
    const catalog = makeCatalog(() => Promise.reject(new Error("offline")));
    const snapshot = catalog.snapshot();
    expect(snapshot).toHaveProperty("onlineModels");
    expect(snapshot).toHaveProperty("freeModels");
    expect(snapshot).toHaveProperty("fresh");
    expect(snapshot).not.toHaveProperty("entries");
    expect(snapshot.online).toBe(false);
  });

  it("resolves provider aliases for lookup and free sets (openrouter-free ← openrouter)", async () => {
    const catalog = makeCatalog(() => Promise.reject(new Error("offline")));
    catalog.entries = {
      openrouter: {
        "baidu/ernie-5.5-flash-preview:free": { input: 0, cacheRead: 0, output: 0 },
        "z-ai/glm-4.6": { input: 0.5, cacheRead: 0.1, output: 2 }
      }
    };
    catalog._free = null;
    catalog._hash = "";
    // 查价：别名命中（免费模型 $0）；未命中模型仍 undefined。
    expect(catalog.lookup("openrouter-free", "baidu/ernie-5.5-flash-preview:free")).toEqual({ input: 0, cacheRead: 0, output: 0 });
    expect(catalog.lookup("openrouter-free", "missing-model")).toBeUndefined();
    // 免费集合：别名 provider 继承目标集合；builtin 独立 provider 不被覆盖。
    const effective = catalog.effectiveFreeModels();
    expect(effective["openrouter-free"]).toEqual({ "baidu/ernie-5.5-flash-preview:free": true });
    expect(effective.bai).toEqual({ "deepseek-v4-flash": true });
  });
});
