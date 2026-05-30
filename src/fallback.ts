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

export interface FallbackOptions {
  modelName: string;
  providers: RoutedProvider[];
  resetIntervalMs?: number;
  onError?: (error: Error, provider: string) => void;
  onCost?: (event: CostEvent) => void;
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

  private emitCost(
    provider: RoutedProvider,
    usage: LanguageModelV3GenerateResult["usage"] | undefined,
  ): void {
    const onCost = this.opts.onCost;
    if (!onCost) return;
    const inputTokens = usage?.inputTokens?.total ?? 0;
    const outputTokens = usage?.outputTokens?.total ?? 0;
    const costUsd = provider.cost
      ? (inputTokens / 1e6) * provider.cost.input + (outputTokens / 1e6) * provider.cost.output
      : 0;
    onCost({
      model: this.opts.modelName,
      provider: provider.label,
      inputTokens,
      outputTokens,
      costUsd,
    });
  }

  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3GenerateResult> {
    this.checkReset();
    const start = this.index;
    let lastError: unknown;
    for (;;) {
      const provider = this.current;
      try {
        const result = await provider.model.doGenerate(options);
        this.emitCost(provider, result.usage);
        return result;
      } catch (error) {
        lastError = error;
        if (!this.shouldRetry(error)) throw error;
        this.opts.onError?.(error as Error, provider.label);
        this.switchNext();
        if (this.index === start) throw lastError;
      }
    }
  }

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    this.checkReset();
    const self = this;
    const start = this.index;

    // Phase 1: obtain a stream that starts without throwing, switching on a
    // pre-stream error (e.g. a 401/429 before the first chunk).
    let result: LanguageModelV3StreamResult;
    let serving: RoutedProvider;
    for (;;) {
      serving = this.current;
      try {
        result = await serving.model.doStream(options);
        break;
      } catch (error) {
        if (!this.shouldRetry(error)) throw error;
        this.opts.onError?.(error as Error, serving.label);
        this.switchNext();
        if (this.index === start) throw error;
      }
    }

    const servingProvider = serving;
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
          self.emitCost(servingProvider, usage);
          controller.close();
        } catch (error) {
          self.opts.onError?.(error as Error, servingProvider.label);
          if (!streamedAny) {
            self.switchNext();
            if (self.index === start) {
              controller.error(error);
              return;
            }
            // Re-enter doStream on the next provider; it owns its own cost event.
            try {
              const next = await self.doStream(options);
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
          controller.error(error);
        } finally {
          reader?.releaseLock();
        }
      },
    });

    return { ...result, stream };
  }
}
