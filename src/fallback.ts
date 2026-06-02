/**
 * Owned failover engine for ai-lcr.
 *
 * A LanguageModelV3 that wraps an ordered, cheapest-first list of providers:
 * it serves from the first healthy one, switches to the next on a retryable
 * error (streaming-safe), and periodically re-probes the cheapest provider
 * (every `resetIntervalMs` after a failover — under load too, not only when
 * idle). It also computes per-call cost from each provider's price and fires
 * `onCost`.
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

/**
 * Coarse error category for a failed attempt — distinct from `errorClass`
 * (which is the raw status/pattern). Use it to alert: `"auth"` and `"billing"`
 * mean a config/account problem masquerading as a healthy failover, the thing
 * you want to page on rather than silently keep burning the pricey fallback.
 *   - "transient": rate limit / overload / 5xx — expected, self-healing.
 *   - "auth":      401 / 403 — a misconfigured or revoked key.
 *   - "billing":   402 / out-of-credit / quota — account needs topping up.
 *   - "client":    a non-retryable caller error (e.g. 400 bad request).
 */
export type ErrorKind = "transient" | "auth" | "billing" | "client";

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
  /** Coarse category of the failure when `ok` is false. See {@link ErrorKind}. */
  kind?: ErrorKind;
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
  /**
   * What the same request would have cost on the most expensive configured
   * provider — the savings baseline (`baselineUsd - costUsd`). Set by the media
   * router; the text router omits it (left undefined) until a per-call text
   * baseline lands. Optional so both routers share one {@link CallRecord} shape.
   */
  baselineUsd?: number;
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
  // Include non-English wording: Chinese providers (e.g. Kunavo) report a failed
  // charge as "余额不足"/"账户欠费"/"扣费失败" with a 200/400 body, which no
  // English keyword and no HTTP status would catch — so without these a billing
  // failure would die instead of failing over, the exact opposite of what we want.
  "insufficient",
  "credit",
  "quota",
  "billing",
  "payment required",
  "balance",
  "余额",
  "欠费",
  "扣费",
  "扣款",
];

// Connection-level failures: the provider is unreachable, the socket dropped,
// DNS failed, or the request timed out at the transport layer. `fetch` surfaces
// these as a TypeError with NO HTTP status — and often wraps the real cause
// (which carries a Node `code`) in `error.cause`. None of them match a status
// or an HTTP pattern, so without explicit detection they'd be misread as a
// non-retryable client error and the request would die on a dead provider
// instead of failing over to the next one — the single most common outage mode.
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPROTO",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const NETWORK_PATTERNS = [
  "fetch failed",
  "failed to fetch",
  "socket hang up",
  "socket disconnected",
  "econnrefused",
  "econnreset",
  "enotfound",
  "etimedout",
  "ehostunreach",
  "enetunreach",
  "eai_again",
  "getaddrinfo",
  "connect timeout",
  "connection refused",
  "connection reset",
  "connection error",
  "network error",
  "dns",
];

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * Gather an error's `message`, `name`, and Node `code` across its whole `cause`
 * chain, lowercased — because `fetch` wraps the real network failure (the one
 * with the useful `code`/text) inside `error.cause`, invisible to a top-level
 * `.message` read. Bounded depth and cycle-safe. Returns the joined searchable
 * text plus every `code` string seen, so callers can match patterns or codes.
 */
function errorSignals(error: unknown): { text: string; codes: string[] } {
  const parts: string[] = [];
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = error;
  for (let depth = 0; depth < 6 && cur && typeof cur === "object" && !seen.has(cur); depth++) {
    seen.add(cur);
    const e = cur as { message?: unknown; name?: unknown; code?: unknown; cause?: unknown };
    if (typeof e.message === "string") parts.push(e.message);
    if (typeof e.name === "string") parts.push(e.name);
    if (typeof e.code === "string") {
      parts.push(e.code);
      codes.push(e.code);
    }
    cur = e.cause;
  }
  if (parts.length === 0) parts.push(safeStringify(error));
  return { text: parts.join(" ").toLowerCase(), codes };
}

/**
 * A transport-level failure (provider unreachable / socket dropped / DNS /
 * connect timeout). These carry no HTTP status, so they must be detected
 * structurally — by Node `code` or message — or they read as non-retryable.
 * Note: a deliberate caller cancellation (AbortError without a network code) is
 * intentionally NOT treated as network here, so we don't "fail over" a request
 * the caller chose to abort.
 */
export function isNetworkError(error: unknown): boolean {
  const { text, codes } = errorSignals(error);
  if (codes.some((c) => NETWORK_CODES.has(c))) return true;
  return NETWORK_PATTERNS.some((p) => text.includes(p));
}

