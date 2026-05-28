# ai-lcr

**Least Cost Routing for LLMs.** Route each model to the cheapest provider that can serve it, and fall back automatically when one fails. Built for the [Vercel AI SDK](https://ai-sdk.dev).

> 🚧 Early development — the API may change. Dogfooded in production before a stable release.

The same model costs different amounts on different providers. `ai-lcr` keeps a cheapest-first list per model, routes to the cheapest healthy one, and falls through on failure — the way phone carriers have done [Least Cost Routing](https://en.wikipedia.org/wiki/Least-cost_routing) for decades.

## Supported providers

Any OpenAI-compatible endpoint works. To start, `ai-lcr` targets three:

- **[OpenRouter](https://openrouter.ai)** — widest model coverage, list pricing
- **[Inference.ai](https://inference.ai)** — discounted Claude
- **[Kunavo](https://kunavo.com/?ref=hJ2uT3iW)** — ~30% off list on Gemini & Claude

## Price comparison

USD per 1M tokens, input / output. Snapshot as of 2026-05 — **verify current rates with each provider**. OpenRouter passes list price through; Kunavo discounts ~30% off list on the models it carries.

### Text models

| Model | List (official) | OpenRouter | [Kunavo](https://kunavo.com/?ref=hJ2uT3iW) | Kunavo vs list |
|---|---|---|---|---|
| Gemini 3 Flash | 0.50 / 3.00 | 0.50 / 3.00 | **0.35 / 2.10** | 70% — 30% off |
| Gemini 3 Pro | 2.00 / 12.00 | 2.00 / 12.00 | **1.40 / 8.40** | 70% — 30% off |
| Claude Sonnet 4.6 | 3.00 / 15.00 | 3.00 / 15.00 | **2.10 / 10.50** | 70% — 30% off |
| Claude Haiku 4.5 | 1.00 / 5.00 | 1.00 / 5.00 | **0.70 / 3.50** | 70% — 30% off |
| DeepSeek V4 Flash | 0.10 / 0.20 | 0.10 / 0.20 | — | route via OpenRouter |
| GPT-5.4 | 2.50 / 15.00 | 2.50 / 15.00 | — | route via OpenRouter |

Kunavo carries Anthropic + Google. For OpenAI / DeepSeek / Grok / Mistral, `ai-lcr` routes to OpenRouter.

### Image & video models

Billed per image / per second (not per token), so prices aren't published on the token endpoints and need a per-provider quote. Image routing is on the roadmap.

| Model | Provider | Billing |
|---|---|---|
| nano-banana / -2 / -pro | [Kunavo](https://kunavo.com/?ref=hJ2uT3iW) | per image — quote |
| gpt-image-2 | [Kunavo](https://kunavo.com/?ref=hJ2uT3iW) | per image — quote |
| veo-3 / -quality / -lite | [Kunavo](https://kunavo.com/?ref=hJ2uT3iW) | per second — quote |

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
  models: {
    // One logical model, served cheapest-first across providers.
    "gemini-3-flash": [
      kunavo("gemini-3-flash"),                     // cheapest → tried first
      openrouter("google/gemini-3-flash-preview"),  // fallback on failure
    ],
  },
});

const { text } = await generateText({
  model: lcr("gemini-3-flash"),
  prompt: "Explain Least Cost Routing in one sentence.",
});
```

`lcr("gemini-3-flash")` returns a standard AI SDK `LanguageModel`, so it works with `generateText`, `streamText`, `generateObject`, tools, and agents.

## How it routes

1. **Cheapest first.** Providers are tried in order — list them cheapest-first.
2. **Fall through on failure.** On a retryable error (rate limit, 5xx, timeout) it advances to the next provider, streaming-safe.
3. **Recover.** After an idle window (`resetIntervalMs`, default 60s) it snaps back to the cheapest provider.

## Roadmap

- [ ] Real per-call cost accounting from a bundled price table
- [ ] Auto cheapest-first ordering straight from the price table
- [ ] Provider-quirk middleware (transparently patch known per-provider request quirks)
- [ ] Offline capability probe (tool-calling / caching / streaming) → trust matrix
- [ ] Image & video model routing

## Affiliate disclosure

`ai-lcr` is provider-neutral and works with any OpenAI-compatible endpoint. The author holds an affiliate arrangement with **[Kunavo](https://kunavo.com/?ref=hJ2uT3iW)**, which — because it discounts off list — is often the cheapest option for Gemini and Claude. Signing up through that link may earn the author a share. You're never required to use it; bring your own providers and routing works identically.

## License

[MIT](./LICENSE) © Victor
