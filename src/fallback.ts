/**
 * Owned failover engine for ai-lcr.
 *
 * A LanguageModelV3 that wraps an ordered, cheapest-first list of providers:
 * it serves from the first healthy one, switches to the next on a retryable
 * error (streaming-safe), and snaps back to the cheapest after an idle window.
 * It also computes per-call cost from each provider's price and fires `onCost`.
 *
 * The switching loop is adapted from `ai-fallback` (MIT, © remorses) — its
 * streaming-safe fallback approach — reimplemented here so ai-lcr owns its core
 * engine and can layer cost accounting + provider quirks directly into it.
 */
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";

/** USD per 1M tokens. */
export interface ProviderCost {
  input: number;
  output: number;
}

export interface RoutedProvider {
  model: LanguageModelV3;
  /** Human label for cost events / logs (e.g. "kunavo"). */
  label: string;
  /** Price for cost accounting + cheapest-first sorting. Optional. */
  cost?: ProviderCost;
}

export interface CostEvent {
  /** Logical model name (the key in createLCR's `models`). */
  model: string;
  /** Which provider actually served the request. */
  provider: string;
  inputTokens: number;
  outputTokens: number;
  /** Computed from the serving provider's `cost`; 0 if no price was given. */
  costUsd: number;
}

/** One provider attempt within a single request. */
export interface RouteAttempt {
  /** Provider label that was tried (e.g. "tokenmart"). */
  provider: string;
  /** Did this provider serve the request? The last attempt is the winner when true. */
  ok: boolean;
  /** Wall time spent on this attempt, ms (for the winner of a stream, the full stream duration). */
  latencyMs: number;
  /** Normalized failure reason when `ok` is false (e.g. "502", "rate_limit", "timeout"). */
  errorClass?: string;
}

/**
 * One settled request, with its full failover chain. Emitted exactly once per
 * `doGenerate`/`doStream` call (success OR final failure) via `onCall`. This is
 * the single correlated record `onError` + `onCost` couldn't give you: it ties
 * every attempt, the winner, the reasons, latency, and cost into one line.
 * Pair it with `formatCallRecord` for a human-readable one-liner.
 */
export interface CallRecord {
  /** Correlation id, unique per request (shared across a stream's failover recursion). */
  id: string;
  /** Logical model name (the key in createLCR's `models`). */
  model: string;
  /** Providers tried, in order. `attempts.length > 1` means a failover happened. */
  attempts: RouteAttempt[];
  /** Provider that served the request; undefined if every provider failed. */
  winner?: string;
  ok: boolean;
  /** True when more than one provider was tried — the thing you want to spot at a glance. */
  failedOver: boolean;
  /** Total wall time across all attempts, ms. */
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Computed from the winner's `cost`; 0 if no price was given or the call failed. */
  costUsd: number;
}

export interface FallbackOptions {
  modelName: string;
  providers: RoutedProvider[];
  resetIntervalMs?: number;
  onError?: (error: Error, provider: string) => void;
  onCost?: (event: CostEvent) => void;
  /** Called once per settled request with the full failover chain. See {@link CallRecord}. */
  onCall?: (record: CallRecord) => void;
  shouldRetry?: (error: unknown) => boolean;
}

// Errors that mean "this provider can't serve right now" → try the next one.
// 402 is included on purpose: a provider that's out of credit / over quota
// can't serve, and the whole point of least-cost routing is to fall over to
// the next one rather than fail the request.
const RETRYABLE_STATUS = new Set([401, 402, 403, 408, 409, 413, 429, 498, 500]);
const RETRYABLE_PATTERNS = [
  "overloaded",
  "service unavailable",
  "bad gateway",
  "too many requests",
  "internal server error",
  "gateway timeout",
  "rate_limit",
  "ratelimit",
  "rate limit",
  "capacity",
  "timeout",
  "server_error",
  "502",
  "503",
  "504",
  "429",
  // Billing caps — a capped provider should fall over, not kill the request.
  "insufficient",
  "credit",
  "quota",
  "billing",
  "payment required",
];

