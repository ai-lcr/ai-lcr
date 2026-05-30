import { describe, it, expect } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { isRetryableError } from "./fallback";
import { createLCR } from "./index";

const noRetry = { maxRetries: 0 as const };

function usage(input: number, output: number): LanguageModelV3GenerateResult["usage"] {
  return {
    inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: undefined, reasoning: undefined },
  };
}

function okModel(id: string, text: string) {
  return new MockLanguageModelV3({
    modelId: id,
    provider: id,
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: usage(10, 5),
      warnings: [],
    }),
  });
}

function failModel(id: string, statusCode: number, message = "boom") {
  return new MockLanguageModelV3({
    modelId: id,
    provider: id,
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
      const err = new Error(message) as Error & { statusCode: number };
      err.statusCode = statusCode;
      throw err;
    },
  });
}

describe("isRetryableError", () => {
  it("treats provider-down / overload / rate-limit statuses as retryable", () => {
    for (const s of [408, 409, 429, 500, 502, 503, 504]) {
      expect(isRetryableError({ statusCode: s })).toBe(true);
    }
  });

  it("treats a billing cap (HTTP 402) as retryable so routing falls over", () => {
    expect(isRetryableError({ statusCode: 402 })).toBe(true);
  });

  it("treats out-of-credit / quota / billing messages as retryable", () => {
    expect(isRetryableError(new Error("Insufficient credits"))).toBe(true);
    expect(isRetryableError(new Error("You have exceeded your quota"))).toBe(true);
    expect(isRetryableError(new Error("Payment required to continue"))).toBe(true);
    expect(isRetryableError({ message: "billing hard cap reached" })).toBe(true);
  });

  it("does NOT treat a caller error (400) or a plain message as retryable", () => {
    expect(isRetryableError({ statusCode: 400 })).toBe(false);
    expect(isRetryableError(new Error("invalid prompt"))).toBe(false);
  });
});

describe("createLCR — cap-aware failover (end-to-end)", () => {
  it("fails over to the backup when the primary hits a 402 billing cap", async () => {
    const capped = failModel("primary", 402, "Insufficient credits");
    const backup = okModel("backup", "served-by-backup");
    let switchedFrom: string | undefined;
    const lcr = createLCR({
      models: { m: [capped, backup] },
      onError: (_e, provider) => {
        switchedFrom = provider;
      },
    });

    const { text } = await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });

    expect(text).toBe("served-by-backup");
    expect(switchedFrom).toBe("primary");
  });

  it("fails over on an out-of-credit message even when no status is set", async () => {
    const capped = failModel("primary", 0, "Your account balance is insufficient");
    const backup = okModel("backup", "recovered");
    const lcr = createLCR({ models: { m: [capped, backup] } });

    const { text } = await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });

    expect(text).toBe("recovered");
  });
});
