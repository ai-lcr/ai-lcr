import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ai-lcr vs ai-fallback vs OpenRouter — LLM routing & failover compared",
  description:
    "How ai-lcr compares to ai-fallback, OpenRouter's built-in fallback, and a single raw provider: cheapest-first routing, mid-stream failover, real cost tracking, your own keys (no proxy markup), cross-provider mixing, and image/video routing.",
};

// Static page — no DB, no live data.
export const dynamic = "force-static";

type Cell = { v: "yes" | "no" | "partial"; note: string };
type Row = { feature: string; lcr: Cell; fallback: Cell; openrouter: Cell; single: Cell };

const COLUMNS = [
  { key: "lcr", label: "ai-lcr", highlight: true },
  { key: "fallback", label: "ai-fallback" },
  { key: "openrouter", label: "OpenRouter\nfallback" },
  { key: "single", label: "Single\nprovider" },
] as const;

const Y = (note: string): Cell => ({ v: "yes", note });
const N = (note: string): Cell => ({ v: "no", note });
const P = (note: string): Cell => ({ v: "partial", note });

const ROWS: Row[] = [
  {
    feature: "Automatic failover on error",
    lcr: Y("Built-in engine"),
    fallback: Y("Its core feature"),
    openrouter: Y("Within OR's network"),
    single: N("One provider, no retry path"),
  },
  {
    feature: "Streaming-safe (reroute mid-stream)",
    lcr: Y("Reroutes after a failed chunk"),
    fallback: Y("Same approach ai-lcr adapts"),
    openrouter: P("New requests only, not mid-stream"),
    single: N(),
  },
  {
    feature: "Cheapest-first routing across providers",
    lcr: Y("autoSort by per-1M cost"),
    fallback: N("Priority order, cost-unaware"),
    openrouter: P("sort=price, but only OR's routes"),
    single: N(),
  },
  {
    feature: "Real per-call cost (USD) callback",
    lcr: Y("onCost fires actual $ per call"),
    fallback: N(),
    openrouter: P("usage in response; you compute $"),
    single: P("usage in response; you compute $"),
  },
  {
    feature: "Your own keys — no proxy, no markup",
    lcr: Y("Calls each vendor directly"),
    fallback: Y("Any AI SDK model"),
    openrouter: N("All traffic proxied through OR"),
    single: Y("Direct to one vendor"),
  },
  {
    feature: "Mix native APIs + aggregators in one list",
    lcr: Y("DeepSeek API + Kunavo + OpenRouter…"),
    fallback: Y("Any models you pass"),
    openrouter: N("Only models OR itself hosts"),
    single: N(),
  },
  {
    feature: "Image & video routing",
    lcr: Y("Media LCR: fal / Runware / Kunavo"),
    fallback: N("Text models only"),
    openrouter: N("Text / multimodal chat only"),
    single: N(),
  },
  {
    feature: "Capability + cost probe to vet a provider",
    lcr: Y("check-provider.sh → trust matrix"),
    fallback: N(),
    openrouter: N(),
    single: N(),
  },
  {
    feature: "Recover to cheapest after idle window",
    lcr: Y("resetIntervalMs, default 60s"),
    fallback: P("Resets on a cooldown"),
    openrouter: N("OR decides routing each request"),
    single: N(),
  },
  {
    feature: "Runs in your process — no added hop",
    lcr: Y("It's a library"),
    fallback: Y("It's a library"),
    openrouter: N("External service in the path"),
    single: Y("Direct call"),
  },
];

function Mark({ cell, highlight }: { cell: Cell; highlight?: boolean }) {
  const color =
    cell.v === "yes" ? "var(--green)" : cell.v === "partial" ? "var(--amber)" : "var(--faint)";
  const glyph = cell.v === "yes" ? "✓" : cell.v === "partial" ? "~" : "—";
  return (
    <td
      style={{
        padding: "14px 16px",
        borderTop: "1px solid var(--line)",
        background: highlight ? "color-mix(in srgb, var(--green) 7%, transparent)" : undefined,
        verticalAlign: "top",
      }}
    >
      <span style={{ color, fontWeight: 700, fontSize: 15 }}>{glyph}</span>
      {cell.note ? (
        <span style={{ color: "var(--muted)", fontSize: 12.5, marginLeft: 8, lineHeight: 1.5 }}>
          {cell.note}
        </span>
      ) : null}
    </td>
  );
}