/** Default switch criterion: provider down / rate-limited / overloaded. */
export function isRetryableError(error: unknown): boolean {
  const e = error as { statusCode?: number; status?: number; message?: string } | undefined;
  const status = e?.statusCode ?? e?.status;
  if (typeof status === "number" && (RETRYABLE_STATUS.has(status) || status > 500)) {
    return true;
  }
  const text = (e?.message ? String(e.message) : safeStringify(error)).toLowerCase();
  return RETRYABLE_PATTERNS.some((p) => text.includes(p));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * Normalize an error into a short, log-friendly class for {@link CallRecord}.
 * An HTTP status wins (e.g. "502", "429"); otherwise the first matching
 * retryable pattern (e.g. "rate_limit", "timeout"); otherwise "error".
 * Reuses the same signals as {@link isRetryableError} — no new vocabulary.
 */
export function classifyError(error: unknown): string {
  const e = error as { statusCode?: number; status?: number; message?: string } | undefined;
  const status = e?.statusCode ?? e?.status;
  if (typeof status === "number") return String(status);
  const text = (e?.message ? String(e.message) : safeStringify(error)).toLowerCase();
  return RETRYABLE_PATTERNS.find((p) => text.includes(p)) ?? "error";
}

// Per-request correlation id. crypto.randomUUID when available (Node/edge),
// else a monotonic fallback — no external dependency, no Math.random.
let callSeq = 0;
function newCallId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `lcr_${Date.now().toString(36)}_${(callSeq++).toString(36)}`;
}

/** Per-request accumulator: threaded through a stream's failover recursion so
 * every attempt lands in one {@link CallRecord}. Must be per-call (the model
 * instance is shared across concurrent requests), never instance state. */
interface CallCtx {
  id: string;
  attempts: RouteAttempt[];
  startedAt: number;
}

