#!/usr/bin/env node
// ai-lcr MEDIA ASYNC integrity check — live probe of the submit/poll API.
//
// Where check-kunavo-media.sh hits the provider's REST endpoints with raw curl,
// THIS exercises ai-lcr's own async surface end to end:
//
//   const lcr = createMediaLCR({ registry, adapters })
//   const handle = await lcr.submit(modelId, input)   // process A (request handler)
//   …serialize the handle through JSON (the cross-process boundary)…
//   const r = await lcr.poll(handle)                   // process B (cron / worker)
//
// It deliberately JSON round-trips the handle between submit and poll to prove
// it survives a database/queue hop with no live object references — the whole
// reason the handle is plain data. On a provider job failure it watches the
// router re-submit to the next provider (poll-time failover).
//
// Spends real money: one veo-3-lite clip ≈ 16¢ (Kunavo) or ~40¢ (fal fallback).
//
// PREREQ: build first so dist/ is current →  npm run build
// Usage:
//   KUNAVO_API_KEY=sk-kn-... node scripts/check-media-async.mjs
//   # FAL_KEY (optional) adds a fal fallback route to exercise failover
//   # keys also auto-read from sibling .env.local files (see below)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let createMediaLCR, createKunavoMediaAdapter, createFalMediaAdapter;
try {
  ({ createMediaLCR, createKunavoMediaAdapter, createFalMediaAdapter } = await import(
    join(__dirname, "../dist/index.js")
  ));
} catch (err) {
  console.error("✗ could not import ../dist/index.js — run `npm run build` first\n", err.message);
  process.exit(1);
}

// ── Resolve keys (env first, then sibling .env.local files) ──────────────────
function readEnv(file, name) {
  try {
    const line = readFileSync(file, "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).replace(/["'\r]/g, "").trim() : "";
  } catch {
    return "";
  }
}
const KUNAVO_KEY =
  process.env.KUNAVO_API_KEY ||
  readEnv(join(__dirname, "../../chat-diagram/.env.local"), "KUNAVO_API_KEY");
const FAL_KEY =
  process.env.FAL_KEY ||
  readEnv(join(__dirname, "../../ai-art/apps/mintdreamer/.env.local"), "FAL_KEY");

if (!KUNAVO_KEY) {
  console.error("✗ no KUNAVO_API_KEY (env or ../chat-diagram/.env.local)");
  process.exit(1);
}

// ── Build a video model with a Kunavo route (+ fal fallback when keyed) ───────
const registry = {
  "google/veo-3-lite": {
    id: "google/veo-3-lite",
    modality: "video",
    routes: [
      { provider: "kunavo", externalId: "veo-3-lite", pricing: { unit: "call", cents: 16 } },
      ...(FAL_KEY
        ? [{ provider: "fal", externalId: "fal-ai/veo3.1/lite", pricing: { unit: "second", cents: 8 } }]
        : []),
    ],
  },
};
const adapters = {
  kunavo: createKunavoMediaAdapter({ apiKey: KUNAVO_KEY }),
  ...(FAL_KEY ? { fal: createFalMediaAdapter({ apiKey: FAL_KEY }) } : {}),
};

let pass = 0;
let fail = 0;
const ok = (m) => (console.log(`  ✅ ${m}`), pass++);
const bad = (m) => (console.log(`  ❌ ${m}`), fail++);

console.log(
  `ai-lcr media async check  (kunavo ${KUNAVO_KEY.slice(0, 8)}…${FAL_KEY ? ", fal fallback ON" : ", fal fallback OFF"})\n`,
);

const lcr = createMediaLCR({
  registry,
  adapters,
  onCall: (rec) =>
    console.log(
      `    onCall: winner=${rec.winner ?? "—"} ok=${rec.ok} failedOver=${rec.failedOver} ` +
        `cost=$${rec.costUsd.toFixed(4)} baseline=$${(rec.baselineUsd ?? 0).toFixed(4)} ${rec.latencyMs}ms`,
    ),
});

// ── Phase A: submit (process "request handler") ──────────────────────────────
console.log("[A] submit google/veo-3-lite");
let handle;
try {
  handle = await lcr.submit("google/veo-3-lite", {
    prompt: "a calm ocean wave rolling onto a sandy beach at sunset",
    aspect_ratio: "16:9",
  });
  ok(`submitted → provider=${handle.provider} requestId=${handle.requestId}`);
  console.log(`     fallbacks: [${handle.fallbacks.map((f) => f.provider).join(", ") || "none"}]`);
} catch (err) {
  bad(`submit threw: ${err.message}`);
  finish();
}

// ── Cross-process boundary: serialize → deserialize the handle ───────────────
const wire = JSON.stringify(handle);
console.log(`\n[wire] handle JSON is ${wire.length} bytes — round-tripping through JSON.parse`);
handle = JSON.parse(wire);

// ── Phase B: poll loop (process "worker") ────────────────────────────────────
console.log("\n[B] poll until terminal (6s cadence, 10m cap)");
const deadline = Date.now() + 600_000;
try {
  for (;;) {
    const r = await lcr.poll(handle);
    if (r.done) {
      ok(`done on provider=${r.provider}  cost=${r.costCents}¢ (estimated=${r.estimated})`);
      console.log(`     outputs: ${r.outputs.map((o) => o.url).join(", ")}`);
      break;
    }
    console.log(`     status=${r.status}${r.failedOver ? " (FAILED OVER → " + r.handle.provider + ")" : ""}`);
    handle = r.handle;
    if (Date.now() > deadline) {
      bad("poll loop exceeded 10m cap");
      break;
    }
    await new Promise((res) => setTimeout(res, 6000));
  }
} catch (err) {
  bad(`poll exhausted/threw: ${err.message}`);
}

finish();

function finish() {
  console.log("\n──────────────────────────────────────────");
  console.log(`PASS=${pass}  FAIL=${fail}`);
  console.log(fail === 0 ? "✅ media async: submit/poll works live" : "⚠️  review failures above");
  process.exit(fail === 0 ? 0 : 1);
}
