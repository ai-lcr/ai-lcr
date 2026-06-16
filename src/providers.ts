/**
 * Default provider configs — the URLs + env var names that every portfolio app
 * copy-pastes. Import these instead of redeclaring them per project.
 *
 * Adding a provider here (or changing a URL) propagates to every consumer on
 * the next `npm update ai-lcr` — no per-app code change.
 */

export interface ProviderConfig {
  /** Base URL for the OpenAI-compatible endpoint (no trailing `/v1` unless required). */
  baseURL: string;
  /** Name of the env var that holds the API key. */
  apiKeyEnv: string;
}

export const DEFAULT_PROVIDERS = {
  openrouter: { baseURL: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
  deepinfra: { baseURL: "https://api.deepinfra.com/v1/openai", apiKeyEnv: "DEEPINFRA_API_KEY" },
  tokenmart: { baseURL: "https://model.service-inference.ai/v1", apiKeyEnv: "INFERENCE_API_KEY" },
  deepseek: { baseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" },
  kunavo: { baseURL: "https://api.kunavo.com/v1", apiKeyEnv: "KUNAVO_API_KEY" },
  runware: { baseURL: "https://api.runware.ai/v1", apiKeyEnv: "RUNWARE_API_KEY" },
  fal: { baseURL: "https://queue.fal.run", apiKeyEnv: "FAL_KEY" },
} as const satisfies Record<string, ProviderConfig>;

export type DefaultProviderId = keyof typeof DEFAULT_PROVIDERS;
