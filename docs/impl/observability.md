# Observability & self-hosted dashboard — implementation spec

> Implementation spec for ai-lcr's call logging and the companion self-hosted
> dashboard. This document describes the **generic, open-source** design only —
> no deployment, tenant, or product-specific configuration belongs here.

## Goal

Let any ai-lcr user answer, at a glance: *what did my app request over time, which
succeeded, and when a failover happened — which provider did it switch to, and
why?* Without ai-lcr becoming stateful, a hosted service, or holding anyone's data.

## Positioning constraint (why it's built this way)

ai-lcr is a **stateless routing primitive**, not an observability platform. So:

- The library **emits** a structured event and **never stores** anything.
- Where the event goes is 100% the caller's choice (console, a log drain, or a
  self-hosted dashboard). The library is dashboard-agnostic.
- The dashboard is a **separate, self-hostable** open-source app. Each user runs
  their own instance → no multi-tenant auth, no cross-user isolation, and the
  data never leaves the user's own infrastructure.

## Three layers

```
ai-lcr (library)            →  emits one CallRecord per request (onCall)
  formatCallRecord()        →  pure one-liner for console / log drains
  createHttpSink()          →  optional: POST each CallRecord to a URL
                                 │ (fire-and-forget, dashboard-agnostic)
                                 ▼
ai-lcr-dashboard (separate repo, self-hosted)
  /api/ingest               →  validate optional bearer, write to storage
  storage                   →  any Postgres via DATABASE_URL (db9 = zero-friction option)
  /                         →  Spend · Calls · Failover rate + live failover feed
```

### Layer 1 — the event (`onCall` + `CallRecord`)

One correlated record per settled request (success OR final failure), carrying the
full failover chain. Shipped; see `src/fallback.ts`.

```ts
interface RouteAttempt { provider: string; ok: boolean; latencyMs: number; errorClass?: string }
interface CallRecord {
  id: string;            // correlation id, one per request
  model: string;         // logical model name
  attempts: RouteAttempt[];
  winner?: string;       // serving provider; undefined if all failed
  ok: boolean;
  failedOver: boolean;
  latencyMs: number;
  inputTokens: number; outputTokens: number;
  costUsd: number;
}
```

- **Privacy by design:** `CallRecord` carries **no prompt or response content** —
  metadata only. Safe to centralize; nothing sensitive to leak.
- **Correlation across stream failover:** a per-call accumulator is threaded
  through the streaming failover recursion so a mid-stream switch appends to one
  record (not one per hop). See `doStreamWithCtx`.

### Layer 1.5 — the sink (`createHttpSink`)

Optional helper that turns `onCall` into a fire-and-forget POST. Shipped; see
`src/sink.ts`.

- Dashboard-agnostic: `url` points at anything accepting the CallRecord JSON.
- Never throws out of the app; failures swallowed (optional `onError`).
- `dispatch` hook so serverless callers pass `after`/`waitUntil` to avoid blocking
  or losing the POST when the function returns.
- Optional `project` tag merged into the payload for users running one instance
  across several apps.

### Layer 2 — the dashboard (`ai-lcr-dashboard`, separate repo)

A minimal Next.js app the user self-hosts.

**`/api/ingest` (POST)**
- Optional bearer check: if `INGEST_KEY` is set, require `Authorization: Bearer <key>`.
- Derive/accept a `project` tag (the instance owner controls trust — it's their box).
- Upsert one row into `lcr_calls` keyed by `id` (idempotent under client retries).
- Must be fast and side-effect-only; the SDK side is fire-and-forget.

**Storage — any Postgres, db9 as the zero-friction option**
- A single `pg` pool against `DATABASE_URL`. db9 (https://db9.ai) is plain
  Postgres over TLS, so the same driver serves both. db9's instant, disposable
  provisioning removes the "spin up a database" friction — recommend a
  `db:provision` script that creates the db9 database + the table in one step.

```sql
CREATE TABLE IF NOT EXISTS lcr_calls (
  id            text PRIMARY KEY,
  project       text NOT NULL DEFAULT 'default',
  ts            timestamptz NOT NULL DEFAULT now(),
  model         text NOT NULL,
  winner        text,
  ok            boolean NOT NULL,
  failed_over   boolean NOT NULL,
  latency_ms    integer NOT NULL,
  input_tokens  integer NOT NULL,
  output_tokens integer NOT NULL,
  cost_usd      numeric(12,6) NOT NULL,
  attempts      jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS lcr_calls_project_ts ON lcr_calls (project, ts DESC);
```

- Keep the table small with a retention `DELETE` (e.g. older than 90 days), mirroring
  the liveness-ping table's cleanup.
- db9 SQL note: aggregate with `GROUP BY` + `count(*) FILTER (...)`; avoid
  `WITHIN GROUP` / parameterized `::interval` casts (use inline interval literals).

**`/` (dashboard, server component)**
- Top metrics over a time window (1h / 24h / 7d / 30d): **Spend** (Σ cost_usd) ·
  **Calls** (count) · **Failover rate** (failed_over share).
- **Live failover feed:** recent rows rendered as the one-liner story
  (`✓ / ⚠ / ✗ provider→provider … ⤷ reason`).
- **Real provider mix:** counts grouped by `winner` (the demand-side complement to
  any synthetic provider-health monitor).
- **Top failover reasons:** `attempts` entries with `ok=false` grouped by `errorClass`.
- Optional single-instance gate (`DASHBOARD_PASSWORD`) — within one self-hosted
  instance, `project` is a filter, not a security boundary (the box is the owner's).

**Savings (follow-up):** `CallRecord` carries actual `costUsd` but no baseline. To
show "saved vs baseline", either (a) have ai-lcr compute a `baselineUsd` from the
priciest route using the same token counts, or (b) estimate in the dashboard from a
reference price table. Out of scope for the first cut.

## Versioning

`onCall` / `CallRecord` / `formatCallRecord` / `classifyError` / `createHttpSink`
ship together in **0.2.0** as the observability set. All additive — `onCost` /
`onError` are unchanged.

## Out of scope (explicitly not built here)

- Multi-user auth, billing, cross-tenant isolation (would only matter for a *hosted*
  offering; self-host sidesteps all of it).
- Prompt/response content logging (kept out by design — metadata only).
- Any specific deployment's project names, keys, or DB URLs (runtime env, never code).
