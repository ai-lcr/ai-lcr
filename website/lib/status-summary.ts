import { getPool } from "./db";
import { PROVIDERS, REACHABILITY_MODEL } from "./providers";

export interface ProviderStatus {
  id: string;
  label: string;
  link?: string;
  checkMode: string;
  state: "up" | "degraded" | "unknown";
  uptimePct: number | null;
  integrity: { pass: number; total: number } | null;
}

export interface StatusSummary {
  providers: ProviderStatus[];
  allUp: boolean;
  anyData: boolean;
}

const k = (provider: string, model: string) => `${provider} ${model}`;

function livenessModels(id: string): string[] {
  const p = PROVIDERS.find((x) => x.id === id)!;
  const ids = p.models.map((m) => m.id);
  if (p.check === "reachable" || p.reachable) ids.push(REACHABILITY_MODEL);
  return ids.length > 0 ? ids : [REACHABILITY_MODEL];
}

// Lightweight per-provider rollup for the homepage strip. Mirrors the /status
// page logic but returns only summary numbers. Swallows DB errors (the build
// step has no DB credentials) so the homepage still renders, just empty.
export async function statusSummary(): Promise<StatusSummary> {
  const empty: StatusSummary = { providers: [], allUp: false, anyData: false };
  try {
    const pool = getPool();
    const [latestQ, dayQ, checkQ] = await Promise.all([
      pool.query<{ provider: string; model: string; ok: boolean }>(
        `SELECT DISTINCT ON (provider, model) provider, model, ok
         FROM provider_pings ORDER BY provider, model, checked_at DESC`,
      ),
      pool.query<{ provider: string; up: number; total: number }>(
        `SELECT provider, count(*) FILTER (WHERE ok)::int AS up, count(*)::int AS total
         FROM provider_pings WHERE checked_at > now() - interval '24 hours'
         GROUP BY provider`,
      ),
      pool.query<{ provider: string; status: string }>(
        `SELECT provider, status FROM (
           SELECT DISTINCT ON (provider, model, check_name) provider, status
           FROM provider_checks
           ORDER BY provider, model, check_name, checked_at DESC
         ) latest`,
      ),
    ]);

    const latest = new Map<string, boolean>();
    for (const r of latestQ.rows) latest.set(k(r.provider, r.model), r.ok);

    const day = new Map<string, { up: number; total: number }>();
    for (const r of dayQ.rows) day.set(r.provider, { up: r.up, total: r.total });

    const integ = new Map<string, { pass: number; total: number }>();
    for (const r of checkQ.rows) {
      if (r.status === "skip") continue;
      const cur = integ.get(r.provider) ?? { pass: 0, total: 0 };
      cur.total += 1;
      if (r.status === "pass") cur.pass += 1;
      integ.set(r.provider, cur);
    }

    const providers: ProviderStatus[] = PROVIDERS.map((p) => {
      const models = livenessModels(p.id);
      const known = models.some((m) => latest.has(k(p.id, m)));
      const up = known && models.every((m) => latest.get(k(p.id, m)) === true);
      const d = day.get(p.id);
      return {
        id: p.id,
        label: p.label,
        link: p.link,
        checkMode: p.check,
        state: !known ? "unknown" : up ? "up" : "degraded",
        uptimePct: d && d.total > 0 ? (d.up / d.total) * 100 : null,
        integrity: integ.get(p.id) ?? null,
      };
    });

    const anyData = latest.size > 0;
    return {
      providers,
      allUp: anyData && providers.every((p) => p.state === "up"),
      anyData,
    };
  } catch {
    return empty;
  }
}