/** Default switch criterion: provider down / rate-limited / overloaded / unreachable. */
export function isRetryableError(error: unknown): boolean {
  const e = error as { statusCode?: number; status?: number } | undefined;
  const status = e?.statusCode ?? e?.status;
  if (typeof status === "number" && (RETRYABLE_STATUS.has(status) || status > 500)) {
    return true;
  }
  if (isNetworkError(error)) return true;
  const { text } = errorSignals(error);
  return RETRYABLE_PATTERNS.some((p) => text.includes(p));
}

/**
 * Normalize an error into a short, log-friendly class for {@link CallRecord}.
 * An HTTP status wins (e.g. "502", "429"); otherwise the first matching
 * retryable pattern (e.g. "rate_limit", "timeout"); otherwise "error".
 * Reuses the same signals as {@link isRetryableError} — no new vocabulary.
 */
export function classifyError(error: unknown): string {
  const e = error as { statusCode?: number; status?: number } | undefined;
  const status = e?.statusCode ?? e?.status;
  if (typeof status === "number") return String(status);
  if (isNetworkError(error)) return "network";
  const { text } = errorSignals(error);
  return RETRYABLE_PATTERNS.find((p) => text.includes(p)) ?? "error";
}

// Auth / billing live inside RETRYABLE_* on purpose (a dead key or a capped
// account should still fail over so the request survives) — but they are NOT
// transient, so we surface them separately for alerting. See {@link ErrorKind}.
const AUTH_STATUS = new Set([401, 403]);
const BILLING_PATTERNS = [
  "insufficient",
  "credit",
  "quota",
  "billing",
  "payment required",
  "balance",
  "exhausted",
  "余额",
  "欠费",
  "扣费",
  "扣款",
];

/**
 * Categorize an error for alerting. Orthogonal to {@link isRetryableError}
 * (which decides *whether* to fail over) — this decides *how alarming* the
 * failover is. A run of `"auth"`/`"billing"` attempts means you're silently
 * burning the pricey fallback because a key/account is broken: page on it.
 */
