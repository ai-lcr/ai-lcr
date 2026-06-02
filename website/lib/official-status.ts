/**
 * Pull a provider's OWN public status page and normalize it.
 *
 * This is complementary to our probes, not a replacement: our liveness/integrity
 * checks tell you whether *our key* can call the model right now; the provider's
 * status page tells you whether *their whole platform* is healthy. Showing both
 * side by side lets you triage a red — "is it us (key/credit/rate-limit) or them
 * (global outage)?" — at a glance.
 *
 * Only Instatus is supported today (fal + Runware both run on it). Instatus
 * exposes per-component state at GET /v2/components.json, no auth, no API key:
 *   { "components": [ { "name", "status", "group": { "name" } | null }, ... ] }
 * Status enum: OPERATIONAL | UNDERMAINTENANCE | DEGRADEDPERFORMANCE
 *            | PARTIALOUTAGE | MAJOROUTAGE.
 */

export type OfficialStatusSource = {
  /** Only "instatus" today. */
  platform: "instatus";
  /** Status-page origin, no trailing slash. e.g. "https://status.fal.ai". */
  url: string;
};

export type OfficialComponent = {
  name: string;
  /** Containing group name, or null for a top-level component. */
  group: string | null;
  /** Raw Instatus status (OPERATIONAL, MAJOROUTAGE, …). */
  status: string;
};

export type OfficialStatus = {
  /** true = every component operational, false = at least one isn't, null = couldn't reach the page. */
  ok: boolean | null;
  components: OfficialComponent[];
  /** Link to the human status page. */
  url: string;
  /** Set when the page couldn't be fetched/parsed. */
  error?: string;
};

type InstatusComponentsResponse = {
  components?: Array<{
    name?: string;
    status?: string;
    group?: { name?: string } | null;
  }>;
};

/** Instatus statuses that count as "healthy". */
const HEALTHY = new Set(["OPERATIONAL"]);

export async function fetchOfficialStatus(src: OfficialStatusSource): Promise<OfficialStatus> {
  const url = src.url.replace(/\/$/, "");
  try {
    const res = await fetch(`${url}/v2/components.json`, {
      signal: AbortSignal.timeout(8000),
      // Cache the upstream call for 60s — the detail page is force-dynamic, but
      // there's no reason to hammer their status API on every visit.
      next: { revalidate: 60 },
    });
    if (!res.ok) {
      return { ok: null, components: [], url, error: `status page returned HTTP ${res.status}` };
    }
    const json = (await res.json()) as InstatusComponentsResponse;
    const components: OfficialComponent[] = (json.components ?? []).map((c) => ({
      name: c.name ?? "(unnamed)",
      group: c.group?.name ?? null,
      status: c.status ?? "UNKNOWN",
    }));
    if (components.length === 0) {
      return { ok: null, components, url, error: "status page exposed no components" };
    }
    const ok = components.every((c) => HEALTHY.has(c.status));
    return { ok, components, url };
  } catch (e) {
    return { ok: null, components: [], url, error: (e as Error).message };
  }
}

/** Lowercase, human-readable form of an Instatus status. */
export function officialStatusLabel(status: string): string {
  switch (status) {
    case "OPERATIONAL":
      return "operational";
    case "UNDERMAINTENANCE":
      return "under maintenance";
    case "DEGRADEDPERFORMANCE":
      return "degraded performance";
    case "PARTIALOUTAGE":
      return "partial outage";
    case "MAJOROUTAGE":
      return "major outage";
    default:
      return status.toLowerCase();
  }
}

/** Color var for an Instatus status, matching the page's palette. */
export function officialStatusColor(status: string): string {
  switch (status) {
    case "OPERATIONAL":
      return "var(--green)";
    case "DEGRADEDPERFORMANCE":
    case "UNDERMAINTENANCE":
      return "var(--amber)";
    case "PARTIALOUTAGE":
    case "MAJOROUTAGE":
      return "var(--red)";
    default:
      return "var(--faint)";
  }
}
