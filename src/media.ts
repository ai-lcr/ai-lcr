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

// ── Async (submit / poll) contract ────────────────────────────
// The blocking `run()` above holds a serverless invocation open until the file
// is ready — fine for image (seconds), impossible for a minutes-long video job.
// The async path splits that into two independent calls so `submit` can happen
// in one process (the request handler) and `checkStatus` in another (a cron /
// queue worker), with nothing held open in between. The shapes mirror ai-art's
// `ProviderAdapter` (submit / checkStatus) so a consumer can delegate its own
// async runtime to ai-lcr with no glue. See {@link createMediaLCR}.

export interface MediaSubmitRequest {
  externalId: string;
  /** Canonical input: { prompt, image_url?, duration?, aspect_ratio?, … }. */
  input: Record<string, unknown>;
  /** Opaque caller metadata passed through to the provider (e.g. a webhook hint). */
  metadata?: Record<string, unknown>;
}

/** What `submit` returns: the provider-native job id to poll on. */
export interface MediaSubmitResult {
  requestId: string;
}

export interface MediaStatusRequest {
  externalId: string;
  requestId: string;
}

/** Lifecycle of an async media job. `done`/`error` are terminal. */
export type MediaJobStatus = "queued" | "running" | "done" | "error";

/** What `checkStatus` returns when polling an in-flight job. */
export interface MediaStatusResult {
  status: MediaJobStatus;
  /** Present on `done`. */
  outputs?: MediaOutput[];
  /** Provider-reported actual cost in cents, when the API returns it (`done`). */
  costCents?: number;
  /** Units billed (e.g. seconds of video) — cost fallback when `costCents` is absent. */
  units?: number;
  /** Human-readable reason on `error`. */
  error?: string;
}

/**
 * A provider adapter.
 *
 * - `run` is the SYNC path: it resolves only when the output is ready (image
 *   adapters return synchronously; the blocking video path polls internally).
 *   Always present.
 * - `submit` + `checkStatus` are the optional ASYNC path: `submit` enqueues the
 *   job and returns a `requestId`; `checkStatus` polls it. A provider that only
 *   serves synchronously (e.g. image-only) omits both — {@link createMediaLCR}'s
 *   `submit`/`poll` simply skip a route whose adapter can't serve async.
 */
