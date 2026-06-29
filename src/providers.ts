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

export interface OfficialProviderConfig {
  /** AI SDK provider package to install when this native route is used. */
  packageName: string;
  /** Name of the env var that holds the API key, when the provider has a single key. */
  apiKeyEnv?: string;
  /** Credential/config env vars the official provider can read. */
  envVars: readonly string[];
  /** Factory export used to create a configured provider instance. */
  factoryExport: string;
}

export type OfficialProviderFactory = (
  modelId: string,
  settings?: Record<string, unknown>,
) => {
  // Keep this duck-typed so ai-lcr does not need every official SDK as a dep.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doGenerate: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doStream: (...args: any[]) => any;
  provider: string;
  modelId: string;
};

export type OfficialProviderOptions = Record<string, unknown> & {
  /** Defaults to process.env[OFFICIAL_PROVIDERS[id].apiKeyEnv] when available. */
  apiKey?: string;
};

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

export const OFFICIAL_PROVIDERS = {
  anthropic: {
    packageName: "@ai-sdk/anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    envVars: ["ANTHROPIC_API_KEY"],
    factoryExport: "createAnthropic",
  },
  openai: {
    packageName: "@ai-sdk/openai",
    apiKeyEnv: "OPENAI_API_KEY",
    envVars: ["OPENAI_API_KEY"],
    factoryExport: "createOpenAI",
  },
  google: {
    packageName: "@ai-sdk/google",
    apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
    envVars: ["GOOGLE_GENERATIVE_AI_API_KEY"],
    factoryExport: "createGoogle",
  },
  xai: {
    packageName: "@ai-sdk/xai",
    apiKeyEnv: "XAI_API_KEY",
    envVars: ["XAI_API_KEY"],
    factoryExport: "createXai",
  },
  mistral: {
    packageName: "@ai-sdk/mistral",
    apiKeyEnv: "MISTRAL_API_KEY",
    envVars: ["MISTRAL_API_KEY"],
    factoryExport: "createMistral",
  },
  deepseek: {
    packageName: "@ai-sdk/deepseek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    envVars: ["DEEPSEEK_API_KEY"],
    factoryExport: "createDeepSeek",
  },
  cohere: {
    packageName: "@ai-sdk/cohere",
    apiKeyEnv: "COHERE_API_KEY",
    envVars: ["COHERE_API_KEY"],
    factoryExport: "createCohere",
  },
  groq: {
    packageName: "@ai-sdk/groq",
    apiKeyEnv: "GROQ_API_KEY",
    envVars: ["GROQ_API_KEY"],
    factoryExport: "createGroq",
  },
  perplexity: {
    packageName: "@ai-sdk/perplexity",
    apiKeyEnv: "PERPLEXITY_API_KEY",
    envVars: ["PERPLEXITY_API_KEY"],
    factoryExport: "createPerplexity",
  },
  fireworks: {
    packageName: "@ai-sdk/fireworks",
    apiKeyEnv: "FIREWORKS_API_KEY",
    envVars: ["FIREWORKS_API_KEY"],
    factoryExport: "createFireworks",
  },
  togetherai: {
    packageName: "@ai-sdk/togetherai",
    apiKeyEnv: "TOGETHER_API_KEY",
    envVars: ["TOGETHER_API_KEY"],
    factoryExport: "createTogetherAI",
  },
  cerebras: {
    packageName: "@ai-sdk/cerebras",
    apiKeyEnv: "CEREBRAS_API_KEY",
    envVars: ["CEREBRAS_API_KEY"],
    factoryExport: "createCerebras",
  },
  azure: {
    packageName: "@ai-sdk/azure",
    apiKeyEnv: "AZURE_API_KEY",
    envVars: ["AZURE_API_KEY", "AZURE_RESOURCE_NAME"],
    factoryExport: "createAzure",
  },
  "google-vertex": {
    packageName: "@ai-sdk/google-vertex",
    apiKeyEnv: "GOOGLE_VERTEX_API_KEY",
    envVars: ["GOOGLE_VERTEX_API_KEY", "GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION"],
    factoryExport: "createGoogleVertex",
  },
  "amazon-bedrock": {
    packageName: "@ai-sdk/amazon-bedrock",
    apiKeyEnv: "AWS_BEARER_TOKEN_BEDROCK",
    envVars: [
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ],
    factoryExport: "createAmazonBedrock",
  },
} as const satisfies Record<string, OfficialProviderConfig>;

export type OfficialProviderId = keyof typeof OFFICIAL_PROVIDERS;

const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<Record<string, unknown>>;

function readEnv(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

/**
 * Load an official AI SDK provider package only when you use it.
 *
 * Example:
 *   const anthropic = await createOfficialProvider("anthropic");
 *   const model = anthropic("claude-sonnet-4-6");
 *
 * The official packages stay optional peer dependencies: install only the ones
 * you route to, e.g. `npm i @ai-sdk/anthropic`.
 */
export async function createOfficialProvider(
  id: OfficialProviderId,
  options: OfficialProviderOptions = {},
): Promise<OfficialProviderFactory> {
  const config = OFFICIAL_PROVIDERS[id];
  if (!config) {
    throw new Error(`ai-lcr: unknown official provider "${id}"`);
  }

  let mod: Record<string, unknown>;
  try {
    mod = await dynamicImport(config.packageName);
  } catch (error) {
    throw new Error(
      `ai-lcr: official provider "${id}" requires ${config.packageName}. Install it with: npm i ${config.packageName}`,
      { cause: error },
    );
  }

  const createProvider = mod[config.factoryExport];
  if (typeof createProvider !== "function") {
    throw new Error(
      `ai-lcr: ${config.packageName} does not export ${config.factoryExport}`,
    );
  }

  const apiKey = options.apiKey ?? (config.apiKeyEnv ? readEnv(config.apiKeyEnv) : undefined);
  const settings = { ...options, ...(apiKey !== undefined ? { apiKey } : {}) };
  const provider = createProvider(Object.keys(settings).length > 0 ? settings : undefined);
  if (typeof provider !== "function") {
    throw new Error(`ai-lcr: ${config.factoryExport} did not return a provider function`);
  }

  return provider as OfficialProviderFactory;
}
