import type { Metadata } from "next";
import { getPool } from "@/lib/db9";
import { PROVIDERS } from "@/lib/providers";

// Always read live from db9 — a status page must not serve a stale snapshot,
// and the build step has no DB credentials to prerender against.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "ai-lcr — Provider Status",
  description:
    "Live uptime for the LLM providers ai-lcr routes across. Heartbeat every 15 minutes.",
};

type Latest = {
  provider: string;
  model: string;
  ok: boolean;
  latency_ms: number | null;
  error: string | null;
  checked_at: string;
};
type Agg = { provider: string; up: number; total: number; avg_latency: number | null };
type Strip = { provider: string; ok: boolean; checked_at: string };

type Data = {
  latest: Map<string, Latest>;
  day: Map<string, Agg>;
  week: Map<string, Agg>;
  strips: Map<string, Strip[]>;
  error?: string;
};

async function load(): Promise<Data> {
  const empty: Data = {
    latest: new Map(),
    day: new Map(),
    week: new Map(),
    strips: new Map(),
  };
  try {
    const pool = getPool();
    const [latestQ, dayQ, weekQ, stripQ] = await Promise.all([
      pool.query<Latest>(
        `SELECT DISTINCT ON (provider) provider, model, ok, latency_ms, error, checked_at
         FROM provider_pings ORDER BY provider, checked_at DESC`,
      ),
      pool.query<Agg>(
        `SELECT provider,
                count(*) FILTER (WHERE ok)::int AS up,
                count(*)::int AS total,
                avg(latency_ms) FILTER (WHERE ok) AS avg_latency
         FROM provider_pings
         WHERE checked_at > now() - interval '24 hours'
         GROUP BY provider`,
      ),
      pool.query<Agg>(
        `SELECT provider,
                count(*) FILTER (WHERE ok)::int AS up,
                count(*)::int AS total,
                avg(latency_ms) FILTER (WHERE ok) AS avg_latency
         FROM provider_pings
         WHERE checked_at > now() - interval '7 days'
         GROUP BY provider`,
      ),
      pool.query<Strip>(
        `SELECT provider, ok, checked_at FROM provider_pings
         WHERE checked_at > now() - interval '12 hours'
         ORDER BY checked_at ASC`,
      ),
    ]);

    const data: Data = { ...empty };
    for (const r of latestQ.rows) data.latest.set(r.provider, r);
    for (const r of dayQ.rows) data.day.set(r.provider, r);
    for (const r of weekQ.rows) data.week.set(r.provider, r);
    for (const r of stripQ.rows) {
      const arr = data.strips.get(r.provider) ?? [];
      arr.push(r);
      data.strips.set(r.provider, arr);
    }
    return data;
  } catch (e) {
    return { ...empty, error: (e as Error).message };
  }
}

function pct(a?: Agg): string {
  if (!a || a.total === 0) return "—";
  return ((a.up / a.total) * 100).toFixed(a.up === a.total ? 0 : 1) + "%";
}

function ago(iso?: string): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const C = {
  green: "var(--green)",
  red: "var(--red)",
  faint: "var(--faint)",
};

export default async function Status() {
  const data = await load();
  const anyData = data.latest.size > 0;
  const allUp =
    anyData && PROVIDERS.every((p) => data.latest.get(p.id)?.ok);

  return (
    <>
      <nav className="nav">
        <div className="wrap nav__row">
          <a className="brand" href="/" style={{ textDecoration: "none", color: "inherit" }}>
            <span className="brand__word">ai<b>-lcr</b></span>
          </a>
          <div className="nav__links">
            <a href="/">Home</a>
          </div>
        </div>
      </nav>

      <main className="wrap" style={{ paddingTop: 48, paddingBottom: 80 }}>
        <header style={{ marginBottom: 32 }}>
          <span className="eyebrow">
            <span
              className="dot"
              style={{ background: anyData ? (allUp ? C.green : C.red) : C.faint }}
            />
            Provider Status
          </span>
          <h1 className="h1" style={{ fontSize: "clamp(28px,5vw,44px)", marginTop: 14 }}>
            {!anyData
              ? "Awaiting first check"
              : allUp
                ? "All providers operational"
                : "Some providers degraded"}
          </h1>
          <p className="sub" style={{ marginTop: 8 }}>
            Each provider gets a heartbeat every 15 minutes — a <code>max_tokens: 1</code>{" "}
            completion where we verify real inference, or a lightweight reachability ping
            for trusted endpoints. Uptime reflects those heartbeats.
          </p>
        </header>

        {data.error && (
          <p style={{ color: C.red, fontFamily: "var(--font-mono)", fontSize: 13 }}>
            status store unavailable: {data.error}
          </p>
        )}

        <div style={{ display: "grid", gap: 14 }}>
          {PROVIDERS.map((p) => {
            const latest = data.latest.get(p.id);
            const strip = data.strips.get(p.id) ?? [];
            const up = latest?.ok ?? false;
            const known = !!latest;
            const color = known ? (up ? C.green : C.red) : C.faint;
            return (
              <section
                key={p.id}
                style={{
                  border: "1px solid var(--line)",
                  background: "var(--panel)",
                  borderRadius: 14,
                  padding: "18px 20px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: color,
                      boxShadow: known && up ? `0 0 10px ${C.green}` : "none",
                      flex: "0 0 auto",
                    }}
                  />
                  <div style={{ flex: "1 1 auto", minWidth: 200 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                      <a
                        href={`/status/${p.id}`}
                        style={{ fontWeight: 700, fontSize: 17, color: "var(--text)" }}
                      >
                        {p.label}
                      </a>
                      <code style={{ color: "var(--muted)", fontSize: 12 }}>{p.model}</code>
                    </div>
                    <div style={{ color: "var(--faint)", fontSize: 12, marginTop: 2 }}>
                      {known
                        ? `${up ? "operational" : "down"} · checked ${ago(latest!.checked_at)} · ${p.check} check`
                        : `no data yet · ${p.check} check`}
                      {latest && !up && latest.error ? ` · ${latest.error}` : ""}
                    </div>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 22,
                      fontSize: 13,
                      color: "var(--muted)",
                      flex: "0 0 auto",
                    }}
                  >
                    <Metric label="24h" value={pct(data.day.get(p.id))} />
                    <Metric label="7d" value={pct(data.week.get(p.id))} />
                    <Metric
                      label="latency"
                      value={
                        latest?.latency_ms != null ? `${latest.latency_ms}ms` : "—"
                      }
                    />
                  </div>
                </div>

                {strip.length > 0 && (
                  <div style={{ display: "flex", gap: 3, marginTop: 14 }}>
                    {strip.slice(-48).map((s, i) => (
                      <span
                        key={i}
                        title={`${s.ok ? "up" : "down"} · ${ago(s.checked_at)}`}
                        style={{
                          flex: "1 1 0",
                          height: 22,
                          borderRadius: 3,
                          background: s.ok ? C.green : C.red,
                          opacity: s.ok ? 0.55 : 0.85,
                          minWidth: 2,
                        }}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        <p style={{ color: "var(--faint)", fontSize: 12, marginTop: 28 }}>
          Heartbeat history kept 30 days · last 12h shown above. ai-lcr routes to the
          cheapest <em>healthy</em> provider, falling back automatically when one goes down.
        </p>
      </main>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: "right" }}>
      <div style={{ color: "var(--text)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      <div style={{ color: "var(--faint)", fontSize: 11 }}>{label}</div>
    </div>
  );
}
