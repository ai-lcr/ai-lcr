# Changelog

All notable changes to `ai-lcr` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.4.0] — 2026-06-02

All additions are optional and backward compatible.

### Added

- **`CallRecord.ttftMs` — time to first token.** Streaming calls now report TTFT,
  the industry-standard responsiveness metric: ms from the winning provider's
  stream attempt start to its first content token (`text-delta` /
  `reasoning-delta`). Measured against the *winner's* attempt, so failover
  overhead (already in `latencyMs`) doesn't distort it. `undefined` for
  `doGenerate` (no streaming → no "first token") and for calls that failed before
  producing content. `formatCallRecord` shows it inline next to total latency when
  present (`412ms (ttft 88ms)`). With `latencyMs` and `outputTokens` on the same
  record, output throughput is derivable: `outputTokens / ((latencyMs − ttftMs) /
  1000)` tokens/sec.

## [0.3.0] — 2026-06-02

Integration-feedback pass from wiring ai-lcr into a real agentic product
(multi-step tool loops, Anthropic prompt caching). All additions are optional
and backward compatible.

### Fixed

- **`createHttpSink` is exported again.** It shipped in 0.2.0, then silently
  dropped out of the package somewhere after — so `import { createHttpSink }`
  (as the integration playbook documents) failed with TS2305 on 0.2.1+. The
  source and tests are restored and the symbol is now pinned in the public-API
  smoke test so it can't regress unnoticed.
- **Capability probe no longer false-FAILs tool support.** `check-provider.sh`
  tested tools with `tool_choice:"auto"` and a single roll — reasoning / chatty
  models often answer in text instead of calling, which looked identical to
  dropped tools. It now forces `tool_choice:"required"` (testing *can* the
  provider call a tool, not *will* the model decide to). The token-inflation
  parser also surfaces a stderr diagnostic on a parse failure instead of
  silently returning empty (which masqueraded as an inconclusive result).

### Added

- **`CallRecord.baselineUsd` on the text side.** The text router now fills the
  savings baseline — the same token usage priced on the most expensive priced
  provider in the chain — so `baselineUsd − costUsd` (the headline a cost
  dashboard shows) is computable for text, not just media.
- **Prompt-cache-aware cost.** `ProviderCost` gains an optional `cacheRead`
  (USD per 1M cached input tokens). When a call reports
  `usage.inputTokens.cacheRead`, those tokens bill at that rate; omit it and
  they fall back to the full `input` rate (unchanged). `CallRecord` exposes
  `cachedInputTokens` for auditing. Accounting only — routing weights are
  unchanged in this release.
- **`CallRecord.requestId` passthrough.** Read from `providerOptions.lcr.requestId`;
  stamp the same id on every step of a tool loop to roll a multi-step request
  up into one cost figure on the dashboard.
- **`CallRecord.usageMissing` flag.** Set when the winner served OK but reported
  zero input *and* output tokens — i.e. the provider emitted no usage, so
  `costUsd` (and any token-based credit metering) silently reads 0. Surfaces the
  difference between "free" and "cost unknown"; `formatCallRecord` shows it as
  `⚠no-usage`, and a savings suffix `(saved $X)` when `baselineUsd` beats cost.

## [0.2.6] — 2026-06-01

### Changed

- **fal media adapter now covers image *and* video** via fal's async queue API
  (submit → poll `status_url` → fetch `response_url`), replacing the synchronous
  image-only `fal.run` adapter shipped in 0.2.5. This is ai-lcr's first working
  **video** execution path: the registry already priced/routed the Veo family
  but no adapter could run it. Same house style — raw `fetch`, injectable
  `fetchImpl`, no provider SDK; `Authorization: Key` (not Bearer); cost left to
  the router's normalized estimate (the queue result carries no per-call price).
  Following the submit response's `status_url`/`response_url` sidesteps fal's
  sub-path quirk (`fal-ai/flux/schnell` submits to the full path, but status and
  result live under the `fal-ai/flux` base). `createFalMediaAdapter`'s public
  name is unchanged; image callers are unaffected.

## [0.2.5] — 2026-06-01

Pre-launch failover-robustness + media-provider pass — closing cases where a
real provider failure slipped past the switch criterion and killed the request,
and making fal a live failover target.

### Fixed

- **A network-unreachable provider didn't fail over.** `isRetryableError` only
  matched HTTP statuses and English keywords, but a provider that's down throws
  a `fetch` `TypeError` with *no* status — and wraps the real cause
  (`ECONNREFUSED`/`ECONNRESET`/`ENOTFOUND`/connect-timeout, with the Node `code`)
  in `error.cause`. Those read as a non-retryable client error, so the cheapest
  provider going down killed the request instead of falling over — the most
  common outage mode. The engine now walks the `cause` chain and treats Node
  network codes / transport-failure messages as retryable. Applies to both the
  text and media routers. New exported helper `isNetworkError`.
