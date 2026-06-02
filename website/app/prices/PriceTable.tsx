"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ComparisonRow,
  type TextRow,
  type License,
  vendorLabel,
  providerLabel,
  textProviderLabel,
} from "@/lib/prices";
import Select from "@/app/components/Select";
import VendorIcon, { hasVendorIcon } from "@/app/components/VendorIcon";

type Column = { id: string; label: string; link?: string };

type ModalityFilter = "all" | "text" | "image" | "video";
type LicenseFilter = "all" | License;

// The handful of makers worth offering as a filter — biggest catalogs + the
// headline labs. Other vendors still show their icon/label in rows, they're
// just not individually filterable.
const POPULAR_VENDORS = [
  "openai",
  "anthropic",
  "google",
  "xai",
  "deepseek",
  "bfl",
  "alibaba",
  "bytedance",
  "kuaishou",
  "runway",
];

const C = {
  green: "var(--green)",
  text: "var(--text)",
  muted: "var(--muted)",
  faint: "var(--faint)",
  line: "var(--line)",
  panel: "var(--panel)",
};

function fmtCents(c: number | undefined): string {
  if (c == null) return "—";
  return `${parseFloat(c.toFixed(2))}¢`;
}

function fmtUsd(n: number): string {
  return `$${parseFloat(n.toFixed(2))}`;
}

const LICENSE_CHIP: Record<License, { label: string; color: string }> = {
  open: { label: "open weights", color: "var(--green)" },
  proprietary: { label: "proprietary", color: "var(--blue)" },
};

const th: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: ".04em",
  textTransform: "uppercase",
  padding: "12px 14px",
  whiteSpace: "nowrap",
};

const td: React.CSSProperties = {
  padding: "11px 14px",
  verticalAlign: "top",
};

function LicenseTag({ license }: { license: License }) {
  const meta = LICENSE_CHIP[license];
  return (
    <span
      title={license === "open" ? "Downloadable / self-hostable weights" : "API-only"}
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: ".02em",
        textTransform: "uppercase",
        padding: "1px 7px",
        borderRadius: 999,
        color: meta.color,
        border: `1px solid color-mix(in srgb, ${meta.color} 45%, transparent)`,
      }}
    >
      {meta.label}
    </span>
  );
}