export class LcrFallbackModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;

  private index = 0;
  private lastReset = Date.now();
  private readonly resetIntervalMs: number;

  constructor(private readonly opts: FallbackOptions) {
    if (opts.providers.length === 0) {
      throw new Error(`ai-lcr: model "${opts.modelName}" has no providers`);
    }
    this.resetIntervalMs = opts.resetIntervalMs ?? 60_000;
  }

  private get current(): RoutedProvider {
    return this.opts.providers[this.index]!;
  }

  get modelId(): string {
    return this.current.model.modelId;
  }

  get provider(): string {
    return this.current.model.provider;
  }

  get supportedUrls() {
    return this.current.model.supportedUrls;
  }

  private checkReset(): void {
    if (this.index !== 0 && Date.now() - this.lastReset >= this.resetIntervalMs) {
      this.index = 0;
    }
    this.lastReset = Date.now();
  }

  private switchNext(): void {
    this.index = (this.index + 1) % this.opts.providers.length;
  }

  private shouldRetry(error: unknown): boolean {
    return (this.opts.shouldRetry ?? isRetryableError)(error);
  }

  private startCall(): CallCtx {
    return { id: newCallId(), attempts: [], startedAt: Date.now() };
  }

  /** Record a failed attempt onto the call's chain (no event yet). */
  private recordFail(
    ctx: CallCtx,
    provider: RoutedProvider,
    attemptStart: number,
    error: unknown,
  ): void {
    ctx.attempts.push({
      provider: provider.label,
      ok: false,
      latencyMs: Date.now() - attemptStart,
      errorClass: classifyError(error),
    });
  }

  /** Winner settled: record the attempt, fire `onCost` (compat) + `onCall`. */
  private finalizeOk(
    ctx: CallCtx,
    provider: RoutedProvider,
    attemptStart: number,
    usage: LanguageModelV3GenerateResult["usage"] | undefined,
  ): void {
    ctx.attempts.push({ provider: provider.label, ok: true, latencyMs: Date.now() - attemptStart });
    const inputTokens = usage?.inputTokens?.total ?? 0;
    const outputTokens = usage?.outputTokens?.total ?? 0;
    const costUsd = provider.cost
      ? (inputTokens / 1e6) * provider.cost.input + (outputTokens / 1e6) * provider.cost.output
      : 0;
    this.opts.onCost?.({
      model: this.opts.modelName,
      provider: provider.label,
      inputTokens,
      outputTokens,
      costUsd,
    });
    this.opts.onCall?.({
      id: ctx.id,
      model: this.opts.modelName,
      attempts: ctx.attempts,
      winner: provider.label,
      ok: true,
      failedOver: ctx.attempts.length > 1,
      latencyMs: Date.now() - ctx.startedAt,
      inputTokens,
      outputTokens,
      costUsd,
    });
  }

  /** Every provider failed: fire `onCall` with no winner. */
  private finalizeFail(ctx: CallCtx): void {
    this.opts.onCall?.({
      id: ctx.id,
      model: this.opts.modelName,
      attempts: ctx.attempts,
      winner: undefined,
      ok: false,
      failedOver: ctx.attempts.length > 1,
      latencyMs: Date.now() - ctx.startedAt,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  }

  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3GenerateResult> {
    this.checkReset();
    const ctx = this.startCall();
    const start = this.index;
    let lastError: unknown;
    for (;;) {
      const provider = this.current;
      const attemptStart = Date.now();
      try {
        const result = await provider.model.doGenerate(options);
        this.finalizeOk(ctx, provider, attemptStart, result.usage);
        return result;
      } catch (error) {
        lastError = error;
        if (!this.shouldRetry(error)) {
          this.recordFail(ctx, provider, attemptStart, error);
          this.finalizeFail(ctx);
          throw error;
        }
        this.opts.onError?.(error as Error, provider.label);
        this.recordFail(ctx, provider, attemptStart, error);
        this.switchNext();
        if (this.index === start) {
          this.finalizeFail(ctx);
          throw lastError;
        }
      }
    }
  }

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    this.checkReset();
    return this.doStreamWithCtx(options, this.startCall());
  }

  // The stream's failover recursion re-enters here with the SAME `ctx`, so a
  // mid-stream switch keeps appending to one CallRecord instead of starting a
  // fresh one. `finalizeOk`/`finalizeFail` fire exactly once per outer request.
  private async doStreamWithCtx(
    options: LanguageModelV3CallOptions,
    ctx: CallCtx,
  ): Promise<LanguageModelV3StreamResult> {
    const self = this;
    const start = this.index;

    // Phase 1: obtain a stream that starts without throwing, switching on a
    // pre-stream error (e.g. a 401/429 before the first chunk).
    let result: LanguageModelV3StreamResult;
    let serving: RoutedProvider;
    let servingStart: number;
    for (;;) {
      serving = this.current;
      servingStart = Date.now();
      try {
        result = await serving.model.doStream(options);
        break;
      } catch (error) {
        if (!this.shouldRetry(error)) {
          this.recordFail(ctx, serving, servingStart, error);
          this.finalizeFail(ctx);
          throw error;
        }
        this.opts.onError?.(error as Error, serving.label);
        this.recordFail(ctx, serving, servingStart, error);
        this.switchNext();
        if (this.index === start) {
          this.finalizeFail(ctx);
          throw error;
        }
      }
    }

    const servingProvider = serving;
    const servingAttemptStart = servingStart;
    let usage: LanguageModelV3GenerateResult["usage"] | undefined;
    let streamedAny = false;

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        let reader: ReadableStreamDefaultReader<LanguageModelV3StreamPart> | null = null;
        try {
          reader = result.stream.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            // An error surfaced as the first chunk → fail over (only if nothing
            // user-visible has streamed yet).
            if (!streamedAny && value && typeof value === "object" && "error" in value) {
              const err = (value as { error: unknown }).error;
              if (self.shouldRetry(err)) throw err;
            }
            if (done) break;
            if (value.type === "finish") usage = value.usage;
            controller.enqueue(value);
            if (value.type !== "stream-start") streamedAny = true;
          }
          self.finalizeOk(ctx, servingProvider, servingAttemptStart, usage);
          controller.close();
        } catch (error) {
          self.opts.onError?.(error as Error, servingProvider.label);
          self.recordFail(ctx, servingProvider, servingAttemptStart, error);
          if (!streamedAny) {
            self.switchNext();
            if (self.index === start) {
              self.finalizeFail(ctx);
              controller.error(error);
              return;
            }
            // Re-enter on the next provider with the SAME ctx, so its attempts
            // and final event belong to this one CallRecord.
            try {
              const next = await self.doStreamWithCtx(options, ctx);
              const nextReader = next.stream.getReader();
              try {
                for (;;) {
                  const { done, value } = await nextReader.read();
                  if (done) break;
                  controller.enqueue(value);
                }
                controller.close();
              } finally {
                nextReader.releaseLock();
              }
            } catch (nextError) {
              controller.error(nextError);
            }
            return;
          }
          // Already streamed user-visible output — can't fail over. Settle the
          // record as failed (the recorded attempt carries the reason).
          self.finalizeFail(ctx);
          controller.error(error);
        } finally {
          reader?.releaseLock();
        }
      },
    });

    return { ...result, stream };
  }
}
