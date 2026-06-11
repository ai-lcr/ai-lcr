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
  type CallRecord,
  type ProviderCost,
  type RoutedProvider,
  type CooldownOptions,
} from "./fallback";

export type { CostEvent, CallRecord, RouteAttempt, ProviderCost, ErrorKind, CooldownOptions } from "./fallback";
export { classifyError, classifyErrorKind, isRetryableError, isNetworkError, isAbortError, shouldFailover } from "./fallback";
export { formatCallRecord, type FormatOptions } from "./format";
export { createHttpSink, type HttpSinkOptions } from "./sink";
import { resolveCache, type CacheStore, type CacheOptions } from "./cache";
import { resolvePromptCache, type PromptCacheOptions } from "./prompt-cache";
export { createMemoryCacheStore } from "./cache";
export type { CacheStore, CachedCall, CachedMeta, CacheOptions, MemoryCacheOptions } from "./cache";
export type { PromptCacheOptions } from "./prompt-cache";
import { MODEL_PRICES } from "./text-prices";
export { MODEL_PRICES } from "./text-prices";

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
  billableUnits,
  priceCents,
  durationFromInput,
} from "./media";
export type {
  MediaModality,
  MediaUnit,
  MediaPricing,
  MediaUsage,
  BillableContext,
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
  MediaSubmitRequest,
  MediaSubmitResult,
  MediaStatusRequest,
  MediaStatusResult,
  MediaJobStatus,
  MediaSubmitOptions,
  MediaJobHandle,
  MediaPollResult,
  MediaLCR,
} from "./media";
export { MEDIA_PRICING } from "./media-registry";
export { OFFICIAL_PRICES } from "./media-official";
export { createKunavoMediaAdapter } from "./adapters/kunavo-media";
export { createRunwareMediaAdapter } from "./adapters/runware-media";
export { createFalMediaAdapter } from "./adapters/fal-media";

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
      /**
       * Fraction off the bundled list price (0–1) — the reseller-discount knob.
       * Applied ONLY when `autoPrice` fills this entry from {@link MODEL_PRICES}
       * (i.e. no explicit `cost`): a flat-discount aggregator like Kunavo (−20%)
       * becomes `{ model: kunavo("gemini-2.5-pro"), discount: 0.2 }` with no
       * hand-typed price. Scales input, output, and cacheRead alike. Ignored when
       * `cost` is set, when `autoPrice` is off, or when no bundled price is found.
       */
      discount?: number;
    };

/**
 * Look up a model's bundled official list price by id. Tries the id as given,
 * then with a leading `provider/` segment stripped (so `anthropic/claude-haiku-4-5`
 * resolves the same as `claude-haiku-4-5`). Returns undefined for unknown models.
 * The table ({@link MODEL_PRICES}) carries native-maker first-party rates only —
 * see `scripts/gen-text-prices.mjs`.
 */
export function getModelPrice(modelId: string): ProviderCost | undefined {
  if (!modelId) return undefined;
  const direct = MODEL_PRICES[modelId];
  if (direct) return direct;
  const slash = modelId.indexOf("/");
  if (slash !== -1) {
    const bare = MODEL_PRICES[modelId.slice(slash + 1)];
    if (bare) return bare;
  }
  return undefined;
}