export interface MediaAdapter {
  provider: string;
  run(req: MediaGenerateRequest): Promise<MediaGenerateResult>;
  submit?(req: MediaSubmitRequest): Promise<MediaSubmitResult>;
  checkStatus?(req: MediaStatusRequest): Promise<MediaStatusResult>;
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

export interface MediaSubmitOptions {
  /** Opaque caller metadata forwarded to the provider's `submit`. */
  metadata?: Record<string, unknown>;
}

/**
 * A serializable receipt for an in-flight async job, returned by `submit` and
 * passed back to `poll`. It is plain JSON ON PURPOSE: submit and poll typically
 * run in different processes (request handler vs. cron worker), so the handle
 * must survive a round-trip through a database or queue with no live object
 * references.
 *
 * Crucially it carries everything `poll` needs to fail over WITHOUT re-routing
 * from scratch: the provider currently serving, the not-yet-tried `fallbacks`
 * (already cheapest-first), and the original `input` — so when a provider's job
 * fails mid-poll, `poll` can re-submit to the next provider rather than give up.
 * It also threads the telemetry accumulator (`startedAt`, `attempts`,
 * `baselineUsd`) across processes so the single settled {@link CallRecord} lands
 * at the terminal poll with the full failover chain intact.
 */
export interface MediaJobHandle {
  modelId: string;
  /** Provider currently serving the job. */
  provider: string;
  /** Selected route's provider-native id (needed to poll). */
  externalId: string;
  /** Provider-native job id from `submit`. */
  requestId: string;
  /** Normalized cost (cents/ref output) of the serving route — used to estimate cost. */
  refCents: number;
  /** Not-yet-tried routes, cheapest-first, for poll-time re-submit failover. */
  fallbacks: { provider: string; externalId: string; refCents: number }[];
  /** Original canonical input, retained so a failover can re-submit elsewhere. */
  input: Record<string, unknown>;
  /** Caller metadata, retained for re-submit. */
  metadata?: Record<string, unknown>;
  /** Savings baseline (USD) for the settled record — the go-direct/official price. */
  baselineUsd: number;
  /** Epoch ms the whole request started (first submit) — drives total latency. */
  startedAt: number;
  /** Epoch ms the CURRENT provider's attempt started (its submit). */
  attemptStart: number;
  /** Failed attempts so far, threaded across processes for the final CallRecord. */
  attempts: CallRecord["attempts"];
}

/** Outcome of one `poll` call. `done:false` ⇒ keep polling `handle`. */
export type MediaPollResult =
  | {
      done: false;
      /** "queued"/"running" from the provider; a fresh re-submit reports "queued". */
      status: "queued" | "running";
      /** The handle to poll next — a NEW one (next provider) when `failedOver`. */
      handle: MediaJobHandle;
      /** True when this poll re-submitted to a fallback provider. */
      failedOver?: boolean;
    }
  | {
      done: true;
      status: "done";
      outputs: MediaOutput[];
      provider: string;
      costCents: number;
      estimated: boolean;
    };

/**
 * The router returned by {@link createMediaLCR}: a callable (the sync `run`
 * path, unchanged) with `submit`/`poll` attached (the async path). Existing
 * `const generate = createMediaLCR(...); generate(id, input)` keeps working
 * verbatim — the methods are purely additive.
 */
export interface MediaLCR {
  (modelId: string, input: Record<string, unknown>): Promise<MediaRunResult>;
  /** Route + enqueue cheapest-first; returns a serializable {@link MediaJobHandle}. */
  submit(
    modelId: string,
    input: Record<string, unknown>,
    options?: MediaSubmitOptions,
  ): Promise<MediaJobHandle>;
  /** Poll one job; on a provider failure re-submits to the next provider. */
  poll(handle: MediaJobHandle): Promise<MediaPollResult>;
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

export function createMediaLCR(config: MediaLCRConfig): MediaLCR {
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

  // Resolve a model to its cheapest-first routes + savings baseline. Shared by
  // the sync and async entry points so routing/baseline stay identical.
  function resolve(modelId: string): { ranked: RankedRoute[]; baselineUsd: number } {
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
    return { ranked, baselineUsd };
  }

  // cost = provider-reported when present, else the normalized ref-price estimate.
  const costFor = (refCents: number, result: { costCents?: number; units?: number }) =>
    result.costCents === undefined ? refCents * (result.units ?? 1) : result.costCents;

  // One CallRecord for a request that settled in failure / exhaustion. Shared by
  // both paths — the sync loop, a submit that no provider accepts, and a poll
  // that exhausts its fallbacks.
  const emitFail = (
    modelId: string,
    attempts: CallRecord["attempts"],
    baselineUsd: number,
    startedAt: number,
  ): void =>
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

  // One CallRecord for a request that settled successfully on `provider`.
  const emitOk = (
    modelId: string,
    provider: string,
    attempts: CallRecord["attempts"],
    costCents: number,
    baselineUsd: number,
    startedAt: number,
  ): void =>
    safeCall({
      id: newMediaCallId(),
      model: modelId,
      attempts,
      winner: provider,
      ok: true,
      failedOver: attempts.length > 1,
      latencyMs: Date.now() - startedAt,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: costCents / 100,
      baselineUsd,
    });

  // ── Sync path (unchanged behavior) ──────────────────────────
  const generate = async function generate(
    modelId: string,
    input: Record<string, unknown>,
  ): Promise<MediaRunResult> {
    const { ranked, baselineUsd } = resolve(modelId);
    const startedAt = Date.now();
    const attempts: CallRecord["attempts"] = [];
    let lastErr: unknown;

    for (const route of ranked) {
      const adapter = adapters[route.provider];
      if (!adapter) continue; // no adapter wired for this provider → skip to next
      const attemptStart = Date.now();
      try {
        const result = await adapter.run({ externalId: route.externalId, input });
        const estimated = result.costCents === undefined;
        const costCents = costFor(route.refCents, result);
        attempts.push({ provider: route.provider, ok: true, latencyMs: Date.now() - attemptStart });
        safeCost({ modelId, provider: route.provider, costCents, estimated });
        emitOk(modelId, route.provider, attempts, costCents, baselineUsd, startedAt);
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
          emitFail(modelId, attempts, baselineUsd, startedAt); // caller's fault → don't waste fallbacks
          throw err;
        }
      }
    }
    emitFail(modelId, attempts, baselineUsd, startedAt);
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`ai-lcr: no provider could serve media model "${modelId}"`);
  } as MediaLCR;

  // ── Async path: submit / poll ───────────────────────────────
  // Routes that can serve async = have an adapter wired AND that adapter
  // implements `submit`. (Image-only adapters omit `submit`, so they're skipped
  // here even though they serve the sync path.)
  const asyncRanked = (modelId: string): RankedRoute[] => {
    const { ranked } = resolve(modelId);
    return ranked.filter((r) => typeof adapters[r.provider]?.submit === "function");
  };

