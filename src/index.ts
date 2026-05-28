/**
 * ai-lcr — Least Cost Routing for LLMs.
 *
 * v0 scope: cheapest-first routing across providers + streaming-safe failover
 * (delegated to `ai-fallback`). Per-call cost accounting (`onCost`), the
 * provider-quirk middleware layer, and the offline capability probe are typed
 * below but land in P1 — see the roadmap in README.md. This package is
 * dogfooded in production before a stable release; expect the API to move.
 */
import type { LanguageModel } from "ai";
import { createFallback } from "ai-fallback";

/** A single call's usage + computed cost, surfaced to `onCost`. Reserved — wired in P1. */
export interface CostEvent {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface LCRConfig {
  /**
   * Map of logical model name -> providers to try, cheapest-first.
   * Each entry is a standard AI SDK LanguageModel, e.g. from
   * `createOpenAICompatible(...)("model-id")`. Order is priority order:
   * the first provider that succeeds serves the request.
   */
  models: Record<string, LanguageModel[]>;
  /** Idle window after which routing snaps back to the cheapest provider. Default 60s. */
  resetIntervalMs?: number;
  /** Called when a provider errors and routing falls through to the next. */
  onError?: (error: Error, modelId: string) => void;
  /** Reserved (P1): real per-call cost accounting from the bundled price table. */
  onCost?: (event: CostEvent) => void;
}

/** Resolve a logical model name to a routed AI SDK LanguageModel. */
export type LCRRouter = (modelName: string) => LanguageModel;

/**
 * Build a Least Cost Router. Returns a function that resolves a logical model
 * name to a routed `LanguageModel` usable anywhere in the Vercel AI SDK
 * (generateText, streamText, generateObject, tools, agents).
 */
export function createLCR(config: LCRConfig): LCRRouter {
  const { models, resetIntervalMs = 60_000, onError } = config;

  const routed = new Map<string, LanguageModel>();
  for (const [name, providers] of Object.entries(models)) {
    if (providers.length === 0) {
      throw new Error(`ai-lcr: model "${name}" has no providers`);
    }
    const fallback = createFallback({
      models: providers,
      modelResetInterval: resetIntervalMs,
      onError,
    });
    routed.set(name, fallback as unknown as LanguageModel);
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