export interface LCRConfig {
  /**
   * Map of logical model name -> providers to try, cheapest-first.
   * Order is priority order unless `autoSort` is set.
   */
  models: Record<string, ProviderEntry[]>;
  /** Sort each model's providers cheapest-first by `cost` before routing. */
  autoSort?: boolean;
  /**
   * Fill any provider entry that has no explicit `cost` from the bundled price
   * table ({@link MODEL_PRICES}), looked up by the entry's `model.modelId`. A
   * native-vendor route then needs zero hand-typed pricing; a flat-discount
   * aggregator just adds `discount` (see {@link ProviderEntry}). Off by default —
   * unpriced entries stay unpriced (the pre-existing behavior), so turning it on
   * never silently re-prices a model you priced yourself (explicit `cost` always
   * wins). Pairs naturally with `autoSort` and `onCost`/`onCall`.
   */
  autoPrice?: boolean;
  /** Idle window after which routing snaps back to the cheapest provider. Default 60s. */
  resetIntervalMs?: number;
  /**
   * Circuit breaker: stop sending traffic to a provider that keeps failing,
   * instead of re-probing it on every request. A provider that fails enough
   * times in a window is *skipped* for a cooldown period (one success clears it).
   * This is sharper than `resetIntervalMs` alone, which blindly re-tries the
   * cheapest provider on a timer — a provider that's down then eats a failed
   * attempt every window. `true` enables sensible defaults (3 failures / 60s →
   * 60s cooldown); pass an object to tune; omit to disable (the default —
   * unchanged routing, no provider is ever skipped). See {@link CooldownOptions}.
   */
  cooldown?: boolean | CooldownOptions;
  /**
   * Exact-match RESPONSE cache: when a request is identical to one already
   * answered, replay the stored response and call no provider at all — zero
   * latency, `costUsd: 0`, and the avoided cost reported as `cacheHitSavingUsd`
   * on the {@link CallRecord} (with `cacheHit: true`). Off by default.
   *
   * `true` uses a process-local in-memory store; pass a {@link CacheStore} to
   * bring your own (Redis / Vercel KV — required for cross-request hits on
   * serverless, where memory isn't shared); pass `{ store?, ttlMs? }` to set a
   * TTL. ai-lcr runs no service of its own — any shared store is yours.
   *
   * Caching makes identical requests return identical responses: ideal for
   * idempotent / `temperature: 0` calls, a behavior change for sampled ones.
   * Empty completions and usage-less results are never cached.
   */
  cache?: boolean | CacheStore | CacheOptions;
  /**
   * Automatic provider-side PROMPT caching: insert a `cache_control` breakpoint
   * on the last system message so the static prompt head bills at the
   * cache-read rate (~0.1× input) on repeats. The model still runs — this only
   * lowers input cost, it does not skip the call (that's `cache`). Only
   * Anthropic / MiniMax need the marker; OpenAI / Gemini / DeepSeek cache the
   * prefix automatically and ignore it, so this is safe on a mixed chain.
   *
   * `true` for the 5-minute default, `{ ttl: "1h" }` for the longer window.
   * Off by default; steps aside entirely if you set `cacheControl` yourself.
   */
  promptCache?: boolean | PromptCacheOptions;
  /** Called when a provider errors and routing falls through to the next. */
  onError?: (error: Error, provider: string) => void;
  /** Called after each successful call with the serving provider, tokens, and cost. */
  onCost?: (event: CostEvent) => void;
  /**
   * Called once per settled request (success OR final failure) with the full
   * failover chain — the single correlated record `onError`/`onCost` can't give
   * you. Pair with `formatCallRecord` for a one-line log. See {@link CallRecord}.
   */
  onCall?: (record: CallRecord) => void;
  /**
   * Decide whether a failed attempt should fail over to the next provider.
   * Defaults to {@link shouldFailover} — fail over on everything except a
   * deliberate caller cancellation, so a provider-specific 400 still survives by
   * trying the next provider. Pass {@link isRetryableError} to restore the
   * stricter behavior where a client error (e.g. 400) fails fast.
   */
  shouldRetry?: (error: unknown) => boolean;
  /**
   * Fallback prompt-cache read rate, as a fraction of each leg's `input` price,
   * applied ONLY to legs whose `cost` omits an explicit `cacheRead`. So a leg
   * priced `{ input: 0.5, output: 3 }` with `defaultCacheReadRatio: 0.1` bills
   * its cached input tokens at `0.05`/1M and reports the resulting
   * `cachedSavingUsd` — without every route having to hardcode `cacheRead`.
   *
   * Most providers' cache-read price is ~0.1× input (Anthropic, Gemini, DeepSeek);
   * `0.1` is a sane default. Legs with their own `cacheRead` are untouched, so set
   * it explicitly for outliers (e.g. OpenAI's ~0.5×). Unset = pre-existing
   * behavior: cached tokens bill at the full input rate and save nothing.
   * Caching is detected from the provider's reported usage either way; this only
   * controls the *price* applied to it. Must be in [0, 1].
   */
  defaultCacheReadRatio?: number;
}

/** Resolve a logical model name to a routed model. */
export type LCRRouter = (modelName: string) => LanguageModelV3;

function isLanguageModel(entry: ProviderEntry): entry is LanguageModelV3 {
  return typeof (entry as LanguageModelV3).doGenerate === "function";
}

