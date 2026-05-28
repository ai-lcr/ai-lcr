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
  <img src="assets/ai-lcr-hero.svg" alt="ai-lcr routes each model to its own cheapest provider — Gemini to Kunavo, DeepSeek to OpenRouter, Seedream to fal, Flux Schnell to Runware — and falls back on failure" width="820">
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
      { model: kunavo("gemini-3-flash"), label: "kunavo", cost: { input: 0.35, output: 2.1 } },
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

## How it routes

1. **Cheapest first.** Providers are tried in order — list them cheapest-first, or set `autoSort: true` to order them by `cost` automatically.
2. **Fall through on failure.** On a retryable error (rate limit, 5xx, timeout) it advances to the next provider, streaming-safe. Hard errors (400, 401, 403, 422) pass through immediately.
3. **Recover.** After an idle window (`resetIntervalMs`, default 60s) it snaps back to the cheapest provider.

<p align="center">
  <img src="assets/ai-lcr-routing.svg" alt="routing diagram: cheapest first, fallback on failure, recover after idle" width="820">
</p>

## Supported providers

Any OpenAI-compatible endpoint works.

- **Text:** [OpenRouter](https://openrouter.ai) (widest coverage, list pricing) · [Kunavo](https://kunavo.com/?ref=victorimf) (**30% off** every model)
- **Image / video:** [Kunavo](https://kunavo.com/?ref=victorimf) (**30% off**) · [fal.ai](https://fal.ai) · [Runware](https://runware.ai) — routing on the roadmap

## Text model pricing

USD per 1M tokens, input / output. Official rates as of 2026-05 — verify current rates with each provider. OpenRouter passes list price through; Kunavo is a flat 30% off the official rate.

| Model | Official (in / out) | OpenRouter | [Kunavo](https://kunavo.com/?ref=victorimf) | Cheapest |
|---|---|---|---|---|
| Gemini 3 Flash | $0.50 / $3.00 | no discount | −30% | ⭐ Kunavo |
| Gemini 3 Pro / 3.1 Pro | $2.00 / $12.00 | no discount | −30% | ⭐ Kunavo |
| Gemini 2.5 Pro | $1.25 / $10.00 | no discount | −30% | ⭐ Kunavo |
| Gemini 2.5 Flash | $0.30 / $2.50 | no discount | −30% | ⭐ Kunavo |
| Claude Sonnet 4.6 | $3.00 / $15.00 | no discount | −30% list, but ~5× tokens ⚠️ | ⭐ OpenRouter¹ |
| Claude Haiku 4.5 | $1.00 / $5.00 | no discount | −30% list, but ~5× tokens ⚠️ | ⭐ OpenRouter¹ |
| DeepSeek V4 | $0.43 / $0.87 | no discount | not carried | ⭐ OpenRouter |

Kunavo carries Anthropic + Google. DeepSeek / OpenAI / Grok / Mistral route to OpenRouter — one config can mix them all.

> **¹ List price isn't effective price — verify with the [probe](#vetting-a-provider-capability--cost-probe).** As of the last probe run (2026-05-27), Kunavo's **Claude** path reports `input_tokens` ~5× higher than the true count (3,607 → 17,475 for the same prompt vs OpenRouter) **and bills on the inflated number** — so the −30% list discount becomes ~3–5× *more* expensive than OpenRouter in practice. It also injects a hidden system prompt into Claude requests (pollutes output) and ignores `max_tokens`. **Kunavo's Gemini path is clean** (token counts match within ~1.1×), so Gemini stays ⭐ Kunavo. Route `claude-*` to OpenRouter until Kunavo fixes this — re-run the probe to check. Effective cost is why `ai-lcr` should rank by measured behavior, not the sticker price.

## Image model pricing

USD per image, as of 2026-05 (provider list / retail; verify current rates). Kunavo is 30% off official. fal and Runware are compute providers — `ai-lcr` picks the cheapest per model (⭐).

| Model | fal.ai | Runware | [Kunavo](https://kunavo.com/?ref=victorimf) | Cheapest |
|---|---|---|---|---|
| Nano Banana 2 | $0.080 | $0.069 | $0.047 | ⭐ Kunavo |
| Nano Banana Pro | $0.080 | — | $0.094 | ⭐ fal |
| GPT-Image-2 | $0.210 | $0.094 | $0.089 | ⭐ Kunavo |
| Imagen 4 Ultra | $0.060 | $0.060 | — | ⭐ fal / Runware |
| Ideogram V3 | $0.060 | $0.060 | — | ⭐ fal / Runware |
| Seedream 4 | $0.030 | — | — | ⭐ fal |
| Flux 1.1 Pro | $0.040 | $0.040 | — | ⭐ fal / Runware |
| Flux Dev | $0.025 | $0.025 | — | ⭐ fal / Runware |
| Flux Schnell | $0.0030 | $0.0013 | — | ⭐ Runware |
| Qwen-Image | — | $0.0038 | — | ⭐ Runware |
| FLUX.2 Klein 4B | — | $0.0006 | — | ⭐ Runware |

## Video model pricing

USD per second, as of 2026-05 — verify current rates. Video billing differs by provider, so a clean cross-provider table isn't apples-to-apples: fal.ai and Runware charge per second, while Kunavo's Veo is per clip (Fast ~$0.28 / Lite ~$0.168 / Quality ~$1.34). Below are fal.ai's per-second rates (the video workhorse in testing); a normalized fal / Runware / Kunavo comparison is a TODO.

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

## Vetting a provider (capability + cost probe)

A discount is worthless if the provider quietly breaks the wire protocol. `ai-lcr` ships a zero-dependency probe (`scripts/probe-provider.sh`, just `bash` + `curl` + `python3`) that checks the things that actually cost you money or corrupt output, **per model**:

- **tool calling** — single call and a multi-step round-trip with `content: null` (the shape every agent loop sends)
- **`max_tokens` honored** — caps must bound output
- **hidden-prompt injection** — sends a neutral message; flags the provider if the model starts reacting to a system prompt it was never given
- **token over-counting** — compares reported `prompt_tokens` against a trusted baseline provider; >1.5× means the bill is inflated and the "discount" may be a loss
- **prompt caching** — whether `cache_control` actually produces a `cache_read` on repeats

```bash
# point it at the provider you're vetting; add a trusted baseline (e.g. OpenRouter)
# to enable the token-inflation check
API_KEY=$KUNAVO_API_KEY BASE=https://api.kunavo.com \
  GEMINI=gemini-3-flash CLAUDE=claude-sonnet-4-6 \
  REF_API_KEY=$OPENROUTER_API_KEY REF_BASE=https://openrouter.ai/api \
  REF_GEMINI=google/gemini-3-flash-preview REF_CLAUDE=anthropic/claude-sonnet-4.6 \
  bash scripts/probe-provider.sh
```

A `FAIL` on injection or token over-counting means that provider is **not** a safe least-cost target for that model — keep it off that model's cheapest-first list until it's fixed, then re-probe.

### Trust matrix — Kunavo (as of 2026-05-27)

| Check | Kunavo Gemini | Kunavo Claude |
|---|---|---|
| Single + multi-step tool calls (`content: null`) | ✅ | ✅ |
| Token count vs OpenRouter baseline | ✅ ~1.1× | ❌ **~4.8–5.1×** (billed on it) |
| Hidden-prompt injection | ✅ none | ❌ injects a confidential system prompt |
| `max_tokens` honored | ❌ ignored | ❌ ignored |
| Prompt caching (`cache_control`) | n/a | ❌ not applied |

**Verdict:** Gemini → Kunavo (the −30% is real). Claude → OpenRouter (token inflation + injection wipe out the discount). `max_tokens` being ignored is a provider-wide Kunavo quirk — bound output via prompt, not the parameter, until it's fixed.

## Roadmap

- [x] Own failover engine — cheapest-first routing + streaming-safe fallback, no external routing dependency
- [x] Real per-call cost accounting (`onCost`)
- [x] Auto cheapest-first ordering (`autoSort`) from per-provider `cost`
- [x] Offline capability + cost probe (`scripts/probe-provider.sh`) → per-model trust matrix
- [ ] Bundled price table for zero-config pricing (drop the manual `cost` numbers)
- [ ] Provider-quirk middleware (transparently patch known per-provider request quirks, e.g. Kunavo's ignored `max_tokens`)
- [ ] Feed probe results into routing automatically (auto-exclude a model from a provider that fails its probe)
- [ ] Image & video model routing (fal.ai / Runware / Kunavo)

## Affiliate disclosure

`ai-lcr` is provider-neutral and works with any OpenAI-compatible endpoint. The author holds an affiliate arrangement with **[Kunavo](https://kunavo.com/?ref=victorimf)**, which — at 30% off official rates — is often (not always) the cheapest option, as the tables above show. Signing up through that link may earn the author a share. You're never required to use it; bring your own providers and routing works identically.

## Development

```bash
npm install
npm run typecheck
npm test          # mocked routing/failover tests + live Kunavo tests
```

The suite covers cheapest-first routing, failover on retryable errors (and *not* failing over on a 400), exhausting the whole chain, and a real broken-provider → Kunavo recovery. Live tests run only when `KUNAVO_API_KEY` is set in the environment; otherwise they're skipped.

## Credits

The streaming-safe failover approach is adapted from [`ai-fallback`](https://github.com/remorses/ai-fallback) (MIT) — reimplemented in-house so ai-lcr owns its engine and layers cost accounting + routing directly into it. Built on the [Vercel AI SDK](https://ai-sdk.dev).

## License

[MIT](./LICENSE) © Victor
