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
import {
  cacheKeyOf,
  streamFromParts,
  type ResolvedCache,
  type CachedCall,
  type CachedMeta,
} from "./cache";
import { withPromptCacheBreakpoint, type ResolvedPromptCache } from "./prompt-cache";

/** USD per 1M tokens. */
export interface ProviderCost {
  /** USD per 1M input (prompt) tokens. */
  input: number;
  /** USD per 1M output (completion) tokens. */
  output: number;
  /**
   * USD per 1M *cached* input tokens read (prompt-cache hits). Optional. When a
   * call reports `usage.inputTokens.cacheRead`, those tokens are billed at this
   * rate instead of `input` — so the cost stays honest for cache-heavy traffic
   * (e.g. Anthropic, where a cache read is ~0.1× the input price). Omit it and
   * cached tokens fall back to the full `input` rate (the pre-0.3 behavior).
   */
  cacheRead?: number;
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
 *   - "empty":     provider returned a clean 200 but generated nothing
 *                  (zero output tokens, no content) — a *content*-integrity
 *                  failure, not a transport one. The provider looks healthy to
 *                  every status/network check yet hands the user a blank. We
 *                  fail over on it like a transient error, but tag it separately
 *                  so a run of `"empty"` attempts (a quietly degraded model)
 *                  doesn't hide inside the transient noise.
 */
export type ErrorKind = "transient" | "auth" | "billing" | "client" | "empty";

/**
 * Marker thrown internally when a provider streams (or returns) a clean,
 * error-free response that contains no generated content — zero output tokens
 * and not a single content part. It carries no HTTP status and matches no
 * network pattern, so the only way the failover engine can react to it is this
 * explicit type. Not part of the public surface; callers never see it (the
 * engine either fails over past it or settles the record with `emptyCompletion`).
 */
export class EmptyCompletionError extends Error {
  constructor(provider: string) {
    super(`ai-lcr: provider "${provider}" returned an empty completion (0 output tokens, no content)`);
    this.name = "EmptyCompletionError";
  }
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
  /**
   * Time to first token (TTFT), ms — the industry-standard responsiveness
   * metric. Measured from the *winning* provider's stream attempt start to its
   * first content token (`text-delta` / `reasoning-delta`), so it captures how
   * fast the model that actually served started replying, not failover overhead
   * (that's already in `latencyMs`). Streaming only: **undefined** for
   * `doGenerate` (the whole response lands at once, so there's no "first token")
   * and for calls that failed before producing any content. With `latencyMs` and
   * `outputTokens`, output throughput is derivable: `outputTokens / ((latencyMs −
   * ttftMs) / 1000)` tokens/sec.
   */
  ttftMs?: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * Cached input (prompt-cache) tokens the winner read, when the provider
   * reported them (`usage.inputTokens.cacheRead`). Present only when > 0. Lets
   * the dashboard show cache-hit volume and audit why `costUsd` is lower than
   * sticker × tokens. Undefined when the provider reports no cache info.
   */
  cachedInputTokens?: number;
  /** Computed from the winner's `cost`; 0 if no price was given or the call failed. */
  costUsd: number;
  /**
   * What this same usage would have cost on the savings baseline, so
   * `baselineUsd - costUsd` is what routing actually saved. Text router: the
   * always-on fallback leg — the LAST priced provider in the chain, i.e. the
   * list-price provider you'd fall back to without routing (e.g. OpenRouter).
   * Media router: the model-maker's official direct price. NOT the most
   * expensive leg of the chain: prompt caching can make a sticker-cheaper
   * provider cost more on a cache-heavy call, and a max-of-chain baseline would
   * fabricate a "saving" on calls the fallback itself served. Undefined only
   * when no provider was priced.
   */
  baselineUsd?: number;
  /**
   * How `baselineUsd` was derived, so a dashboard can qualify the savings
   * number instead of treating every baseline as equally authoritative:
   *   - "last-leg":        text router — the always-on fallback leg's list price.
   *   - "official":        media router — the model maker's first-party price.
   *   - "priciest-route":  media router with no official price — the most
   *                        expensive configured route (self-referential; honest
   *                        about cross-provider spread, but not a market price).
   * Undefined when `baselineUsd` is undefined.
   */
  baselineKind?: "last-leg" | "official" | "priciest-route";
  /**
   * Media only: "image" | "video". Lets the dashboard split media traffic from
   * token-billed text (whose records leave this unset) without inferring from
   * zero token counts.
   */
  modality?: "image" | "video";
  /**
   * Media only: the actual billable quantity behind `costUsd` — seconds of
   * video, output count, or megapixels — so per-unit economics ($/second,
   * $/image) are derivable downstream. Absent when nothing was measured.
   */
  usage?: { seconds?: number; outputs?: number; megapixels?: number };
  /**
   * Media only: the model maker's official first-party price for THIS call's
   * usage (USD). Present only when an official price is known; equals
   * `baselineUsd` when `baselineKind` is "official".
   */
  officialUsd?: number;
  /**
   * What the configured price table PREDICTED this call would cost (USD), on
   * the same usage. When the provider reports an actual cost, `costUsd −
   * estCostUsd` is the price-table drift — the signal that a registry price is
   * stale or mis-entered. When no provider cost is reported the two are equal
   * (the estimate IS the cost), so drift is only meaningful on reported rows.
   */
  estCostUsd?: number;
  /**
   * The slice of `costUsd` that prompt-cache reads saved versus paying the full
   * input rate for those same tokens (`cachedTokens × (input − cacheRead)`).
   * Present only when > 0. This is the serving provider's own caching benefit —
   * it happens with or without routing — so it is NOT a routing saving and must
   * be surfaced separately, never folded into `baselineUsd - costUsd`.
   */
  cachedSavingUsd?: number;
  /**
   * True when this request was served from ai-lcr's exact-match RESPONSE cache
   * — no provider was called at all. Distinct from `cachedInputTokens` /
   * `cachedSavingUsd`, which are the *provider's* prompt-cache (the model still
   * ran). On a hit `costUsd` is 0, `winner` is the provider that served the
   * ORIGINAL (now-cached) call, and `attempts` has a single synthetic entry.
   */
  cacheHit?: boolean;
  /**
   * On a `cacheHit`, the money the hit avoided — i.e. what the original call
   * actually cost when it ran. Present only when > 0. Like `cachedSavingUsd`
   * this is a caching saving, NOT a routing saving, so it lives on its own line
   * and is never folded into `baselineUsd - costUsd`.
   */
  cacheHitSavingUsd?: number;
  /**
   * Caller-supplied correlation id, read from `providerOptions.lcr.requestId`
   * on the call. Multi-step tool loops emit one record per `doStream`/
   * `doGenerate` step; stamp the same `requestId` on every step to let the
   * dashboard roll a whole user request up into one cost/`calls` figure.
   */
  requestId?: string;
  /**
   * True when the winner served OK but reported **zero** input *and* output
   * tokens — i.e. the provider didn't emit usage. A silent danger: `costUsd`
   * collapses to 0 and any token-based credit metering under-charges with no
   * other signal. Treat a flagged record as "cost unknown", not "free".
   */
  usageMissing?: boolean;
  /**
   * True when the winner served a clean, error-free response that nonetheless
   * generated **nothing**: zero output tokens with a non-empty prompt (and, for
   * streams, not one content part). The user asked and got a blank. Distinct
   * from {@link usageMissing} (which is input *and* output both zero — usage not
   * reported); here the prompt was billed but the model produced no output.
   *
   * Set only when this empty response is what the caller actually received —
   * i.e. every provider in the chain came back empty, so failover couldn't
   * rescue it. (When an earlier provider returns empty but a later one produces
   * content, that earlier attempt is recorded as a failed `empty_completion` hop
   * and this flag stays unset, because the winner did produce output.) Alert on
   * it: a provider that quietly returns blanks passes every health check.
   */
  emptyCompletion?: boolean;
}

/**
 * Circuit-breaker tuning for {@link FallbackOptions.cooldown}. A provider that
 * fails `maxFailures` times within `windowMs` is *skipped* for `cooldownMs` —
 * not just stepped past per request. Without it, the only recovery lever is the
 * `resetIntervalMs` snap-back, which blindly re-probes the cheapest provider on
 * a timer: a provider that's down keeps eating one failed attempt every window.
 * The breaker remembers the failure and stops sending traffic to it until it's
 * had time to recover. A single success clears its failure count.
 */
export interface CooldownOptions {
  /** Failures within `windowMs` that trip the breaker for a provider. Default 3. */
  maxFailures?: number;
  /** Sliding window over which failures are counted, ms. Default 60_000. */
  windowMs?: number;
  /** How long a tripped provider is skipped before it's re-tried, ms. Default 60_000. */
  cooldownMs?: number;
}

interface ResolvedCooldown {
  maxFailures: number;
  windowMs: number;
  cooldownMs: number;
}

const COOLDOWN_DEFAULTS: ResolvedCooldown = {
  maxFailures: 3,
  windowMs: 60_000,
  cooldownMs: 60_000,
};

/** Normalize the public `cooldown` option to a resolved config, or `undefined`
 *  when disabled (the default) — in which case routing behaves exactly as before
 *  (no provider is ever skipped, only stepped past per request). */
function resolveCooldown(opt: boolean | CooldownOptions | undefined): ResolvedCooldown | undefined {
  if (!opt) return undefined;
  if (opt === true) return { ...COOLDOWN_DEFAULTS };
  return {
    maxFailures: opt.maxFailures ?? COOLDOWN_DEFAULTS.maxFailures,
    windowMs: opt.windowMs ?? COOLDOWN_DEFAULTS.windowMs,
    cooldownMs: opt.cooldownMs ?? COOLDOWN_DEFAULTS.cooldownMs,
  };
}

export interface FallbackOptions {
  modelName: string;
  providers: RoutedProvider[];
  resetIntervalMs?: number;
  /**
   * Circuit breaker: skip a provider that keeps failing instead of re-probing it
   * every request. `true` for sensible defaults, an object to tune, omitted to
   * disable (the default — pre-existing behavior). See {@link CooldownOptions}.
   */
  cooldown?: boolean | CooldownOptions;
  /** Resolved response cache (see ./cache). Undefined = no response caching. */
  cache?: ResolvedCache;
  /** Resolved prompt-cache breakpoints (see ./prompt-cache). Undefined = off. */
  promptCache?: ResolvedPromptCache;
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
 * A deliberate caller cancellation (an `AbortSignal` fired by the app). This is
 * the one failure we must NEVER fail over: re-issuing an aborted request to the
 * next provider is the opposite of what the caller asked for. Detected by name
 * (`fetch`/AI SDK emit an `AbortError`) and by the canonical abort message.
 */
export function isAbortError(error: unknown): boolean {
  const e = error as { name?: unknown } | undefined;
  if (typeof e?.name === "string" && e.name === "AbortError") return true;
  const { text } = errorSignals(error);
  return text.includes("operation was aborted") || text.includes("operation was canceled");
}

/**
 * Default failover criterion — broader than {@link isRetryableError} on purpose.
 * It fails over on *anything* except a deliberate caller cancellation, including
 * a client error such as a 400. In the OpenAI-compatible aggregator world a 400
 * is most often "THIS provider won't take this request" (an unsupported param, a
 * model it hasn't listed, a stricter schema) rather than a universally-broken
 * request — and the next provider may well serve it, which is the whole point of
 * the router. When every provider rejects the request, the engine still throws
 * (surfacing the original error), so a genuinely-bad request stays debuggable.
 * The failed attempts keep their precise {@link ErrorKind} (`"client"` for a
 * 400) so a real caller bug is still visible in the {@link CallRecord}.
 *
 * Pass a custom `shouldRetry` to opt out (e.g. `isRetryableError` to restore the
 * stricter "client errors fail fast" behavior).
 */
export function shouldFailover(error: unknown): boolean {
  return !isAbortError(error);
}

/**
 * Normalize an error into a short, log-friendly class for {@link CallRecord}.
 * An HTTP status wins (e.g. "502", "429"); otherwise the first matching
 * retryable pattern (e.g. "rate_limit", "timeout"); otherwise "error".
 * Reuses the same signals as {@link isRetryableError} — no new vocabulary.
 */
export function classifyError(error: unknown): string {
  if (error instanceof EmptyCompletionError) return "empty_completion";
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
  if (error instanceof EmptyCompletionError) return "empty";
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
  /** Caller-supplied correlation id from `providerOptions.lcr.requestId`, if any. */
  requestId?: string;
  /**
   * The first error in the failover chain. When every provider fails we throw
   * THIS rather than the last provider's error — so a genuinely-bad request
   * surfaces the original (representative) reason instead of whatever the final
   * fallback happened to say. Set once, on the first recorded failure.
   */
  firstError?: unknown;
  /**
   * Settle-time summary stamped by `finalizeOk`, so the response-cache wrapper
   * (which lives outside the stream's failover recursion) can read the winner,
   * cost, and tokens after the call completes — and know whether the result is
   * safe to cache (`cacheable` is false for an empty completion / missing
   * usage, which must never be stored as a good answer).
   */
  settled?: { meta: CachedMeta; cacheable: boolean };
}

/**
 * Cost of one settled call on a given price, honoring prompt-cache reads:
 * cached input tokens bill at `cost.cacheRead` when set (else the full `input`
 * rate — pre-0.3 behavior). Pure; reused for the winner's cost AND the
 * baseline (most-expensive-provider) figure so both stay consistent.
 */
function costForUsage(
  cost: ProviderCost,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
): number {
  const cached = Math.min(Math.max(cacheReadTokens, 0), inputTokens);
  const fullInput = inputTokens - cached;
  const cachedRate = cost.cacheRead ?? cost.input;
  return (
    (fullInput / 1e6) * cost.input +
    (cached / 1e6) * cachedRate +
    (outputTokens / 1e6) * cost.output
  );
}

/**
 * The slice of a settled call's bill that prompt-cache reads saved, vs paying
 * the full `input` rate for those same tokens: `cachedTokens × (input − cacheRead)`.
 * Zero when the provider has no `cacheRead` (caching gives no discount there).
 * This is the provider's own caching benefit — independent of routing — so the
 * dashboard reports it on its own line, never inside the routing-savings figure.
 */
function cacheSavingForUsage(cost: ProviderCost, inputTokens: number, cacheReadTokens: number): number {
  if (cost.cacheRead === undefined) return 0;
  const cached = Math.min(Math.max(cacheReadTokens, 0), inputTokens);
  return (cached / 1e6) * (cost.input - cost.cacheRead);
}

/**
 * Provider-reported ACTUAL cost (USD) for a settled text call, when the provider
 * hands one back — so we record the bill instead of estimating it. Preferred over
 * the price table whenever present; the table stays the fallback and the drift
 * baseline (`estCostUsd`).
 *
 * Why it matters: on a multi-provider aggregator a single model is served across
 * many sub-providers at prices that differ several-fold, so a static price table
 * can only encode ONE price while the real bill is whichever sub-provider served
 * THIS call — knowable only after the fact. The reported number already folds in
 * sub-provider selection, every token kind (cache read/write, reasoning), and any
 * fees; the table cannot.
 *
 * Sources:
 *  - OpenRouter (`@openrouter/ai-sdk-provider`): `providerMetadata.openrouter.usage`.
 *    Prefer `costDetails.upstreamInferenceCost` (the real upstream model spend on a
 *    BYOK / pass-through route) over `cost` (the OpenRouter credit charge) — on a
 *    BYOK route `cost` is only the platform fee or 0 while upstream is the real
 *    model cost; on a normal route the two coincide. Requires the caller to enable
 *    usage accounting (`usage: { include: true }`); without it neither field is
 *    present and we fall back to the table.
 *  - OpenAI-compatible providers (e.g. DeepInfra): `estimated_cost` on the raw
 *    usage body, when the SDK surfaces it.
 * Returns undefined when nothing is reported → the caller uses the table estimate.
 */
function reportedCost(
  providerMetadata: LanguageModelV3GenerateResult["providerMetadata"] | undefined,
  usage: LanguageModelV3GenerateResult["usage"] | undefined,
): number | undefined {
  const orUsage = (
    providerMetadata?.openrouter as unknown as
      | { usage?: { cost?: unknown; costDetails?: { upstreamInferenceCost?: unknown } } }
      | undefined
  )?.usage;
  if (orUsage) {
    const upstream = orUsage.costDetails?.upstreamInferenceCost;
    if (typeof upstream === "number" && upstream > 0) return upstream;
    if (typeof orUsage.cost === "number") return orUsage.cost;
  }
  const raw = (usage as unknown as { raw?: Record<string, unknown> } | undefined)?.raw;
  if (raw) {
    const est = raw["estimated_cost"] ?? raw["cost"];
    if (typeof est === "number") return est;
  }
  return undefined;
}

/** Read a caller-supplied correlation id from `providerOptions.lcr.requestId`. */
function requestIdFrom(options: LanguageModelV3CallOptions): string | undefined {
  const raw = options.providerOptions?.lcr?.requestId;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

// Stream parts that carry actual model output the consumer would see. Used to
// decide two things: (1) whether a stream that ended with zero output tokens is
// truly *empty* (none of these arrived) vs a legitimate no-text step like a
// tool call (which emits tool-call / tool-input parts and bills output tokens),
// and (2) whether it is still safe to fail over — once real content has reached
// the consumer we can't rewind, but stream-start / response-metadata / finish
// have not shown them anything, so a switch after only those is fine.
const CONTENT_PART_TYPES = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-call",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-end",
  "file",
  "source",
  "tool-result",
  "raw",
]);

export class LcrFallbackModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;

