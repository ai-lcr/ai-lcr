/**
 * ai-lcr — Least Cost Routing for LLMs.
 *
 * Route each model to the cheapest provider that can serve it, fall back
 * automatically on failure, and report real per-call cost. Built on its own
 * failover engine (see ./fallback) — no external routing dependency.
 *
 * Roadmap (see README): provider-quirk middleware, offline capability probe,
 * a bundled price table for zero-config cheapest-first ordering.
 */
import type { LanguageModelV3 } from "@ai-sdk/provider";
import {
  LcrFallbackModel,
  type CostEvent,
  type ProviderCost,
  type RoutedProvider,
} from "./fallback";

export type { CostEvent, ProviderCost } from "./fallback";

// ── Image & video Least Cost Routing (parallel to the text router above) ──
// The text router is LanguageModelV3-bound (token-billed). Media (image/video)
// is a separate, self-contained side — file outputs, mixed pricing units, and
// async video jobs. See ./media for the rationale.
export {
  createMediaLCR,
  comparePrices,
  rankRoutes,
  cheapestRoute,
  normalizedCents,
  referenceMegapixels,
  DEFAULT_REFERENCE,
} from "./media";
export type {
  MediaModality,
  MediaUnit,
  MediaPricing,
  MediaRoute,
  MediaModelDef,
  MediaRegistry,
  ReferenceSpec,
  RankedRoute,
  PriceComparisonRow,
  MediaGenerateRequest,
  MediaOutput,
  MediaGenerateResult,
  MediaAdapter,
  MediaCostEvent,
  MediaLCRConfig,
  MediaRunResult,
} from "./media";
export { MEDIA_PRICING } from "./media-registry";
export { createKunavoMediaAdapter } from "./adapters/kunavo-media";
export { createRunwareMediaAdapter } from "./adapters/runware-media";

/**
 * A provider for a model: either a bare AI SDK model (e.g.
 * `createOpenAICompatible(...)("id")`), or that model wrapped with price/label
 * metadata to unlock cost accounting and cheapest-first auto-sorting.
 */
export type ProviderEntry =
  | LanguageModelV3
  | {
      model: LanguageModelV3;
      /** USD per 1M tokens. Enables `onCost` and `autoSort`. */
      cost?: ProviderCost;
      /** Label used in cost events / logs. Defaults to the model's provider id. */
      label?: string;
    };

export interface LCRConfig {
  /**
   * Map of logical model name -> providers to try, cheapest-first.
   * Order is priority order unless `autoSort` is set.
   */
  models: Record<string, ProviderEntry[]>;
  /** Sort each model's providers cheapest-first by `cost` before routing. */
  autoSort?: boolean;
  /** Idle window after which routing snaps back to the cheapest provider. Default 60s. */
  resetIntervalMs?: number;
  /** Called when a provider errors and routing falls through to the next. */
  onError?: (error: Error, provider: string) => void;
  /** Called after each successful call with the serving provider, tokens, and cost. */
  onCost?: (event: CostEvent) => void;
}

/** Resolve a logical model name to a routed model. */
export type LCRRouter = (modelName: string) => LanguageModelV3;

function isLanguageModel(entry: ProviderEntry): entry is LanguageModelV3 {
  return typeof (entry as LanguageModelV3).doGenerate === "function";
}

function normalize(entry: ProviderEntry): RoutedProvider {
  if (isLanguageModel(entry)) {
    return { model: entry, label: entry.provider };
  }
  return {
    model: entry.model,
    label: entry.label ?? entry.model.provider,
    cost: entry.cost,
  };
}

function priceKey(p: RoutedProvider): number {
  return p.cost ? p.cost.input + p.cost.output : Number.POSITIVE_INFINITY;
}

/**
 * Build a Least Cost Router. Returns a function that resolves a logical model
 * name to a routed model usable anywhere in the Vercel AI SDK (generateText,
 * streamText, generateObject, tools, agents).
 */
export function createLCR(config: LCRConfig): LCRRouter {
  const { models, autoSort = false, resetIntervalMs, onError, onCost } = config;

  const routed = new Map<string, LcrFallbackModel>();
  for (const [name, entries] of Object.entries(models)) {
    let providers = entries.map(normalize);
    if (autoSort) {
      providers = [...providers].sort((a, b) => priceKey(a) - priceKey(b));
    }
    routed.set(
      name,
      new LcrFallbackModel({ modelName: name, providers, resetIntervalMs, onError, onCost }),
    );
  }

  return (modelName: string) => {
    const model = routed.get(modelName);
    if (!model) {
      throw new Error(
        `ai-lcr: unknown model "${modelName}" — add it to createLCR({ models })`,
      );
    }
    return model;
  };
}
