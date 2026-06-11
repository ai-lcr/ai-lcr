/**
 * Automatic prompt-cache breakpoints (Feature ①).
 *
 * Provider-side prompt caching (Anthropic, MiniMax) caches a *prefix* of the
 * prompt so repeated calls bill the static head — the system prompt — at the
 * cache-read rate (~0.1× input) instead of full price. The model still runs;
 * only the input cost of the cached prefix drops. Anthropic needs an explicit
 * `cache_control` marker; OpenAI / Gemini / DeepSeek cache the prefix
 * automatically with no marker at all.
 *
 * This module adds, when `promptCache` is enabled, a single `cacheControl`
 * breakpoint on the LAST system message — the canonical large, stable head of
 * a prompt. It only writes the `anthropic` provider-options namespace, which
 * every non-Anthropic provider ignores, so it is safe to apply on every leg of
 * a mixed chain: Anthropic reads it, the rest pass it through untouched. No
 * external service and no storage — the cache itself lives at the provider.
 *
 * It steps aside the moment the caller is managing caching themselves: if ANY
 * message already carries an `anthropic.cacheControl`, the prompt is returned
 * unchanged. Same "explicit always wins" discipline as the price table.
 */
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";

/** Tuning for automatic prompt-cache breakpoints. See {@link LCRConfig.promptCache}. */
export interface PromptCacheOptions {
  /**
   * Cache lifetime for the injected breakpoint. `"5m"` (the Anthropic default,
   * a cheaper cache write) or `"1h"` (a pricier write that pays off when the
   * same prefix is reused over a longer span). Default `"5m"`.
   */
  ttl?: "5m" | "1h";
}

export interface ResolvedPromptCache {
  ttl: "5m" | "1h";
}

/** Normalize the public `promptCache` option, or `undefined` when disabled
 *  (the default — the prompt is forwarded exactly as the caller built it). */
export function resolvePromptCache(
  opt: boolean | PromptCacheOptions | undefined,
): ResolvedPromptCache | undefined {
  if (!opt) return undefined;
  if (opt === true) return { ttl: "5m" };
  return { ttl: opt.ttl ?? "5m" };
}

type Message = LanguageModelV3CallOptions["prompt"][number];

/** Does this message already carry an Anthropic cache-control marker? If any
 *  does, the caller is managing caching by hand and we leave the prompt alone. */
function hasAnthropicCacheControl(message: Message): boolean {
  const anthropic = message.providerOptions?.anthropic;
  return !!anthropic && "cacheControl" in anthropic;
}

/**
 * Return a copy of `options` with a single Anthropic `cacheControl` breakpoint
 * on the last system message, or the original `options` unchanged when there is
 * nothing safe to cache (no system message) or the caller is already managing
 * cache control. Never mutates the caller's prompt.
 */
export function withPromptCacheBreakpoint(
  options: LanguageModelV3CallOptions,
  cfg: ResolvedPromptCache,
): LanguageModelV3CallOptions {
  const prompt = options.prompt;
  if (!Array.isArray(prompt) || prompt.length === 0) return options;
  if (prompt.some(hasAnthropicCacheControl)) return options;

  // The last system message is the end of the stable prefix — cache through it.
  // With no system message we do nothing: the only remaining "prefix" is user
  // content, which changes every call, so a breakpoint there would never hit.
  let target = -1;
  for (let i = 0; i < prompt.length; i++) {
    if (prompt[i]!.role === "system") target = i;
  }
  if (target === -1) return options;

  const cacheControl = cfg.ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  const newPrompt = prompt.map((message, i) => {
    if (i !== target) return message;
    return {
      ...message,
      providerOptions: {
        ...message.providerOptions,
        anthropic: { ...message.providerOptions?.anthropic, cacheControl },
      },
    };
  });
  return { ...options, prompt: newPrompt };
}