- **Non-English billing failures didn't fail over.** Out-of-credit detection was
  English-only, but Chinese providers (e.g. Kunavo) report a failed charge as
  `余额不足`/`账户欠费`/`扣费失败` in a 200/400 body with no billing status.
  Those are now matched (plus `balance`/`exhausted`), so a failed charge fails
  over and is tagged `billing` by `classifyErrorKind` for alerting.
- **An out-of-balance 403 was mis-tagged as `auth`.** Providers report an
  exhausted account as 403 (e.g. fal "exhausted balance") — a top-up problem,
  not a revoked key. `classifyErrorKind` now lets billing wording win over a
  bare 401/403 status, so it's tagged `billing` (a plain 403 stays `auth`).
- **A throwing observer could fail a successful request.** `onCost`/`onCall`/
  `onError` were invoked unguarded; a logging sink that threw (e.g. a flaky db9
  write) turned an otherwise-successful generation into a thrown error. All
  observer callbacks are now fire-and-forget — wrapped so a throw can never
  affect routing or the request outcome. Applies to both routers.

### Added

- **fal media adapter** (`createFalMediaAdapter`). fal was in the price table
  but had no adapter, so its routes were silently skipped at runtime — now it's
  a real cheapest-first / failover target for image models. Synchronous
  `https://fal.run/<model>` with `Authorization: Key`, generic input pass-
  through, HTTP-status-bearing errors (403 out-of-balance → fails over; 422 bad
  input → doesn't). Image only; fal video (queue) is on the roadmap.
- **Status-page liveness probes for Runware + fal** (`website`). Both are now
  monitored with a free, generation-free reachability probe: Runware's `ping`
  task (→ `pong`, 0 cost) and fal's `GET /v1/account/billing` (2xx ⇒ endpoint up
  + key valid). Generalized via a new `ReachProbe` so a "reachable" check can
  hit a provider-specific free endpoint instead of `GET /v1/models`. Requires
  `RUNWARE_API_KEY` and `FAL_KEY` env vars to be set.

## [0.2.3] — 2026-06-01

Release-quality and engine-correctness pass.

### Fixed

- **Build was red on `main`.** `media.ts` set `CallRecord.baselineUsd` but the
  type never declared it, so `tsc`/`npm run build` failed while `npm test`
  (which doesn't typecheck) stayed green. `baselineUsd?: number` is now part of
  `CallRecord`. The text router leaves it `undefined`; the media router sets it.
- **Failover used shared mutable state across concurrent requests.** The active
  provider index was an instance field used both as the per-request loop cursor
  and the loop's termination check. Two requests sharing one model instance
  could clobber each other's cursor mid-flight (skipped providers, wrong
  termination). Each request now walks providers on a fully local cursor; the
  only shared state is a "where to start next" hint, read once and written once.
- **Cheapest provider was never re-probed under sustained traffic.** The
  snap-back-to-cheapest timer reset on *every* call, so with calls more frequent
  than `resetIntervalMs` it never fired — one blip pinned you on the expensive
  fallback indefinitely (exactly when spend is highest). The timer now measures
  from the last *failover*, so re-probe fires under load too.

### Added

- **`classifyErrorKind(error)` and `RouteAttempt.kind`** (`"transient" | "auth"
  | "billing" | "client"`). 401/403 (auth) and 402/out-of-credit (billing)
  still fail over so the request survives — but they're now tagged distinctly
  from transient 429/5xx, so a misconfigured key silently burning the pricey
  fallback is something you can alert on instead of mistaking for healthy
  routing.
- **Continuous Integration** (`.github/workflows/ci.yml`): `build` +
  `typecheck` + `test` on Node 20 & 22, plus a `pack-smoke` job that installs
  the actual `npm pack` tarball into a clean directory and imports it (ESM and
  CJS) — catching dropped exports and broken `dist` that an in-repo test can't.
- **`prepublishOnly` gate**: `npm publish` now runs build + typecheck + test
  first, so a red tree can't be published.
- **Public-export surface test** (`public-api.test.ts`): pins every runtime
  export by name, so removing one fails loudly and adding one is deliberate.

## [0.2.1] — earlier

- `onCall` correlated `CallRecord` + `formatCallRecord` one-liner for the text
  router, extended to the media router (image/video).

## [0.2.0] — earlier

- Observability: `onCall` / `CallRecord`, `formatCallRecord`.

## [0.1.x] — earlier

- Dual ESM/CJS build. Media (image/video) least-cost routing with the Runware
  and Kunavo adapters; cap-aware failover for the text router.

[0.2.6]: https://github.com/victorzhrn/ai-lcr/releases/tag/v0.2.6
[0.2.5]: https://github.com/victorzhrn/ai-lcr/releases/tag/v0.2.5
[0.2.3]: https://github.com/victorzhrn/ai-lcr/releases/tag/v0.2.3
