"use client";

import { useMemo, useState } from "react";
import {
  type ComparisonRow,
  type TextRow,
  type License,
  vendorLabel,
  providerLabel,
  textProviderLabel,
} from "@/lib/prices";

type Column = { id: string; label: string; link?: string };

type ModalityFilter = "all" | "text" | "image" | "video";
type LicenseFilter = "all" | License;
type SortKey = "best" | "name";

const C = {
  green: "var(--green)",
  blue: "var(--blue)",
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

// Quick-filter chips for the major model makers, shared with the vendor <select>.
const QUICK_VENDORS = ["openai", "anthropic", "google"];

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
  const [sort, setSort] = useState<SortKey>("best");

  const vendors = useMemo(() => {
    const set = new Map<string, string>();
    for (const r of rows) set.set(r.vendor, vendorLabel(r.vendor));
    for (const r of textRows) set.set(r.vendor, vendorLabel(r.vendor));
    return [...set.entries()].sort((a, b) => a[1].localeCompare(b[1]));
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
    out.sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : (a.byProvider[a.cheapestProvider]?.blended ?? 0) -
          (b.byProvider[b.cheapestProvider]?.blended ?? 0),
    );
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textRows, showText, license, vendor, needle, sort]);

  const filteredMedia = useMemo(() => {
    if (!showMedia) return [];
    const out = rows.filter((r) => {
      if (modality === "image" && r.modality !== "image") return false;
      if (modality === "video" && r.modality !== "video") return false;
      return matchCommon(r);
    });
    out.sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : a.cheapestCents - b.cheapestCents,
    );
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, showMedia, modality, license, vendor, needle, sort]);

  const totalShown = filteredText.length + filteredMedia.length;
  const totalAll = rows.length + textRows.length;

  const tab = (active: boolean): React.CSSProperties => ({
    fontSize: 13,
    fontWeight: 600,
    padding: "6px 14px",
    borderRadius: 999,
    border: `1px solid ${active ? "transparent" : C.line}`,
    background: active ? C.text : "transparent",
    color: active ? "var(--bg, #0a0a0a)" : C.muted,
    cursor: "pointer",
  });

  const chip = (active: boolean, color: string): React.CSSProperties => ({
    fontSize: 12.5,
    fontWeight: 600,
    padding: "6px 12px",
    borderRadius: 999,
    border: `1px solid ${active ? color : C.line}`,
    background: active ? `color-mix(in srgb, ${color} 16%, transparent)` : "transparent",
    color: active ? color : C.muted,
    cursor: "pointer",
  });

  const sectionTitle: React.CSSProperties = {
    fontSize: 13,
    fontWeight: 700,
    color: C.faint,
    letterSpacing: ".04em",
    textTransform: "uppercase",
    margin: "0 0 10px",
  };

  return (
    <div>
      {/* ── Controls ─────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {(["all", "text", "image", "video"] as ModalityFilter[]).map((m) => (
              <button key={m} type="button" style={tab(modality === m)} onClick={() => setModality(m)}>
                {m === "all" ? "All" : m === "text" ? "Text" : m === "image" ? "Image" : "Video"}
              </button>
            ))}
          </div>
          <span style={{ width: 1, height: 22, background: C.line, margin: "0 4px" }} />
          <button type="button" style={chip(license === "open", LICENSE_CHIP.open.color)} onClick={() => setLicense(license === "open" ? "all" : "open")}>
            open weights
          </button>
          <button type="button" style={chip(license === "proprietary", LICENSE_CHIP.proprietary.color)} onClick={() => setLicense(license === "proprietary" ? "all" : "proprietary")}>
            proprietary
          </button>
          <span style={{ width: 1, height: 22, background: C.line, margin: "0 4px" }} />
          {QUICK_VENDORS.map((id) => (
            <button
              key={id}
              type="button"
              style={chip(vendor === id, C.blue)}
              onClick={() => setVendor(vendor === id ? "all" : id)}
            >
              {vendorLabel(id)}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="search"
            placeholder="Search model or vendor…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{
              flex: "1 1 220px",
              minWidth: 180,
              fontSize: 13,
              padding: "8px 12px",
              borderRadius: 10,
              border: `1px solid ${C.line}`,
              background: C.panel,
              color: C.text,
              outline: "none",
            }}
          />
          <select
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            style={{
              fontSize: 13,
              padding: "8px 12px",
              borderRadius: 10,
              border: `1px solid ${C.line}`,
              background: C.panel,
              color: C.text,
              cursor: "pointer",
            }}
          >
            <option value="all">All vendors</option>
            {vendors.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            style={{
              fontSize: 13,
              padding: "8px 12px",
              borderRadius: 10,
              border: `1px solid ${C.line}`,
              background: C.panel,
              color: C.text,
              cursor: "pointer",
            }}
          >
            <option value="best">Sort: cheapest first</option>
            <option value="name">Sort: name A–Z</option>
          </select>
          <span style={{ fontSize: 12.5, color: C.faint, marginLeft: "auto" }}>
            {totalShown} of {totalAll}
          </span>
        </div>
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
                  {textColumns.map((c) => (
                    <th key={c.id} style={{ ...th, textAlign: "right" }}>
                      {c.link ? (
                        <a href={c.link} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
                          {c.label}
                        </a>
                      ) : (
                        c.label
                      )}
                    </th>
                  ))}
                  <th style={{ ...th, textAlign: "right" }}>Best</th>
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
                        {vendorLabel(r.vendor)} · <code>{r.modelId}</code>
                      </div>
                      {r.note && (
                        <div style={{ fontSize: 11, color: C.faint, marginTop: 3, fontStyle: "italic" }}>
                          {r.note}
                        </div>
                      )}
                    </td>
                    {textColumns.map((c) => {
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
                    })}
                    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                      <span style={{ fontWeight: 700, color: C.green }}>
                        {textProviderLabel(r.cheapestProvider)}
                      </span>
                      {r.savingsPct != null && r.savingsPct > 0 && (
                        <span style={{ color: C.green, fontSize: 11.5, marginLeft: 6, fontVariantNumeric: "tabular-nums" }}>
                          −{r.savingsPct}%
                        </span>
                      )}
                    </td>
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
                  {columns.map((c) => (
                    <th key={c.id} style={{ ...th, textAlign: "right" }}>
                      {c.link ? (
                        <a href={c.link} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
                          {c.label}
                        </a>
                      ) : (
                        c.label
                      )}
                    </th>
                  ))}
                  <th style={{ ...th, textAlign: "right" }}>Best</th>
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
                        {vendorLabel(r.vendor)} · <code>{r.modelId}</code>
                      </div>
                      {r.note && (
                        <div style={{ fontSize: 11, color: C.faint, marginTop: 3, fontStyle: "italic" }}>
                          {r.note}
                        </div>
                      )}
                    </td>
                    {columns.map((c) => {
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
                    })}
                    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                      <span style={{ fontWeight: 700, color: C.green }}>
                        {providerLabel(r.cheapestProvider)}
                      </span>
                      {r.savingsPct != null && r.savingsPct > 0 && (
                        <span style={{ color: C.green, fontSize: 11.5, marginLeft: 6, fontVariantNumeric: "tabular-nums" }}>
                          −{r.savingsPct}%
                        </span>
                      )}
                    </td>
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
