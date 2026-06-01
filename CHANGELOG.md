# Changelog

All notable changes to `ai-lcr` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

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

[0.2.3]: https://github.com/victorzhrn/ai-lcr/releases/tag/v0.2.3
