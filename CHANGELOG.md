# Changelog

## 3.0.0 (2026-11-13)

Fork of [bpc-oss/dsh-web-billing](https://github.com/bpc-oss/dsh-web-billing) v2.3.2, rebuilt around an online pricing catalog. **Breaking-ish**: pricing semantics gained two layers (online catalog + free-model aliases); existing ledgers are automatically repriced on first launch of 3.0.0 (engine version bump), so totals may shift slightly for third-party usage-based models that now use real market prices instead of the official DeepSeek `*` fallback.

### Added — online pricing catalog (fixes stale hardcoded price tables)

- New `lib/catalog.js`: built-in snapshot + online refresh (models.dev + OpenRouter `/api/v1/models`) + TTL disk cache (`web-billing-catalog.json`, 12h default, compact array encoding ~330KB for 8.7k models).
- Price resolution chain in `priceAt` now has a **catalog layer**: user override → coding plan → official policy (named models) → user `*` → **online catalog (provider+model market USD price)** → official `*` fallback. Third-party models like `zai/glm-5.1` or `nvidia/*` now bill at real market prices instead of DeepSeek's fallback.
- Provider aliases (`openrouter-free` ← `openrouter`): the dsh-model-palette free lane and custom router providers resolve prices and free sets through their catalog namespace.
- Endpoints: `GET /billing/catalog` (snapshot + free sets), `POST /billing/catalog/refresh` (`{force}` skips TTL), and catalog status embedded in `/billing/state`.
- Config `catalog`: `enabled` / `modelsDevUrl` / `openrouterUrl` / `ttlMs` / `timeoutMs` / `refreshOnStartup` / `refreshIntervalMinutes` (0=off). Memory-guarded: flat price triples only, 50k model cap, 64MB response cap, free-set cache on the hot path.
- Pricing hash now includes a `PRICING_ENGINE_VERSION` + catalog content hash — repricing triggers only when prices/free sets actually change.

### Added — cached free-model detection (no more re-probing per message)

- Free-model identification is **derived from the cached catalog** (`deriveFreeModels`: zero input+output price or `:free` id) — zero network on the hot path, refreshed only with the catalog.
- `GET /billing/free-models` (effective sets + applied state), `POST /billing/free-models/refresh` (force re-fetch, summary of added/removed).
- Effective free sets = built-in `PROMO_MODELS` ∪ online-derived (online overrides same provider; built-in-only providers like `bai` survive).

### Added — one-click zero-rate free models (confirm-first UI)

- `POST /billing/free-models/apply` `{provider, models[], action: add|remove}`: flips the provider to `usage-free` with an exact user-selected free set, persists, and **reprices history** (billed→free→savings).
- Settings → Cost gains a **free-models panel**: provider groups (applied pinned first, sorted by model count), per-model checkboxes, select-all/none, and a confirmation strip (`确认按 0 费率计费？+N · 历史将重估`) — nothing is applied silently.
- `zeroCostDisplay` config (`show` default / `hide`): pure-zero messages can hide their `¥0` chips; session badges show `¥0` for fully-free sessions unless hidden.
- `/billing/state` now ships `promoCounts` (counts only) instead of the full promo table — the 5s poll no longer carries hundreds of model ids; full lists are fetched on demand.

### Changed

- Update-check source moved to `Jensen-Yao/dsh-web-billing` releases; repository/homepage now point to the fork (GitHub Pages site for docs).
- Tests migrated from `node --test` to **vitest** (46 tests): catalog parsing/merge/hash/TTL/concurrency/offline-degradation, priceAt precedence chain, zero-rating, and HTTP endpoint integration (fake ctx + local catalog server).
- `prepack-check` covers new files (catalog.js, docs/index.html, banners, workflows, CHANGELOG).

## 2.3.2 (upstream base)

See upstream repository history for 2.x changes.
