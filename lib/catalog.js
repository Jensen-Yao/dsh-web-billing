/**
 * @dsh-local/dsh-web-billing — online pricing catalog.
 *
 * 定价目录：内置快照（promo-models / coding-plans，随包发行）+ 在线刷新
 * （models.dev 全量目录 + OpenRouter 实时价）+ TTL 磁盘缓存。解决「写死过期表」：
 * 新模型/调价后无需发版，目录刷新即可拿到市场美元价；离线时回退内置快照。
 *
 * 内存/磁盘设计（面向长驻进程，刻意从紧）：
 * - 条目扁平三元组 { input, cacheRead, output }（$/1M），不保留 context/
 *   released 等计费无关字段；磁盘缓存用 [input, cacheRead, output] 紧凑数组编码，
 *   体积约为对象编码的一半。
 * - 条目总量上限保护（畸形/超巨目录截断），响应体大小上限保护。
 * - 免费集合推导结果缓存（refresh/load 才失效），计费热路径零重算。
 *
 * 解析逻辑均为纯函数（可单测）；网络与缓存封装在 PricingCatalog：
 * - refresh(force)：拉取目录（TTL 内且非 force 直接复用缓存）；刷新与识别分离——
 *   「识别免费模型」是从缓存目录推导（deriveFreeModels），零网络成本。
 * - lookup(provider, model)：在线目录美元单价（无则 undefined，走官方政策链兜底）。
 * - effectiveFreeModels()：内置 PROMO_MODELS ∪ 在线免费（在线覆盖同名 provider）。
 *
 * 数据源记录结构（均为公开目录，无需鉴权）：
 * - models.dev/api.json：{ [providerId]: { models: { [modelId]: { cost: { input,
 *   output, cache_read } } } } }，cost 单位 $/1M tokens，与 pi-ai catalog 同源口径。
 * - openrouter.ai/api/v1/models：{ data: [{ id, pricing: { prompt, completion,
 *   input_cache_read } }] }，pricing 为 $/token 字符串，需 ×1e6；`:free` 后缀
 *   或全零价视为免费。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { PROMO_MODELS } from "./promo-models.js";

/** 目录缓存默认 TTL（12h，与 models.dev 生态惯例一致）。 */
export const DEFAULT_CATALOG_TTL_MS = 12 * 60 * 60 * 1000;

/** 目录请求超时。 */
export const DEFAULT_CATALOG_TIMEOUT_MS = 15_000;

/** 目录条目总量上限（防畸形/超巨响应撑爆内存；正常两源合计 ~9k）。 */
export const MAX_CATALOG_MODELS = 50_000;

/** 单源响应体大小上限（64MB；models.dev 实际 ~6MB）。 */
export const MAX_CATALOG_RESPONSE_BYTES = 64 * 1024 * 1024;

/** 默认数据源地址。 */
export const DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json";
export const DEFAULT_OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

/** 数值清洗：非有限/负数归 0。 */
function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** $/token 字符串 → $/1M tokens（OpenRouter 口径换算；6 位圆整去浮点尾差）。 */
function perTokenToPerM(value) {
  return Math.round(num(value) * 1e6 * 1e6) / 1e6;
}

/**
 * 解析 models.dev 目录（纯函数）：返回 provider → model → 价格三元组。
 * 只收带 cost 的模型（无价条目对计费无意义）；cost 字段缺省键按 0 处理。
 * @param json - 反序列化后的 models.dev 文档。
 */
export function parseModelsDevPricing(json) {
  const out = {};
  if (typeof json !== "object" || json === null || Array.isArray(json)) return out;
  let count = 0;
  for (const [providerId, provider] of Object.entries(json)) {
    if (typeof provider !== "object" || provider === null) continue;
    const models = provider.models;
    if (typeof models !== "object" || models === null) continue;
    const bucket = {};
    for (const [modelId, model] of Object.entries(models)) {
      if (count >= MAX_CATALOG_MODELS) return out;
      if (typeof model !== "object" || model === null) continue;
      const cost = model.cost;
      if (typeof cost !== "object" || cost === null) continue;
      bucket[modelId] = { input: num(cost.input), cacheRead: num(cost.cache_read), output: num(cost.output) };
      count += 1;
    }
    if (Object.keys(bucket).length > 0) out[providerId] = bucket;
  }
  return out;
}

/**
 * 解析 OpenRouter 目录（纯函数）：返回 { openrouter: model → 价格三元组 }。
 * id 保持 OpenRouter 原样（含命名空间前缀与 `:free` 后缀）——DSH 的 openrouter
 * provider 用的就是这些 id。
 * @param json - 反序列化后的 OpenRouter /api/v1/models 文档。
 */
