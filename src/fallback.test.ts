import { describe, it, expect } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { isRetryableError, isNetworkError, classifyError, classifyErrorKind } from "./fallback";
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

  it("treats a non-English (Chinese) billing failure as retryable", () => {
    // Kunavo-style: a failed charge with no HTTP status, body in Chinese.
    expect(isRetryableError(new Error("余额不足，请充值"))).toBe(true);
    expect(isRetryableError(new Error("账户欠费，扣款失败"))).toBe(true);
    expect(classifyErrorKind(new Error("余额不足"))).toBe("billing");
  });

  it("tags an out-of-balance 403 as billing, but a plain 403 as auth", () => {
    // fal reports an exhausted account as 403 — a top-up problem, not a dead key.
    const e = Object.assign(new Error("Exhausted balance"), { status: 403 });
    expect(classifyErrorKind(e)).toBe("billing");
    expect(isRetryableError(e)).toBe(true); // still fails over
    // A 403 with no billing wording is a genuine auth failure.
    expect(classifyErrorKind({ status: 403, message: "forbidden" })).toBe("auth");
    expect(classifyErrorKind({ status: 401 })).toBe("auth");
  });

  it("treats a transport-level network failure as retryable", () => {
    // `fetch` throws a bare TypeError with no status — the provider is down.
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
    // …and wraps the real cause (with a Node `code`) in `error.cause`.
    const wrapped = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
        code: "ECONNREFUSED",
      }),
    });
    expect(isNetworkError(wrapped)).toBe(true);
    expect(isRetryableError(wrapped)).toBe(true);
    expect(classifyError(wrapped)).toBe("network");
    // A network failure is alarming-but-transient, not auth/billing/client.
    expect(classifyErrorKind(wrapped)).toBe("transient");
  });

  it("does NOT misread a caller cancellation as a network failure", () => {
    // A deliberate AbortError (no network code) must propagate, not fail over.
    const abort = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    expect(isNetworkError(abort)).toBe(false);
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

  it("fails over when the cheapest provider is unreachable (network error)", async () => {
    // The primary's fetch dies at the transport layer — no HTTP status at all.
    const down = new MockLanguageModelV3({
      modelId: "primary",
      provider: "primary",
      doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
            code: "ECONNREFUSED",
          }),
        });
      },
    });
    const backup = okModel("backup", "served-by-backup");
    const lcr = createLCR({ models: { m: [down, backup] } });

    const { text } = await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });

    expect(text).toBe("served-by-backup");
  });

  it("does not let a throwing observer turn a success into a failure", async () => {
    const ok = okModel("primary", "served");
    const lcr = createLCR({
      models: { m: [ok] },
      onCall: () => {
        throw new Error("logging sink is down");
      },
      onCost: () => {
        throw new Error("metrics sink is down");
      },
    });

    const { text } = await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });

    expect(text).toBe("served");
  });
});