  // Cross-request *hint* for where the next request starts: after a failover we
  // remember the provider that worked so we don't re-probe a dead cheap one on
  // every call. Shared mutable state, but read once per request (snapshotted into
  // a local cursor) and written once on settle, never used as a per-request loop
  // bound. The within-request iteration is fully local, so concurrent requests
  // can't corrupt each other's routing. The cooldown state below shares the same
  // discipline: it's a cross-request hint that only ever *reorders* the local
  // attempt list, never bounds it.
  private sticky = 0;
  // When `sticky` was last advanced (a failover). The re-probe timer measures
  // from THIS, not from the last call — so it fires under sustained traffic too,
  // instead of being pushed forward forever by a busy stream of requests.
  private lastFailoverAt = Date.now();
  private readonly resetIntervalMs: number;

  // Circuit breaker (undefined = disabled). Per-provider, parallel to `providers`:
  // `failures[i]` is the timestamps of recent failures within the window, and
  // `cooldownUntil[i]` is the time before which provider i is skipped. Both are
  // cross-request hints — like `sticky`, eventually consistent under concurrency
  // and never used to bound a request's local iteration.
  private readonly cooldown: ResolvedCooldown | undefined;
  private readonly failures: number[][];
  private readonly cooldownUntil: number[];

  constructor(private readonly opts: FallbackOptions) {
    if (opts.providers.length === 0) {
      throw new Error(`ai-lcr: model "${opts.modelName}" has no providers`);
    }
    this.resetIntervalMs = opts.resetIntervalMs ?? 60_000;
    this.cooldown = resolveCooldown(opts.cooldown);
    this.failures = opts.providers.map(() => []);
    this.cooldownUntil = opts.providers.map(() => 0);
  }

