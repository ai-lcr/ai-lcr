/**
 * Two independent monitors run against each provider:
 *
 * 1. Liveness (every 15 min, cheap) — see CheckMode:
 *    - "inference": a real `max_tokens: 1` completion against each model in
 *      `models`. Proves the inference path works, per model. A few tokens each.
 *    - "reachable": a free `GET /v1/models` reachability + auth check (0 tokens).
 *      Enough for trusted aggregators where "is the endpoint up" is all we need.
 *
 * 2. Integrity (daily, richer) — the `integrity` block. Ports
 *    scripts/check-provider.sh: tool calls, multi-step tool loops, max_tokens,
 *    hidden-prompt injection, token over-counting vs a trusted baseline, and
 *    Anthropic-native prompt caching. Only configured for providers we don't
 *    fully trust (discount gateways); the baseline provider does the comparing.
 */
export type CheckMode = "inference" | "reachable";

/** A model to liveness-ping. */
export type LiveModel = { id: string; label?: string };

/** A model to run the daily integrity suite against. */
export type IntegrityModel = {
  /** Model id on THIS provider. */
  id: string;
  /** Matching model id on the baseline provider — enables token-inflation check. */
  ref?: string;
  /** Run the native /v1/messages prompt-caching test (Anthropic-style models). */
  anthropicNative?: boolean;
};

export type Provider = {
  /** Stable key used as the DB `provider` column + React key. */
  id: string;
  /** Display name on the status page. */
  label: string;
  /** Base URL WITHOUT /v1 — pings append /v1/chat/completions, /v1/models, /v1/messages. */
  base: string;
  /** Name of the env var holding this provider's API key. */
  apiKeyEnv: string;
  /** Liveness strategy — see CheckMode. */
  check: CheckMode;
  /** Models to liveness-ping ("inference" mode). Empty for pure "reachable". */
  models: LiveModel[];
  /** Optional homepage link. */
  link?: string;
  /** Daily integrity suite config. Omit for providers we only liveness-check. */
  integrity?: {
    /** Trusted baseline provider base (no /v1) for the token-inflation comparison. */
    refBase: string;
    /** Env var holding the baseline provider's API key. */
    refApiKeyEnv: string;
    /** Models to run the suite against. */
    models: IntegrityModel[];
  };
};

/** Sentinel model value stored for "reachable" liveness rows (no specific model). */
export const REACHABILITY_MODEL = "(reachability)";

export const PROVIDERS: Provider[] = [
  {
    id: "kunavo",
    label: "Kunavo",
    base: "https://api.kunavo.com",
    apiKeyEnv: "KUNAVO_API_KEY",
    check: "inference",
    // Kunavo carries Anthropic + Google only.
    models: [
      { id: "gemini-2-5-flash" },
      { id: "gemini-2-5-pro" },
      { id: "claude-haiku-4-5" },
      { id: "claude-sonnet-4-6" },
      { id: "claude-opus-4-7" },
    ],
    link: "https://kunavo.com/?ref=victorimf",
    integrity: {
      refBase: "https://openrouter.ai/api",
      refApiKeyEnv: "OPENROUTER_API_KEY",
      // One Gemini + one Claude representative; caching tested once (the Claude one).
      models: [
        { id: "gemini-2-5-flash", ref: "google/gemini-2.5-flash" },
        { id: "claude-haiku-4-5", ref: "anthropic/claude-haiku-4.5", anthropicNative: true },
      ],
    },
  },
  {
    id: "tokenmart",
    label: "TokenMart",
    base: "https://model.service-inference.ai",
    apiKeyEnv: "INFERENCE_API_KEY",
    check: "inference",
    // Mainstream models this key can actually serve. TokenMart lists GPT /
    // DeepSeek / Qwen in /v1/models, but inference on them returns HTTP 502
    // "Upstream authentication error" (ERR_PROVIDER_005) — those upstreams
    // aren't provisioned on this account, so we don't monitor them as "down".
    models: [
      { id: "claude-sonnet-4-6" },
      { id: "claude-opus-4-7" },
      { id: "claude-haiku-4-5-20251001" },
      { id: "gemini-3-flash-preview" },
      { id: "gemini-2.5-pro" },
      { id: "glm-4.6" },
    ],
    link: "https://thetokenmart.ai",
    integrity: {
      refBase: "https://openrouter.ai/api",
      refApiKeyEnv: "OPENROUTER_API_KEY",
      models: [
        { id: "gemini-2.5-pro", ref: "google/gemini-2.5-pro" },
        { id: "claude-sonnet-4-6", ref: "anthropic/claude-sonnet-4.6", anthropicNative: true },
      ],
    },
  },
  {
    // Also the integrity baseline for the discount providers above (referenced
    // by URL, independent of its own check mode). GPT only actually serves here
    // — Kunavo has no GPT text models, TokenMart's GPT 502s (upstream not
    // provisioned) — so the mainstream GPT liveness lives on OpenRouter.
    id: "openrouter",
    label: "OpenRouter",
    base: "https://openrouter.ai/api",
    apiKeyEnv: "OPENROUTER_API_KEY",
    check: "inference",
    models: [
      { id: "openai/gpt-5.1" },
      { id: "openai/gpt-4o" },
      { id: "openai/gpt-4o-mini" },
    ],
    link: "https://openrouter.ai",
  },
];
