// Generate src/text-prices.ts — the bundled text-model price table.
//
// SOURCE: LiteLLM's community-maintained `model_prices_and_context_window.json`
// (BerriAI/litellm, MIT). It's the broadest open list of per-model token prices.
// We DON'T vendor the 1.5 MB source or ship the whole thing: a least-cost router
// only needs official, first-party maker prices — the "go direct" rate the README
// pushes as the cheapest, most-featureful route. Aggregator/reseller discounts
// (Kunavo −20%, TokenMart, …) are expressed at config time with `discount`, not
// baked here, because they drift and vary per model.
//
// What we keep: chat models from the native vendors ai-lcr documents — the
// Western proprietary makers (openai · anthropic · gemini · xai · mistral) plus
// the open-weights labs whose own first-party API publishes a stable list rate
// (deepseek · qwen/Alibaba · kimi/Moonshot · minimax · glm/Z.ai). Keyed by the
// BARE model id the user passes to that vendor's AI SDK provider (e.g.
// `anthropic("claude-haiku-4-5")`, `google("gemini-2.5-flash")`, `qwen-plus`,
// `glm-4.6`). Per-token prices are converted to ai-lcr's unit: USD per 1M tokens.
//
// Note on open-weights routing: a dedicated inference host (DeepInfra, …) is
// often cheaper than the first-party API and uses HF-style ids (`Qwen/Qwen3-…`)
// that won't match these bare keys — so for an aggregator route, pass an explicit
// `cost` (or `discount`). The bundled first-party rate is the autoPrice baseline
// for the maker's own provider and a documented reference price for the rest.
//
// Refresh (manual — the generated file is committed):
//   node scripts/gen-text-prices.mjs
//   # or point at a local copy / mirror:
//   LITELLM_PRICES=/path/to/model_prices_and_context_window.json node scripts/gen-text-prices.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../src/text-prices.ts");
const URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// Native model makers only — a vendor's own first-party API publishes a stable
// list rate worth bundling. (LiteLLM provider ids: `dashscope` = Qwen/Alibaba,
// `moonshot` = Kimi, `zai` = GLM/Z.ai.) Aggregators (deepinfra, together,
// fireworks, groq, openrouter, …) are deliberately excluded — their prices drift
// and are expressed at config time with `cost`/`discount`.
const ALLOW = new Set([
  "openai",
  "anthropic",
  "gemini",
  "xai",
  "mistral",
  "deepseek",
  "dashscope", // Qwen (Alibaba)
  "moonshot", // Kimi
  "minimax",
  "zai", // GLM (Z.ai / Zhipu)
]);

const PER_TOKEN_TO_PER_M = 1e6;

async function loadSource() {
  const local = process.env.LITELLM_PRICES;
  if (local) return JSON.parse(readFileSync(local, "utf8"));
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`fetch ${URL} → ${res.status}`);
  return res.json();
}

/** Strip a single leading "provider/" segment so keys match the bare model id
 *  the user passes to the vendor's AI SDK provider. "gemini/gemini-2.5-flash"
 *  → "gemini-2.5-flash"; "claude-haiku-4-5" is already bare. */
function bareId(key) {
  const slash = key.indexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

/** Round to 6 significant-ish decimals and drop float noise (1.0000000002 → 1). */
function clean(n) {
  return Number(n.toFixed(6));
}

const src = await loadSource();
const table = new Map(); // bareId -> { input, output, cacheRead? }
let collisions = 0;

for (const [key, v] of Object.entries(src)) {
  if (!v || typeof v !== "object") continue;
  if (!ALLOW.has(v.litellm_provider)) continue;
  if (v.mode !== "chat") continue;
  if (key.startsWith("ft:")) continue; // fine-tunes aren't a routing target
  const inPer = v.input_cost_per_token;
  const outPer = v.output_cost_per_token;
  if (!inPer || !outPer) continue; // need both to price a call

  const id = bareId(key);
  const cost = {
    input: clean(inPer * PER_TOKEN_TO_PER_M),
    output: clean(outPer * PER_TOKEN_TO_PER_M),
  };
  if (v.cache_read_input_token_cost) {
    cost.cacheRead = clean(v.cache_read_input_token_cost * PER_TOKEN_TO_PER_M);
  }

  const prev = table.get(id);
  if (prev) {
    // Same bare id seen twice (e.g. "deepseek-chat" and "deepseek/deepseek-chat").
    // List prices should agree; if they diverge >5% keep the first and flag it.
    const drift = Math.abs(prev.input - cost.input) / Math.max(prev.input, 1e-9);
    if (drift > 0.05) collisions++;
    continue;
  }
  table.set(id, cost);
}

const entries = [...table.entries()].sort(([a], [b]) => a.localeCompare(b));
const fmt = (c) =>
  c.cacheRead !== undefined
    ? `{ input: ${c.input}, output: ${c.output}, cacheRead: ${c.cacheRead} }`
    : `{ input: ${c.input}, output: ${c.output} }`;
const body = entries.map(([id, c]) => `  ${JSON.stringify(id)}: ${fmt(c)},`).join("\n");

const ts = `// GENERATED by scripts/gen-text-prices.mjs — DO NOT EDIT.
// Source: LiteLLM's model_prices_and_context_window.json (BerriAI/litellm, MIT).
//
// Official first-party list prices for native model makers — openai · anthropic ·
// gemini · xai · mistral · deepseek · qwen (Alibaba) · kimi (Moonshot) · minimax ·
// glm (Z.ai) — keyed by the BARE model id you pass to that vendor's AI SDK
// provider. USD per 1M tokens (input / output, optional cacheRead). This is the
// first-party list rate; aggregator/reseller routes (DeepInfra, Kunavo, TokenMart,
// …) are NOT baked in — express them per-entry with \`cost\` or \`discount\` (see
// createLCR's autoPrice). Refresh: node scripts/gen-text-prices.mjs
import type { ProviderCost } from "./fallback";

export const MODEL_PRICES: Record<string, ProviderCost> = {
${body}
};
`;

writeFileSync(OUT, ts);
console.log(`wrote ${OUT} — ${entries.length} model prices${collisions ? ` (${collisions} price collisions kept first)` : ""}`);
