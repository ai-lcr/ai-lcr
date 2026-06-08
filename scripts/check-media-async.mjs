#!/usr/bin/env node
// ai-lcr MEDIA ASYNC integrity check — live probe of the submit/poll API across
// EVERY async provider (kunavo · fal · runware), not just one.
//
// Where check-kunavo-media.sh hits Kunavo's REST endpoints with raw curl, THIS
// exercises ai-lcr's own async surface end to end, per provider:
//
//   const lcr = createMediaLCR({ registry, adapters })
//   const handle = await lcr.submit(modelId, input)   // process A (request handler)
//   …serialize the handle through JSON (the cross-process boundary)…
//   const r = await lcr.poll(handle)                   // process B (cron / worker)
//
// For each provider whose API key is present it asserts the things that rot
// silently when a provider drifts its wire format (the reason mock unit tests
// aren't enough — they only verify our own assumptions):
//   1. submit returns a requestId
//   2. the handle survives a JSON round-trip (plain data, cross-process)
//   3. poll walks queued/running → done
//   4. the returned URL actually fetches (real bytes, right content-type)
//   5. cost is reported (provider-reported for runware, estimated for kunavo/fal)
//
// With PROBE_FAILOVER=1 it also wires a dead-URL route BEFORE the real one and
// asserts the router fails over to the live provider (submit-time failover).
//
// Spends real money — one clip per present provider (~16¢ kunavo / ~40¢ fal /
// ~12¢ runware); the failover case spends one extra real clip.
//
// PREREQ: build first so dist/ is current →  npm run build
// Usage:
//   KUNAVO_API_KEY=… FAL_KEY=… RUNWARE_API_KEY=… node scripts/check-media-async.mjs
//   PROBE_FAILOVER=1 node scripts/check-media-async.mjs    # + live failover case
//   # keys also auto-read from sibling .env.local files (see CANDIDATES below)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let createMediaLCR, createKunavoMediaAdapter, createFalMediaAdapter, createRunwareMediaAdapter;
try {
  ({ createMediaLCR, createKunavoMediaAdapter, createFalMediaAdapter, createRunwareMediaAdapter } =
    await import(join(__dirname, "../dist/index.js")));
} catch (err) {
  console.error("✗ could not import ../dist/index.js — run `npm run build` first\n", err.message);
  process.exit(1);
}

// ── Resolve a key: env first, then any of the candidate sibling .env.local files ─
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
function resolveKey(name, candidates) {
  if (process.env[name]) return process.env[name];
  for (const rel of candidates) {
    const v = readEnv(join(__dirname, rel), name);
    if (v) return v;
  }
  return "";
}

// One provider case = a real async video model + a single-route price + adapter.
// externalIds are real (verified in ai-art's registry); these cost money to run.
const CASES = [
  {
    provider: "kunavo",
    modelId: "google/veo-3-lite",
    externalId: "veo-3-lite",
    pricing: { unit: "call", cents: 16 },
    key: resolveKey("KUNAVO_API_KEY", ["../../chat-diagram/.env.local"]),
    make: (apiKey, baseUrl) => createKunavoMediaAdapter({ apiKey, ...(baseUrl ? { baseUrl } : {}), pollIntervalMs: 5000 }),
  },
  {
    provider: "fal",
    modelId: "google/veo-3-1-lite",
    externalId: "fal-ai/veo3.1/lite",
    pricing: { unit: "second", cents: 8 },
    key: resolveKey("FAL_KEY", ["../../ai-art/apps/mintdreamer/.env.local"]),
    make: (apiKey, baseUrl) => createFalMediaAdapter({ apiKey, ...(baseUrl ? { baseUrl } : {}) }),
  },
  {
    provider: "runware",
    modelId: "tencent/hunyuan-video-1-5",
    externalId: "runware:hunyuanvideo@1.5",
    pricing: { unit: "second", cents: 2.33 },
    key: resolveKey("RUNWARE_API_KEY", [
      "../../ai-art/apps/mintdreamer/.env.local",
      "../../freeart/apps/freeredesign/.env.local",
    ]),
    make: (apiKey, baseUrl) => createRunwareMediaAdapter({ apiKey, ...(baseUrl ? { baseUrl } : {}) }),
  },
];

const VIDEO_INPUT = {
  prompt: "a calm ocean wave rolling onto a sandy beach at sunset",
  aspect_ratio: "16:9",
  duration: 5,
};

let pass = 0;
let fail = 0;
const ok = (m) => (console.log(`  ✅ ${m}`), pass++);
const bad = (m) => (console.log(`  ❌ ${m}`), fail++);

