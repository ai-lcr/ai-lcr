/**
 * Cross-provider image/video price table for the public "cheapest provider"
 * recommendation page (/prices).
 *
 * DATA lives in ./../data/media-models.json (edit there — it's plain JSON).
 * Prices are US cents per native unit; we normalize every unit to the cost of
 * ONE reference output (16:9 1080p still / 5-second 1080p clip) so per-image,
 * per-second, and per-call prices compare directly. Same standard as the
 * package's src/media.ts. Keep the Kunavo rows in sync with src/media-registry.ts.
 */
import catalog from "../data/media-models.json";

export type MediaModality = "image" | "video";
export type MediaUnit = "image" | "megapixel" | "second" | "call";
export type License = "open" | "proprietary";
export type Kind = "generate" | "edit" | "upscale" | "bg-removal";

export interface PriceRoute {
  provider: string;
  unit: MediaUnit;
  cents: number;
  note?: string;
}

export interface MediaModel {
  id: string;
  name: string;
  modality: MediaModality;
  vendor: string;
  license: License;
  kind: Kind;
  note?: string;
  routes: PriceRoute[];
}

export interface TextRoute {
  provider: string;
  inUsd: number;
  outUsd: number;
}

export interface TextModel {
  id: string;
  name: string;
  vendor: string;
  license: License;
  note?: string;
  routes: TextRoute[];
}

interface Catalog {
  providers: Record<string, { label: string; link: string }>;
  models: MediaModel[];
  textProviders: Record<string, { label: string; link: string }>;
  textModels: TextModel[];
}

const data = catalog as unknown as Catalog;

/** Display metadata for the providers that fulfil a route (the price columns). */
export const PROVIDER_META = data.providers;

/** Vendor (model maker) → display label. */
export const VENDOR_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  bfl: "Black Forest Labs",
  stability: "Stability AI",
  alibaba: "Alibaba",
  hidream: "HiDream",
  civitai: "Civitai",
  google: "Google",
  openai: "OpenAI",
  bytedance: "ByteDance",
  recraft: "Recraft",
  ideogram: "Ideogram",
  bria: "Bria",
  kuaishou: "Kuaishou",
  xai: "xAI",
  runway: "Runway",
  minimax: "MiniMax",
  lightricks: "Lightricks",
  luma: "Luma",
  pixverse: "PixVerse",
  tencent: "Tencent",
  fal: "fal",
};

export function vendorLabel(id: string): string {
  return VENDOR_LABEL[id] ?? id;
}

export function providerLabel(id: string): string {
  return PROVIDER_META[id]?.label ?? id;
}

export const KIND_LABEL: Record<Kind, string> = {
  generate: "generate",
  edit: "edit",
  upscale: "upscale",
  "bg-removal": "bg-removal",
};

// ── Normalization (mirror of src/media.ts) ────────────────────────────
const REFERENCE = { width: 1920, height: 1080, videoSeconds: 5 };
const REF_MEGAPIXELS = (REFERENCE.width * REFERENCE.height) / 1_000_000;

export function normalizedCents(pricing: { unit: MediaUnit; cents: number }): number {
  switch (pricing.unit) {
    case "image":
    case "call":
      return pricing.cents;
    case "megapixel":
      return pricing.cents * REF_MEGAPIXELS;
    case "second":
      return pricing.cents * REFERENCE.videoSeconds;
  }
}

export interface RankedRoute extends PriceRoute {
  refCents: number;
  cheapest: boolean;
}

export interface ComparisonRow {
  modelId: string;
  name: string;
  modality: MediaModality;
  vendor: string;
  license: License;
  kind: Kind;
  note?: string;
  routes: RankedRoute[];
  cheapestProvider: string;
  cheapestCents: number;
  /** % saved vs the most expensive competing route (null if only one route). */
  savingsPct: number | null;
  /** Normalized price per provider id, for the table columns ("—" → undefined). */
  byProvider: Record<string, number | undefined>;
}

