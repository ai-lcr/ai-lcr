/**
 * ai-lcr media routing — Least Cost Routing for image & video models.
 *
 * The text router (./index, ./fallback) is built on the AI SDK's
 * `LanguageModelV3` and only handles token-billed chat/completion. Image and
 * video providers are a different world: outputs are files (URLs), pricing
 * comes in incompatible units (per-image, per-second, per-call, per-megapixel),
 * and video is a long-running async job. This module is the parallel, self-
 * contained media side — no `LanguageModelV3` dependency.
 *
 * The core idea is the SAME as the text LCR: keep a list of providers per
 * model, route to the cheapest healthy one, fall back on failure, report real
 * cost. The only new problem is making prices comparable, which we solve by
 * normalizing every provider's price to ONE reference output (see ReferenceSpec).
 */
import { classifyError, isRetryableError, type CallRecord } from "./fallback";
import { OFFICIAL_PRICES } from "./media-official";

export type MediaModality = "image" | "video";

/**
 * Pricing unit a provider bills in. `cents` on MediaPricing is the price for
 * one of these units, in US cents.
 *   - "image":      flat per generated image (most partner models)
 *   - "megapixel":  compute-billed; scales with output resolution
 *   - "second":     per second of video
 *   - "call":       one flat charge per generation (Kunavo video, fixed clip)
 */
export type MediaUnit = "image" | "megapixel" | "second" | "call";

export interface MediaPricing {
  unit: MediaUnit;
  /** Price in US cents for one `unit`. Fractional allowed (0.13 = $0.0013). */
  cents: number;
}

/** One provider's route for a model. */
export interface MediaRoute {
  /** Provider key: "fal" | "runware" | "kunavo" | … */
  provider: string;
  /** Provider-native model id (what its API expects). */
  externalId: string;
  pricing: MediaPricing;
  /**
   * Free-text caveat surfaced in the price table — e.g. a resolution tier the
   * price assumes, or a SKU/version difference from sibling routes. Optional.
   */
  note?: string;
}

export interface MediaModelDef {
  /** Logical, provider-agnostic id, e.g. "google/nano-banana-2". */
  id: string;
  modality: MediaModality;
  /** Providers that serve this model. Order is irrelevant — routing sorts by cost. */
  routes: MediaRoute[];
  /**
   * The model-maker's first-party list price — what a user pays going DIRECT,
   * bypassing the cheaper providers we route to. When set, it's the savings
   * baseline (savings = official − actual cost). Omit for open-weight models
   * with no first-party API price; those fall back to the priciest configured
   * route, or no baseline if there's only one. Can also be supplied out-of-band
   * via {@link MediaLCRConfig.officialPrices} so a registry needn't carry it inline.
   */
  official?: MediaPricing;
}

export type MediaRegistry = Record<string, MediaModelDef>;

// ── Unified comparison standard ───────────────────────────────
/**
 * Every price is normalized to the cost of producing ONE of these outputs, so
 * a per-image flat fee, a per-megapixel compute charge, a per-second video
 * rate, and a flat per-call video fee all become directly comparable.
 */
export interface ReferenceSpec {
  /** Reference still image. Default 16:9 1080p (1920×1080 ≈ 2.07 MP). */
  image: { width: number; height: number };
  /** Reference clip length in seconds (assumed 1080p). Default 5s. */
  videoSeconds: number;
}

/** 16:9 1080p image, 5-second clip — the house standard. */
export const DEFAULT_REFERENCE: ReferenceSpec = {
  image: { width: 1920, height: 1080 },
  videoSeconds: 5,
};

export function referenceMegapixels(ref: ReferenceSpec): number {
  return (ref.image.width * ref.image.height) / 1_000_000;
}

/**
 * Cost in US cents to produce ONE reference output on this pricing.
 * This is the single normalization that makes providers comparable.
 */
export function normalizedCents(
  pricing: MediaPricing,
  ref: ReferenceSpec = DEFAULT_REFERENCE,
): number {
  switch (pricing.unit) {
    case "image":
    case "call":
      return pricing.cents; // already "one output"
    case "megapixel":
      return pricing.cents * referenceMegapixels(ref);
    case "second":
      return pricing.cents * ref.videoSeconds;
  }
}

