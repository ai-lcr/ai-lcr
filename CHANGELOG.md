# Changelog

All notable changes to `ai-lcr` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.1.0] — 2026-05-31

First public release.

### Added

- **Text Least Cost Routing** — `createLCR({ models })` returns a resolver that
  maps a logical model name to a routed `LanguageModelV3`, usable anywhere in the
  Vercel AI SDK (`generateText`, `streamText`, `generateObject`, tools, agents).
- **Own failover engine** — cheapest-first routing with streaming-safe fallback;
  reroutes to the next healthy provider on a retryable error, even mid-stream.
  Adapted from [`ai-fallback`](https://github.com/remorses/ai-fallback) and
  reimplemented in-house so the router owns its engine. Does **not** fail over on
  a non-retryable 400.
- **Real per-call cost accounting** — `onCost(event)` fires after each successful
  call with the serving `provider`, token counts, and computed `costUsd`.
- **Cap-aware failover** — providers that error or hit caps drop out of rotation
  and routing snaps back to the cheapest one after an idle window
  (`resetIntervalMs`, default 60s).
- **Auto cheapest-first ordering** — `autoSort: true` sorts each model's
  providers by their declared per-1M-token `cost` before routing.
- **Native vendor providers as first-class entries** — a vendor's own API
  (`@ai-sdk/deepseek`, `@ai-sdk/anthropic`, `@ai-sdk/google`, …) and an
  OpenAI-compatible aggregator sit side by side in one model's provider list.
- **Image & video Least Cost Routing** — `createMediaLCR` plus price ranking
  helpers (`comparePrices`, `rankRoutes`, `cheapestRoute`, `normalizedCents`),
  with bundled `MEDIA_PRICING` and reference normalization for cross-provider
  comparison.
- **Media adapters** — `createRunwareMediaAdapter` and `createKunavoMediaAdapter`.
- **Provider probe** — `scripts/check-provider.sh` runs a capability + cost check
  (tool calls, `max_tokens`, token-inflation vs a trusted baseline, optional
  prompt-caching test) to vet a provider before routing to it in production.

[Unreleased]: https://github.com/victorzhrn/ai-lcr/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/victorzhrn/ai-lcr/releases/tag/v0.1.0
