import { describe, expect, it } from "vitest";
import { CODING_PLAN_PRICING } from "../lib/coding-plans.js";
import {
  DEFAULT_CODING_USD_CNY_RATE,
  OFFICIAL_PRICING_POLICIES,
  catalogUnit,
  costOf,
  isPeak,
  priceAt,
  subscriptionUnitFor,
  sourceOf
} from "../lib/pricing.js";

/** 峰谷政策（2026-08-17 起）下的两个时刻：北京时间 10:00（高峰）/ 20:00（空闲）。 */
const PEAK_TIME = Date.parse("2026-10-01T10:00:00+08:00");
const OFFPEAK_TIME = Date.parse("2026-10-01T20:00:00+08:00");
/** 峰谷政策之前的时刻（走 2026-05-22 固定价）。 */
const FLAT_TIME = Date.parse("2026-06-01T10:00:00+08:00");

/** 在线目录桩：zai/glm-5.1 与 nvidia/nemotron-nano-9b-v2（$1/0.1/$3）。 */
const catalogLookup = (provider, model) => {
  const table = {
    "zai|glm-5.1": { input: 1.4, cacheRead: 0.26, output: 4.4 },
    "nvidia|nvidia/nemotron-nano-9b-v2": { input: 1, cacheRead: 0.1, output: 3 }
  };
  return table[`${provider ?? ""}|${model}`];
};

describe("priceAt precedence chain", () => {
  it("user exact override always wins (over policies, coding plans and catalog)", () => {
    const unit = priceAt("glm-5.1", PEAK_TIME, {
      provider: "zai",
      prices: { "glm-5.1": { cny: { input: 9, cacheRead: 9, output: 9 }, usd: { input: 9, cacheRead: 9, output: 9 } } },
      catalogLookup
    });
    expect(unit.cny.input).toBe(9);
    expect(unit.pricingRoute).toBe("user");
  });

  it("coding plan route beats official chain and catalog", () => {
    const unit = priceAt("glm-5.1", PEAK_TIME, { provider: "opencode-go", catalogLookup });
    expect(unit.pricingRoute).toBe("coding");
    expect(unit.usd.input).toBe(1.4);
    // 人民币 = 美元 × 参考汇率（默认 7.2）。
    expect(unit.cny.input).toBeCloseTo(1.4 * DEFAULT_CODING_USD_CNY_RATE, 6);
  });

  it("official policy still prices deepseek models (catalog ignored for named models)", () => {
    const unit = priceAt("deepseek-v4-flash", PEAK_TIME, { provider: "deepseek", catalogLookup });
    expect(unit.mode).toBe("peak");
    expect(unit.cny.input).toBe(3);
    expect(unit.pricingRoute).toBeUndefined();
  });

  it("user wildcard beats catalog for unnamed models", () => {
    const unit = priceAt("some-unknown-model", PEAK_TIME, {
      provider: "zai",
      prices: { "*": { cny: { input: 5, cacheRead: 5, output: 5 }, usd: { input: 5, cacheRead: 5, output: 5 } } },
      catalogLookup
    });
    expect(unit.pricingRoute).toBeUndefined();
    expect(unit.cny.input).toBe(5);
  });

  it("catalog prices unnamed models before the official * fallback", () => {
    const unit = priceAt("glm-5.1", PEAK_TIME, { provider: "zai", catalogLookup });
    expect(unit.pricingRoute).toBe("catalog");
    expect(unit.mode).toBe("flat");
    expect(unit.usd).toEqual({ input: 1.4, cacheRead: 0.26, output: 4.4 });
    expect(unit.cny.input).toBeCloseTo(1.4 * 7.2, 6);
    expect(unit.policy.since).toBe("catalog");
  });

  it("catalog applies a custom usd→cny rate with 6-decimal rounding", () => {
    const unit = priceAt("glm-5.1", PEAK_TIME, { provider: "zai", catalogLookup, codingUsdCnyRate: 7 });
    expect(unit.cny.input).toBe(9.8);
    expect(unit.cny.cacheRead).toBeCloseTo(0.26 * 7, 6);
  });

  it("falls back to official * when neither catalog nor wildcard hits", () => {
    const unit = priceAt("totally-unknown", PEAK_TIME, { provider: "who", catalogLookup });
    expect(unit.pricingRoute).toBeUndefined();
    expect(unit.cny.input).toBe(3); // 峰谷政策 * 高峰价
  });

  it("officialPricing off ignores catalog entirely", () => {
    const unit = priceAt("glm-5.1", PEAK_TIME, { official: false, provider: "zai", catalogLookup });
    expect(unit.pricingRoute).toBeUndefined();
    expect(unit.cny.input).toBe(0); // 无用户表 → 零价
  });

  it("peak/off-peak modes resolve by time under the latest policy", () => {
    expect(priceAt("deepseek-v4-flash", PEAK_TIME, {}).mode).toBe("peak");
    expect(priceAt("deepseek-v4-flash", OFFPEAK_TIME, {}).mode).toBe("offPeak");
    expect(priceAt("deepseek-v4-flash", FLAT_TIME, {}).mode).toBe("flat");
    expect(priceAt("deepseek-v4-flash", FLAT_TIME, {}).cny.input).toBe(1);
  });
});

