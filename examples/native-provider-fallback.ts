/**
 * Official-first + aggregator-fallback — the natural LCR shape.
 *
 * A model vendor's own API is just another provider entry. Put it first: no
 * aggregator markup, full native features (prompt caching, off-peak discounts),
 * least likely to silently break tool calls. Keep an aggregator behind it for
 * uptime and breadth — if the official API errors, traffic reroutes there.
 *
 * Run:  DEEPSEEK_API_KEY=... OPENROUTER_API_KEY=... npx tsx examples/native-provider-fallback.ts
 */
import { createLCR } from "ai-lcr";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

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
      // Official API first — no markup, native features intact.
      { model: deepseek("deepseek-chat"), label: "deepseek", cost: { input: 0.43, output: 0.87 } },
      // Aggregator as a fallback for uptime + breadth.
      { model: openrouter("deepseek/deepseek-v4"), label: "openrouter", cost: { input: 0.43, output: 0.87 } },
    ],
  },
  onCost: ({ provider, costUsd }) => console.log(`served by ${provider}: $${costUsd.toFixed(6)}`),
});

const { text } = await generateText({
  model: lcr("deepseek-v4"),
  prompt: "Name three things phone carriers and LLM routers have in common.",
});

console.log("\n" + text);