export function parseOpenRouterPricing(json) {
  const out = { openrouter: {} };
  const rows = Array.isArray(json?.data) ? json.data : [];
  for (const row of rows) {
    if (Object.keys(out.openrouter).length >= MAX_CATALOG_MODELS) break;
    if (typeof row !== "object" || row === null || typeof row.id !== "string" || row.id === "") continue;
    // 无 pricing 对象的行直接跳过——否则会被误判为全零免费模型。
    const pricing = typeof row.pricing === "object" && row.pricing !== null ? row.pricing : null;
    if (pricing === null) continue;
    out.openrouter[row.id] = {
      input: perTokenToPerM(pricing.prompt),
      cacheRead: perTokenToPerM(pricing.input_cache_read),
      output: perTokenToPerM(pricing.completion)
    };
  }
  return out;
}

/** 条目是否免费（输入与输出均 0；`:free` 后缀 id 一并视为免费）。 */
export function isFreeEntry(modelId, entry) {
  if (/:free$/i.test(modelId)) return true;
  const unit = entry ?? {};
  return num(unit.input) <= 0 && num(unit.output) <= 0;
}

/**
 * 从目录条目推导免费模型集合（纯函数）：provider → { model: true }。
 * 这是「免费模型识别」的唯一真相源——识别=推导（零网络），刷新=重拉目录。
 * @param entries - provider → model → 价格三元组。
 */
export function deriveFreeModels(entries) {
  const free = {};
  for (const [provider, models] of Object.entries(entries ?? {})) {
    const bucket = {};
    for (const [model, entry] of Object.entries(models ?? {})) {
      if (!isFreeEntry(model, entry)) continue;
      bucket[model] = true;
    }
    if (Object.keys(bucket).length > 0) free[provider] = bucket;
  }
  return free;
}

/**
 * 合并多个目录源（纯函数，后者覆盖同名 provider+model）：OpenRouter API 的
 * openrouter 命名空间最后应用（实时价优先于 models.dev 镜像）。
 */
export function mergeCatalogEntries(sources) {
  const merged = {};
  for (const source of sources) {
    for (const [provider, models] of Object.entries(source ?? {})) {
      const bucket = merged[provider] ?? (merged[provider] = {});
      for (const [model, entry] of Object.entries(models ?? {})) bucket[model] = entry;
    }
  }
  return merged;
}

/**
 * 目录内容指纹（内容寻址，不含 fetchedAt）：价格 + 免费集合。
 * 刷新后内容不变 → 指纹不变 → 不触发无谓的历史重估。
 */
export function catalogContentHash(entries) {
  const hash = createHash("sha256");
  for (const provider of Object.keys(entries ?? {}).sort()) {
    hash.update(`\nP:${provider}`);
    for (const model of Object.keys(entries[provider] ?? {}).sort()) {
      const unit = entries[provider][model];
      hash.update(`\nM:${model}:${unit.input}/${unit.cacheRead}/${unit.output}`);
    }
  }
  return hash.digest("hex").slice(0, 32);
}

/**
 * provider 别名：DSH 里免费线路/自定义路由 provider 与目录命名空间不同名
 * （如 dsh-model-palette 的 OpenRouter 免费线路叫 openrouter-free，目录里叫
 * openrouter）。查价与免费集合推导按「精确名 → 别名」顺序解析；别名目标无
 * 数据时保持未命中（不产生误报）。
 */
export const PROVIDER_ALIASES = Object.freeze({
  "openrouter-free": "openrouter"
});

/** 条目 → 紧凑三元组（磁盘编码）。 */
function encodeEntries(entries) {
  const out = {};
  for (const [provider, models] of Object.entries(entries)) {
    const bucket = {};
    for (const [model, unit] of Object.entries(models)) bucket[model] = [unit.input, unit.cacheRead, unit.output];
    out[provider] = bucket;
  }
  return out;
}

/** 紧凑三元组 → 条目（磁盘解码；畸形行跳过）。 */
function decodeEntries(raw) {
  const out = {};
  for (const [provider, models] of Object.entries(raw ?? {})) {
    if (typeof models !== "object" || models === null) continue;
    const bucket = {};
    for (const [model, triple] of Object.entries(models)) {
      if (!Array.isArray(triple) || triple.length < 3) continue;
      bucket[model] = { input: num(triple[0]), cacheRead: num(triple[1]), output: num(triple[2]) };
    }
    if (Object.keys(bucket).length > 0) out[provider] = bucket;
  }
  return out;
}