describe("catalogUnit", () => {
  it("rounds cny conversions to 6 decimals", () => {
    const unit = catalogUnit({ input: 0.019, cacheRead: 0.00019, output: 0.029 }, 7.25);
    expect(unit.cny.input).toBeCloseTo(0.1377500, 6);
    expect(unit.usd.input).toBe(0.019);
  });
});

describe("subscriptionUnitFor with effective promos", () => {
  const promos = { nvidia: { "nvidia/nemotron-nano-9b-v2": true } };
  const nominal = { cny: { input: 3, cacheRead: 0.1, output: 9 }, usd: { input: 0.44, cacheRead: 0.014, output: 1.32 } };

  it("usage-free: free-hit models are zero-rated, others billed", () => {
    const hit = subscriptionUnitFor("nvidia", "nvidia/nemotron-nano-9b-v2", nominal, { nvidia: { mode: "usage-free" } }, promos);
    expect(hit.metered).toBe(true);
    expect(hit.freeHit).toBe(true);
    expect(hit.unit.cny.input).toBe(0);
    const miss = subscriptionUnitFor("nvidia", "nvidia/paid-model", nominal, { nvidia: { mode: "usage-free" } }, promos);
    expect(miss.freeHit).toBe(false);
    expect(miss.unit).toBe(nominal);
  });

  it("non-empty user freeModels override the effective promo table", () => {
    const hit = subscriptionUnitFor(
      "nvidia",
      "nvidia/user-only-free",
      nominal,
      { nvidia: { mode: "usage-free", freeModels: { "nvidia/user-only-free": true } } },
      promos
    );
    expect(hit.freeHit).toBe(true);
    // 内置命中但用户清单不含 → 不算白嫖（用户清单优先）。
    const excluded = subscriptionUnitFor(
      "nvidia",
      "nvidia/nemotron-nano-9b-v2",
      nominal,
      { nvidia: { mode: "usage-free", freeModels: { "nvidia/user-only-free": true } } },
      promos
    );
    expect(excluded.freeHit).toBe(false);
  });

  it("subscription / free / local are all zero-rated", () => {
    for (const mode of ["subscription", "free", "local"]) {
      const sub = subscriptionUnitFor("p", "m", nominal, { p: { mode, monthly: 20 } }, promos);
      expect(sub.metered).toBe(true);
      expect(sub.unit.cny.output).toBe(0);
    }
  });
});

describe("costOf", () => {
  it("computes dual-currency cost from a unit", () => {
    const result = costOf({ inputTokens: 1_000_000, cacheReadTokens: 500_000, outputTokens: 200_000 }, {
      cny: { input: 1, cacheRead: 0.1, output: 2 },
      usd: { input: 0.14, cacheRead: 0.014, output: 0.28 }
    });
    expect(result.cost).toBeCloseTo(1 + 0.05 + 0.4, 9);
    expect(result.costUsd).toBeCloseTo(0.14 + 0.007 + 0.056, 9);
  });
});

describe("sourceOf", () => {
  it("classifies local/coding/subscription/official", () => {
    expect(sourceOf("my-box", "m", { localProviders: ["my-box"] })).toBe("local");
    expect(sourceOf("opencode-go", "glm-5.1", {})).toBe("coding");
    // subscription 类 plan 需 provider+model 双命中（取内置表第一个模型）。
    const qwenModel = Object.keys(CODING_PLAN_PRICING["qwen-token-plan"].models)[0];
    expect(sourceOf("qwen-token-plan", qwenModel, {})).toBe("subscription");
    expect(sourceOf("deepseek", "deepseek-v4-flash", {})).toBe("official");
    expect(sourceOf("", "m", {})).toBe("unknown");
  });
});

describe("isPeak", () => {
  it("follows Asia/Shanghai windows", () => {
    expect(isPeak(PEAK_TIME)).toBe(true);
    expect(isPeak(OFFPEAK_TIME)).toBe(false);
    expect(isPeak(Date.parse("2026-10-01T13:30:00+08:00"))).toBe(false); // 午间缓冲
  });
});

describe("OFFICIAL_PRICING_POLICIES sanity", () => {
  it("policies are sorted ascending by since", () => {
    const times = OFFICIAL_PRICING_POLICIES.map((policy) => Date.parse(policy.since));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