export function classifyErrorKind(error: unknown): ErrorKind {
  const e = error as { statusCode?: number; status?: number } | undefined;
  const status = e?.statusCode ?? e?.status;
  const { text } = errorSignals(error);
  // Billing wording wins over a bare auth status: providers report an
  // out-of-credit account as 403 (e.g. fal "exhausted balance") — that's a
  // top-up problem, not a revoked key, and tagging it `billing` is what lets
  // you alert on the right thing. A 401/403 with no billing wording stays auth.
  if (status === 402 || BILLING_PATTERNS.some((p) => text.includes(p))) return "billing";
  if (typeof status === "number" && AUTH_STATUS.has(status)) return "auth";
  return isRetryableError(error) ? "transient" : "client";
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

  // Cross-request *hint* for where the next request starts: after a failover we
  // remember the provider that worked so we don't re-probe a dead cheap one on
  // every call. This is the ONLY shared mutable state — and crucially it is read
  // once per request (snapshotted into a local cursor) and written once on
  // settle, never used as a per-request loop bound. The within-request iteration
  // is fully local, so concurrent requests can't corrupt each other's routing.
  private sticky = 0;
  // When `sticky` was last advanced (a failover). The re-probe timer measures
  // from THIS, not from the last call — so it fires under sustained traffic too,
  // instead of being pushed forward forever by a busy stream of requests.
  private lastFailoverAt = Date.now();
  private readonly resetIntervalMs: number;

  constructor(private readonly opts: FallbackOptions) {
    if (opts.providers.length === 0) {
      throw new Error(`ai-lcr: model "${opts.modelName}" has no providers`);
    }
    this.resetIntervalMs = opts.resetIntervalMs ?? 60_000;
  }

  private get current(): RoutedProvider {
    return this.opts.providers[this.sticky]!;
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

  /**
   * Index a new request should start at. If we're parked on a non-cheapest
   * provider and it's been `resetIntervalMs` since the failover, snap back to
   * the cheapest and re-probe it — this is what lets routing recover to the
   * cheap source even during continuous traffic.
   */
  private startIndex(): number {
    if (this.sticky !== 0 && Date.now() - this.lastFailoverAt >= this.resetIntervalMs) {
      this.sticky = 0;
    }
    return this.sticky;
  }

  /**
   * A request settled on `winIndex`. Park there so the next request skips the
   * providers we just learned are down. Stamp the failover time only when the
   * parked provider actually CHANGES — so a steady stream of successful calls
   * on the same fallback doesn't keep pushing the re-probe timer forward.
   */
  private settleSticky(winIndex: number): void {
    if (winIndex === this.sticky) return;
    this.sticky = winIndex;
    this.lastFailoverAt = Date.now();
  }

  private shouldRetry(error: unknown): boolean {
    return (this.opts.shouldRetry ?? isRetryableError)(error);
  }

  // Observer callbacks are caller-supplied logging hooks: a throw from one of
  // them must NEVER turn a successful (or already-failed) request into a
  // different outcome. Swallow anything they throw — they are fire-and-forget.
  private emitError(error: unknown, provider: string): void {
    try {
      this.opts.onError?.(error as Error, provider);
    } catch {
      /* observer must not affect routing */
    }
  }

  private emitCost(event: CostEvent): void {
    try {
      this.opts.onCost?.(event);
    } catch {
      /* observer must not affect routing */
    }
  }

  private emitCall(record: CallRecord): void {
    try {
      this.opts.onCall?.(record);
    } catch {
      /* observer must not affect routing */
    }
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
      kind: classifyErrorKind(error),
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
    this.emitCost({
      model: this.opts.modelName,
      provider: provider.label,
      inputTokens,
      outputTokens,
      costUsd,
    });
    this.emitCall({
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
    this.emitCall({
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
    const ctx = this.startCall();
    const providers = this.opts.providers;
    const n = providers.length;
    const start = this.startIndex();
    let lastError: unknown;
    // Local cursor + counter: each request walks every provider once, starting
    // from `start`. Termination is the local `tried` count, never shared state.
    for (let tried = 0; tried < n; tried++) {
      const idx = (start + tried) % n;
      const provider = providers[idx]!;
      const attemptStart = Date.now();
      try {
        const result = await provider.model.doGenerate(options);
        this.settleSticky(idx);
        this.finalizeOk(ctx, provider, attemptStart, result.usage);
        return result;
      } catch (error) {
        lastError = error;
        if (!this.shouldRetry(error)) {
          this.recordFail(ctx, provider, attemptStart, error);
          this.finalizeFail(ctx);
          throw error;
        }
        this.emitError(error, provider.label);
        this.recordFail(ctx, provider, attemptStart, error);
      }
    }
    this.finalizeFail(ctx);
    throw lastError;
  }

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    return this.doStreamWithCtx(options, this.startCall(), this.startIndex(), 0);
  }

  // The stream's failover recursion re-enters here with the SAME `ctx` and a
  // threaded-through local cursor (`idx`/`tried`), so a mid-stream switch keeps
  // appending to one CallRecord and bounds itself on the local `tried` count —
  // never on shared instance state. `finalizeOk`/`finalizeFail` fire exactly
  // once per outer request.
  private async doStreamWithCtx(
    options: LanguageModelV3CallOptions,
    ctx: CallCtx,
    startIdx: number,
    alreadyTried: number,
  ): Promise<LanguageModelV3StreamResult> {
    const self = this;
    const providers = this.opts.providers;
    const n = providers.length;

    // Phase 1: obtain a stream that starts without throwing, switching on a
    // pre-stream error (e.g. a 401/429 before the first chunk). `tried` counts
    // failed providers so far (including any from a prior recursion level).
    let result: LanguageModelV3StreamResult;
    let serving: RoutedProvider;
    let servingStart: number;
    let idx = startIdx;
    let tried = alreadyTried;
    for (;;) {
      serving = providers[idx]!;
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
        this.emitError(error, serving.label);
        this.recordFail(ctx, serving, servingStart, error);
        tried++;
        if (tried >= n) {
          this.finalizeFail(ctx);
          throw error;
        }
        idx = (idx + 1) % n;
      }
    }

    const servingProvider = serving;
    const servingAttemptStart = servingStart;
    const servingIdx = idx;
    const triedBeforeServing = tried;
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
          self.settleSticky(servingIdx);
          self.finalizeOk(ctx, servingProvider, servingAttemptStart, usage);
          controller.close();
        } catch (error) {
          self.emitError(error, servingProvider.label);
          self.recordFail(ctx, servingProvider, servingAttemptStart, error);
          if (!streamedAny) {
            // This serving provider is now also a failure → bump the count and
            // bail if every provider has been tried.
            const nextTried = triedBeforeServing + 1;
            if (nextTried >= n) {
              self.finalizeFail(ctx);
              controller.error(error);
              return;
            }
            // Re-enter on the next provider with the SAME ctx and threaded
            // cursor, so its attempts and final event belong to one CallRecord.
            try {
              const next = await self.doStreamWithCtx(
                options,
                ctx,
                (servingIdx + 1) % n,
                nextTried,
              );
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