/**
 * 定价目录运行时：磁盘缓存（TTL）+ 在线刷新 + 免费模型推导。
 * 任何网络失败都不抛到轮询路径——refresh 仅在「无任何可用数据」时抛错
 * （手动刷新端点据此反馈），有缓存时降级返回 stale 摘要。
 */
export class PricingCatalog {
  /**
   * @param deps - {
   *   cachePath, ttlMs, timeoutMs, modelsDevUrl, openrouterUrl,
   *   builtinFree (默认 PROMO_MODELS), fetchImpl, logger
   * }。
   */
  constructor(deps = {}) {
    this.cachePath = deps.cachePath;
    this.ttlMs = Number.isFinite(deps.ttlMs) && deps.ttlMs > 0 ? deps.ttlMs : DEFAULT_CATALOG_TTL_MS;
    this.timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_CATALOG_TIMEOUT_MS;
    this.modelsDevUrl = deps.modelsDevUrl ?? DEFAULT_MODELS_DEV_URL;
    this.openrouterUrl = deps.openrouterUrl ?? DEFAULT_OPENROUTER_URL;
    this.builtinFree = deps.builtinFree ?? PROMO_MODELS;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.logger = deps.logger ?? console;
    /** 在线条目（provider → model → 价格三元组）；空 = 从未成功拉取。 */
    this.entries = {};
    /** 最近一次成功拉取时刻（epoch ms）。 */
    this.fetchedAt = 0;
    /** 各源最近一次结果（ok/failed + error 摘要）。 */
    this.sources = {};
    /** 指纹缓存（内容寻址，refresh/load 时重算）。 */
    this._hash = "";
    /** 免费集合缓存（refresh/load 时失效；计费热路径每条消息都要取）。 */
    this._free = null;
    /** 并发去重：refresh 进行中共享同一 Promise。 */
    this._inFlight = null;
  }

  /** 从磁盘缓存装载（无缓存/损坏时静默保持空目录）。 */
  load() {
    try {
      if (this.cachePath === void 0 || !existsSync(this.cachePath)) return;
      const raw = JSON.parse(readFileSync(this.cachePath, "utf8"));
      if (raw?.version !== 2) return;
      this.entries = decodeEntries(raw.entries);
      this.fetchedAt = Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : 0;
      this.sources = typeof raw.sources === "object" && raw.sources !== null ? raw.sources : {};
      this._hash = catalogContentHash(this.entries);
      this._free = null;
    } catch (error) {
      this.logger.warn?.("[dsh-web-billing] catalog cache load failed:", error?.message ?? error);
    }
  }

  /** 缓存是否仍在 TTL 内（未拉取过视为过期）。 */
  isFresh(now = Date.now()) {
    return this.fetchedAt > 0 && now - this.fetchedAt < this.ttlMs;
  }

  /** 在线目录单价三元组（精确名 → 别名解析；无命中返回 undefined）。 */
  lookup(provider, model) {
    if (typeof provider !== "string" || provider === "" || typeof model !== "string" || model === "") return void 0;
    const direct = this.entries[provider]?.[model];
    if (direct !== void 0) return direct;
    const alias = PROVIDER_ALIASES[provider];
    return alias === void 0 ? void 0 : this.entries[alias]?.[model];
  }

  /** 是否存在任何在线数据（离线回退判定）。 */
  get hasData() {
    return Object.keys(this.entries).length > 0;
  }

  /**
   * 有效免费模型（内置快照 ∪ 在线推导；在线覆盖同名 provider——活动结束的
   * 模型随在线目录离开，内置独有的 provider（bai 等自定义）继续生效）。
   */
  effectiveFreeModels() {
    if (this._free !== null) return this._free;
    const online = deriveFreeModels(this.entries);
    const effective = { ...this.builtinFree, ...online };
    // 别名 provider 继承目标的免费集合（openrouter-free ← openrouter）；
    // 已有独立集合的（builtin openrouterfree）不被覆盖。
    for (const [alias, target] of Object.entries(PROVIDER_ALIASES)) {
      if (effective[alias] !== void 0 || effective[target] === void 0) continue;
      effective[alias] = effective[target];
    }
    this._free = effective;
    return this._free;
  }

  /** 内容指纹（计价规则输入之一；变化才触发历史重估）。 */
  hash() {
    if (this._hash === "") this._hash = catalogContentHash(this.entries);
    return this._hash;
  }

