/**
 * Migrate an existing "AI SDK + OpenRouter" app to ai-lcr.
 *
 * If you already call OpenRouter through `@openrouter/ai-sdk-provider`, the
 * switch is a drop-in: `openrouter.chat(id)` returns a standard LanguageModelV3,
 * so it slots straight into a provider list. You get failover + cost tracking,
 * and the moment you add a second cheaper provider, least-cost routing kicks in.
 *
 * Run:  OPENROUTER_API_KEY=... KUNAVO_API_KEY=... npx tsx examples/migrate-from-openrouter.ts
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BEFORE — single provider, no failover, no cost visibility:
 *
 *   import { createOpenRouter } from "@openrouter/ai-sdk-provider";
 *   import { generateText } from "ai";
 *
 *   const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! });
 *
 *   const { text } = await generateText({
 *     model: openrouter.chat("anthropic/claude-sonnet-4-6"),
 *     prompt,
 *   });
 *
 * AFTER — same call site, now routed. Note `lcr("claude-sonnet")` replaces
 * `openrouter.chat(...)`; everything downstream (streamText, tools, agents,
 * providerOptions) is unchanged.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createLCR } from "ai-lcr";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

// Keep your existing OpenRouter provider exactly as-is.
const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! });

// Add one cheaper provider to make routing meaningful (optional but recommended —
// a single-provider LCR only buys you cost tracking, not least-cost routing).
const kunavo = createOpenAICompatible({
  name: "kunavo",
  baseURL: "https://api.kunavo.com/v1",
  apiKey: process.env.KUNAVO_API_KEY,
});

// Centralize what used to be scattered `createOpenRouter` call sites into one map.
const lcr = createLCR({
  autoSort: true,
  models: {
    "claude-sonnet": [
      // Kunavo is −20% on Anthropic list — cheapest-first.
      { model: kunavo("claude-sonnet-4-6"), label: "kunavo", cost: { input: 2.4, output: 12 } },
      // Your original OpenRouter route, now the fallback.
      { model: openrouter.chat("anthropic/claude-sonnet-4-6"), label: "openrouter", cost: { input: 3, output: 15 } },
    ],
  },
  onCost: ({ provider, costUsd }) => console.log(`served by ${provider}: $${costUsd.toFixed(6)}`),
});

const { text } = await generateText({
  // was: openrouter.chat("anthropic/claude-sonnet-4-6")
  model: lcr("claude-sonnet"),
  prompt: "Summarize the migration in one sentence.",
});

console.log("\n" + text);
