/**
 * Basic Least Cost Routing.
 *
 * One logical model ("gemini-3-flash") served by two providers, cheapest-first.
 * `autoSort` orders them by declared cost; `onCost` reports the real USD each
 * call spent on whichever provider actually served it.
 *
 * Run:  OPENROUTER_API_KEY=... KUNAVO_API_KEY=... npx tsx examples/basic.ts
 */
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
  autoSort: true, // order each model's providers cheapest-first by `cost`
  models: {
    "gemini-3-flash": [
      { model: kunavo("gemini-3-flash"), label: "kunavo", cost: { input: 0.4, output: 2.4 } },
      { model: openrouter("google/gemini-3-flash-preview"), label: "openrouter", cost: { input: 0.5, output: 3.0 } },
    ],
  },
  onCost: ({ provider, model, inputTokens, outputTokens, costUsd }) => {
    console.log(`[cost] ${model} via ${provider}: ${inputTokens}+${outputTokens} tok = $${costUsd.toFixed(6)}`);
  },
  onError: (err, provider) => {
    console.warn(`[failover] ${provider} failed (${err.message}), trying next…`);
  },
});

const { text } = await generateText({
  model: lcr("gemini-3-flash"),
  prompt: "Explain Least Cost Routing in one sentence.",
});

console.log("\n" + text);