  /** Is provider `idx` currently cooling down (skipped)? Always false when the
   *  breaker is disabled, so callers need no extra guard. */
  private isCooling(idx: number, now: number): boolean {
    return this.cooldown !== undefined && this.cooldownUntil[idx]! > now;
  }

  /** Record a failed attempt on provider `idx`; trip its breaker once failures
   *  within the window reach `maxFailures`. No-op when the breaker is disabled. */
  private recordProviderFailure(idx: number): void {
    const cd = this.cooldown;
    if (cd === undefined) return;
    const now = Date.now();
    const recent = this.failures[idx]!.filter((t) => now - t < cd.windowMs);
    recent.push(now);
    if (recent.length >= cd.maxFailures) {
      this.cooldownUntil[idx] = now + cd.cooldownMs;
      this.failures[idx] = []; // reset the counter once tripped
    } else {
      this.failures[idx] = recent;
    }
  }

  /** A success on provider `idx` clears its failure history and any cooldown —
   *  the breaker is about *sustained* failure, so one good call resets it. */
  private recordProviderSuccess(idx: number): void {
    if (this.cooldown === undefined) return;
    if (this.failures[idx]!.length > 0) this.failures[idx] = [];
    if (this.cooldownUntil[idx]! !== 0) this.cooldownUntil[idx] = 0;
  }

