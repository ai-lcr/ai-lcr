// Live probe: does TokenMart's gemini-3-flash return empty completions under a
// streaming + multi-step tool loop, and does ai-lcr's new engine (B: fail over,
// A: flag) handle it? Reads keys from website/.env.local.
//
//   node scripts/probe-empty-completion.mjs [iterations]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { streamText, stepCountIs, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { jsonSchema } from "ai";
import { createLCR, formatCallRecord } from "../dist/index.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dir, "..", "website", ".env.local"), "utf8")
    .split("\n")
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
);

const tokenmart = createOpenAICompatible({
  name: "tokenmart",
  baseURL: "https://model.service-inference.ai/v1",
  apiKey: env.INFERENCE_API_KEY,
});
const openrouter = createOpenAICompatible({
  name: "openrouter",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: env.OPENROUTER_API_KEY,
});

const ITER = Number(process.argv[2] ?? 18);
const records = [];
const lcr = createLCR({
  models: {
    "gemini-3-flash": [
      { model: tokenmart("gemini-3-flash-preview"), label: "tokenmart", cost: { input: 0.4, output: 2.4 } },
      { model: openrouter("google/gemini-3-flash-preview"), label: "openrouter", cost: { input: 0.5, output: 3.0 } },
    ],
  },
  resetIntervalMs: 0, // re-probe the cheap (tokenmart) leg on every call, so each iteration starts there
  onCall: (r) => records.push(r),
});

// A tool the model must call, then summarize — the multi-step loop where the
// empty-completion step bites: step 1 emits a tool call, step 2 should produce
// the final text but sometimes comes back blank.
const getImage = tool({
  description: "Generate an image for a prompt and return its URL.",
  inputSchema: jsonSchema({
    type: "object",
    properties: { prompt: { type: "string" } },
    required: ["prompt"],
  }),
  execute: async ({ prompt }) => ({ url: `https://img.example/${encodeURIComponent(prompt).slice(0, 24)}.png` }),
});

let emptyFinal = 0; // user-visible final text was blank
let okFinal = 0;
let errored = 0;

for (let i = 0; i < ITER; i++) {
  const before = records.length;
  try {
    const res = streamText({
      model: lcr("gemini-3-flash"),
      tools: { getImage },
      stopWhen: stepCountIs(4),
      maxRetries: 0,
      prompt: "Generate an image of a red fox in snow, then tell me in one sentence what you made.",
    });
    let text = "";
    for await (const d of res.textStream) text += d;
    const finalText = (await res.text) ?? text;
    if (finalText.trim().length === 0) emptyFinal++;
    else okFinal++;
    process.stdout.write(finalText.trim().length === 0 ? "·" : "✓");
  } catch (e) {
    errored++;
    process.stdout.write("✗");
  }
  // Print the records this iteration produced (one per doStream step).
  for (const r of records.slice(before)) {
    // stash for the summary; printed below
  }
}
process.stdout.write("\n\n");

// ---- summary over every CallRecord (one per streamed step) ----
const stepRecords = records;
const tmEmptyHops = stepRecords.flatMap((r) => r.attempts).filter((a) => !a.ok && a.errorClass === "empty_completion");
const flagged = stepRecords.filter((r) => r.emptyCompletion);
const failedOver = stepRecords.filter((r) => r.failedOver);
const tmServed = stepRecords.filter((r) => r.winner === "tokenmart").length;
const orServed = stepRecords.filter((r) => r.winner === "openrouter").length;

console.log(`iterations (user requests): ${ITER}  →  ok=${okFinal} emptyFinal=${emptyFinal} errored=${errored}`);
console.log(`streamed steps (CallRecords): ${stepRecords.length}`);
console.log(`  tokenmart empty-completion hops (B fired → failed over): ${tmEmptyHops.length}`);
console.log(`  records flagged emptyCompletion (A — all providers empty):  ${flagged.length}`);
console.log(`  failed over (any reason): ${failedOver.length}   served by: tokenmart=${tmServed} openrouter=${orServed}`);
console.log("");
console.log("sample of failed-over / flagged step records:");
for (const r of stepRecords.filter((r) => r.failedOver || r.emptyCompletion).slice(0, 12)) {
  console.log("  " + formatCallRecord(r));
}
if (!stepRecords.some((r) => r.failedOver || r.emptyCompletion)) {
  console.log("  (none — no empty completion observed in this sample; sample of normal records:)");
  for (const r of stepRecords.slice(0, 4)) console.log("  " + formatCallRecord(r));
}
