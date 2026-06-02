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

/**
 * A free, generation-free reachability probe for providers that aren't
 * OpenAI-compatible text endpoints (image/video providers). Lets a "reachable"
 * check hit a provider-specific free endpoint instead of `GET /v1/models`:
 *   - Runware: POST a `ping` task → `pong` (0 cost, no image).
 *   - fal:     GET /v1/account/billing → 2xx proves endpoint up + key valid.
 * When set on a provider, the ping route uses this instead of the default
 * `GET /v1/models`.
 */
export type ReachProbe = {
  method: "GET" | "POST";
  /** Appended to `base` (which has no trailing path). e.g. "/v1", "/v1/account/billing". */
  path: string;
  /** Authorization header value for a key. Default: `Bearer <key>`. */
  auth?: (key: string) => string;
  /** JSON request body (POST only). */
  body?: unknown;
  /** Success predicate over the parsed 2xx JSON. Default: any object. */
  ok?: (json: unknown) => boolean;
};

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
  /**
   * Override the chat-completions path appended to `base` for inference pings.
   * Default `/v1/chat/completions`. Needed for providers whose OpenAI-compatible
   * endpoint isn't at the standard path — e.g. DeepInfra serves it at
   * `/v1/openai/chat/completions` (the `/v1/` sits before `openai`).
   */
  chatPath?: string;
  /** Name of the env var holding this provider's API key. */
  apiKeyEnv: string;
  /** Liveness strategy — see CheckMode. */
  check: CheckMode;
  /** Models to liveness-ping ("inference" mode). Empty for pure "reachable". */
  models: LiveModel[];
  /**
   * Also run a free GET /v1/models reachability ping (0 tokens), in addition to
   * any per-model inference checks. Lets an "inference" provider keep a
   * token-free "is the endpoint up" signal alongside its model checks.
   */
  reachable?: boolean;
  /** Optional homepage link. */
  link?: string;
  /**
   * Provider-specific free reachability probe (image/video providers that aren't
   * OpenAI-compatible). Used by the "reachable" check in place of GET /v1/models.
   */
  probe?: ReachProbe;
  /** Daily integrity suite config. Omit for providers we only liveness-check. */
  integrity?: {
    /** Trusted baseline provider base (no /v1) for the token-inflation comparison. */
    refBase: string;
    /** Env var holding the baseline provider's API key. */
    refApiKeyEnv: string;
    /** Models to run the suite against. */
    models: IntegrityModel[];
  };
  /**
   * Daily billing-drift audit — verifies the advertised discount is what's
   * actually billed. Two flavors:
   *   - "mgmt-api": the provider exposes a read-only billing API (TokenMart's
   *     Management API). We reconcile a recent full day's real USD cost against
   *     its real token counts: effective $/1M = cost / tokens. Must equal the
   *     /v1/models sticker.
   *   - "inline-estimated-cost": the provider returns `usage.estimated_cost` per
   *     response (DeepInfra). We confirm it equals advertised_price × tokens.
   */
  billing?:
    | { kind: "mgmt-api"; mgmtKeyEnv: string }
    | { kind: "inline-estimated-cost" };
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
    // Kunavo carries Anthropic + Google only. Opus omitted to save cost —
    // Sonnet + Haiku are enough to represent the Claude path here.
    models: [
      { id: "gemini-2-5-flash" },
      { id: "gemini-2-5-pro" },
      { id: "claude-haiku-4-5" },
      { id: "claude-sonnet-4-6" },
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
    // Mainstream models this key can actually serve (verified by live
    // max_tokens probe, 2026-06-01). GPT and Qwen upstreams are now
    // provisioned (gpt-5.5/gpt-5-nano/qwen3.5-flash serve fine). Caveat:
    // Google's cheap "lite" tiers — gemini-2.5-flash-lite, gemini-3.1-flash-lite,
    // gemini-3.5-flash — currently 502 ("Upstream authentication error"
    // ERR_PROVIDER_005), so we monitor gemini-2.5-flash (serves) as the cheap
    // Gemini rep and watch the lite tier on OpenRouter instead.
    models: [
      { id: "claude-sonnet-4-6" },
      { id: "claude-haiku-4-5-20251001" },
      { id: "gemini-3-flash-preview" },
      { id: "gemini-2.5-flash" },
      { id: "gemini-2.5-pro" },
      { id: "glm-4.6" },
      { id: "qwen3.5-flash" },
      { id: "gpt-5-nano" },
      { id: "gpt-5.5" },
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
    // Read-only Management API (sk-mgmt-v1-…) — reconciles real billed cost vs
    // the /v1/models sticker each day. See scripts/verify-billing.py.
    billing: { kind: "mgmt-api", mgmtKeyEnv: "INFERENCE_MGMT_KEY" },
  },
  {
    // DeepSeek's own official API — OpenAI-compatible. Inference checks are
    // near-zero cost: deepseek-chat at $0.27/$1.10 per 1M i/o is ~$0.002/day
    // at the 15-min cadence. No integrity suite needed — this is the vendor's
    // own endpoint, not a discount aggregator.
    id: "deepseek",
    label: "DeepSeek",
    base: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    check: "inference",
    models: [
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    ],
    link: "https://platform.deepseek.com",
  },
  {
    // Open-weights inference host (Llama/Qwen/DeepSeek/GLM/Kimi/MiniMax) — the
    // cheapest serving option for the Chinese open models. Cheaper than Novita
    // across DeepSeek/Kimi/MiniMax (verified from pricing pages 2026-06-02), so
    // we monitor a cheap rep of each here. No integrity suite — a transparent
    // first-party-ish host, not a discount relay. NOTE its OpenAI endpoint sits
    // at /v1/openai/chat/completions (the /v1/ precedes openai) — hence chatPath.
    // Model ids verified present in /v1/openai/models on the live key 2026-06-02.
    id: "deepinfra",
    label: "DeepInfra",
    base: "https://api.deepinfra.com",
    chatPath: "/v1/openai/chat/completions",
    apiKeyEnv: "DEEPINFRA_API_KEY",
    check: "inference",
    models: [
      { id: "deepseek-ai/DeepSeek-V4-Flash", label: "DeepSeek V4 Flash" },
      { id: "MiniMaxAI/MiniMax-M2.5", label: "MiniMax M2.5" },
      { id: "moonshotai/Kimi-K2.5", label: "Kimi K2.5" },
    ],
    link: "https://deepinfra.com",
    // DeepInfra returns usage.estimated_cost per response — verify it matches
    // advertised price × tokens (no separate billing API).
    billing: { kind: "inline-estimated-cost" },
  },
  {
    // Also the integrity baseline for the discount providers above (referenced
    // by URL, independent of its own check mode). The mainstream GPT liveness
    // lives here (Kunavo has no GPT text models). We also monitor a cheap
    // Anthropic + Gemini rep here against real first-party upstreams: it gives
    // a same-model cross-provider comparison vs the discount gateways, and
    // covers gemini-2.5-flash-lite — the cheapest Gemini, which TokenMart's key
    // can't serve (502).
    id: "openrouter",
    label: "OpenRouter",
    base: "https://openrouter.ai/api",
    apiKeyEnv: "OPENROUTER_API_KEY",
    check: "inference",
    models: [
      { id: "openai/gpt-5.1" },
      { id: "openai/gpt-4o" },
      { id: "openai/gpt-4o-mini" },
      { id: "anthropic/claude-haiku-4.5" },
      { id: "google/gemini-2.5-flash-lite" },
    ],
    // Plus a free, token-free endpoint reachability ping.
    reachable: true,
    link: "https://openrouter.ai",
  },
  {
    // Image/video provider — not OpenAI-compatible, so it's reachability-only via
    // a custom probe. Runware's `ping` task returns `pong` for free (no image,
    // no compute). Proves the endpoint is up; with the auth header it also
    // exercises the key. Runware has no balance endpoint, so this can't tell you
    // you're out of credit — that's caught reactively by the router's failover.
    id: "runware",
    label: "Runware",
    base: "https://api.runware.ai",
    apiKeyEnv: "RUNWARE_API_KEY",
    check: "reachable",
    models: [],
    link: "https://runware.ai",
    probe: {
      method: "POST",
      path: "/v1",
      // Runware uses Bearer (the default), so no `auth` override needed.
      body: [{ taskType: "ping", ping: true }],
      ok: (j) => {
        const data = (j as { data?: unknown })?.data;
        return Array.isArray(data) && data.some((d) => (d as { pong?: boolean })?.pong === true);
      },
    },
  },
  {
    // Image/video provider — reachability via the free model catalog endpoint
    // (GET, no generation). `/v1/account/billing` was 403 for our generation key
    // (billing needs a higher-scoped key); `/v1/models` is reachable with it.
    // The endpoint is public without a header, but WITH an Authorization header
    // it validates the key (a bad key → 401), so sending the key still proves it
    // valid. fal uses `Authorization: Key <k>`, not Bearer. Reachability only —
    // it can't see balance, so a failed charge is caught reactively by failover.
    id: "fal",
    label: "fal.ai",
    base: "https://api.fal.ai",
    apiKeyEnv: "FAL_KEY",
    check: "reachable",
    models: [],
    link: "https://fal.ai",
    probe: {
      method: "GET",
      path: "/v1/models",
      auth: (key) => `Key ${key}`,
      ok: (j) => Array.isArray((j as { models?: unknown[] })?.models) && (j as { models: unknown[] }).models.length > 0,
    },
  },
];