  /**
   * The order of provider indices to try this request: the cheapest-first ring
   * starting at `start`, but with currently-cooling providers moved to the BACK
   * (last-resort, soonest-to-expire first) so the breaker skips them without ever
   * dropping a provider — if every provider is cooling we still try them all
   * rather than fail the request outright. With the breaker disabled this is just
   * the plain ring, identical to the previous modular iteration. Computed once
   * per request and threaded through any stream failover, so it's a stable local
   * snapshot (concurrent requests can't reshuffle a request mid-flight).
   */
  private routeOrder(start: number): number[] {
    const n = this.opts.providers.length;
    const ring: number[] = [];
    for (let k = 0; k < n; k++) ring.push((start + k) % n);
    if (this.cooldown === undefined) return ring;
    const now = Date.now();
    const live = ring.filter((i) => !this.isCooling(i, now));
    if (live.length === 0 || live.length === n) return ring;
    const cooling = ring
      .filter((i) => this.isCooling(i, now))
      .sort((a, b) => this.cooldownUntil[a]! - this.cooldownUntil[b]!);
    return [...live, ...cooling];
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
    return (this.opts.shouldRetry ?? shouldFailover)(error);
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

  private startCall(options: LanguageModelV3CallOptions): CallCtx {
    return {
      id: newCallId(),
      attempts: [],
      startedAt: Date.now(),
      requestId: requestIdFrom(options),
    };
  }

  /** Record a failed attempt onto the call's chain (no event yet) and count it
   *  toward provider `idx`'s circuit breaker. */
  private recordFail(
    ctx: CallCtx,
    idx: number,
    provider: RoutedProvider,
    attemptStart: number,
    error: unknown,
  ): void {
    if (ctx.firstError === undefined) ctx.firstError = error;
    ctx.attempts.push({
      provider: provider.label,
      ok: false,
      latencyMs: Date.now() - attemptStart,
      errorClass: classifyError(error),
      kind: classifyErrorKind(error),
    });
    this.recordProviderFailure(idx);
  }

  /**
   * Baseline = what this same usage would have cost on the always-on fallback:
   * the LAST priced leg of the chain (by convention the list-price provider you'd
   * use without routing — e.g. OpenRouter, always last). The winner's saving is
   * `baselineUsd - costUsd`. We take the last priced leg, NOT the most expensive
   * one: prompt caching can make a sticker-cheaper provider (no `cacheRead`) cost
   * MORE on a cache-heavy call, and a max-of-chain baseline would then fabricate a
   * "saving" even on calls the fallback itself served. Undefined when no provider
   * in the chain carries a price (nothing to compare against).
   */
  private baselineUsd(inputTokens: number, outputTokens: number, cacheReadTokens: number): number | undefined {
    let baseline: number | undefined;
    for (const p of this.opts.providers) {
      if (!p.cost) continue;
      baseline = costForUsage(p.cost, inputTokens, outputTokens, cacheReadTokens);
    }
    return baseline;
  }

  /** Winner settled: record the attempt, fire `onCost` (compat) + `onCall`. */
  private finalizeOk(
    ctx: CallCtx,
    provider: RoutedProvider,
    attemptStart: number,
    usage: LanguageModelV3GenerateResult["usage"] | undefined,
    ttftMs?: number,
    providerMetadata?: LanguageModelV3GenerateResult["providerMetadata"],
  ): void {
    ctx.attempts.push({ provider: provider.label, ok: true, latencyMs: Date.now() - attemptStart });
    const inputTokens = usage?.inputTokens?.total ?? 0;
    const outputTokens = usage?.outputTokens?.total ?? 0;
    const cacheReadTokens = usage?.inputTokens?.cacheRead ?? 0;
    // What our price table PREDICTS this call cost — the routing/estimate number.
    const estCostUsd = provider.cost
      ? costForUsage(provider.cost, inputTokens, outputTokens, cacheReadTokens)
      : undefined;
    // What the provider actually BILLED, when it tells us. Prefer it over the
    // estimate (a static table can't track which sub-provider served, all token
    // kinds, or fees on a multi-provider aggregator); fall back to the estimate
    // when the provider reports nothing. `costUsd − estCostUsd` is the drift signal.
    const costUsd = reportedCost(providerMetadata, usage) ?? estCostUsd ?? 0;
    const cachedSavingUsd = provider.cost
      ? cacheSavingForUsage(provider.cost, inputTokens, cacheReadTokens)
      : 0;
    // Winner served but reported no usage at all → cost/credit metering would
    // silently read 0. Surface it as a flag rather than a believable "free" row.
    const usageMissing = inputTokens === 0 && outputTokens === 0;
    // Winner served a clean response that generated nothing (prompt billed, zero
    // output). The user got a blank. Failover already tried to dodge this; if it
    // reaches here it's because every provider came back empty, so flag the
    // settled record. (input === 0 is the usageMissing case above, not this one.)
    const emptyCompletion = inputTokens > 0 && outputTokens === 0;
    const baselineUsd = this.baselineUsd(inputTokens, outputTokens, cacheReadTokens);
    // Hand the response-cache wrapper everything it needs to store (and replay)
    // this answer. A blank or usage-less result is recorded but NOT cacheable —
    // we must never serve a stored empty completion on future hits.
    ctx.settled = {
      meta: {
        winner: provider.label,
        costUsd,
        inputTokens,
        outputTokens,
        ...(cacheReadTokens > 0 ? { cachedInputTokens: cacheReadTokens } : {}),
      },
      cacheable: !emptyCompletion && !usageMissing,
    };
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
      ...(ttftMs !== undefined ? { ttftMs } : {}),
      inputTokens,
      outputTokens,
      ...(cacheReadTokens > 0 ? { cachedInputTokens: cacheReadTokens } : {}),
      costUsd,
      ...(estCostUsd !== undefined ? { estCostUsd } : {}),
      ...(baselineUsd !== undefined ? { baselineUsd, baselineKind: "last-leg" as const } : {}),
      ...(cachedSavingUsd > 0 ? { cachedSavingUsd } : {}),
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
      ...(usageMissing ? { usageMissing: true } : {}),
      ...(emptyCompletion ? { emptyCompletion: true } : {}),
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
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
    });
  }

  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3GenerateResult> {
    // Response cache: an exact-match hit replays the stored answer and never
    // touches a provider. Key off the ORIGINAL options (before any prompt-cache
    // breakpoint), so the key is stable regardless of `promptCache`.
    const cache = this.opts.cache;
    const cacheKey = cache ? cacheKeyOf(this.opts.modelName, options) : undefined;
    if (cache && cacheKey !== undefined) {
      const hit = await cache.store.get(cacheKey);
      if (hit && hit.kind === "generate") {
        this.finalizeCacheHit(this.startCall(options), hit.meta);
        return hit.result;
      }
    }
    // Forward an optionally cache-marked prompt to providers; the cache key and
    // requestId above were already read from the untouched `options`.
    const callOptions = this.opts.promptCache
      ? withPromptCacheBreakpoint(options, this.opts.promptCache)
      : options;
    const ctx = this.startCall(options);
    const providers = this.opts.providers;
    // Snapshot the attempt order once (cheapest-first ring, cooling providers to
    // the back). Termination is the local position in `order`, never shared state.
    const order = this.routeOrder(this.startIndex());
    let lastError: unknown;
    for (let pos = 0; pos < order.length; pos++) {
      const idx = order[pos]!;
      const provider = providers[idx]!;
      const isLast = pos === order.length - 1;
      const attemptStart = Date.now();
      try {
        const result = await provider.model.doGenerate(callOptions);
        // Empty completion: a clean 200 that generated nothing (prompt billed,
        // zero output tokens). Treat it like a retryable failure and move to the
        // next provider — but only while one remains. On the last provider we
        // settle the empty result and let `finalizeOk` flag it, rather than
        // escalating a blank into a hard request failure with nowhere to turn.
        const out = result.usage?.outputTokens?.total ?? 0;
        const inp = result.usage?.inputTokens?.total ?? 0;
        if (inp > 0 && out === 0 && !isLast) {
          const emptyErr = new EmptyCompletionError(provider.label);
          lastError = emptyErr;
          this.emitError(emptyErr, provider.label);
          this.recordFail(ctx, idx, provider, attemptStart, emptyErr);
          continue;
        }
        this.recordProviderSuccess(idx);
        this.settleSticky(idx);
        this.finalizeOk(ctx, provider, attemptStart, result.usage, undefined, result.providerMetadata);
        if (cache && cacheKey !== undefined && ctx.settled?.cacheable) {
          this.storeCache(cacheKey, { kind: "generate", result, meta: ctx.settled.meta });
        }
        return result;
      } catch (error) {
        lastError = error;
        if (!this.shouldRetry(error)) {
          this.recordFail(ctx, idx, provider, attemptStart, error);
          this.finalizeFail(ctx);
          throw error;
        }
        this.emitError(error, provider.label);
        this.recordFail(ctx, idx, provider, attemptStart, error);
      }
    }
    this.finalizeFail(ctx);
    throw ctx.firstError ?? lastError;
  }

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    const cache = this.opts.cache;
    const cacheKey = cache ? cacheKeyOf(this.opts.modelName, options) : undefined;
    if (cache && cacheKey !== undefined) {
      const hit = await cache.store.get(cacheKey);
      if (hit && hit.kind === "stream") {
        this.finalizeCacheHit(this.startCall(options), hit.meta);
        return { stream: streamFromParts(hit.parts) };
      }
    }
    const ctx = this.startCall(options);
    const callOptions = this.opts.promptCache
      ? withPromptCacheBreakpoint(options, this.opts.promptCache)
      : options;
    const inner = await this.doStreamWithCtx(
      callOptions,
      ctx,
      this.routeOrder(this.startIndex()),
      0,
    );
    if (!cache || cacheKey === undefined) return inner;

    // Collect every part as it streams to the consumer; on a clean finish store
    // the full sequence for replay. `ctx.settled` is stamped by `finalizeOk`
    // (which runs before the inner stream closes), so by the time `flush` fires
    // we know the winner, cost, and whether the result is safe to cache. An
    // errored stream never reaches `flush`, so failures are never cached.
    const collected: LanguageModelV3StreamPart[] = [];
    const self = this;
    const wrapped = inner.stream.pipeThrough(
      new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
        transform(part, controller) {
          collected.push(part);
          controller.enqueue(part);
        },
        flush() {
          if (ctx.settled?.cacheable) {
            self.storeCache(cacheKey, { kind: "stream", parts: collected, meta: ctx.settled.meta });
          }
        },
      }),
    );
    return { ...inner, stream: wrapped };
  }

  /** A response-cache hit: replay a stored answer with no provider call. Settles
   *  one {@link CallRecord} with `cacheHit`, `costUsd: 0`, and the avoided cost
   *  on its own `cacheHitSavingUsd` line. */
  private finalizeCacheHit(ctx: CallCtx, meta: CachedMeta): void {
    this.emitCall({
      id: ctx.id,
      model: this.opts.modelName,
      attempts: [{ provider: meta.winner, ok: true, latencyMs: Date.now() - ctx.startedAt }],
      winner: meta.winner,
      ok: true,
      failedOver: false,
      latencyMs: Date.now() - ctx.startedAt,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      ...(meta.cachedInputTokens ? { cachedInputTokens: meta.cachedInputTokens } : {}),
      costUsd: 0,
      cacheHit: true,
      ...(meta.costUsd > 0 ? { cacheHitSavingUsd: meta.costUsd } : {}),
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
    });
  }

  /** Best-effort write to the response cache: a sync throw or a rejected async
   *  `set` must never break the request. Caching is an optimization, not a
   *  guarantee. */
  private storeCache(key: string, value: CachedCall): void {
    const cache = this.opts.cache;
    if (!cache) return;
    try {
      const r = cache.store.set(key, value, cache.ttlMs);
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch(() => {
          /* cache write is best-effort */
        });
      }
    } catch {
      /* cache write is best-effort */
    }
  }

  // The stream's failover recursion re-enters here with the SAME `ctx` and the
  // SAME `order` snapshot, advancing only the local position `pos`, so a
  // mid-stream switch keeps appending to one CallRecord and bounds itself on the
  // local position — never on shared instance state. `finalizeOk`/`finalizeFail`
  // fire exactly once per outer request.
  private async doStreamWithCtx(
    options: LanguageModelV3CallOptions,
    ctx: CallCtx,
    order: number[],
    pos: number,
  ): Promise<LanguageModelV3StreamResult> {
    const self = this;
    const providers = this.opts.providers;
    const n = order.length;

    // Phase 1: obtain a stream that starts without throwing, switching on a
    // pre-stream error (e.g. a 401/429 before the first chunk). `p` walks the
    // pre-snapshotted attempt order from `pos` onward.
    let result: LanguageModelV3StreamResult;
    let serving: RoutedProvider;
    let servingStart: number;
    let p = pos;
    let idx = order[p]!;
    for (;;) {
      idx = order[p]!;
      serving = providers[idx]!;
      servingStart = Date.now();
      try {
        result = await serving.model.doStream(options);
        break;
      } catch (error) {
        if (!this.shouldRetry(error)) {
          this.recordFail(ctx, idx, serving, servingStart, error);
          this.finalizeFail(ctx);
          throw error;
        }
        this.emitError(error, serving.label);
        this.recordFail(ctx, idx, serving, servingStart, error);
        p++;
        if (p >= n) {
          this.finalizeFail(ctx);
          throw ctx.firstError ?? error;
        }
      }
    }

    const servingProvider = serving;
    const servingAttemptStart = servingStart;
    const servingIdx = idx;
    const servingPos = p;
    let usage: LanguageModelV3GenerateResult["usage"] | undefined;
    // Captured from the `finish` chunk alongside `usage`; carries the provider's
    // reported actual cost (e.g. OpenRouter's `openrouter.usage.cost`) for settle.
    let finishProviderMetadata: LanguageModelV3GenerateResult["providerMetadata"];
    // "Has the consumer seen real content yet?" — gates failover. Deliberately
    // tracks *content* (see CONTENT_PART_TYPES), not "any chunk": stream-start,
    // response-metadata and finish reveal nothing, so a switch after only those
    // is safe, and an empty stream that emitted a stray metadata chunk can still
    // fail over.
    let contentStreamed = false;
    // TTFT: stamped on the first content token (text/reasoning delta), measured
    // from this serving provider's attempt start. Deliberately the first *delta*,
    // not the first chunk — `stream-start` / `text-start` / `response-metadata`
    // arrive before the model has generated anything, so timing to them would
    // understate TTFT.
    let ttftMs: number | undefined;

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        let reader: ReadableStreamDefaultReader<LanguageModelV3StreamPart> | null = null;
        try {
          reader = result.stream.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            // An error surfaced as a chunk → fail over (only while nothing
            // user-visible has streamed yet).
            if (!contentStreamed && value && typeof value === "object" && "error" in value) {
              const err = (value as { error: unknown }).error;
              if (self.shouldRetry(err)) throw err;
            }
            if (done) break;
            if (value.type === "finish") {
              usage = value.usage;
              finishProviderMetadata = value.providerMetadata;
              // Empty completion mid-stream: a clean finish that generated
              // nothing (prompt billed, zero output) with no content emitted.
              // Throw to route into the same failover machinery as a pre-stream
              // error — but only while a provider remains. On the last provider
              // we fall through, enqueue finish, and let finalizeOk flag it
              // rather than turn a blank into a hard stream error.
              const out = value.usage?.outputTokens?.total ?? 0;
              const inp = value.usage?.inputTokens?.total ?? 0;
              if (inp > 0 && out === 0 && !contentStreamed && servingPos + 1 < n) {
                throw new EmptyCompletionError(servingProvider.label);
              }
            }
            if (ttftMs === undefined && (value.type === "text-delta" || value.type === "reasoning-delta")) {
              ttftMs = Date.now() - servingAttemptStart;
            }
            controller.enqueue(value);
            if (CONTENT_PART_TYPES.has(value.type)) contentStreamed = true;
          }
          self.recordProviderSuccess(servingIdx);
          self.settleSticky(servingIdx);
          self.finalizeOk(ctx, servingProvider, servingAttemptStart, usage, ttftMs, finishProviderMetadata);
          controller.close();
        } catch (error) {
          self.emitError(error, servingProvider.label);
          self.recordFail(ctx, servingIdx, servingProvider, servingAttemptStart, error);
          if (!contentStreamed) {
            // This serving provider is now also a failure → advance the position
            // and bail if every provider in the order has been tried.
            const nextPos = servingPos + 1;
            if (nextPos >= n) {
              self.finalizeFail(ctx);
              controller.error(ctx.firstError ?? error);
              return;
            }
            // Re-enter on the next provider with the SAME ctx and order snapshot,
            // so its attempts and final event belong to one CallRecord.
            try {
              const next = await self.doStreamWithCtx(options, ctx, order, nextPos);
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
