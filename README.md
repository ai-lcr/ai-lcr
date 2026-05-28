# ai-lcr

**Least Cost Routing for LLMs.** Route every model call to the cheapest available provider, fall back automatically when one fails, and track what you actually spend — built for the [Vercel AI SDK](https://ai-sdk.dev).

> 🚧 **Early development.** The API below is the target design and is being dogfooded across production apps before a stable release. Star/watch to follow along. Today it builds on [`ai-fallback`](https://github.com/remorses/ai-fallback) for the failover primitive and adds the cost layer on top.

---

## What is "Least Cost Routing"?

Telephone carriers have done **Least Cost Routing (LCR)** for decades: every call is sent over the cheapest carrier that can complete it, and rerouted the moment one is congested or down. Payment networks do the same with debit transactions.

The exact same idea applies to LLM APIs. The *same* model — say `gemini-3-flash` or `claude-sonnet` — is sold at very different prices by OpenRouter, by direct providers, and by aggregators that discount off list. `ai-lcr` keeps an ordered, cheapest-first list of providers for each model, routes to the cheapest one that's healthy, and falls through to the next on failure. You write your code once against the AI SDK; the bill goes down.

## Why not just use `ai-fallback`?

[`ai-fallback`](https://github.com/remorses/ai-fallback) is excellent and `ai-lcr` uses it under the hood for the streaming-safe failover. But its switch logic is a pure **error classifier** — it moves to the next model only when the current one throws a retryable error (5xx / 429 / timeout). That handles exactly one failure mode: *the provider is down*.

In production, multi-provider routing hits three failure modes, and an error classifier only catches the first:

| Failure mode | Example | What `ai-lcr` adds |
|---|---|---|
| **Provider down / rate-limited** | `429`, `503`, timeout | (handled by `ai-fallback`) |
| **Fixable protocol quirk** | An aggregator rejects an assistant turn with `content: null` that the OpenAI spec allows | A **per-provider middleware layer** patches the request (`null → ""`) and *stays on the cheap provider* instead of failing or switching away |
| **Silent correctness failure** | A provider silently drops your `tools` and returns plain text, or ignores `cache_control` and overcharges | An **offline capability probe** validates each provider × model (tool-calling, caching, streaming) and feeds a trust matrix into routing — because these never throw an error at runtime |

On top of that, `ai-lcr` is **cost-first**, not order-first: it ships a maintained price table and per-call cost accounting, so "I think this is cheaper" becomes "here's the dashboard showing 27% saved."

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

// Any OpenAI-compatible provider works — just give it a base URL + key.
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
    // Each provider keeps its own model id.
    "gemini-3-flash": [
      kunavo("gemini-3-flash"),                     // cheapest → tried first
      openrouter("google/gemini-3-flash-preview"),  // fallback on failure
    ],
  },
  // Optional: real cost accounting per call.
  onCost: ({ model, provider, costUsd, inputTokens, outputTokens }) => {
    console.log(`${model} via ${provider}: $${costUsd.toFixed(6)}`);
  },
  // Optional: after this idle window, retry the cheapest provider again.
  resetIntervalMs: 60_000,
});

const { text } = await generateText({
  model: lcr("gemini-3-flash"),
  prompt: "Explain Least Cost Routing in one sentence.",
});
```

`lcr("gemini-3-flash")` returns a standard AI SDK `LanguageModel`, so it works anywhere the SDK does — `generateText`, `streamText`, `generateObject`, tools, agents.

## How routing decides

1. **Cheapest first.** Providers for a model are tried in order. Order them cheapest-first (or let `ai-lcr` order them for you from its price table) and priority order *is* cost order.
2. **Fall through on failure.** On a retryable error (rate limit, 5xx, timeout) it advances to the next provider, streaming-safe.
3. **Patch known quirks instead of failing.** If a provider has a registered quirk (e.g. needs `content: null → ""`), the request is patched and stays on that provider.
4. **Cool down and recover.** After `resetIntervalMs` of not needing a fallback, it snaps back to the cheapest provider.

## Roadmap

- [ ] **P0** — cheapest-first chain + failover + real per-call cost accounting (dogfooded in production first)
- [ ] **P1** — extract as a standalone, provider-neutral package; maintained price table as a separate data file; provider-quirk middleware registry
- [ ] **P1** — offline capability probe → trust matrix (tool-calling / caching / streaming per provider × model)
- [ ] **P2** — auto cheapest-first ordering directly from the price table
- [ ] **P2** — savings dashboard / report

## Affiliate disclosure

`ai-lcr` is provider-neutral and works with any OpenAI-compatible endpoint, OpenRouter, or direct provider. The author holds an affiliate arrangement with **kunavo**, which (because it discounts off list price) tends to be the cheapest option for Gemini and Claude in the bundled price table. If you sign up for kunavo through the link in the docs, the author may receive a share. You are never required to use it — bring your own providers and the routing works exactly the same.

## Credits

- [`ai-fallback`](https://github.com/remorses/ai-fallback) — the streaming-safe failover primitive `ai-lcr` builds on.
- [Vercel AI SDK](https://ai-sdk.dev) — the provider abstraction and `LanguageModel` interface.

## License

[MIT](./LICENSE) © Victor
