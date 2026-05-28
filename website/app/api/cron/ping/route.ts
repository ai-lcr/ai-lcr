import { NextResponse } from "next/server";
import { getPool } from "@/lib/db9";
import { PROVIDERS, REACHABILITY_MODEL, type Provider } from "@/lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const TIMEOUT_MS = 15_000;

type PingResult = {
  provider: string;
  model: string;
  ok: boolean;
  latency_ms: number | null;
  error: string | null;
};

// One liveness heartbeat. For "reachable" providers, `model` is the sentinel
// REACHABILITY_MODEL; for "inference" providers it's a real model id.
//  - "inference": a real max_tokens:1 completion — proves the inference path
//    works (not just the gateway). For discount / quirky providers.
//  - "reachable": a free GET /v1/models — endpoint + auth reachable, 0 tokens.
async function ping(p: Provider, model: string): Promise<PingResult> {
  const key = process.env[p.apiKeyEnv];
  const base = { provider: p.id, model };
  if (!key) {
    return { ...base, ok: false, latency_ms: null, error: `missing env ${p.apiKeyEnv}` };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const r =
      p.check === "reachable"
        ? await fetch(`${p.base}/v1/models`, {
            method: "GET",
            headers: { Authorization: `Bearer ${key}` },
            signal: ctrl.signal,
          })
        : await fetch(`${p.base}/v1/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: "hi" }],
              // 16, not 1: reasoning models (e.g. gpt-5.1) reject a cap below 16.
              // Still a near-zero-cost heartbeat.
              max_tokens: 16,
            }),
            signal: ctrl.signal,
          });
    const latency_ms = Date.now() - t0;

    if (!r.ok) {
      const body = (await r.text()).replace(/\s+/g, " ").slice(0, 200);
      return { ...base, ok: false, latency_ms, error: `HTTP ${r.status}: ${body}` };
    }
    const j = await r.json();
    const ok =
      p.check === "reachable"
        ? Array.isArray(j?.data) && j.data.length > 0
        : Array.isArray(j?.choices) && j.choices.length > 0;
    const failMsg = p.check === "reachable" ? "no models in response" : "no choices in response";
    return { ...base, ok, latency_ms, error: ok ? null : failMsg };
  } catch (e) {
    const err = e as Error;
    return {
      ...base,
      ok: false,
      latency_ms: Date.now() - t0,
      error: err.name === "AbortError" ? "timeout" : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Flatten providers into individual (provider, model) liveness checks.
// "reachable" providers contribute one reachability check; "inference"
// providers contribute one check per listed model.
function pingTasks(): Array<Promise<PingResult>> {
  const tasks: Array<Promise<PingResult>> = [];
  for (const p of PROVIDERS) {
    if (p.check === "reachable" || p.models.length === 0) {
      tasks.push(ping(p, REACHABILITY_MODEL));
    } else {
      for (const m of p.models) tasks.push(ping(p, m.id));
    }
  }
  return tasks;
}

async function runChecks() {
  const results = await Promise.all(pingTasks());

  const pool = getPool();
  const placeholders = results
    .map((_, i) => `($${i * 5 + 1},$${i * 5 + 2},$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5})`)
    .join(",");
  const params = results.flatMap((r) => [r.provider, r.model, r.ok, r.latency_ms, r.error]);

  if (results.length > 0) {
    await pool.query(
      `INSERT INTO provider_pings (provider, model, ok, latency_ms, error) VALUES ${placeholders}`,
      params,
    );
  }
  // Keep the table tiny — drop anything older than 30 days.
  await pool.query(`DELETE FROM provider_pings WHERE checked_at < now() - interval '30 days'`);

  return results;
}

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  // If no secret configured, allow (e.g. local dev). In prod CRON_SECRET is set
  // and Vercel Cron sends it as a Bearer token automatically.
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const results = await runChecks();
    return NextResponse.json({ checked_at: new Date().toISOString(), results });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