/** A normalized provider plus the config-time-only `discount`, dropped before
 *  the entry reaches the routing engine. */
type NormalizedEntry = RoutedProvider & { discount?: number };

function normalize(entry: ProviderEntry): NormalizedEntry {
  if (isLanguageModel(entry)) {
    return { model: entry, label: entry.provider };
  }
  return {
    model: entry.model,
    label: entry.label ?? entry.model.provider,
    cost: entry.cost,
    discount: entry.discount,
  };
}

/** Scale every priced field by `(1 - discount)` — a flat reseller discount
 *  applies to cached reads as well as input/output. */
function applyDiscount(cost: ProviderCost, discount: number): ProviderCost {
  const f = 1 - discount;
  return {
    input: cost.input * f,
    output: cost.output * f,
    ...(cost.cacheRead !== undefined ? { cacheRead: cost.cacheRead * f } : {}),
  };
}

/**
 * When `autoPrice` is on and an entry left `cost` unset, fill it from the bundled
 * table by `model.modelId`, applying `discount` if given. Explicit `cost` and
 * unknown models pass through untouched (cost stays as-is / undefined). Always
 * strips `discount` so the routing engine never sees it.
 */
function withAutoPrice(p: NormalizedEntry, autoPrice: boolean): RoutedProvider {
  const { discount, ...rest } = p;
  if (!autoPrice || rest.cost !== undefined) return rest;
  const base = getModelPrice(rest.model.modelId);
  if (!base) return rest;
  return { ...rest, cost: discount !== undefined ? applyDiscount(base, discount) : base };
}

function priceKey(p: RoutedProvider): number {
  return p.cost ? p.cost.input + p.cost.output : Number.POSITIVE_INFINITY;
}

/**
 * Fill a leg's `cacheRead` from the chain-wide `defaultCacheReadRatio` when the
 * leg priced its input but left `cacheRead` unset. Returns a NEW cost object so
 * the caller's `models` config is never mutated. Legs with an explicit
 * `cacheRead` (or no `cost`) pass through untouched.
 */
function withDefaultCacheRead(p: RoutedProvider, ratio: number | undefined): RoutedProvider {
  if (ratio === undefined || !p.cost || p.cost.cacheRead !== undefined) return p;
  return { ...p, cost: { ...p.cost, cacheRead: p.cost.input * ratio } };
}

/**
 * Build a Least Cost Router. Returns a function that resolves a logical model
 * name to a routed model usable anywhere in the Vercel AI SDK (generateText,
 * streamText, generateObject, tools, agents).
 */
export function createLCR(config: LCRConfig): LCRRouter {
  const {
    models,
    autoSort = false,
    autoPrice = false,
    resetIntervalMs,
    cooldown,
    cache,
    promptCache,
    onError,
    onCost,
    onCall,
    shouldRetry,
    defaultCacheReadRatio,
  } = config;

  const resolvedCache = resolveCache(cache);
  const resolvedPromptCache = resolvePromptCache(promptCache);

  if (defaultCacheReadRatio !== undefined && (defaultCacheReadRatio < 0 || defaultCacheReadRatio > 1)) {
    throw new Error(
      `ai-lcr: defaultCacheReadRatio must be in [0, 1], got ${defaultCacheReadRatio}`,
    );
  }

  const routed = new Map<string, LcrFallbackModel>();
  for (const [name, entries] of Object.entries(models)) {
    for (const entry of entries) {
      const d = (entry as { discount?: number }).discount;
      if (d !== undefined && (d < 0 || d >= 1)) {
        throw new Error(`ai-lcr: discount must be in [0, 1) for model "${name}", got ${d}`);
      }
    }
    let providers = entries
      .map(normalize)
      .map((p) => withAutoPrice(p, autoPrice))
      .map((p) => withDefaultCacheRead(p, defaultCacheReadRatio));
    if (autoSort) {
      providers = [...providers].sort((a, b) => priceKey(a) - priceKey(b));
    }
    routed.set(
      name,
      new LcrFallbackModel({
        modelName: name,
        providers,
        resetIntervalMs,
        cooldown,
        ...(resolvedCache ? { cache: resolvedCache } : {}),
        ...(resolvedPromptCache ? { promptCache: resolvedPromptCache } : {}),
        onError,
        onCost,
        onCall,
        shouldRetry,
      }),
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
