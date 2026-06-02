import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { PROVIDERS, REACHABILITY_MODEL, type Provider } from "@/lib/providers";

export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return PROVIDERS.map((p) => ({ provider: p.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ provider: string }>;
}): Promise<Metadata> {
  const { provider } = await params;
  const p = PROVIDERS.find((x) => x.id === provider);
  if (!p) return { title: "ai-lcr — Provider Status" };
  return {
    title: `${p.label} status — ai-lcr`,
    description: `Live uptime, latency and protocol-integrity for ${p.label}, monitored by ai-lcr.`,
  };
}

type AggRow = { model: string; up: number; total: number; avg_latency: number | null };
type LatestRow = { model: string; ok: boolean; latency_ms: number | null; error: string | null; checked_at: string };
type StripRow = { model: string; ok: boolean; latency_ms: number | null; checked_at: string };
type FailureRow = { model: string; error: string | null; checked_at: string };
type CheckRow = { model: string; check_name: string; status: string; detail: string | null; checked_at: string };

function pct(up: number, total: number): string {
  if (total === 0) return "—";
  return ((up / total) * 100).toFixed(up === total ? 0 : 1) + "%";
}
function ms(n: number | null): string {
  return n == null ? "—" : `${Math.round(n)}ms`;
}
function ago(iso?: string): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function when(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

const C = { green: "var(--green)", red: "var(--red)", amber: "var(--amber)", faint: "var(--faint)" };

const CHECK_ORDER = ["tool_call", "multi_step", "max_tokens", "injection", "token_inflation", "caching", "auth"];
const CHECK_LABEL: Record<string, string> = {
  tool_call: "Tool call",
  multi_step: "Multi-step tool loop",
  max_tokens: "max_tokens honored",
  injection: "No hidden-prompt injection",
  token_inflation: "Token count vs baseline",
  caching: "Prompt caching",
  auth: "API key",
};
function statusColor(s: string): string {
  return s === "pass" ? C.green : s === "fail" ? C.red : s === "warn" ? C.amber : C.faint;
}

function modelLabel(p: Provider, model: string): string {
  if (model === REACHABILITY_MODEL) {
    // Reflect the provider's actual probe (Runware POSTs a ping task; fal GETs
    // its model catalog) instead of a one-size-fits-all label.
    const probe = p.probe ?? { method: "GET", path: "/v1/models" };
    return `${probe.method} ${probe.path} (reachability)`;
  }
  return p.models.find((m) => m.id === model)?.label ?? model;
}

export default async function ProviderStatus({
  params,
}: {
  params: Promise<{ provider: string }>;
}) {
  const { provider } = await params;
  const p = PROVIDERS.find((x) => x.id === provider);
  if (!p) notFound();

  const liveModels = (() => {
    const ids = p.models.map((m) => m.id);
    if (p.check === "reachable" || p.reachable) ids.push(REACHABILITY_MODEL);
    return ids.length > 0 ? ids : [REACHABILITY_MODEL];
  })();

  let latest = new Map<string, LatestRow>();
  const day = new Map<string, AggRow>();
  const week = new Map<string, AggRow>();
  const month = new Map<string, AggRow>();
  const strips = new Map<string, StripRow[]>();
  let failures: FailureRow[] = [];
  let checks: CheckRow[] = [];
  let dbError: string | null = null;

  try {
    const pool = getPool();
    const agg = (interval: "24 hours" | "7 days" | "30 days") =>
      pool.query<AggRow>(
        `SELECT model,
                count(*) FILTER (WHERE ok)::int AS up,
                count(*)::int AS total,
                avg(latency_ms) FILTER (WHERE ok) AS avg_latency
         FROM provider_pings
         WHERE provider = $1 AND checked_at > now() - interval '${interval}'
         GROUP BY model`,
        [p.id],
      );

    const [latestQ, d, w, m, stripQ, failQ, checkQ] = await Promise.all([
      pool.query<LatestRow>(
        `SELECT DISTINCT ON (model) model, ok, latency_ms, error, checked_at
         FROM provider_pings WHERE provider = $1 ORDER BY model, checked_at DESC`,
        [p.id],
      ),
      agg("24 hours"),
      agg("7 days"),
      agg("30 days"),
      pool.query<StripRow>(
        `SELECT model, ok, latency_ms, checked_at FROM provider_pings
         WHERE provider = $1 AND checked_at > now() - interval '48 hours'
         ORDER BY checked_at ASC`,
        [p.id],
      ),
      pool.query<FailureRow>(
        `SELECT model, error, checked_at FROM provider_pings
         WHERE provider = $1 AND ok = false
         ORDER BY checked_at DESC LIMIT 12`,
        [p.id],
      ),
      pool.query<CheckRow>(
        `SELECT DISTINCT ON (model, check_name) model, check_name, status, detail, checked_at
         FROM provider_checks WHERE provider = $1
         ORDER BY model, check_name, checked_at DESC`,
        [p.id],
      ),
    ]);

    for (const r of latestQ.rows) latest.set(r.model, r);
    for (const r of d.rows) day.set(r.model, r);
    for (const r of w.rows) week.set(r.model, r);
    for (const r of m.rows) month.set(r.model, r);
    for (const r of stripQ.rows) {
      const arr = strips.get(r.model) ?? [];
      arr.push(r);
      strips.set(r.model, arr);
    }
    failures = failQ.rows;
    checks = checkQ.rows;
  } catch (e) {
    dbError = (e as Error).message;
    latest = new Map();
  }

  const anyKnown = liveModels.some((m) => latest.get(m));
  const allUp = liveModels.every((m) => latest.get(m)?.ok);
  const headColor = anyKnown ? (allUp ? C.green : C.red) : C.faint;
  const lastBeat = [...latest.values()].sort((a, b) => (a.checked_at < b.checked_at ? 1 : -1))[0];

  // Integrity checks grouped by model, ordered by CHECK_ORDER.
  const checksByModel = new Map<string, CheckRow[]>();
  for (const c of checks) {
    const arr = checksByModel.get(c.model) ?? [];
    arr.push(c);
    checksByModel.set(c.model, arr);
  }
  for (const arr of checksByModel.values()) {
    arr.sort((a, b) => CHECK_ORDER.indexOf(a.check_name) - CHECK_ORDER.indexOf(b.check_name));
  }
  const integrityModels = [...checksByModel.keys()];
  const integrityLatest = checks.reduce<string | undefined>(
    (acc, c) => (!acc || c.checked_at > acc ? c.checked_at : acc),
    undefined,
  );

  return (
    <>
      <nav className="nav">
        <div className="wrap nav__row">
          <a className="brand" href="/" style={{ textDecoration: "none", color: "inherit" }}>
            <span className="brand__word">ai<b>-lcr</b></span>
          </a>
          <div className="nav__links">
            <a href="/status">All providers</a>
          </div>
        </div>
      </nav>

      <main className="wrap" style={{ paddingTop: 40, paddingBottom: 80 }}>
        <a href="/status" style={{ color: "var(--muted)", fontSize: 13 }}>
          ← All providers
        </a>

        <header style={{ margin: "18px 0 28px" }}>
          <span className="eyebrow">
            <span className="dot" style={{ background: headColor }} />
            {anyKnown ? (allUp ? "Operational" : "Degraded") : "No data"}
          </span>
          <h1
            className="h1"
            style={{ fontSize: "clamp(28px,5vw,44px)", marginTop: 14, display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}
          >
            {p.link ? (
              <a href={p.link} target="_blank" rel="noreferrer" style={{ color: "var(--text)" }}>
                {p.label}
              </a>
            ) : (
              p.label
            )}
          </h1>
          <p className="sub" style={{ marginTop: 6 }}>
            {p.check} liveness across {liveModels.length}{" "}
            {liveModels.length === 1 ? "endpoint" : "models"}
            {lastBeat ? ` · last heartbeat ${ago(lastBeat.checked_at)}` : " · awaiting first heartbeat"}
          </p>
        </header>

        {dbError && (
          <p style={{ color: C.red, fontFamily: "var(--font-mono)", fontSize: 13 }}>
            status store unavailable: {dbError}
          </p>
        )}

        {/* Per-model liveness */}
        {liveModels.map((m) => {
          const d = day.get(m) ?? { model: m, up: 0, total: 0, avg_latency: null };
          const w = week.get(m) ?? { model: m, up: 0, total: 0, avg_latency: null };
          const mo = month.get(m) ?? { model: m, up: 0, total: 0, avg_latency: null };
          const l = latest.get(m);
          const strip = strips.get(m) ?? [];
          const up = l?.ok ?? false;
          const known = !!l;
          return (
            <section key={m} style={{ marginBottom: 30 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: known ? (up ? C.green : C.red) : C.faint,
                    flex: "0 0 auto",
                  }}
                />
                <code style={{ fontSize: 14, color: "var(--text)", fontWeight: 600 }}>{modelLabel(p, m)}</code>
                <span style={{ fontSize: 12, color: "var(--faint)" }}>
                  {known
                    ? `${up ? "operational" : "down"} · ${ago(l!.checked_at)}${l!.latency_ms != null ? ` · ${l!.latency_ms}ms` : ""}`
                    : "awaiting first heartbeat"}
                  {l && !up && l.error ? ` · ${l.error}` : ""}
                </span>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))",
                  gap: 10,
                  marginBottom: 14,
                }}
              >
                <Stat label="Uptime · 24h" value={pct(d.up, d.total)} sub={`${d.up}/${d.total} checks`} />
                <Stat label="Uptime · 7d" value={pct(w.up, w.total)} sub={`${w.up}/${w.total} checks`} />
                <Stat label="Uptime · 30d" value={pct(mo.up, mo.total)} sub={`${mo.up}/${mo.total} checks`} />
                <Stat label="Latency · 24h" value={ms(d.avg_latency)} sub={`7d ${ms(w.avg_latency)}`} />
              </div>

              {strip.length > 0 ? (
                <div style={{ display: "flex", gap: 2 }}>
                  {strip.map((s, i) => (
                    <span
                      key={i}
                      title={`${s.ok ? "up" : "down"}${s.latency_ms != null ? ` · ${s.latency_ms}ms` : ""} · ${when(s.checked_at)}`}
                      style={{
                        flex: "1 1 0",
                        height: 26,
                        borderRadius: 3,
                        background: s.ok ? C.green : C.red,
                        opacity: s.ok ? 0.55 : 0.85,
                        minWidth: 2,
                      }}
                    />
                  ))}
                </div>
              ) : (
                <p style={{ color: "var(--faint)", fontSize: 13 }}>No checks yet.</p>
              )}
            </section>
          );
        })}

        {/* Daily integrity suite */}
        {integrityModels.length > 0 && (
          <section style={{ marginTop: 8, marginBottom: 32 }}>
            <h2 style={{ fontSize: 14, color: "var(--muted)", margin: "0 0 4px" }}>
              Integrity suite · daily
            </h2>
            <p style={{ fontSize: 12, color: "var(--faint)", margin: "0 0 16px" }}>
              Protocol conformance from <code>scripts/check-provider.sh</code>
              {integrityLatest ? ` · last run ${ago(integrityLatest)}` : ""}. A fail here means this
              provider is not a safe least-cost target for that model.
            </p>
            {integrityModels.map((m) => (
              <div key={m} style={{ marginBottom: 18 }}>
                <code style={{ fontSize: 13, color: "var(--text)", fontWeight: 600 }}>{m}</code>
                <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                  {(checksByModel.get(m) ?? []).map((c) => (
                    <div
                      key={c.check_name}
                      style={{
                        display: "flex",
                        gap: 12,
                        alignItems: "baseline",
                        fontSize: 13,
                        borderBottom: "1px solid var(--line)",
                        paddingBottom: 6,
                        flexWrap: "wrap",
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontWeight: 700,
                          fontSize: 11,
                          textTransform: "uppercase",
                          color: statusColor(c.status),
                          flex: "0 0 52px",
                        }}
                      >
                        {c.status}
                      </span>
                      <span style={{ color: "var(--text)", flex: "0 0 auto", minWidth: 180 }}>
                        {CHECK_LABEL[c.check_name] ?? c.check_name}
                      </span>
                      {c.detail && (
                        <span
                          style={{
                            color: "var(--muted)",
                            fontFamily: "var(--font-mono)",
                            fontSize: 12,
                            wordBreak: "break-word",
                            flex: "1 1 200px",
                          }}
                        >
                          {c.detail}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}

        {/* Liveness failures */}
        <h2 style={{ fontSize: 14, color: "var(--muted)", margin: "0 0 10px" }}>
          Recent liveness failures
        </h2>
        {failures.length > 0 ? (
          <div style={{ display: "grid", gap: 6 }}>
            {failures.map((f, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 14,
                  fontSize: 12.5,
                  fontFamily: "var(--font-mono)",
                  color: "var(--muted)",
                  borderBottom: "1px solid var(--line)",
                  paddingBottom: 6,
                  flexWrap: "wrap",
                }}
              >
                <span style={{ color: "var(--faint)", flex: "0 0 auto" }}>{when(f.checked_at)}</span>
                <span style={{ color: "var(--text)", flex: "0 0 auto" }}>{modelLabel(p, f.model)}</span>
                <span style={{ color: C.red, wordBreak: "break-word", flex: "1 1 200px" }}>
                  {f.error ?? "unknown error"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: "var(--faint)", fontSize: 13 }}>
            No liveness failures recorded in the last 30 days.
          </p>
        )}
      </main>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div
      style={{
        border: "1px solid var(--line)",
        background: "var(--panel)",
        borderRadius: 12,
        padding: "12px 14px",
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{label}</div>
      <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 2 }}>{sub}</div>
    </div>
  );
}
