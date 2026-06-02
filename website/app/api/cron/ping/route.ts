import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { PROVIDERS, REACHABILITY_MODEL, type Provider, type ReachProbe } from "@/lib/providers";
import { fetchOfficialStatus } from "@/lib/official-status";

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

// Default reachability probe for OpenAI-compatible providers: a free
// GET /v1/models (endpoint + auth reachable, 0 tokens). Media providers
// (Runware/fal) override this with `p.probe`.
const DEFAULT_REACHABLE: ReachProbe = {
  method: "GET",
  path: "/v1/models",
  ok: (j) => Array.isArray((j as { data?: unknown[] })?.data) && (j as { data: unknown[] }).data.length > 0,
};

// One liveness heartbeat.
//  - "inference": a real max_tokens:16 completion against `model` — proves the
//    inference path works (not just the gateway). For discount / quirky providers.
//  - "reachable": a free probe — GET /v1/models by default, or the provider's
//    custom `probe` (Runware ping task / fal billing). 0 tokens, no generation.
//    `model` is the sentinel REACHABILITY_MODEL.
async function ping(p: Provider, model: string, mode: "inference" | "reachable"): Promise<PingResult> {
  const key = process.env[p.apiKeyEnv];
  const base = { provider: p.id, model };
  if (!key) {
    return { ...base, ok: false, latency_ms: null, error: `missing env ${p.apiKeyEnv}` };
  }

  const probe = mode === "reachable" ? p.probe ?? DEFAULT_REACHABLE : null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const r = probe
      ? await fetch(`${p.base}${probe.path}`, {
          method: probe.method,
          headers: {
            Authorization: probe.auth ? probe.auth(key) : `Bearer ${key}`,
            ...(probe.method === "POST" ? { "Content-Type": "application/json" } : {}),
          },
          ...(probe.body !== undefined ? { body: JSON.stringify(probe.body) } : {}),
          signal: ctrl.signal,
        })
      : await fetch(`${p.base}${p.chatPath ?? "/v1/chat/completions"}`, {
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
    const ok = probe
      ? (probe.ok ?? (() => true))(j)
      : Array.isArray(j?.choices) && j.choices.length > 0;
    const failMsg = probe ? "reachability check failed" : "no choices in response";
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

type OfficialRow = {
  provider: string;
  component: string;
  grp: string | null;
  status: string;
  ok: boolean;
};

// Pull each provider's OWN status page (Instatus) and flatten to one heartbeat
// row per component. Recorded on the same 15-min cadence as our probes so the
// detail page can show their self-reported uptime in the same style as ours.
// A page we can't reach (ok: null / no components) records nothing this tick —
// better an honest gap than a synthetic value poisoning the uptime%.
async function officialTasks(): Promise<OfficialRow[]> {
  const providers = PROVIDERS.filter((p) => p.officialStatus);
  const perProvider = await Promise.all(
    providers.map(async (p) => {
      const s = await fetchOfficialStatus(p.officialStatus!);
      return s.components.map((c) => ({
        provider: p.id,
        component: c.name,
        grp: c.group,
        status: c.status,
        ok: c.ok,
      }));
    }),
  );
  return perProvider.flat();
}

// Flatten providers into individual liveness checks: one inference ping per
// listed model, plus a free reachability ping when check==="reachable" or the
// provider opts in via `reachable` (so OpenRouter gets both GPT + endpoint up).
function pingTasks(): Array<Promise<PingResult>> {
  const tasks: Array<Promise<PingResult>> = [];
  for (const p of PROVIDERS) {
    for (const m of p.models) tasks.push(ping(p, m.id, "inference"));
    if (p.check === "reachable" || p.reachable) {
      tasks.push(ping(p, REACHABILITY_MODEL, "reachable"));
    }
  }
  return tasks;
}

async function runChecks() {
  // Liveness probes and official-status pulls are independent — run concurrently
  // so the cron's wall-clock is max(), not sum().
  const [results, official] = await Promise.all([Promise.all(pingTasks()), officialTasks()]);

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

  await recordOfficial(pool, official);

  return { results, official: official.length };
}

// Persist official-status heartbeats. Self-bootstraps the table (no migration
// framework in this repo — the cron is the only writer), then bulk-inserts one
// row per component and trims to a 30-day window, mirroring provider_pings.
async function recordOfficial(pool: ReturnType<typeof getPool>, rows: OfficialRow[]) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS provider_official (
       provider   text NOT NULL,
       component  text NOT NULL,
       grp        text,
       status     text NOT NULL,
       ok         boolean NOT NULL,
       checked_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS provider_official_lookup
       ON provider_official (provider, component, checked_at DESC)`,
  );

  if (rows.length > 0) {
    const placeholders = rows
      .map((_, i) => `($${i * 5 + 1},$${i * 5 + 2},$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5})`)
      .join(",");
    const params = rows.flatMap((r) => [r.provider, r.component, r.grp, r.status, r.ok]);
    await pool.query(
      `INSERT INTO provider_official (provider, component, grp, status, ok) VALUES ${placeholders}`,
      params,
    );
  }
  await pool.query(`DELETE FROM provider_official WHERE checked_at < now() - interval '30 days'`);
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
    const { results, official } = await runChecks();
    return NextResponse.json({ checked_at: new Date().toISOString(), official, results });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