/** Drive submit → JSON round-trip → poll-to-terminal for one ai-lcr router. */
async function runToCompletion(lcr, modelId, label) {
  let handle = await lcr.submit(modelId, VIDEO_INPUT);
  if (!handle.requestId) return bad(`${label}: submit returned no requestId`), null;
  ok(`${label}: submitted → provider=${handle.provider} requestId=${handle.requestId.slice(0, 24)}…`);

  handle = JSON.parse(JSON.stringify(handle)); // cross-process boundary
  const deadline = Date.now() + 600_000;
  for (;;) {
    const r = await lcr.poll(handle);
    if (r.done) {
      ok(`${label}: done on ${r.provider}  cost=${r.costCents}¢ (estimated=${r.estimated})`);
      return r;
    }
    console.log(`     ${label}: status=${r.status}${r.failedOver ? " (FAILED OVER → " + r.handle.provider + ")" : ""}`);
    handle = r.handle;
    if (Date.now() > deadline) return bad(`${label}: poll exceeded 10m cap`), null;
    await new Promise((res) => setTimeout(res, 6000));
  }
}

/** HEAD-fetch the output URL and assert it returns real bytes. */
async function assertUrlFetches(url, label) {
  try {
    const res = await fetch(url, { method: "GET", headers: { range: "bytes=0-1023" } });
    const ct = res.headers.get("content-type") ?? "?";
    if (res.ok || res.status === 206) ok(`${label}: URL fetches (${res.status}, ${ct})`);
    else bad(`${label}: URL fetch returned ${res.status}`);
  } catch (err) {
    bad(`${label}: URL fetch threw: ${err.message}`);
  }
}

const present = CASES.filter((c) => c.key);
const skipped = CASES.filter((c) => !c.key).map((c) => c.provider);
console.log(`ai-lcr media async check — ${present.length} provider(s): ${present.map((c) => c.provider).join(", ") || "none"}`);
if (skipped.length) console.log(`(skipped, no key: ${skipped.join(", ")})`);
if (present.length === 0) {
  console.error("\n✗ no provider keys found (env or sibling .env.local)");
  process.exit(1);
}
console.log();

// ── Per-provider happy path ──────────────────────────────────────────────────
for (const c of present) {
  console.log(`[${c.provider}] ${c.modelId} (${c.externalId})`);
  const lcr = createMediaLCR({
    registry: {
      [c.modelId]: { id: c.modelId, modality: "video", routes: [{ provider: c.provider, externalId: c.externalId, pricing: c.pricing }] },
    },
    adapters: { [c.provider]: c.make(c.key) },
    onCall: (rec) => console.log(`     onCall: winner=${rec.winner ?? "—"} ok=${rec.ok} cost=$${rec.costUsd.toFixed(4)} ${rec.latencyMs}ms`),
  });
  try {
    const r = await runToCompletion(lcr, c.modelId, c.provider);
    if (r?.done) {
      if (r.costCents > 0) ok(`${c.provider}: cost is positive (${r.costCents}¢)`);
      else bad(`${c.provider}: cost is 0 — estimate/normalization broke`);
      await assertUrlFetches(r.outputs[0].url, c.provider);
    }
  } catch (err) {
    bad(`${c.provider}: threw — ${err.message}`);
  }
  console.log();
}

// ── Optional: live submit-time failover (dead URL first, real provider second) ─
if (process.env.PROBE_FAILOVER) {
  const c = present[0];
  console.log(`[failover] ${c.provider}: dead-URL route → live ${c.provider} (PROBE_FAILOVER=1)`);
  const down = `${c.provider}_down`;
  const lcr = createMediaLCR({
    registry: {
      [c.modelId]: {
        id: c.modelId,
        modality: "video",
        routes: [
          { provider: down, externalId: c.externalId, pricing: { unit: c.pricing.unit, cents: c.pricing.cents / 2 } }, // cheaper → tried first
          { provider: c.provider, externalId: c.externalId, pricing: c.pricing },
        ],
      },
    },
    adapters: {
      [down]: c.make(c.key, "https://router-failover-probe.invalid"), // DNS failure → retryable → fail over
      [c.provider]: c.make(c.key),
    },
    onError: (err, p) => console.log(`     onError (${p}): ${String(err.message).slice(0, 80)}`),
  });
  try {
    const r = await runToCompletion(lcr, c.modelId, "failover");
    if (r?.done && r.provider === c.provider) ok(`failover: routed to live ${c.provider} after the dead route`);
    else if (r?.done) bad(`failover: ended on ${r.provider}, expected ${c.provider}`);
  } catch (err) {
    bad(`failover: threw — ${err.message}`);
  }
  console.log();
}

console.log("──────────────────────────────────────────");
console.log(`PASS=${pass}  FAIL=${fail}`);
console.log(fail === 0 ? "✅ media async: submit/poll works live across providers" : "⚠️  review failures above");
process.exit(fail === 0 ? 0 : 1);