// ── Cheapest-first ranking (the LCR core) ─────────────────────
export interface RankedRoute extends MediaRoute {
  /** Normalized cost (cents per reference output) used for ordering. */
  refCents: number;
}

/** A model's routes, cheapest reference-cost first. */
export function rankRoutes(
  def: MediaModelDef,
  ref: ReferenceSpec = DEFAULT_REFERENCE,
): RankedRoute[] {
  return def.routes
    .map((r) => ({ ...r, refCents: normalizedCents(r.pricing, ref) }))
    .sort((a, b) => a.refCents - b.refCents);
}

export function cheapestRoute(
  def: MediaModelDef,
  ref: ReferenceSpec = DEFAULT_REFERENCE,
): RankedRoute {
  const ranked = rankRoutes(def, ref);
  if (ranked.length === 0) {
    throw new Error(`ai-lcr: model "${def.id}" has no routes`);
  }
  return ranked[0]!;
}

/** Per-model cheapest-provider summary — the price-comparison reference list. */
export interface PriceComparisonRow {
  modelId: string;
  modality: MediaModality;
  cheapest: { provider: string; refCents: number };
  routes: { provider: string; refCents: number; unit: MediaUnit; note?: string }[];
}

export function comparePrices(
  registry: MediaRegistry,
  ref: ReferenceSpec = DEFAULT_REFERENCE,
): PriceComparisonRow[] {
  return Object.values(registry).map((def) => {
    const ranked = rankRoutes(def, ref);
    return {
      modelId: def.id,
      modality: def.modality,
      cheapest: { provider: ranked[0]!.provider, refCents: ranked[0]!.refCents },
      routes: ranked.map((r) => ({
        provider: r.provider,
        refCents: r.refCents,
        unit: r.pricing.unit,
        ...(r.note ? { note: r.note } : {}),
      })),
    };
  });
}

// ── Adapter contract + routing runtime ────────────────────────
export interface MediaGenerateRequest {
  externalId: string;
  /** Canonical input: { prompt, image_url?, duration?, aspect_ratio?, … }. */
  input: Record<string, unknown>;
}

export interface MediaOutput {
  url: string;
  type: MediaModality;
}

export interface MediaGenerateResult {
  outputs: MediaOutput[];
  /** Provider-reported actual cost in cents, when the API returns it. */
  costCents?: number;
  /** Units actually billed (images, or seconds of video) — for cost fallback. */
  units?: number;
}

/**
 * A provider adapter. `run` resolves only when the output is ready: image
 * adapters return synchronously; video adapters submit and poll internally.
 */
export interface MediaAdapter {
  provider: string;
  run(req: MediaGenerateRequest): Promise<MediaGenerateResult>;
}

export interface MediaCostEvent {
  modelId: string;
  provider: string;
  /** Actual cost: provider-reported if available, else normalized estimate. */
  costCents: number;
  estimated: boolean;
}

export interface MediaLCRConfig {
  registry: MediaRegistry;
  /** Adapters keyed by provider. A route with no adapter is skipped. */
  adapters: Record<string, MediaAdapter>;
  reference?: ReferenceSpec;
  /**
   * Model-maker first-party list prices keyed by modelId — the savings baseline
   * for a model whose registry def carries no inline `official` price. Lets a
   * downstream registry (e.g. ai-art's) get correct baselines without inlining
   * prices. Defaults to the bundled {@link OFFICIAL_PRICES} (lifted from the
   * cross-provider price table). A def's inline `official` wins over this.
   */
  officialPrices?: Record<string, MediaPricing>;
  onError?: (error: Error, provider: string) => void;
  onCost?: (event: MediaCostEvent) => void;
  /**
   * One correlated {@link CallRecord} per settled request — the full failover
   * chain, winner, latency, and cost — mirroring the text side's `onCall`, so
   * the same dashboard sink works for image/video. Fire-and-forget; never
   * throws. Media records carry no token counts (inputTokens/outputTokens = 0).
   */
  onCall?: (record: CallRecord) => void;
}

export interface MediaRunResult {
  outputs: MediaOutput[];
  provider: string;
  costCents: number;
  estimated: boolean;
}