  // Try to submit to the cheapest of `routes`, recording each failed attempt.
  // Returns the handle on the first success. Throws (after emitting a fail
  // record) when none accept it or a non-retryable error is hit — but only if
  // `emitOnFail`, so the poll-time caller can decide when to settle the record.
  async function submitFrom(
    modelId: string,
    routes: RankedRoute[],
    input: Record<string, unknown>,
    metadata: Record<string, unknown> | undefined,
    baselineUsd: number,
    startedAt: number,
    attempts: CallRecord["attempts"],
  ): Promise<MediaJobHandle> {
    let lastErr: unknown;
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i]!;
      const adapter = adapters[route.provider];
      if (!adapter?.submit) continue;
      const attemptStart = Date.now();
      try {
        const { requestId } = await adapter.submit({ externalId: route.externalId, input, metadata });
        return {
          modelId,
          provider: route.provider,
          externalId: route.externalId,
          requestId,
          refCents: route.refCents,
          fallbacks: routes
            .slice(i + 1)
            .map((r) => ({ provider: r.provider, externalId: r.externalId, refCents: r.refCents })),
          input,
          ...(metadata ? { metadata } : {}),
          baselineUsd,
          startedAt,
          attemptStart,
          attempts,
        };
      } catch (err) {
        lastErr = err;
        attempts.push({
          provider: route.provider,
          ok: false,
          latencyMs: Date.now() - attemptStart,
          errorClass: classifyError(err),
        });
        safeError(err as Error, route.provider);
        if (!isRetryableError(err)) break; // caller's fault → stop trying
      }
    }
    emitFail(modelId, attempts, baselineUsd, startedAt);
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`ai-lcr: no async provider could submit media model "${modelId}"`);
  }

  generate.submit = async function submit(
    modelId: string,
    input: Record<string, unknown>,
    options?: MediaSubmitOptions,
  ): Promise<MediaJobHandle> {
    const { ranked, baselineUsd } = resolve(modelId);
    const usable = ranked.filter((r) => typeof adapters[r.provider]?.submit === "function");
    if (usable.length === 0) {
      throw new Error(
        `ai-lcr: no provider for media model "${modelId}" supports async submit (need an adapter with submit/checkStatus)`,
      );
    }
    return submitFrom(modelId, usable, input, options?.metadata, baselineUsd, Date.now(), []);
  };

  generate.poll = async function poll(handle: MediaJobHandle): Promise<MediaPollResult> {
    const adapter = adapters[handle.provider];
    if (!adapter?.checkStatus) {
      throw new Error(
        `ai-lcr: provider "${handle.provider}" has no checkStatus — cannot poll model "${handle.modelId}"`,
      );
    }

    // Re-submit to the next fallback provider after the current one failed. The
    // accumulated `attempts` (carrying the failed leg) and `startedAt` thread
    // through so the eventual settled record shows the whole chain. Returns a
    // fresh handle to keep polling; emits a fail record + throws when exhausted.
    const failover = async (attempts: CallRecord["attempts"]): Promise<MediaPollResult> => {
      const next = asyncRanked(handle.modelId).filter((r) =>
        handle.fallbacks.some((f) => f.provider === r.provider && f.externalId === r.externalId),
      );
      const newHandle = await submitFrom(
        handle.modelId,
        next,
        handle.input,
        handle.metadata,
        handle.baselineUsd,
        handle.startedAt,
        attempts,
      );
      return { done: false, status: "queued", handle: newHandle, failedOver: true };
    };

    // A failed leg → record it, then fail over to the next provider when a
    // fallback remains and the failure is worth retrying; otherwise settle the
    // record as failed and throw. `retryable` is decided by the caller: a thrown
    // transport error uses the standard {@link isRetryableError} gate (so a
    // caller-bug 400 on the poll endpoint doesn't loop), whereas a provider's own
    // job-level failure (`status:"error"`, or completed-empty) is always worth
    // trying on another provider — the whole point of poll-time failover.
    const onLegFailure = async (err: unknown, retryable: boolean): Promise<MediaPollResult> => {
      const attempts: CallRecord["attempts"] = [
        ...handle.attempts,
        {
          provider: handle.provider,
          ok: false,
          latencyMs: Date.now() - handle.attemptStart,
          errorClass: classifyError(err),
        },
      ];
      safeError(err as Error, handle.provider);
      if (retryable && handle.fallbacks.length > 0) {
        return failover(attempts);
      }
      emitFail(handle.modelId, attempts, handle.baselineUsd, handle.startedAt);
      throw err instanceof Error ? err : new Error(String(err));
    };

    let status: MediaStatusResult;
    try {
      status = await adapter.checkStatus({ externalId: handle.externalId, requestId: handle.requestId });
    } catch (err) {
      // A thrown poll error (transport/timeout, e.g. the 504 remap) → fail over
      // when the standard classifier says it's retryable.
      return onLegFailure(err, isRetryableError(err));
    }

    if (status.status === "queued" || status.status === "running") {
      return { done: false, status: status.status, handle };
    }

    if (status.status === "done") {
      const outputs = status.outputs ?? [];
      if (outputs.length === 0) {
        // Completed with nothing to show — a provider failure; always worth a
        // fallback rather than handing the caller an empty success.
        return onLegFailure(
          new Error(`ai-lcr: ${handle.provider} job ${handle.requestId} completed with no output`),
          true,
        );
      }
      const estimated = status.costCents === undefined;
      const costCents = costFor(handle.refCents, status);
      const attempts: CallRecord["attempts"] = [
        ...handle.attempts,
        { provider: handle.provider, ok: true, latencyMs: Date.now() - handle.attemptStart },
      ];
      safeCost({ modelId: handle.modelId, provider: handle.provider, costCents, estimated });
      emitOk(handle.modelId, handle.provider, attempts, costCents, handle.baselineUsd, handle.startedAt);
      return { done: true, status: "done", outputs, provider: handle.provider, costCents, estimated };
    }

    // status === "error" — a provider's job failed; always worth a fallback.
    return onLegFailure(new Error(status.error ?? `ai-lcr: ${handle.provider} job failed`), true);
  };

  return generate;
}