/** The reference table, ranked cheapest-first per model — what /prices renders. */
export function comparison(): ComparisonRow[] {
  return data.models.map((m) => {
    const ranked = m.routes
      .map((r) => ({ ...r, refCents: normalizedCents(r), cheapest: false }))
      .sort((a, b) => a.refCents - b.refCents);
    ranked[0]!.cheapest = true;
    const cheapestCents = ranked[0]!.refCents;
    const dearest = ranked[ranked.length - 1]!.refCents;
    const savingsPct =
      ranked.length > 1 && dearest > 0
        ? Math.round(((dearest - cheapestCents) / dearest) * 100)
        : null;
    const byProvider: Record<string, number | undefined> = {};
    for (const r of ranked) byProvider[r.provider] = r.refCents;
    return {
      modelId: m.id,
      name: m.name,
      modality: m.modality,
      vendor: m.vendor,
      license: m.license,
      kind: m.kind,
      note: m.note,
      routes: ranked,
      cheapestProvider: ranked[0]!.provider,
      cheapestCents,
      savingsPct,
      byProvider,
    };
  });
}

/** Provider ids that appear as price columns, in display order. */
export const PROVIDER_COLUMNS = Object.keys(PROVIDER_META);

export const REFERENCE_LABEL = "16:9 1080p image · 5-second 1080p clip";

export const MODEL_COUNT = data.models.length;

// ── Text LLM pricing ──────────────────────────────────────────────────
export const TEXT_PROVIDER_META = data.textProviders;
export const TEXT_PROVIDER_COLUMNS = Object.keys(TEXT_PROVIDER_META);

export function textProviderLabel(id: string): string {
  return TEXT_PROVIDER_META[id]?.label ?? id;
}

export interface TextCell {
  inUsd: number;
  outUsd: number;
  /** in + out, used for cheapest ranking. */
  blended: number;
}

export interface TextRow {
  modelId: string;
  name: string;
  vendor: string;
  license: License;
  note?: string;
  /** Per-provider price (undefined → provider doesn't carry this model). */
  byProvider: Record<string, TextCell | undefined>;
  cheapestProvider: string;
  /** % saved on blended in+out vs the dearest competing route (null if sole). */
  savingsPct: number | null;
}

/** Text models, cheapest-first per model — what the /prices Text table renders. */
export function textComparison(): TextRow[] {
  return data.textModels.map((m) => {
    const byProvider: Record<string, TextCell | undefined> = {};
    for (const r of m.routes) {
      byProvider[r.provider] = { inUsd: r.inUsd, outUsd: r.outUsd, blended: r.inUsd + r.outUsd };
    }
    const ranked = m.routes
      .map((r) => ({ provider: r.provider, blended: r.inUsd + r.outUsd }))
      .sort((a, b) => a.blended - b.blended);
    const cheapest = ranked[0]!.blended;
    const dearest = ranked[ranked.length - 1]!.blended;
    const savingsPct =
      ranked.length > 1 && dearest > 0
        ? Math.round(((dearest - cheapest) / dearest) * 100)
        : null;
    return {
      modelId: m.id,
      name: m.name,
      vendor: m.vendor,
      license: m.license,
      note: m.note,
      byProvider,
      cheapestProvider: ranked[0]!.provider,
      savingsPct,
    };
  });
}

export const TEXT_MODEL_COUNT = data.textModels.length;

export interface TextSaving {
  id: string;
  name: string;
  /** OpenRouter (list) blended in+out per 1M, or the dearest route if no OR. */
  listBlended: number;
  cheapestBlended: number;
  cheapestProvider: string;
  /** % saved on blended in+out vs list. */
  discountPct: number;
}

/**
 * Per-model savings vs list price, for the homepage savings calculator.
 * "List" = OpenRouter (which passes vendor list pricing through). Models with
 * only one route (no cheaper alternative) are dropped.
 */
export function textSavings(): TextSaving[] {
  return data.textModels
    .map((m) => {
      const blended = m.routes.map((r) => ({ provider: r.provider, b: r.inUsd + r.outUsd }));
      const list =
        blended.find((x) => x.provider === "openrouter") ??
        blended.reduce((a, c) => (c.b > a.b ? c : a));
      const cheapest = blended.reduce((a, c) => (c.b < a.b ? c : a));
      const discountPct =
        list.b > 0 ? Math.round(((list.b - cheapest.b) / list.b) * 100) : 0;
      return {
        id: m.id,
        name: m.name,
        listBlended: list.b,
        cheapestBlended: cheapest.b,
        cheapestProvider: cheapest.provider,
        discountPct,
      };
    })
    .filter((s) => s.discountPct > 0)
    .sort((a, b) => b.discountPct - a.discountPct);
}
