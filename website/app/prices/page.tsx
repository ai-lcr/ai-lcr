import type { Metadata } from "next";
import {
  comparison,
  textComparison,
  PROVIDER_COLUMNS,
  PROVIDER_META,
  TEXT_PROVIDER_COLUMNS,
  TEXT_PROVIDER_META,
  REFERENCE_LABEL,
  MODEL_COUNT,
  TEXT_MODEL_COUNT,
} from "@/lib/prices";
import PriceTable from "./PriceTable";

export const metadata: Metadata = {
  title: "ai-lcr — Cheapest provider per model (text, image & video)",
  description:
    "Official cheapest-provider recommendation across OpenRouter, Kunavo, TokenMart, fal and Runware. Text LLMs priced per 1M tokens (input / output); image & video normalized to one 16:9 1080p image / 5-second clip so providers compare directly. Filter by open-weight vs proprietary, vendor, and modality.",
};

// Static table — no DB, no live data. Safe to prerender.
export const dynamic = "force-static";

export default function Prices() {
  const rows = comparison();
  const columns = PROVIDER_COLUMNS.map((id) => ({
    id,
    label: PROVIDER_META[id]?.label ?? id,
    link: PROVIDER_META[id]?.link,
  }));
  const textRows = textComparison();
  const textColumns = TEXT_PROVIDER_COLUMNS.map((id) => ({
    id,
    label: TEXT_PROVIDER_META[id]?.label ?? id,
    link: TEXT_PROVIDER_META[id]?.link,
  }));

  return (
    <>
      <nav className="nav">
        <div className="wrap nav__row">
          <a className="brand" href="/" style={{ textDecoration: "none", color: "inherit" }}>
            <span className="brand__word">ai<b>-lcr</b></span>
          </a>
          <div className="nav__links">
            <a href="/status">Status</a>
            <a href="/">Home</a>
          </div>
        </div>
      </nav>

      <main className="wrap" style={{ paddingTop: 48, paddingBottom: 80 }}>
        <header style={{ marginBottom: 28 }}>
          <h1
            className="h1"
            style={{ fontSize: "clamp(28px,5vw,42px)", margin: 0, maxWidth: "none" }}
          >
            The <span className="accent">cheapest provider</span> for every model.
          </h1>
          <p className="sub" style={{ margin: "12px 0 0", maxWidth: "68ch" }}>
            {TEXT_MODEL_COUNT} text LLMs + {MODEL_COUNT}&nbsp;image &amp; video models. Text per 1M tokens
            (in&nbsp;/&nbsp;out); media normalized to one reference output (
            <strong>{REFERENCE_LABEL}</strong>).
            The <b style={{ color: "var(--green)" }}>green</b> cell is the cheapest route ai-lcr picks
            first.
          </p>
        </header>

        <PriceTable rows={rows} columns={columns} textRows={textRows} textColumns={textColumns} />

        <p style={{ color: "var(--faint)", fontSize: 12.5, marginTop: 24, lineHeight: 1.7 }}>
          <b style={{ color: "var(--muted)" }}>Notes.</b> Text rates are per 1M tokens (input /
          output). <b>Official</b> is the model maker&apos;s own first-party list price (OpenAI,
          Anthropic, Google, Z.ai, DeepSeek, Moonshot, etc.); <b>OpenRouter</b>, <b>Kunavo</b> and{" "}
          <b>TokenMart</b> are pulled live from each provider&apos;s <code>/v1/models</code>. The{" "}
          <b style={{ color: "var(--green)" }}>green</b> cell + <em>Best</em> column mark the cheapest
          buyable route and its discount versus Official. A listed price ≠ a working route — some
          discount upstreams aren&apos;t provisioned and 502 in practice, so re-probe before routing;
          the live status page tracks which are actually up. Image &amp; video models are normalized
          to {REFERENCE_LABEL} instead (Kunavo bills a flat <em>per-call</em> fee while fal/Runware
          bill <em>per-second</em>); their <b>Official</b> column is the maker&apos;s first-party API
          rate at the closest standard tier (open-weight models with no first-party API show
          &ldquo;—&rdquo;), so it&apos;s a directional reference, not a SKU-exact match. License tags
          are best-effort (<em>open</em> = downloadable weights, <em>proprietary</em> = API-only).
        </p>
      </main>
    </>
  );
}