  /** API 摘要（GET /billing/catalog 等；只含计数，不携全量清单）。 */
  snapshot() {
    const free = this.effectiveFreeModels();
    let onlineModels = 0;
    for (const bucket of Object.values(this.entries)) onlineModels += Object.keys(bucket).length;
    let freeCount = 0;
    for (const bucket of Object.values(free)) freeCount += Object.keys(bucket).length;
    return {
      fetchedAt: this.fetchedAt > 0 ? new Date(this.fetchedAt).toISOString() : null,
      ttlMs: this.ttlMs,
      fresh: this.isFresh(),
      online: this.hasData,
      onlineModels,
      onlineProviders: Object.keys(this.entries).length,
      freeProviders: Object.keys(free).length,
      freeModels: freeCount,
      builtinFreeProviders: Object.keys(this.builtinFree).length,
      sources: { ...this.sources },
      hash: this.hash()
    };
  }

  /**
   * 刷新目录（TTL 内且非 force 直接复用缓存；并发调用共享同一请求）。
   * 两源 allSettled 并行：全部失败且无历史数据 → 抛错（手动刷新端点向用户
   * 反馈）；有缓存则返回 stale 摘要（billing 离线可用，不更新 fetchedAt）。
   * @param options - { force?: boolean }。
   * @returns 刷新摘要（added/removed 相对刷新前的有效免费集合变化）。
   */
  async refresh(options = {}) {
    if (this._inFlight !== null) return this._inFlight;
    this._inFlight = this._refreshInner(options).finally(() => {
      this._inFlight = null;
    });
    return this._inFlight;
  }

  async _refreshInner({ force = false } = {}) {
    if (!force && this.isFresh()) {
      return { ...this.snapshot(), fromCache: true };
    }
    const [modelsDev, openrouter] = await Promise.allSettled([
      this.fetchJson(this.modelsDevUrl),
      this.fetchJson(this.openrouterUrl)
    ]);
    const sources = {};
    const parts = [];
    if (modelsDev.status === "fulfilled") {
      sources.modelsDev = { ok: true };
      parts.push(parseModelsDevPricing(modelsDev.value));
    } else {
      sources.modelsDev = { ok: false, error: errorText(modelsDev.reason) };
    }
    if (openrouter.status === "fulfilled") {
      sources.openrouter = { ok: true };
      parts.push(parseOpenRouterPricing(openrouter.value));
    } else {
      sources.openrouter = { ok: false, error: errorText(openrouter.reason) };
    }
    if (parts.length === 0) {
      if (!this.hasData) throw new Error("pricing catalog refresh failed (both sources unreachable)");
      // 有缓存：降级为 stale 摘要，不更新 fetchedAt（TTL 继续倒计时）。
      this.sources = sources;
      return { ...this.snapshot(), stale: true };
    }
    const beforeCount = countFree(this.effectiveFreeModels());
    // 解析完成后立即丢弃原始响应引用（parts 之外不再持有大 JSON）。
    this.entries = mergeCatalogEntries(parts);
    this.fetchedAt = Date.now();
    this.sources = sources;
    this._hash = catalogContentHash(this.entries);
    this._free = null;
    const afterCount = countFree(this.effectiveFreeModels());
    await this.persist(sources);
    return {
      ...this.snapshot(),
      fromCache: false,
      added: Math.max(0, afterCount - beforeCount),
      removed: Math.max(0, beforeCount - afterCount)
    };
  }

  /** 落盘（紧凑数组编码 + 原子替换；cachePath 未配置时跳过——纯内存模式，测试用）。 */
  async persist(sources = this.sources) {
    if (this.cachePath === void 0) return;
    try {
      const body = JSON.stringify({
        version: 2,
        fetchedAt: this.fetchedAt,
        sources,
        entries: encodeEntries(this.entries)
      });
      const tmp = `${this.cachePath}.tmp`;
      await writeFile(tmp, body, "utf8");
      await rename(tmp, this.cachePath);
    } catch (error) {
      this.logger.warn?.("[dsh-web-billing] catalog cache persist failed:", error?.message ?? error);
    }
  }

  async fetchJson(url) {
    const response = await this.fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "error"
    });
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    const length = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > MAX_CATALOG_RESPONSE_BYTES) {
      throw new Error(`response too large (${length} bytes)`);
    }
    return response.json();
  }
}

/** 免费集合总数。 */
function countFree(free) {
  let count = 0;
  for (const bucket of Object.values(free ?? {})) count += Object.keys(bucket ?? {}).length;
  return count;
}

/** 错误摘要（截断，避免目录源 HTML 错误页污染日志/响应）。 */
function errorText(error) {
  return String(error instanceof Error ? error.message : error).slice(0, 200);
}
