# Changelog

All notable changes to `ai-lcr` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.6.2] — 2026-06-11

> Merge after #23 (0.6.1, bundled price table). This entry assumes that landed first.

Circuit breaker for persistently-failing providers. Until now the only recovery
lever was `resetIntervalMs`, which snaps routing back to the cheapest provider on
a timer — so a provider that's actually down keeps eating one failed attempt
every window. The breaker remembers the failure and stops sending it traffic.

### Added

- **`createLCR({ cooldown })`.** A provider that fails `maxFailures` times within
  `windowMs` is *skipped* for `cooldownMs` instead of being re-probed every
  request; a single success clears its count. `true` enables defaults (3 / 60s →
  60s); pass `{ maxFailures, windowMs, cooldownMs }` to tune. New exported type
  `CooldownOptions`.
- The breaker only **reorders** each request's attempt list (cooling providers go
  last), so when every provider is cooling a request still tries them all rather
  than failing outright — it can never turn a recoverable request into a hard
  failure.

### Changed

- The routing engine now snapshots a per-request **attempt order** once (cheapest
  ring with cooling providers moved to the back) and threads it through streaming
  failover, replacing the previous modular index walk. Behavior is identical when
  `cooldown` is unset.

### Compatibility

- Fully backward compatible. `cooldown` is **off by default** — with it unset no
  provider is ever skipped and routing behaves exactly as before.

## [0.6.0] — 2026-06-10

Media billing contract v2: **rank by the reference, bill by actual usage.**
The 0.5 media router used one number for both jobs — the price normalized to a
reference output (1080p image / 5-second clip) ranked routes *and* estimated
costs, multiplied by an untyped `units` count. That mispriced off-reference
outputs (an 8s clip billed as 5s) and made the baseline duration-blind, and the
bare `units` invited a seconds-as-count 8× overcharge. 0.6 separates the two.

### Added

- **Typed usage (`MediaUsage`).** Adapter results (`MediaGenerateResult`,
  `MediaStatusResult`) carry `usage: { seconds?, outputs?, megapixels? }` —
  explicitly named dimensions that cannot be confused. The bundled adapters
  report it (Kunavo video now safely reports the real `duration_seconds`).
  The legacy bare `units` field is still honored as an output count.
- **Settle-time billing.** Cost estimates price the route's actual unit on
  actual usage: per-second SKUs bill `usage.seconds` → `input.duration`
  (numbers or `"8s"`-style strings) → the reference (last resort); per-image /
  per-call SKUs bill output count; per-megapixel SKUs bill measured megapixels.
  New public helpers: `billableUnits`, `priceCents`, `durationFromInput`.
- **Usage-aware savings baseline.** `baselineUsd` is now priced at settle time
  against the same usage as the cost — an 8-second clip is baselined at 8
  seconds of the official rate, not the 5-second reference. Off-reference calls
  can no longer produce negative or understated savings.
