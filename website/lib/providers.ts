/**
 * How a provider's heartbeat is performed:
 * - "inference": a real `max_tokens: 1` completion against `model`. Proves the
 *   inference path actually works — use it for discount / quirky providers you
 *   don't fully trust. Costs a few tokens per check.
 * - "reachable": a free `GET /v1/models` reachability + auth check (0 tokens).
 *   Enough for trusted aggregators where "is the endpoint up" is all we need.
 */
export type CheckMode = "inference" | "reachable";

export type Provider = {
  /** Stable key used as the DB `provider` column + React key. */
  id: string;
  /** Display name on the status page. */
  label: string;
  /** Base URL WITHOUT /v1 — the ping appends /v1/chat/completions or /v1/models. */
  base: string;
  /** Name of the env var holding this provider's API key. */
  apiKeyEnv: string;
  /** Model id (used by "inference" checks; shown on the page for both modes). */
  model: string;
  /** Heartbeat strategy — see CheckMode. */
  check: CheckMode;
  /** Optional homepage link. */
  link?: string;
};

export const PROVIDERS: Provider[] = [
  {
    id: "kunavo",
    label: "Kunavo",
    base: "https://api.kunavo.com",
    apiKeyEnv: "KUNAVO_API_KEY",
    model: "gemini-2-5-flash",
    check: "inference",
    link: "https://kunavo.com/?ref=victorimf",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    base: "https://openrouter.ai/api",
    apiKeyEnv: "OPENROUTER_API_KEY",
    model: "google/gemini-3-flash-preview",
    check: "reachable",
    link: "https://openrouter.ai",
  },
];
