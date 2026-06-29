import { describe, expect, it } from "vitest";
import { createOfficialProvider, OFFICIAL_PROVIDERS } from "./providers";

describe("official provider registry", () => {
  it("includes native AI SDK providers with package, env, and factory metadata", () => {
    expect(OFFICIAL_PROVIDERS.anthropic).toEqual({
      packageName: "@ai-sdk/anthropic",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      envVars: ["ANTHROPIC_API_KEY"],
      factoryExport: "createAnthropic",
    });
    expect(OFFICIAL_PROVIDERS.openai).toMatchObject({
      packageName: "@ai-sdk/openai",
      apiKeyEnv: "OPENAI_API_KEY",
      envVars: ["OPENAI_API_KEY"],
      factoryExport: "createOpenAI",
    });
    expect(OFFICIAL_PROVIDERS.google).toMatchObject({
      packageName: "@ai-sdk/google",
      apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
      envVars: ["GOOGLE_GENERATIVE_AI_API_KEY"],
      factoryExport: "createGoogle",
    });
    expect(OFFICIAL_PROVIDERS.groq).toMatchObject({
      packageName: "@ai-sdk/groq",
      apiKeyEnv: "GROQ_API_KEY",
      factoryExport: "createGroq",
    });
    expect(OFFICIAL_PROVIDERS["google-vertex"]).toMatchObject({
      packageName: "@ai-sdk/google-vertex",
      apiKeyEnv: "GOOGLE_VERTEX_API_KEY",
      factoryExport: "createGoogleVertex",
    });
    expect(OFFICIAL_PROVIDERS["amazon-bedrock"]).toMatchObject({
      packageName: "@ai-sdk/amazon-bedrock",
      apiKeyEnv: "AWS_BEARER_TOKEN_BEDROCK",
      factoryExport: "createAmazonBedrock",
    });
  });

  it("reports the package to install when an optional official SDK is absent", async () => {
    await expect(createOfficialProvider("anthropic")).rejects.toThrow(
      /requires @ai-sdk\/anthropic.*npm i @ai-sdk\/anthropic/,
    );
  });
});
