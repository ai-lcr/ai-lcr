# ai-lcr

**Least Cost Routing for LLMs.** Route each model to the cheapest provider that can serve it, and fall back automatically when one fails. Built for the [Vercel AI SDK](https://ai-sdk.dev).

> 🚧 Early development — the API may change. Dogfooded in production before a stable release.

The same model costs different amounts on different providers. `ai-lcr` keeps a cheapest-first list per model, routes to the cheapest healthy one, and falls through on failure — the way phone carriers have done [Least Cost Routing](https://en.wikipedia.org/wiki/Least-cost_routing) for decades.

## Supported providers

Any OpenAI-compatible endpoint works. To start, `ai-lcr` targets three:

- **[OpenRouter](https://openrouter.ai)** — widest model coverage, list pricing
- **[Inference.ai](https://inference.ai)** — discounted Claude
- **[Kunavo](https://kunavo.com/?ref=hJ2uT3iW)** — **30% off** every model's official rate

## Pricing

Kunavo publishes a flat **30% off** the provider's official rate on every model. OpenRouter passes the official list price through. The **Official** column is the anchor; each provider column shows its discount. Official rates as of 2026-05 — verify current rates with each provider.

### Text models

| Model | Official (in / out, per 1M) | OpenRouter | [Kunavo](https://kunavo.com/?ref=hJ2uT3iW) |
|---|---|---|---|
| Gemini 3 Flash | $0.50 / $3.00 | no discount | **−30%** |
| Gemini 3 Pro / 3.1 Pro | $2.00 / $12.00 | no discount | **−30%** |
| Gemini 2.5 Pro | $1.25 / $10.00 | no discount | **−30%** |
| Gemini 2.5 Flash | $0.30 / $2.50 | no discount | **−30%** |
| Claude Sonnet 4.6 | $3.00 / $15.00 | no discount | **−30%** |
| Claude Haiku 4.5 | $1.00 / $5.00 | no discount | **−30%** |
| DeepSeek V4 | $0.43 / $0.87 | no discount | not carried |

Kunavo carries Anthropic + Google. DeepSeek (and OpenAI / Grok / Mistral) route to OpenRouter — `ai-lcr` picks the cheapest provider per model, so a single config can mix all of them.

### Image & video models

Billed per image / per second (not per token). Kunavo is **−30%** off the official rate here too; the Official column below is derived from Kunavo's published price.

| Model | Type | Official (≈) | [Kunavo](https://kunavo.com/?ref=hJ2uT3iW) |
|---|---|---|---|
| Nano Banana | image | ~$0.039 / image | **$0.0273 / image** |
| Nano Banana 2 | image | from ~$0.067 / image | **from $0.0469 / image** |
| Nano Banana Pro | image | from ~$0.134 / image | **from $0.0938 / image** |
| GPT-Image-2 | image | ~$0.127 / image | **$0.0886 / image** |
| Veo 3 Fast | video | from ~$0.40 / video | **from $0.28 / video** |
| Veo 3 Quality | video | from ~$1.91 / video | **from $1.34 / video** |
| Veo 3 Lite | video | from ~$0.24 / video | **from $0.168 / video** |

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

`ai-lcr` is provider-neutral and works with any OpenAI-compatible endpoint. The author holds an affiliate arrangement with **[Kunavo](https://kunavo.com/?ref=hJ2uT3iW)**, which — at 30% off official rates — is often the cheapest option for Gemini and Claude. Signing up through that link may earn the author a share. You're never required to use it; bring your own providers and routing works identically.

## License

[MIT](./LICENSE) © Victor
