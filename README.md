# AI-LCR — AI Least Cost Routing

<p align="center">
  <b>English</b> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <b>Automatic least-cost routing for LLM calls. One line to cut your AI bill.</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ai-lcr"><img src="https://img.shields.io/npm/v/ai-lcr.svg" alt="npm version"/></a>
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"/>
  <a href="https://ai-sdk.dev"><img src="https://img.shields.io/badge/built%20for-Vercel%20AI%20SDK-black?logo=vercel&logoColor=white" alt="built for Vercel AI SDK"/></a>
</p>

<p align="center">
  <img src="assets/ai-lcr-hero.svg" alt="ai-lcr keeps a cheapest-first list of providers per model — serves the cheapest (saving ~40%), fails over to the next on error, and snaps back to the cheapest after ~60s" width="720">
</p>

The same model costs different amounts on different providers — and no single provider is cheapest for everything. `ai-lcr` keeps a cheapest-first list per model, routes to the cheapest healthy one (⭐ below), and falls through on failure — the way phone carriers have done [Least Cost Routing](https://en.wikipedia.org/wiki/Least-cost_routing) for decades.

## Install

```bash
npm install ai-lcr
```

`ai` (the Vercel AI SDK) is a peer dependency.

## Quick start

```ts
import { createLCR } from "ai-lcr";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

const kunavo = createOpenAICompatible({
  name: "kunavo",
  baseURL: "https://api.kunavo.com/v1",
  apiKey: process.env.KUNAVO_API_KEY,
});
const openrouter = createOpenAICompatible({
  name: "openrouter",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

const lcr = createLCR({
  autoSort: true, // sort each model's providers cheapest-first by `cost`
  models: {
    // One logical model, served cheapest-first across providers.
    "gemini-3-flash": [
      { model: kunavo("gemini-3-flash"), label: "kunavo", cost: { input: 0.40, output: 2.40 } },
      { model: openrouter("google/gemini-3-flash-preview"), label: "openrouter", cost: { input: 0.5, output: 3.0 } },
    ],
  },
  // See exactly what each call cost, on whichever provider served it.
  onCost: ({ provider, costUsd }) => console.log(`${provider}: $${costUsd.toFixed(6)}`),
});

const { text } = await generateText({
  model: lcr("gemini-3-flash"),
  prompt: "Explain Least Cost Routing in one sentence.",
});
```

`cost` and `label` are optional — pass bare models (`kunavo("gemini-3-flash")`) if you don't need cost accounting or `autoSort`. `lcr("gemini-3-flash")` returns a standard AI SDK model, so it works with `generateText`, `streamText`, `generateObject`, tools, and agents.

## Route to a model vendor's own API (native providers)

A "provider" doesn't have to be an aggregator. A model vendor's **own official API** is just another entry in the list — often the cheapest, since there's no aggregator markup, and the least likely to silently break native features (prompt caching, tool calls). Any AI SDK provider package returns a standard model, so a vendor's native API and an OpenAI-compatible aggregator sit side by side in the same list:

```ts
import { createLCR } from "ai-lcr";
import { createDeepSeek } from "@ai-sdk/deepseek";          // DeepSeek's own API
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const deepseek = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY });
const openrouter = createOpenAICompatible({
  name: "openrouter",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

const lcr = createLCR({
  autoSort: true,
  models: {
    "deepseek-v4": [
      // Official API first — no markup, full native features (caching, off-peak discounts).
      { model: deepseek("deepseek-chat"), label: "deepseek", cost: { input: 0.43, output: 0.87 } },
      // Aggregator as a fallback for uptime + breadth.
      { model: openrouter("deepseek/deepseek-v4"), label: "openrouter", cost: { input: 0.43, output: 0.87 } },
    ],
  },
});
```

The same pattern works for any vendor's native SDK provider — `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`, `@ai-sdk/xai`, and so on. They all return `LanguageModelV3`, so you can mix a native vendor API with aggregators in one model's list. Native APIs are narrow (only that vendor's models) but featureful; aggregators are broad. **Official-first + aggregator-fallback** is the natural LCR shape.

## Cheapest route for open-weights models (DeepInfra)

For open-weights models — DeepSeek, Kimi, MiniMax, GLM, Qwen — a dedicated inference host is usually the cheapest route, well under aggregator pricing. [DeepInfra](https://deepinfra.com) is OpenAI-compatible, so it slots in as just another entry. **One gotcha:** its OpenAI endpoint lives at `/v1/openai` (the `/v1/` precedes `openai`), not the usual `/v1`:

```ts
import { createLCR } from "ai-lcr";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const deepinfra = createOpenAICompatible({
  name: "deepinfra",
  baseURL: "https://api.deepinfra.com/v1/openai", // note: /v1/openai, not /v1
  apiKey: process.env.DEEPINFRA_API_KEY,
});
const openrouter = createOpenAICompatible({
  name: "openrouter",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

const lcr = createLCR({
  autoSort: true,
  models: {
    // DeepInfra is cheapest; OpenRouter is the breadth/uptime fallback.
    // DeepInfra uses HuggingFace-style ids (org/Name).
    "deepseek-v4-flash": [
      { model: deepinfra("deepseek-ai/DeepSeek-V4-Flash"), label: "deepinfra", cost: { input: 0.10, output: 0.20 } },
      { model: openrouter("deepseek/deepseek-v4-flash"), label: "openrouter", cost: { input: 0.27, output: 1.10 } },
    ],
    "minimax-m2.5": [
      { model: deepinfra("MiniMaxAI/MiniMax-M2.5"), label: "deepinfra", cost: { input: 0.15, output: 1.15 } },
    ],
    "kimi-k2.5": [
      { model: deepinfra("moonshotai/Kimi-K2.5"), label: "deepinfra", cost: { input: 0.45, output: 2.25 } },
    ],
  },
});
```

DeepInfra carries open weights only — no first-party Claude / GPT / Gemini. For those closed models, route through OpenRouter or a discount gateway instead.

## How it routes

1. **Cheapest first.** Providers are tried in order — list them cheapest-first, or set `autoSort: true` to order them by `cost` automatically.
2. **Fall through on failure.** On any provider failure — rate limit, 5xx, timeout, a **billing cap** (402 / out-of-credit / quota), *and* a client error like a **400** — it advances to the next provider, streaming-safe. A 400 fails over on purpose: across OpenAI-compatible aggregators a 400 is usually "*this* provider won't take this request" (an unsupported param, a model it hasn't listed, a stricter schema), not a universally-broken request — so the next provider may well serve it. If every provider rejects the request it still fails, surfacing the **original** error so a genuine caller bug stays debuggable. The one failure that never fails over is a deliberate caller cancellation (`AbortSignal`). Pass `shouldRetry: isRetryableError` to `createLCR` to restore the stricter "client errors fail fast" behavior.
3. **Recover.** After an idle window (`resetIntervalMs`, default 60s) it snaps back to the cheapest provider.

## See what happened (`onCall`)

`onError`/`onCost` fire separately and uncorrelated, so a failover is hard to read after the fact. `onCall` gives you **one record per request** — the full chain, the winner, the reason for each failed hop, latency, and cost — and `formatCallRecord` turns it into a one-liner you can scan:

```ts
import { createLCR, formatCallRecord } from "ai-lcr";

const lcr = createLCR({
  models: { /* … */ },
  onCall: (record) => console.log(formatCallRecord(record)),
});
```

```text
✓ text  tokenmart                      412ms  $0.0003
⚠ text  tokenmart→openrouter           910ms  $0.0004  ⤷ tokenmart 502
✗ text  deepseek→tokenmart→openrouter  1240ms FAILED   ⤷ deepseek 401, tokenmart 502, openrouter 429
```

`✓` served on the first try · `⚠` failed over but recovered · `✗` every provider failed. The `⤷` shows which provider died and why.

**Persist it anywhere — zero lock-in.** `record` is a plain `CallRecord` object. Log the JSON and point any log drain at it (Axiom, Datadog, your own DB); ai-lcr never decides where it goes:

```ts
onCall: (record) => console.log(JSON.stringify(record)),
```

```ts
interface CallRecord {
  id: string;                // correlation id, one per request
  model: string;             // logical model name
  attempts: { provider: string; ok: boolean; latencyMs: number; errorClass?: string }[];
  winner?: string;           // provider that served; undefined if all failed
  ok: boolean;
  failedOver: boolean;       // more than one provider was tried
  latencyMs: number;
  ttftMs?: number;           // streaming only: time to first token (winner's first content delta) — industry-standard responsiveness metric
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number; // prompt-cache hits the winner read (when reported)
  costUsd: number;            // winner cost, cache-discount applied (see `cacheRead`)
  baselineUsd?: number;       // same usage on the priciest priced leg → savings = baselineUsd − costUsd
  requestId?: string;         // your correlation id (see below) — roll multi-step tool loops into one request
  usageMissing?: boolean;     // winner served but reported 0/0 tokens → costUsd is 0 but unknown, not free
}
```

**Savings, not just spend.** Whenever at least one provider in a chain carries a `cost`, `baselineUsd` is what the same call would have cost on the most expensive priced leg (typically your safety-net fallback). `baselineUsd − costUsd` is the money routing saved on that call — the number a cost dashboard exists to show.

**Responsiveness, not just total time.** On streaming calls (`streamText`, `streamObject`, streaming agents), `ttftMs` is the **time to first token** — measured from the winning provider's attempt start to its first content delta. It's the metric most LLM dashboards lead with, because it's what a user feels as "how fast did it start replying". Total `latencyMs` covers the whole stream including any failover; `ttftMs` isolates the serving model's responsiveness. It's `undefined` for `generateText`/`generateObject` (no streaming → no "first" token) and for calls that failed before any content. Output throughput (tokens/sec) is then `outputTokens / ((latencyMs − ttftMs) / 1000)`.

**Cache-aware cost.** Add `cacheRead` (USD per 1M cached input tokens) to a provider's `cost` and ai-lcr bills prompt-cache hits at that rate when the call reports `usage.inputTokens.cacheRead`. Omit it and cached tokens fall back to the full `input` rate (unchanged from before). For cache-heavy traffic (e.g. Anthropic, where a cache read is ~0.1×) this keeps `costUsd` honest — and `cachedInputTokens` lets a dashboard audit it:

```ts
{ model: claude, label: "anthropic", cost: { input: 3, output: 15, cacheRead: 0.3 } }
```

**Group a multi-step request.** An agentic turn does one `onCall` per `doStream`/`doGenerate` step, so a 10-step tool loop emits 10 records. Pass a stable id through `providerOptions.lcr.requestId` and every step's record carries it — group by `requestId` for per-request cost:

```ts
await streamText({ model: lcr("chat"), messages, providerOptions: { lcr: { requestId } } });
```

### Ship records to a collector (`createHttpSink`)

`createHttpSink` builds an `onCall` handler that POSTs each `CallRecord` as JSON to an endpoint (e.g. a self-hosted dashboard's `/api/ingest`, or any drain that takes the shape). Fire-and-forget — a failed POST never breaks your app. On serverless, pass a `waitUntil`-style `dispatch` (Next.js: `after`) so the request isn't cut off:

```ts
import { createLCR, createHttpSink } from "ai-lcr";
import { after } from "next/server";

const lcr = createLCR({
  models: { /* … */ },
  onCall: createHttpSink({
    url: process.env.LCR_INGEST_URL + "/api/ingest",
    headers: { authorization: `Bearer ${process.env.LCR_INGEST_KEY}` },
    project: process.env.LCR_PROJECT, // optional tenant tag merged into each payload
    dispatch: after,
  }),
});
```

## Supported providers

Any OpenAI-compatible endpoint works — and so does any AI SDK provider package, including a model vendor's own official API.

- **Model vendors' own APIs (native):** route straight to [DeepSeek](https://platform.deepseek.com), [OpenAI](https://openai.com), [Anthropic](https://anthropic.com), [Google](https://ai.google.dev), [xAI](https://x.ai), etc. via their AI SDK provider packages — no markup, full native features. See [Route to a model vendor's own API](#route-to-a-model-vendors-own-api-native-providers).
- **Text aggregators:** [OpenRouter](https://openrouter.ai) (widest coverage, list pricing) · [Kunavo](https://kunavo.com/?ref=victorimf) (**20% off** every model) · [TokenMart](https://thetokenmart.ai) (15–65% off, varies by model)
- **Image / video:** [Kunavo](https://kunavo.com/?ref=victorimf) (**20% off**) · [TokenMart](https://thetokenmart.ai) · [fal.ai](https://fal.ai) · [Runware](https://runware.ai) — routing via `createMediaLCR`. Image: Kunavo (generations + `*-edit` reference-image endpoints) + Runware + fal. Video: fal (async queue) and Kunavo (async `POST /v1/videos` + poll, sync fallback) — both verified live

## Text model pricing

USD per 1M tokens, input / output. Official rates as of 2026-05 — verify current rates with each provider. OpenRouter passes list price through; Kunavo is a flat 20% off the official rate. TokenMart prices vary by model (15–65% off list) — verify current rates at [thetokenmart.ai](https://thetokenmart.ai).

| Model | Official (in / out) | OpenRouter | [Kunavo](https://kunavo.com/?ref=victorimf) | [TokenMart](https://thetokenmart.ai) | Cheapest |
|---|---|---|---|---|---|
| Gemini 3 Flash | $0.50 / $3.00 | no discount | −20% | — | ⭐ Kunavo |
| Gemini 3 Pro / 3.1 Pro | $2.00 / $12.00 | no discount | −20% | −20% → **$2.40 / $9.60** | ⭐ Kunavo |
| Gemini 2.5 Pro | $1.25 / $10.00 | no discount | −20% | — | ⭐ Kunavo |
| Gemini 2.5 Flash | $0.30 / $2.50 | no discount | −20% | — | ⭐ Kunavo |
| Claude Opus 4.7 | $15.00 / $75.00 | no discount | −20% | **$4.25 / $21.25** | ⭐ TokenMart |
| Claude Sonnet 4.6 | $3.00 / $15.00 | no discount | −20% | −15% → **$2.55 / $12.75** | ⭐ Kunavo |
| Claude Haiku 4.5 | $1.00 / $5.00 | no discount | −20% | — | ⭐ Kunavo |
| DeepSeek V4 | $0.43 / $0.87 | no discount | not carried | — | ⭐ DeepSeek (official) |

Kunavo carries Anthropic + Google. DeepSeek / OpenAI / Grok / Mistral route to their **own official APIs** (cheapest, full native features) with OpenRouter as a broad fallback — one config can mix native vendors and aggregators.

> **Note:** List price ≠ effective price — always verify with the [probe](#vetting-a-provider-capability--cost-probe). As of 2026-05-28, Kunavo token counts are clean for both Gemini (~1.1–1.4×) and Claude (~1.0×). Remaining caveats: `max_tokens` is still ignored on both models, and hidden-prompt injection appears intermittently for Claude — re-probe before routing in production. Effective cost is why `ai-lcr` should rank by measured behavior, not the sticker price.

> **Note:** TokenMart token counts are also verified clean (same backend as Inference.ai, all checks passed 2026-05-27: tool calls, `max_tokens`, no injection, token ~1.0×, prompt caching) — a reliable second provider for Claude at −15% list. Re-probe before routing in production.

## Image model pricing

USD per image, as of 2026-05 (provider list / retail; verify current rates). Kunavo is 20% off official. fal and Runware are compute providers — `ai-lcr` picks the cheapest per model (⭐).

| Model | fal.ai | Runware | [Kunavo](https://kunavo.com/?ref=victorimf) | [TokenMart](https://thetokenmart.ai) | Cheapest |
|---|---|---|---|---|---|
| Nano Banana 2 | $0.080 | $0.069 | $0.054 | **$0.050** | ⭐ TokenMart |
| Nano Banana Pro | $0.080 | — | $0.107 | — | ⭐ fal |
| GPT-Image-2 | $0.210 | $0.094 | $0.102 | — | ⭐ Runware |
| Imagen 4 Ultra | $0.060 | $0.060 | — | — | ⭐ fal / Runware |
| Ideogram V3 | $0.060 | $0.060 | — | — | ⭐ fal / Runware |
| Seedream 4 | $0.030 | — | — | — | ⭐ fal |
| Flux 1.1 Pro | $0.040 | $0.040 | — | — | ⭐ fal / Runware |
| Flux Dev | $0.025 | $0.025 | — | — | ⭐ fal / Runware |
| Flux Schnell | $0.0030 | $0.0013 | — | — | ⭐ Runware |
| Qwen-Image | — | $0.0038 | — | — | ⭐ Runware |
| FLUX.2 Klein 4B | — | $0.0006 | — | — | ⭐ Runware |

## Video model pricing

USD per second, as of 2026-05 — verify current rates. Video billing differs by provider, so a clean cross-provider table isn't apples-to-apples: fal.ai and Runware charge per second, while Kunavo's Veo is per clip (Fast ~$0.28 / Lite ~$0.168 / Quality ~$1.34). Below are fal.ai's per-second rates (the video workhorse in testing); a normalized fal / Runware / Kunavo comparison is a TODO.

> **Kunavo video — verified live 2026-06-06.** `veo-3-lite` renders a real 720p mp4 via Kunavo's async API (`POST /v1/videos` → poll `GET /v1/videos/{id}`, ~80s) and its sync fallback (`POST /v1/video/generations`, ~108s). The `createMediaLCR` Kunavo adapter defaults to async (non-blocking, fal-isomorphic). Two caveats: per-clip prices are hand-entered (`GET /v1/models` returns no pricing), and the async queue can occasionally sit much longer than 80s — the adapter's `pollTimeoutMs` bounds it so the router can fail over.

| Model | fal.ai ($/s) |
|---|---|
| Seedance Lite | $0.036 |
| Hailuo 02 Standard | $0.045 |
| LTX-2 | $0.060 |
| Kling 2.6 Pro | $0.070 |
| WAN 2.2 | $0.080 |
| Veo 3.1 Lite | $0.080 |
| Kling V3 Pro | $0.112 |
| Seedance Pro | $0.124 |
| Veo 3.1 (audio-on) | $0.400 |

## Image & video routing (`createMediaLCR`)

Image and video are a separate, self-contained side of `ai-lcr` (file outputs, mixed pricing units, async jobs) — see [`src/media.ts`](src/media.ts). You give it a registry (each model's provider routes + per-unit price) and a set of adapters; it routes cheapest-first, fails over, and reports real/normalized cost through the same `onCall` sink as text.

```ts
import { createMediaLCR, createKunavoMediaAdapter, createFalMediaAdapter } from 'ai-lcr'

const lcr = createMediaLCR({
  registry: {
    'google/veo-3-lite': {
      id: 'google/veo-3-lite', modality: 'video',
      routes: [
        { provider: 'kunavo', externalId: 'veo-3-lite',        pricing: { unit: 'call',   cents: 16 } },
        { provider: 'fal',    externalId: 'fal-ai/veo3.1/lite', pricing: { unit: 'second', cents: 8  } },
      ],
    },
  },
  adapters: {
    kunavo: createKunavoMediaAdapter({ apiKey: process.env.KUNAVO_API_KEY! }),
    fal:    createFalMediaAdapter({ apiKey: process.env.FAL_KEY! }),
  },
  onCall: rec => console.log(rec.winner, rec.costUsd, rec.failedOver),
})

// Sync: resolves when the file is ready (fine for images).
const { outputs, provider, costCents } = await lcr('google/veo-3-lite', { prompt: 'a wave' })
```

### Async (`submit` / `poll`) — for long-running video

A minutes-long video job can't hold a serverless request open. `submit` routes + enqueues and returns a **plain-JSON handle**; `poll` checks it. The two run in different processes — the handle survives a database/queue hop.

```ts
// process A — request handler: route + enqueue, return immediately
const handle = await lcr.submit('google/veo-3-lite', { prompt: 'a wave', aspect_ratio: '16:9' })
await db.jobs.put(jobId, JSON.stringify(handle))

// process B — cron / queue worker: poll until terminal
let handle = JSON.parse(await db.jobs.get(jobId))
const r = await lcr.poll(handle)
if (r.done) {
  save(r.outputs, r.costCents)                 // settled — telemetry already emitted
} else {
  await db.jobs.put(jobId, JSON.stringify(r.handle))  // keep polling r.handle
}
```

Design choices worth knowing:

- **Routing is at `submit`** (cheapest async-capable provider); the handle carries the not-yet-tried fallbacks, so…
- **Failover is at `poll`** — a provider whose job fails mid-poll is re-submitted to the next provider automatically (a fresh `r.handle` to keep polling), rather than the request just dying.
- **Telemetry lands once, at the terminal poll** — one `onCall` `CallRecord` with the full failover chain, threaded across both processes (not at `submit`).
- An adapter advertises async by implementing `submit` + `checkStatus`; image-only adapters omit them and are skipped by the async router. The bundled Kunavo, fal, and Runware adapters all implement the async path (Kunavo/Runware async is video-only; fal covers both).

## Vetting a provider (capability + cost probe)

A discount is worthless if the provider quietly breaks the wire protocol. `ai-lcr` ships a zero-dependency check (`scripts/check-provider.sh`, just `bash` + `curl` + `python3`) that vets the things that actually cost you money or corrupt output, **per model**:

> **Media providers** have their own probes: `scripts/check-kunavo-media.sh` (`bash` + `curl` + `jq`) live-tests Kunavo's image generation, `*-edit` reference endpoint, and async + sync video; `scripts/check-media-async.mjs` exercises `ai-lcr`'s own `submit`/`poll` API across **every async provider** (kunavo · fal · runware) whose key is present — submit → JSON round-trip the handle → poll to done → assert the URL fetches and cost is reported, per provider (`PROBE_FAILOVER=1` adds a live submit-time failover case). Run them before trusting a media route in production.

- **tool calling** — single call and a multi-step round-trip with `content: null` (the shape every agent loop sends)
- **`max_tokens` honored** — caps must bound output
- **hidden-prompt injection** — sends a neutral message; flags the provider if the model starts reacting to a system prompt it was never given
- **token over-counting** — compares reported `prompt_tokens` against a trusted baseline provider; >1.5× means the bill is inflated and the "discount" may be a loss
- **prompt caching** — whether `cache_control` actually produces a `cache_read` on repeats

```bash
# point it at the provider you're vetting; models are generic numbered slots
# (works for Gemini, Claude, GPT, Llama, …). Add a per-model REF_n on a trusted
# baseline (e.g. OpenRouter) to enable the token-inflation check. CACHE_MODEL
# (optional) runs the Anthropic-native /v1/messages prompt-caching test.
API_KEY=$KUNAVO_API_KEY BASE=https://api.kunavo.com \
  MODEL_1=gemini-3-flash    REF_1=google/gemini-3-flash-preview \
  MODEL_2=claude-sonnet-4-6 REF_2=anthropic/claude-sonnet-4.6 \
  CACHE_MODEL=claude-sonnet-4-6 \
  REF_API_KEY=$OPENROUTER_API_KEY REF_BASE=https://openrouter.ai/api \
  bash scripts/check-provider.sh

# TokenMart (Inference AI) uses bare, un-prefixed model IDs
API_KEY=$INFERENCE_API_KEY BASE=https://model.service-inference.ai \
  MODEL_1=gemini-3-flash-preview      REF_1=google/gemini-3-flash-preview \
  MODEL_2=claude-sonnet-4-6           REF_2=anthropic/claude-sonnet-4.6 \
  CACHE_MODEL=claude-sonnet-4-6 \
  REF_API_KEY=$OPENROUTER_API_KEY REF_BASE=https://openrouter.ai/api \
  bash scripts/check-provider.sh
```

A `FAIL` on injection or token over-counting means that provider is **not** a safe least-cost target for that model — keep it off that model's cheapest-first list until it's fixed, then re-probe.

### Trust matrix (probed 2026-05-27)

Two OpenAI-compatible providers, same probe, same day. Cells cover both families (G = Gemini, C = Claude).

| Check | Kunavo | [TokenMart](https://thetokenmart.ai) |
|---|---|---|
| Tool calls (single + multi-step `content: null`) | G ⚠️ intermittent¹ · C ✅ | ✅ both |
| Token count vs OpenRouter baseline | G ✅ ~1.1–1.4× · C ✅ ~1.0× | ✅ both ~1.0× |
| Hidden-prompt injection | G ✅ none · C ❌ intermittent² | ✅ none |
| `max_tokens` honored | ❌ ignored (both) | ✅ both |
| Prompt caching (`cache_control`) | C ❌ not applied (endpoint also hung mid-probe) | C ✅ `cache_read` > 0 |

¹ Kunavo Gemini returned a clean tool call on one run and **dropped tools entirely** on the next identical request — not a stable pass.
² Kunavo Claude reacted to a phantom "fake system prompt" on one run and stayed clean on another — the injection is intermittent, not removed.

**Verdict:** TokenMart passes every check on both Gemini and Claude with stable, repeatable results — route freely. Kunavo: token counts are now clean for Claude (re-probed 2026-05-28); at −20% list, Kunavo is the cheapest option for Claude. Remaining caveats: `max_tokens` is ignored on both models, hidden-prompt injection appears intermittently for Claude, and Gemini drops tool calls intermittently — re-probe before routing a new model in production.

## Roadmap

- [x] Own failover engine — cheapest-first routing + streaming-safe fallback, no external routing dependency
- [x] Real per-call cost accounting (`onCost`)
- [x] One correlated record per request with the full failover chain (`onCall` + `formatCallRecord`)
- [x] Auto cheapest-first ordering (`autoSort`) from per-provider `cost`
- [x] Offline capability + cost check (`scripts/check-provider.sh`) → per-model trust matrix
- [ ] Bundled price table for zero-config pricing (drop the manual `cost` numbers)
- [ ] Provider-quirk middleware (transparently patch known per-provider request quirks, e.g. Kunavo's ignored `max_tokens`)
- [ ] Feed probe results into routing automatically (auto-exclude a model from a provider that fails its probe)
- [x] Image & video model routing (`createMediaLCR`) — image via Kunavo (incl. `*-edit`) + Runware + fal; **video live via fal and Kunavo** (both verified)
- [ ] Normalized cross-provider video price comparison + verified Runware video adapter

## Affiliate disclosure

`ai-lcr` is provider-neutral and works with any OpenAI-compatible endpoint. The author holds an affiliate arrangement with **[Kunavo](https://kunavo.com/?ref=victorimf)**, which — at 20% off official rates — is often (not always) the cheapest option, as the tables above show. Signing up through that link may earn the author a share. You're never required to use it; bring your own providers and routing works identically.

## Development

```bash
npm install
npm run typecheck
npm test          # mocked routing/failover tests + live Kunavo tests
```

The suite covers cheapest-first routing, failover on retryable errors *and* on a provider 400 (but *not* on a caller cancellation), surfacing the original error when the whole chain is exhausted, and a real broken-provider → Kunavo recovery. Live tests run only when `KUNAVO_API_KEY` is set in the environment; otherwise they're skipped.

## Credits

The streaming-safe failover approach is adapted from [`ai-fallback`](https://github.com/remorses/ai-fallback) (MIT) — reimplemented in-house so ai-lcr owns its engine and layers cost accounting + routing directly into it. Built on the [Vercel AI SDK](https://ai-sdk.dev).

## License

[MIT](./LICENSE) © Victor