/**
 * Build a media Least Cost Router. Returns `generate(modelId, input)` which
 * tries providers cheapest-first and falls through on a retryable error —
 * exactly the text LCR's contract, for image/video.
 */
/** Correlation id for one media request (mirrors the text side's call ids). */
function newMediaCallId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `lcr_${Date.now().toString(36)}`;
}

export function createMediaLCR(config: MediaLCRConfig) {
  const {
    registry,
    adapters,
    reference = DEFAULT_REFERENCE,
    officialPrices = OFFICIAL_PRICES,
    onError,
    onCost,
    onCall,
  } = config;

  // Observer callbacks are caller-supplied logging hooks: a throw from one must
  // never turn a settled request into a different outcome (a throwing db9 sink
  // shouldn't fail a generation that already succeeded). Swallow what they throw.
  const safeError = (error: Error, provider: string): void => {
    try {
      onError?.(error, provider);
    } catch {
      /* observer must not affect routing */
    }
  };
  const safeCost = (event: MediaCostEvent): void => {
    try {
      onCost?.(event);
    } catch {
      /* observer must not affect routing */
    }
  };
  const safeCall = (record: CallRecord): void => {
    try {
      onCall?.(record);
    } catch {
      /* observer must not affect routing */
    }
  };

  return async function generate(
    modelId: string,
    input: Record<string, unknown>,
  ): Promise<MediaRunResult> {
    const def = registry[modelId];
    if (!def) {
      throw new Error(`ai-lcr: unknown media model "${modelId}" — add it to the registry`);
    }
    const ranked = rankRoutes(def, reference);
    // Baseline = what this output costs going DIRECT to the model maker (its
    // first-party list price), normalized to the reference output → savings =
    // baselineUsd - costUsd, same shape as text. That's the honest "what you'd
    // pay without ai-lcr" number. When no official price is known (open-weight
    // models with no first-party API), fall back to the priciest configured
    // route, preserving the cross-provider savings story.
    const official = def.official ?? officialPrices[modelId];
    const baselineUsd =
      official !== undefined
        ? normalizedCents(official, reference) / 100
        : ranked.length > 0
          ? Math.max(...ranked.map((r) => r.refCents)) / 100
          : 0;

    const startedAt = Date.now();
    const attempts: CallRecord["attempts"] = [];
    let lastErr: unknown;

    // One CallRecord for a settled request that ended in failure / exhaustion.
    const emitFail = () =>
      safeCall({
        id: newMediaCallId(),
        model: modelId,
        attempts,
        winner: undefined,
        ok: false,
        failedOver: attempts.length > 1,
        latencyMs: Date.now() - startedAt,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        baselineUsd,
      });

    for (const route of ranked) {
      const adapter = adapters[route.provider];
      if (!adapter) continue; // no adapter wired for this provider → skip to next
      const attemptStart = Date.now();
      try {
        const result = await adapter.run({ externalId: route.externalId, input });
        const estimated = result.costCents === undefined;
        const costCents = estimated
          ? route.refCents * (result.units ?? 1) // estimate from the normalized ref price
          : result.costCents!;
        attempts.push({ provider: route.provider, ok: true, latencyMs: Date.now() - attemptStart });
        safeCost({ modelId, provider: route.provider, costCents, estimated });
        safeCall({
          id: newMediaCallId(),
          model: modelId,
          attempts,
          winner: route.provider,
          ok: true,
          failedOver: attempts.length > 1,
          latencyMs: Date.now() - startedAt,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: costCents / 100,
          baselineUsd,
        });
        return { outputs: result.outputs, provider: route.provider, costCents, estimated };
      } catch (err) {
        lastErr = err;
        attempts.push({
          provider: route.provider,
          ok: false,
          latencyMs: Date.now() - attemptStart,
          errorClass: classifyError(err),
        });
        safeError(err as Error, route.provider);
        if (!isRetryableError(err)) {
          emitFail(); // caller's fault (e.g. bad input) → don't waste fallbacks
          throw err;
        }
      }
    }
    emitFail();
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`ai-lcr: no provider could serve media model "${modelId}"`);
  };
}