export default function Compare() {
  return (
    <>
      <nav className="nav">
        <div className="wrap nav__row">
          <a className="brand" href="/" style={{ textDecoration: "none", color: "inherit" }}>
            <span className="brand__word">ai<b>-lcr</b></span>
          </a>
          <div className="nav__links">
            <a href="/status">Status</a>
            <a href="/prices">Prices</a>
            <a href="/">Home</a>
          </div>
        </div>
      </nav>

      <main className="wrap" style={{ paddingTop: 48, paddingBottom: 80 }}>
        <header style={{ marginBottom: 28 }}>
          <h1 className="h1" style={{ fontSize: "clamp(28px,5vw,42px)", margin: 0, maxWidth: "none" }}>
            ai-lcr vs <span className="accent">the alternatives</span>
          </h1>
          <p className="sub" style={{ margin: "12px 0 0", maxWidth: "70ch" }}>
            Three honest ways to call an LLM with a backup: the{" "}
            <a className="ilink" href="https://github.com/remorses/ai-fallback" target="_blank" rel="noreferrer">
              ai-fallback
            </a>{" "}
            library, <a className="ilink" href="https://openrouter.ai" target="_blank" rel="noreferrer">OpenRouter</a>'s
            built-in fallback, or a single raw provider. Here's where each lands — and where ai-lcr's
            cost-first routing, your-own-keys model, and media support pull ahead.
          </p>
        </header>

        <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 14 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760, fontSize: 14 }}>
            <thead>
              <tr>
                <th
                  style={{
                    textAlign: "left",
                    padding: "14px 16px",
                    color: "var(--muted)",
                    fontWeight: 600,
                    fontSize: 13,
                  }}
                >
                  Capability
                </th>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    style={{
                      textAlign: "left",
                      padding: "14px 16px",
                      whiteSpace: "pre-line",
                      fontWeight: 700,
                      color: c.highlight ? "var(--green)" : "var(--text)",
                      background: c.highlight
                        ? "color-mix(in srgb, var(--green) 10%, transparent)"
                        : undefined,
                      borderTopLeftRadius: c.highlight ? 0 : undefined,
                    }}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.feature}>
                  <td
                    style={{
                      padding: "14px 16px",
                      borderTop: "1px solid var(--line)",
                      color: "var(--text)",
                      fontWeight: 500,
                      verticalAlign: "top",
                    }}
                  >
                    {row.feature}
                  </td>
                  <Mark cell={row.lcr} highlight />
                  <Mark cell={row.fallback} />
                  <Mark cell={row.openrouter} />
                  <Mark cell={row.single} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 14,
            marginTop: 28,
          }}
        >
          {[
            {
              t: "vs ai-fallback",
              d: "ai-lcr is built on the same streaming-safe failover engine (credited & adapted), then adds cost-first ordering, a real onCost callback, image/video routing, and a provider probe. If you only need plain priority failover, ai-fallback is a great minimal pick.",
            },
            {
              t: "vs OpenRouter fallback",
              d: "OpenRouter's catalog and single bill are genuinely convenient. But every call is proxied through it (markup, no native vendor keys), and you can't mix in a vendor's own API or a cheaper aggregator like Kunavo. ai-lcr routes to each vendor directly with your keys.",
            },
            {
              t: "vs a single provider",
              d: "One provider is the simplest thing that works — until it's down, or another provider is half the price. ai-lcr keeps the same call site and adds the backup + savings without a rewrite.",
            },
          ].map((c) => (
            <div
              key={c.t}
              style={{
                border: "1px solid var(--line)",
                borderRadius: 12,
                padding: 16,
                background: "var(--panel)",
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 6, color: "var(--text)" }}>{c.t}</div>
              <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.6, margin: 0 }}>{c.d}</p>
            </div>
          ))}
        </div>

        <p style={{ color: "var(--faint)", fontSize: 12.5, marginTop: 28, lineHeight: 1.7 }}>
          <b style={{ color: "var(--muted)" }}>Notes.</b> <b>✓</b> full support, <b>~</b> partial /
          with caveats, <b>—</b> not supported. Comparison reflects each tool's documented behavior at
          the time of writing; competitors evolve — verify against their current docs. ai-lcr's
          failover engine is adapted from ai-fallback (MIT) and credited in the{" "}
          <a className="ilink" href="https://github.com/victorzhrn/ai-lcr#credits" target="_blank" rel="noreferrer">
            README
          </a>
          .
        </p>
      </main>

      <footer className="footer">
        <div className="wrap footer__row">
          <span>ai-lcr — MIT · Least Cost Routing, the way carriers have done it for decades</span>
          <span className="footer__links">
            <a href="/status">Status</a>
            <a href="/prices">Prices</a>
            <a href="/">Home</a>
            <a href="https://github.com/victorzhrn/ai-lcr" target="_blank" rel="noreferrer">GitHub</a>
          </span>
        </div>
      </footer>
    </>
  );
}
