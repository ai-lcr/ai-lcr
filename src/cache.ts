/**
 * Exact-match response cache (Feature ②).
 *
 * Unlike provider-side prompt caching (see ./prompt-cache), this skips the
 * model call *entirely*: when a request is byte-for-byte identical to one
 * already answered, the stored response is replayed and no provider is touched
 * — zero latency, zero cost. This is the layer Vercel AI Gateway notably does
 * NOT offer, and it composes naturally with ai-lcr's cost truth: a hit settles
 * a {@link CallRecord} with `costUsd: 0` and `cacheHit: true`, and reports the
 * money it avoided as `cacheHitSavingUsd` — a saving kept on its own line, the
 * same discipline as prompt-cache savings, never folded into routing savings.
 *
 * Storage is pluggable and the package ships ZERO dependencies for it. The
 * default `createMemoryCacheStore()` is a process-local Map: real on a
 * long-running server, and useful within a single serverless invocation (an
 * agent loop that repeats a sub-call), but it does NOT survive across
 * serverless requests — different function instances don't share memory. For
 * cross-request hits on serverless, inject your own store backed by a shared
 * layer (Upstash Redis, Vercel KV). ai-lcr never runs that service; you bring
 * it. A custom store is responsible for serializing the stored value.
 *
 * Determinism caveat: caching makes identical requests return identical
 * responses. That is exactly right for idempotent / `temperature: 0` calls and
 * changes behavior for sampled ones (the variety is gone). Enable it where a
 * repeated answer is acceptable.
 */
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";

/** A stored, replayable LLM response plus the cost it originally incurred. */
export type CachedCall =
  | {
      kind: "generate";
      result: LanguageModelV3GenerateResult;
      meta: CachedMeta;
    }
  | {
      kind: "stream";
      parts: LanguageModelV3StreamPart[];
      meta: CachedMeta;
    };

/** Settle-time facts carried in the cache entry so a hit can report honest
 *  tokens, the originally-serving provider, and the money the hit avoided. */
export interface CachedMeta {
  /** The provider that served the original (cached) call. */
  winner: string;
  /** What the original call actually cost — i.e. the money a hit avoids. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache reads on the original call, when reported (> 0 only). */
  cachedInputTokens?: number;
}

/**
 * Pluggable response-cache backend. Implement it over Redis / Vercel KV / any
 * shared store to get cross-request hits on serverless; the bundled
 * {@link createMemoryCacheStore} is the dependency-free default. `get`/`set`
 * may be sync or async. A `set` that throws must never break the request — the
 * engine treats the cache as best-effort.
 */
export interface CacheStore {
  get(key: string): CachedCall | undefined | Promise<CachedCall | undefined>;
  set(key: string, value: CachedCall, ttlMs?: number): void | Promise<void>;
}

/** Public response-cache config. See {@link LCRConfig.cache}. */
export interface CacheOptions {
  /** Where to store responses. Defaults to a process-local in-memory store. */
  store?: CacheStore;
  /** Entry lifetime in ms. Omit for no expiry (entries live until evicted). */
  ttlMs?: number;
}

export interface ResolvedCache {
  store: CacheStore;
  ttlMs?: number;
}

function isCacheStore(x: unknown): x is CacheStore {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as CacheStore).get === "function" &&
    typeof (x as CacheStore).set === "function"
  );
}

/**
 * Normalize the public `cache` option to a resolved store, or `undefined` when
 * disabled (the default — no response is ever cached). `true` uses the bundled
 * in-memory store; a bare {@link CacheStore} is used directly; an object lets
 * you set `ttlMs` and/or bring your own store.
 */
export function resolveCache(
  opt: boolean | CacheStore | CacheOptions | undefined,
): ResolvedCache | undefined {
  if (!opt) return undefined;
  if (opt === true) return { store: createMemoryCacheStore() };
  if (isCacheStore(opt)) return { store: opt };
  return {
    store: opt.store ?? createMemoryCacheStore(),
    ...(opt.ttlMs !== undefined ? { ttlMs: opt.ttlMs } : {}),
  };
}

/**
 * Build the cache key for a call: the logical model name plus every input that
 * changes the output — the prompt and all generation settings. Deliberately
 * EXCLUDES the `lcr` provider-options namespace (it carries a per-request
 * `requestId` correlation id that would make every call unique and never hit)
 * and transport-only fields (`abortSignal`, `headers`). Two requests with the
 * same key are guaranteed to be answerable by the same response.
 */
export function cacheKeyOf(modelName: string, options: LanguageModelV3CallOptions): string {
  const rest = options.providerOptions
    ? Object.entries(options.providerOptions).filter(([ns]) => ns !== "lcr")
    : [];
  // Collapse an options bag that held ONLY `lcr` to undefined, so a request
  // carrying just a correlation id keys identically to one with no options.
  const po = rest.length > 0 ? Object.fromEntries(rest) : undefined;
  return JSON.stringify({
    m: modelName,
    prompt: options.prompt,
    maxOutputTokens: options.maxOutputTokens,
    temperature: options.temperature,
    topP: options.topP,
    topK: options.topK,
    frequencyPenalty: options.frequencyPenalty,
    presencePenalty: options.presencePenalty,
    stopSequences: options.stopSequences,
    seed: options.seed,
    responseFormat: options.responseFormat,
    tools: options.tools,
    toolChoice: options.toolChoice,
    po,
  });
}

/** Replay cached stream parts as a fresh, fully-buffered stream. No delays:
 *  a cache hit should return immediately. Dependency-free (no `ai` import). */
export function streamFromParts(
  parts: LanguageModelV3StreamPart[],
): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

interface MemoryEntry {
  value: CachedCall;
  /** Absolute expiry (ms epoch), or undefined for no expiry. */
  expiresAt?: number;
}

/** Tuning for {@link createMemoryCacheStore}. */
export interface MemoryCacheOptions {
  /**
   * Cap on stored entries. When exceeded, the oldest-inserted entry is dropped
   * (insertion-order FIFO — Map preserves it). Keeps an unbounded key space
   * (every distinct prompt) from leaking memory in a long-running process.
   * Default 1000.
   */
  maxEntries?: number;
}

/**
 * A process-local in-memory {@link CacheStore} with optional TTL and a
 * bounded entry count. Zero dependencies. See the module header for where this
 * is (and isn't) useful — notably it does NOT share across serverless requests.
 */
export function createMemoryCacheStore(opts: MemoryCacheOptions = {}): CacheStore {
  const maxEntries = opts.maxEntries ?? 1000;
  const map = new Map<string, MemoryEntry>();
  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
        map.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      const entry: MemoryEntry =
        ttlMs !== undefined ? { value, expiresAt: Date.now() + ttlMs } : { value };
      // Refresh insertion order so a re-set entry counts as newest.
      map.delete(key);
      map.set(key, entry);
      if (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    },
  };
}