- **`CallRecord` provenance fields** (all optional, backward compatible):
  `modality` ("image" | "video"), `usage`, `baselineKind`
  ("official" | "priciest-route" | "last-leg" — the text router now stamps
  "last-leg"), `officialUsd` (the official price for this call's usage), and
  `estCostUsd` (the price-table prediction; `costUsd − estCostUsd` on
  provider-reported rows is price-table drift).
- **Cost-outlier guard.** A provider-reported cost ≥25× off the table
  prediction (the classic USD-vs-cents slip is exactly 100×) raises `onError`
  with both numbers; the reported bill still stands.
- `MediaRunResult` and the terminal `MediaPollResult` expose the `usage` that
  backed the bill.

### Changed

- `MediaJobHandle` now carries the serving route's `pricing` and the resolved
  savings `baseline` so settle-time billing works across processes. Handles
  serialized by 0.5.x still poll fine: they settle with the legacy
  reference-price estimate and the submit-time baseline.

## [0.5.6] — 2026-06-07

All additions are optional and backward compatible. The sync `createMediaLCR`
router (the callable `generate(modelId, input)`) and every adapter's `run()` are
**unchanged** in signature and behavior.

### Added

- **Async media routing — `submit` / `poll` for long-running (video) jobs.**
  The blocking media path holds a serverless invocation open until the file is
  ready: fine for an image (seconds), impossible for a minutes-long video job.
  `createMediaLCR(...)` now returns a callable with two methods attached:

  ```ts
  const lcr = createMediaLCR({ registry, adapters })

  // process A (request handler): route + enqueue, return immediately
  const handle = await lcr.submit('google/veo-3-lite', { prompt, aspect_ratio: '16:9' })
  await db.save(JSON.stringify(handle))      // the handle is plain JSON

  // process B (cron / queue worker): poll until terminal
  const r = await lcr.poll(handle)
  if (r.done) use(r.outputs, r.costCents)    // else keep polling r.handle
  ```

  - **Routing happens at `submit`** — it picks the cheapest provider whose
    adapter supports async, and the returned `MediaJobHandle` carries the
    not-yet-tried fallback routes (cheapest-first), the original input, and the
    telemetry accumulator. The handle is **serializable on purpose**: submit and
    poll typically run in different processes, so it must survive a round-trip
    through a database or queue.
  - **Failover happens at `poll`, not just submit.** When a provider's job fails
    mid-poll (a `status:"error"`, a completed-but-empty job, or a thrown
    retryable transport error such as the video-timeout `504` remap), `poll`
    **re-submits to the next fallback provider** and hands back a fresh handle to
    keep polling — it does not give up. A thrown error uses the standard
    `isRetryableError` gate (so a caller-bug `400` on the poll endpoint doesn't
    loop); a provider's own job failure always earns a fallback attempt.
  - **Telemetry lands once, at the terminal poll.** The single correlated
    `CallRecord` (via `onCall`) and the `onCost` event fire when the job settles
    (`poll` → done/exhausted), carrying the full failover chain across both
    processes — not at `submit`. The one exception: a `submit` that *no* provider
    accepts settles a failed record there (there is no poll to do it).

- **`MediaAdapter.submit` / `MediaAdapter.checkStatus` (both optional).** The
  adapter contract gains the async pair, shaped to match ai-art's
  `ProviderAdapter` so a consumer can delegate its own async runtime to ai-lcr
  with no glue:

  ```ts
  submit({ externalId, input, metadata? }) -> { requestId }
  checkStatus({ externalId, requestId }) ->
    { status: 'queued' | 'running' | 'done' | 'error', outputs?, costCents?, units?, error? }
  ```

  A sync-only adapter (image-only) omits both; the async router simply skips a
  route whose adapter can't serve async.

- **All three bundled adapters now implement the async path:**
  - **Kunavo** — `submit` → `POST /v1/videos`, `checkStatus` → `GET /v1/videos/{id}`
    (video only; submitting an image id throws, since Kunavo images are sync).
    `run()`'s blocking async path now reuses these internally.
  - **fal** — `submit` → `POST queue.fal.run/{model}`, `checkStatus` reconstructs
    the queue base from the id (the `fal-ai/flux/schnell` → `fal-ai/flux`
    sub-path quirk) for cross-process polling.
  - **Runware** — gains an **async video** path (`videoInference` with
    `deliveryMethod:"async"`, polled via `getResponse`). Image stays on the
    synchronous `run()`.

- **New exported types:** `MediaSubmitRequest`, `MediaSubmitResult`,
  `MediaStatusRequest`, `MediaStatusResult`, `MediaJobStatus`,
  `MediaSubmitOptions`, `MediaJobHandle`, `MediaPollResult`, and `MediaLCR` (the
  callable-with-methods return type of `createMediaLCR`).

- **Live probe `scripts/check-media-async.mjs`** — exercises the real
  `submit`/`poll` API across **every async provider** (kunavo · fal · runware)
  whose key is present: submit → JSON round-trip the handle → poll to done →
  assert the output URL fetches and cost is reported, per provider.
  `PROBE_FAILOVER=1` adds a live submit-time failover case.

### Migration

Nothing breaks. To adopt async, give your video adapters `submit`/`checkStatus`
(the bundled fal/kunavo/runware adapters already have them) and call
`lcr.submit(...)` / `lcr.poll(...)` instead of the blocking `lcr(...)`. The
blocking call still works for image and for video where holding the request open
is acceptable.

## [0.5.5] — 2026-06-06

Kunavo media (image + video) verified live and properly wired. The Kunavo
adapter previously had a working image path but an unverified, broken video
path; this release fixes the video path against the real API and adds the
reference-image edit endpoint. Backward compatible — `videoMode` defaults to
the new async path, and existing image routes are unchanged.

### Fixed

- **Kunavo video hit the wrong endpoints.** `createKunavoMediaAdapter`'s
  `runVideo` POSTed to the sync `POST /v1/video/generations` but then polled a
  non-existent `GET /v1/video/generations/{id}` — unreachable dead code that
  only ever worked through an inline early-return. Replaced with Kunavo's real,
  live-verified endpoints (see Added). Long video SKUs no longer risk a hung,
  timeout-less `fetch`: both video paths are now bounded.

### Added

- **Kunavo async video (default).** Verified live 2026-06-06: `veo-3-lite`
  renders a real 720p mp4 via `POST /v1/videos` → poll `GET /v1/videos/{id}`
  (~80s). This is the adapter's default and mirrors the fal submit→poll shape.
  A poll timeout surfaces as a retryable `504` so the media router fails over.
- **Kunavo sync video fallback.** New `KunavoMediaConfig.videoMode: "sync"`
  uses the blocking `POST /v1/video/generations` (~108s for veo-3-lite),
  hard-capped by `syncVideoTimeoutMs` (default 10m, remapped to a retryable
  `504` on timeout). `pollIntervalMs` / `pollTimeoutMs` now actually drive the
  async path.
- **Kunavo image edit (reference image).** `*-edit` slugs
  (`nano-banana-edit`, `gpt-image-2-edit`) route to `POST /v1/images/edits`
  with the caller's `image` / `image_urls[]` — the character-reference path.
- **`scripts/check-kunavo-media.sh`** — a `bash` + `curl` + `jq` live media
  integrity probe (image gen, edit, async + sync video) mirroring the text
  `check-provider.sh`.
- **Test coverage for the Kunavo media adapter**, which previously shipped with
  none (fal and Runware had tests; Kunavo did not).

## [0.5.4] — 2026-06-03

### Changed

- **A provider 400 now fails over instead of being passed through.** Previously
  any client error (400/422/…) was treated as the caller's fault and thrown
  immediately, killing the request even when another provider would have served
  it. But across OpenAI-compatible aggregators a 400 is most often
  *provider-specific* — an unsupported parameter, a model the provider hasn't
  listed, a stricter JSON schema — not a universally-broken request. The default
  failover gate (`shouldFailover`) now advances to the next provider on **any**
  failure except a deliberate caller cancellation (`AbortSignal`), which is the
  one thing we must never re-issue elsewhere. When every provider rejects the
  request it still throws — now surfacing the **first** (original) error rather
  than the last fallback's, so a genuine caller bug stays debuggable. Failed
  attempts keep their precise `ErrorKind` (`"client"` for a 400) in the
  `CallRecord`, so a real bug is still visible.

  To restore the old "client errors fail fast" behavior, pass
  `shouldRetry: isRetryableError` to `createLCR`.

### Added

- **`createLCR({ shouldRetry })`.** The failover predicate is now configurable
  from the top-level API (it previously existed only on the internal engine), so
  callers can tune or fully override the policy above.
- **Exported error predicates** `isRetryableError`, `isNetworkError`,
  `isAbortError`, and `shouldFailover` — building blocks for a custom
  `shouldRetry`.

## [0.5.3] — 2026-06-03

All additions are optional and backward compatible.

### Added

- **`defaultCacheReadRatio` — chain-wide fallback price for prompt-cache reads.**
  ai-lcr already detects cache hits from the provider's reported usage and emits
  `cachedInputTokens` for any provider that reports them (Anthropic, Gemini's
  implicit cache, DeepSeek, …). But the *saving* (`cachedSavingUsd`) and the
  cache-discounted `costUsd` were only computed when a leg set an explicit
  `cost.cacheRead` — so a route that forgot it (e.g. a Gemini OpenRouter leg)
  silently reported `$0` saved and billed cached tokens at the full input rate.

  `createLCR({ defaultCacheReadRatio: 0.1 })` now supplies a fallback cache-read
  price as a fraction of each leg's `input`, applied **only** to legs that omit
  an explicit `cacheRead`. Most providers' cache-read price is ~0.1× input, so
  `0.1` makes cache cost + savings "just work" across every model without each
  route hardcoding a rate. Legs with their own `cacheRead` are untouched (set it
  for outliers like OpenAI's ~0.5×). Unset = previous behavior. Must be in [0, 1].

## [0.5.0] — 2026-06-02

All additions are optional and backward compatible.

### Added

- **Official-price savings baseline for media.** A media model's savings baseline
  is now the model-maker's first-party list price — what a user pays going
  *direct*, bypassing the cheaper providers we route to — instead of the priciest
  provider we happen to route between. For the common case of a model served by a
  single aggregator (Runware, fal, …), the old baseline equalled the actual cost,
  so savings showed as `$0`; the official price surfaces the real saving.
  - `MediaModelDef.official?: MediaPricing` — an inline first-party price on a
    model def. When set, it wins.
  - `MediaLCRConfig.officialPrices?: Record<string, MediaPricing>` — a modelId →
    price map so a downstream registry gets correct baselines without inlining
    prices. Defaults to the bundled **`OFFICIAL_PRICES`** (now exported), lifted
    from the cross-provider price table by `scripts/gen-media-official.mjs`.
  - When no official price is known (e.g. open-weight models served only by
    aggregators), the baseline falls back to the priciest configured route — or
    none if there's a single route — exactly as before.

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