export default function PriceTable({
  rows,
  columns,
  textRows,
  textColumns,
}: {
  rows: ComparisonRow[];
  columns: Column[];
  textRows: TextRow[];
  textColumns: Column[];
}) {
  const [modality, setModality] = useState<ModalityFilter>("all");
  const [license, setLicense] = useState<LicenseFilter>("all");
  const [vendor, setVendor] = useState<string>("all");
  const [q, setQ] = useState("");

  // ── URL sync (shareable filtered views) ───────────────────────────────
  // Read the query string once on mount (kept out of the initial render so the
  // hydrated markup matches the static HTML), then mirror filter changes back
  // into the URL via replaceState — no history spam, no full navigation.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const m = sp.get("modality");
    if (m && (["all", "text", "image", "video"] as const).includes(m as ModalityFilter)) {
      setModality(m as ModalityFilter);
    }
    const v = sp.get("vendor");
    if (v && (v === "all" || POPULAR_VENDORS.includes(v))) setVendor(v);
    const l = sp.get("license");
    if (l && (["all", "open", "proprietary"] as const).includes(l as LicenseFilter)) {
      setLicense(l as LicenseFilter);
    }
    const query = sp.get("q");
    if (query) setQ(query);
  }, []);

  const didInit = useRef(false);
  useEffect(() => {
    // Skip the first run (defaults, before the mount read above lands) so a
    // shared link's params aren't wiped on load.
    if (!didInit.current) {
      didInit.current = true;
      return;
    }
    const sp = new URLSearchParams();
    if (modality !== "all") sp.set("modality", modality);
    if (vendor !== "all") sp.set("vendor", vendor);
    if (license !== "all") sp.set("license", license);
    if (q.trim()) sp.set("q", q.trim());
    const qs = sp.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [modality, vendor, license, q]);

  const vendors = useMemo(() => {
    const present = new Set<string>();
    for (const r of rows) present.add(r.vendor);
    for (const r of textRows) present.add(r.vendor);
    return POPULAR_VENDORS.filter((id) => present.has(id)).map(
      (id) => [id, vendorLabel(id)] as const,
    );
  }, [rows, textRows]);

  const needle = q.trim().toLowerCase();
  const matchCommon = (r: { name: string; modelId: string; vendor: string; license: License }) => {
    if (license !== "all" && r.license !== license) return false;
    if (vendor !== "all" && r.vendor !== vendor) return false;
    if (needle) {
      const hay = `${r.name} ${r.modelId} ${vendorLabel(r.vendor)}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  };

  const showText = modality === "all" || modality === "text";
  const showMedia = modality === "all" || modality === "image" || modality === "video";

  const filteredText = useMemo(() => {
    if (!showText) return [];
    const out = textRows.filter(matchCommon);
    out.sort(
      (a, b) =>
        (a.byProvider[a.cheapestProvider]?.blended ?? 0) -
        (b.byProvider[b.cheapestProvider]?.blended ?? 0),
    );
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textRows, showText, license, vendor, needle]);

  const filteredMedia = useMemo(() => {
    if (!showMedia) return [];
    const out = rows.filter((r) => {
      if (modality === "image" && r.modality !== "image") return false;
      if (modality === "video" && r.modality !== "video") return false;
      return matchCommon(r);
    });
    out.sort((a, b) => a.cheapestCents - b.cheapestCents);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, showMedia, modality, license, vendor, needle]);

  const vendorOptions = useMemo(
    () => [
      { value: "all", label: "All vendors" },
      ...vendors.map(([id, label]) => ({
        value: id,
        label,
        icon: hasVendorIcon(id) ? <VendorIcon id={id} /> : undefined,
      })),
    ],
    [vendors],
  );

  const sectionTitle: React.CSSProperties = {
    fontSize: 13,
    fontWeight: 700,
    color: C.faint,
    letterSpacing: ".04em",
    textTransform: "uppercase",
    margin: "0 0 10px",
  };

  // "Best Value" sits right after Official so the recommendation stays visible
  // as more supplier columns get added on the right.
  const splitCols = (cols: Column[]) =>
    [cols.filter((c) => c.id === "official"), cols.filter((c) => c.id !== "official")] as const;
  const [textOfficialCols, textRestCols] = splitCols(textColumns);
  const [mediaOfficialCols, mediaRestCols] = splitCols(columns);

  const colHeader = (c: Column) => (
    <th key={c.id} style={{ ...th, textAlign: "right" }}>
      {c.link ? (
        <a href={c.link} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
          {c.label}
        </a>
      ) : (
        c.label
      )}
    </th>
  );
  const bestHeader = () => (
    <th key="__best" style={{ ...th, textAlign: "right" }}>
      Best Value
    </th>
  );

  const textPriceCell = (r: TextRow, c: Column) => {
    const cell = r.byProvider[c.id];
    const isCheapest = cell != null && c.id === r.cheapestProvider;
    return (
      <td
        key={c.id}
        style={{
          ...td,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
          fontWeight: isCheapest ? 700 : 500,
          color: isCheapest ? C.green : cell != null ? C.muted : C.faint,
          background: isCheapest ? `color-mix(in srgb, ${C.green} 12%, transparent)` : "transparent",
        }}
      >
        {cell ? `${fmtUsd(cell.inUsd)} / ${fmtUsd(cell.outUsd)}` : "—"}
      </td>
    );
  };
  const mediaPriceCell = (r: ComparisonRow, c: Column) => {
    const v = r.byProvider[c.id];
    const isCheapest = v != null && c.id === r.cheapestProvider;
    return (
      <td
        key={c.id}
        style={{
          ...td,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
          fontWeight: isCheapest ? 700 : 500,
          color: isCheapest ? C.green : v != null ? C.muted : C.faint,
          background: isCheapest ? `color-mix(in srgb, ${C.green} 12%, transparent)` : "transparent",
        }}
      >
        {fmtCents(v)}
      </td>
    );
  };
  const bestCell = (provider: string, savingsPct: number | null, label: (id: string) => string) => (
    <td key="__best" style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
      <span style={{ fontWeight: 700, color: C.green }}>{label(provider)}</span>
      {savingsPct != null && savingsPct > 0 && (
        <span style={{ color: C.green, fontSize: 11.5, marginLeft: 6, fontVariantNumeric: "tabular-nums" }}>
          −{savingsPct}%
        </span>
      )}
    </td>
  );

  return (
    <div>
      {/* ── Controls ─────────────────────────────────────────── */}
      <div className="pf">
        <div className="seg" role="group" aria-label="Modality">
          {(["all", "text", "image", "video"] as ModalityFilter[]).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={modality === m}
              onClick={() => setModality(m)}
            >
              {m === "all" ? "All" : m === "text" ? "Text" : m === "image" ? "Image" : "Video"}
            </button>
          ))}
        </div>

        <label className="pf__search">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="m20 20-3.2-3.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            placeholder="Search model or vendor…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search models"
          />
        </label>

        <Select
          value={vendor}
          ariaLabel="Filter by vendor"
          onChange={setVendor}
          options={vendorOptions}
        />

        <Select
          value={license}
          ariaLabel="Filter by license"
          onChange={(v) => setLicense(v as LicenseFilter)}
          options={[
            { value: "all", label: "All licenses" },
            { value: "open", label: "Open weights" },
            { value: "proprietary", label: "Proprietary" },
          ]}
        />
      </div>

      {/* ── Text table ───────────────────────────────────────── */}
      {showText && (
        <div style={{ marginBottom: showMedia ? 32 : 0 }}>
          {modality === "all" && (
            <h2 style={sectionTitle}>
              Text LLMs <span style={{ color: C.muted, fontWeight: 500 }}>· $/1M tokens, input / output</span>
            </h2>
          )}
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, overflow: "auto", background: C.panel }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 640 }}>
              <thead>
                <tr style={{ textAlign: "left", color: C.faint }}>
                  <th style={th}>Model</th>
                  {textOfficialCols.map(colHeader)}
                  {bestHeader()}
                  {textRestCols.map(colHeader)}
                </tr>
              </thead>
              <tbody>
                {filteredText.map((r) => (
                  <tr key={r.modelId} style={{ borderTop: `1px solid ${C.line}` }}>
                    <td style={{ ...td, minWidth: 230 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 700, color: C.text }}>{r.name}</span>
                        <LicenseTag license={r.license} />
                      </div>
                      <div style={{ fontSize: 11.5, color: C.faint, marginTop: 3 }}>
                        <span className="vmark">
                          {hasVendorIcon(r.vendor) && (
                            <VendorIcon id={r.vendor} size={12} style={{ color: C.muted }} />
                          )}
                          {vendorLabel(r.vendor)}
                        </span>{" "}
                        · <code>{r.modelId}</code>
                      </div>
                      {r.note && (
                        <div style={{ fontSize: 11, color: C.faint, marginTop: 3, fontStyle: "italic" }}>
                          {r.note}
                        </div>
                      )}
                    </td>
                    {textOfficialCols.map((c) => textPriceCell(r, c))}
                    {bestCell(r.cheapestProvider, r.savingsPct, textProviderLabel)}
                    {textRestCols.map((c) => textPriceCell(r, c))}
                  </tr>
                ))}
                {filteredText.length === 0 && (
                  <tr>
                    <td colSpan={textColumns.length + 2} style={{ ...td, textAlign: "center", color: C.faint, padding: "28px 16px" }}>
                      No text models match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Media table ──────────────────────────────────────── */}
      {showMedia && (
        <div>
          {modality === "all" && (
            <h2 style={sectionTitle}>
              Image &amp; Video <span style={{ color: C.muted, fontWeight: 500 }}>· normalized ¢ per reference output</span>
            </h2>
          )}
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, overflow: "auto", background: C.panel }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 720 }}>
              <thead>
                <tr style={{ textAlign: "left", color: C.faint }}>
                  <th style={th}>Model</th>
                  {mediaOfficialCols.map(colHeader)}
                  {bestHeader()}
                  {mediaRestCols.map(colHeader)}
                </tr>
              </thead>
              <tbody>
                {filteredMedia.map((r) => (
                  <tr key={r.modelId} style={{ borderTop: `1px solid ${C.line}` }}>
                    <td style={{ ...td, minWidth: 230 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 700, color: C.text }}>{r.name}</span>
                        <LicenseTag license={r.license} />
                        {r.kind !== "generate" && (
                          <span
                            style={{
                              fontSize: 10.5,
                              fontWeight: 700,
                              padding: "1px 7px",
                              borderRadius: 999,
                              color: C.muted,
                              border: `1px solid ${C.line}`,
                            }}
                          >
                            {r.kind}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11.5, color: C.faint, marginTop: 3 }}>
                        <span className="vmark">
                          {hasVendorIcon(r.vendor) && (
                            <VendorIcon id={r.vendor} size={12} style={{ color: C.muted }} />
                          )}
                          {vendorLabel(r.vendor)}
                        </span>{" "}
                        · <code>{r.modelId}</code>
                      </div>
                      {r.note && (
                        <div style={{ fontSize: 11, color: C.faint, marginTop: 3, fontStyle: "italic" }}>
                          {r.note}
                        </div>
                      )}
                    </td>
                    {mediaOfficialCols.map((c) => mediaPriceCell(r, c))}
                    {bestCell(r.cheapestProvider, r.savingsPct, providerLabel)}
                    {mediaRestCols.map((c) => mediaPriceCell(r, c))}
                  </tr>
                ))}
                {filteredMedia.length === 0 && (
                  <tr>
                    <td colSpan={columns.length + 2} style={{ ...td, textAlign: "center", color: C.faint, padding: "28px 16px" }}>
                      No media models match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
