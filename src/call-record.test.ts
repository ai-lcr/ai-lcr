import { describe, it, expect } from "vitest";
import { generateText, streamText, simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { classifyError, formatCallRecord, type CallRecord } from "./index";
import { createLCR } from "./index";

const noRetry = { maxRetries: 0 as const };

function usage(input: number, output: number): LanguageModelV3GenerateResult["usage"] {
  return {
    inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: undefined, reasoning: undefined },
  };
}

function usageWithCache(
  input: number,
  output: number,
  cacheRead: number,
): LanguageModelV3GenerateResult["usage"] {
  return {
    inputTokens: { total: input, noCache: input - cacheRead, cacheRead, cacheWrite: undefined },
    outputTokens: { total: output, text: undefined, reasoning: undefined },
  };
}

function okModel(id: string, text: string, u = usage(10, 5)) {
  return new MockLanguageModelV3({
    modelId: id,
    provider: id,
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: u,
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

function textChunks(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: text },
    { type: "text-end", id: "0" },
    { type: "finish", usage: usage(10, 5), finishReason: { unified: "stop", raw: undefined } },
  ];
}

function streamOkModel(id: string, text: string) {
  return new MockLanguageModelV3({
    modelId: id,
    provider: id,
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: textChunks(text), initialDelayInMs: 0, chunkDelayInMs: 0 }),
    }),
  });
}

// Stream that emits `stream-start` then a retryable error chunk before any
// text — exercises the mid-stream failover *recursion* (the risky path where
// attempts must accumulate into one record).
function streamMidFailModel(id: string, statusCode: number) {
  const err = Object.assign(new Error("mid-stream"), { statusCode });
  return new MockLanguageModelV3({
    modelId: id,
    provider: id,
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [{ type: "stream-start", warnings: [] }, { type: "error", error: err }] as LanguageModelV3StreamPart[],
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
      }),
    }),
  });
}

describe("classifyError", () => {
  it("prefers an HTTP status", () => {
    expect(classifyError({ statusCode: 502 })).toBe("502");
    expect(classifyError({ status: 429 })).toBe("429");
  });
  it("falls back to a retryable pattern, then 'error'", () => {
    expect(classifyError(new Error("Rate limit exceeded"))).toBe("rate limit");
    expect(classifyError(new Error("totally unknown"))).toBe("error");
  });
});

describe("onCall — one correlated record per request (generate)", () => {
  it("a clean success: one record, no failover, winner + cost set", async () => {
    const records: CallRecord[] = [];
    const lcr = createLCR({
      models: { m: [{ model: okModel("tokenmart", "hi"), label: "tokenmart", cost: { input: 1, output: 2 } }] },
      onCall: (r) => records.push(r),
    });

    await generateText({ model: lcr("m"), prompt: "x", ...noRetry });

    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.ok).toBe(true);
    expect(r.failedOver).toBe(false);
    expect(r.winner).toBe("tokenmart");
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ provider: "tokenmart", ok: true });
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.model).toBe("m");
    expect(typeof r.id).toBe("string");
  });

  it("failover: one record carrying the full chain + reason + winner", async () => {
    const records: CallRecord[] = [];
    const lcr = createLCR({
      models: { m: [failModel("tokenmart", 502), okModel("openrouter", "served")] },
      onCall: (r) => records.push(r),
    });

    const { text } = await generateText({ model: lcr("m"), prompt: "x", ...noRetry });

    expect(text).toBe("served");
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.ok).toBe(true);
    expect(r.failedOver).toBe(true);
    expect(r.winner).toBe("openrouter");
    expect(r.attempts.map((a) => [a.provider, a.ok, a.errorClass])).toEqual([
      ["tokenmart", false, "502"],
      ["openrouter", true, undefined],
    ]);
  });

  it("total failure: one record, no winner, every attempt failed", async () => {
    const records: CallRecord[] = [];
    const lcr = createLCR({
      models: { m: [failModel("a", 502), failModel("b", 429)] },
      onCall: (r) => records.push(r),
    });

    await expect(generateText({ model: lcr("m"), prompt: "x", ...noRetry })).rejects.toThrow();

    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.ok).toBe(false);
    expect(r.winner).toBeUndefined();
    expect(r.failedOver).toBe(true);
    expect(r.attempts.every((a) => !a.ok)).toBe(true);
    expect(r.attempts).toHaveLength(2);
  });
});

describe("onCall — streaming failover accumulates into ONE record", () => {
  it("mid-stream error on the primary fails over, recorded as a single record", async () => {
    const records: CallRecord[] = [];
    const lcr = createLCR({
      models: { m: [streamMidFailModel("tokenmart", 503), streamOkModel("openrouter", "streamed")] },
      onCall: (r) => records.push(r),
    });

    const res = streamText({ model: lcr("m"), prompt: "x", ...noRetry });
    let out = "";
    for await (const delta of res.textStream) out += delta;

    expect(out).toBe("streamed");
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.ok).toBe(true);
    expect(r.winner).toBe("openrouter");
    expect(r.failedOver).toBe(true);
    expect(r.attempts.map((a) => [a.provider, a.ok])).toEqual([
      ["tokenmart", false],
      ["openrouter", true],
    ]);
    expect(r.attempts[0]!.errorClass).toBe("503");
  });
});

describe("onCall — TTFT (time to first token)", () => {
  it("streaming success carries ttftMs, within [0, latencyMs]", async () => {
    const records: CallRecord[] = [];
    const lcr = createLCR({
      models: { m: [streamOkModel("tokenmart", "hello world")] },
      onCall: (r) => records.push(r),
    });

    const res = streamText({ model: lcr("m"), prompt: "x", ...noRetry });
    let out = "";
    for await (const delta of res.textStream) out += delta;

    expect(out).toBe("hello world");
    const r = records[0]!;
    expect(typeof r.ttftMs).toBe("number");
    expect(r.ttftMs!).toBeGreaterThanOrEqual(0);
    // First token can't arrive after the whole stream finished.
    expect(r.ttftMs!).toBeLessThanOrEqual(r.latencyMs);
  });

  it("non-streaming (doGenerate) leaves ttftMs undefined — no 'first token' concept", async () => {
    const records: CallRecord[] = [];
    const lcr = createLCR({
      models: { m: [okModel("tokenmart", "hi")] },
      onCall: (r) => records.push(r),
    });
    await generateText({ model: lcr("m"), prompt: "x", ...noRetry });
    expect(records[0]!.ttftMs).toBeUndefined();
  });

  it("on a streaming failover, ttftMs belongs to the winner that actually streamed", async () => {
    const records: CallRecord[] = [];
    const lcr = createLCR({
      models: { m: [streamMidFailModel("tokenmart", 503), streamOkModel("openrouter", "streamed")] },
      onCall: (r) => records.push(r),
    });
    const res = streamText({ model: lcr("m"), prompt: "x", ...noRetry });
    let out = "";
    for await (const delta of res.textStream) out += delta;

    expect(out).toBe("streamed");
    const r = records[0]!;
    expect(r.winner).toBe("openrouter");
    expect(typeof r.ttftMs).toBe("number");
    expect(r.ttftMs!).toBeGreaterThanOrEqual(0);
  });
});

describe("onCall — savings baseline (text side)", () => {
  it("sets baselineUsd from the most expensive priced provider on the same usage", async () => {
    const records: CallRecord[] = [];
    const lcr = createLCR({
      models: {
        m: [
          { model: okModel("tokenmart", "hi"), label: "tokenmart", cost: { input: 1, output: 2 } },
          { model: okModel("openrouter", "hi"), label: "openrouter", cost: { input: 3, output: 4 } },
        ],
      },
      onCall: (r) => records.push(r),
    });

    await generateText({ model: lcr("m"), prompt: "x", ...noRetry });

    const r = records[0]!;
    expect(r.winner).toBe("tokenmart");
    // winner: 10/1e6*1 + 5/1e6*2 = 2e-5 ; baseline (openrouter): 10/1e6*3 + 5/1e6*4 = 5e-5
    expect(r.costUsd).toBeCloseTo(2e-5, 12);
    expect(r.baselineUsd).toBeCloseTo(5e-5, 12);
    expect(r.baselineUsd! - r.costUsd).toBeGreaterThan(0);
  });

  it("leaves baselineUsd undefined when no provider is priced", async () => {
    const records: CallRecord[] = [];
    const lcr = createLCR({
      models: { m: [okModel("tokenmart", "hi")] },
      onCall: (r) => records.push(r),
    });
    await generateText({ model: lcr("m"), prompt: "x", ...noRetry });
    expect(records[0]!.baselineUsd).toBeUndefined();
  });
});

describe("onCall — prompt-cache aware cost", () => {
  it("bills cacheRead tokens at the cache rate and surfaces cachedInputTokens", async () => {
    const records: CallRecord[] = [];
    const lcr = createLCR({
      models: {
        m: [
          {
            model: okModel("anthropic", "hi", usageWithCache(1000, 100, 800)),
            label: "anthropic",
            cost: { input: 3, output: 4, cacheRead: 0.3 },
          },
        ],
      },
      onCall: (r) => records.push(r),
    });

    await generateText({ model: lcr("m"), prompt: "x", ...noRetry });

    const r = records[0]!;
    // 200 full input @3 + 800 cached @0.3 + 100 output @4 = 6e-4 + 2.4e-4 + 4e-4
    expect(r.costUsd).toBeCloseTo(1.24e-3, 12);
    // without the discount it would be 1000@3 + 100@4 = 3.4e-3 — strictly higher
    expect(r.costUsd).toBeLessThan(3.4e-3);
    expect(r.cachedInputTokens).toBe(800);
  });

  it("falls back to the full input rate when cacheRead is not configured (back-compat)", async () => {
    const records: CallRecord[] = [];
    const lcr = createLCR({
      models: {
        m: [
          {
            model: okModel("p", "hi", usageWithCache(1000, 100, 800)),
            label: "p",
            cost: { input: 3, output: 4 },
          },
        ],
      },
      onCall: (r) => records.push(r),
    });
    await generateText({ model: lcr("m"), prompt: "x", ...noRetry });
    expect(records[0]!.costUsd).toBeCloseTo(3.4e-3, 12);
  });
});

describe("onCall — requestId passthrough + usageMissing flag", () => {
  it("stamps requestId from providerOptions.lcr.requestId onto the record", async () => {
    const records: CallRecord[] = [];
    const lcr = createLCR({
      models: { m: [okModel("tokenmart", "hi")] },
      onCall: (r) => records.push(r),
    });
    await generateText({
      model: lcr("m"),
      prompt: "x",
      providerOptions: { lcr: { requestId: "req-123" } },
      ...noRetry,
    });
    expect(records[0]!.requestId).toBe("req-123");
  });

  it("flags usageMissing when the winner reports zero input AND output tokens", async () => {
    const records: CallRecord[] = [];
    const lcr = createLCR({
      models: { m: [{ model: okModel("p", "hi", usage(0, 0)), label: "p", cost: { input: 5, output: 5 } }] },
      onCall: (r) => records.push(r),
    });
    await generateText({ model: lcr("m"), prompt: "x", ...noRetry });
    const r = records[0]!;
    expect(r.usageMissing).toBe(true);
    expect(r.costUsd).toBe(0);
  });

  it("does NOT flag usageMissing on a normal call", async () => {
    const records: CallRecord[] = [];
    const lcr = createLCR({
      models: { m: [okModel("p", "hi")] },
      onCall: (r) => records.push(r),
    });
    await generateText({ model: lcr("m"), prompt: "x", ...noRetry });
    expect(records[0]!.usageMissing).toBeUndefined();
  });
});

describe("formatCallRecord", () => {
  const base = { id: "1", model: "text", inputTokens: 10, outputTokens: 5, latencyMs: 412 };

  it("clean success → ✓ with provider and cost", () => {
    const line = formatCallRecord({
      ...base,
      attempts: [{ provider: "tokenmart", ok: true, latencyMs: 412 }],
      winner: "tokenmart",
      ok: true,
      failedOver: false,
      costUsd: 0.0003,
    });
    expect(line).toBe("✓ text  tokenmart  412ms  $0.0003");
  });

  it("failover-but-served → ⚠ with the arrow chain and the failed reason", () => {
    const line = formatCallRecord({
      ...base,
      latencyMs: 910,
      attempts: [
        { provider: "tokenmart", ok: false, latencyMs: 500, errorClass: "502" },
        { provider: "openrouter", ok: true, latencyMs: 410 },
      ],
      winner: "openrouter",
      ok: true,
      failedOver: true,
      costUsd: 0.0004,
    });
    expect(line).toBe("⚠ text  tokenmart→openrouter  910ms  $0.0004  ⤷ tokenmart 502");
  });

  it("total failure → ✗ FAILED with every reason", () => {
    const line = formatCallRecord({
      ...base,
      latencyMs: 1240,
      attempts: [
        { provider: "deepseek", ok: false, latencyMs: 400, errorClass: "401" },
        { provider: "tokenmart", ok: false, latencyMs: 440, errorClass: "502" },
        { provider: "openrouter", ok: false, latencyMs: 400, errorClass: "429" },
      ],
      winner: undefined,
      ok: false,
      failedOver: true,
      costUsd: 0,
    });
    expect(line).toBe(
      "✗ text  deepseek→tokenmart→openrouter  1240ms  FAILED  ⤷ deepseek 401, tokenmart 502, openrouter 429",
    );
  });

  it("appends a (saved $X) suffix when baselineUsd beats costUsd", () => {
    const line = formatCallRecord({
      ...base,
      attempts: [{ provider: "tokenmart", ok: true, latencyMs: 412 }],
      winner: "tokenmart",
      ok: true,
      failedOver: false,
      costUsd: 0.0002,
      baselineUsd: 0.0005,
    });
    expect(line).toBe("✓ text  tokenmart  412ms  $0.0002  (saved $0.0003)");
  });

  it("appends ⚠no-usage when the winner reported no usage", () => {
    const line = formatCallRecord({
      ...base,
      attempts: [{ provider: "p", ok: true, latencyMs: 1 }],
      winner: "p",
      ok: true,
      failedOver: false,
      costUsd: 0,
      usageMissing: true,
    });
    expect(line).toBe("✓ text  p  412ms  $0  ⚠no-usage");
  });

  it("shows TTFT next to total latency when present (streaming)", () => {
    const line = formatCallRecord({
      ...base,
      attempts: [{ provider: "tokenmart", ok: true, latencyMs: 412 }],
      winner: "tokenmart",
      ok: true,
      failedOver: false,
      ttftMs: 88,
      costUsd: 0.0003,
    });
    expect(line).toBe("✓ text  tokenmart  412ms (ttft 88ms)  $0.0003");
  });

  it("color option wraps the line in ANSI", () => {
    const line = formatCallRecord(
      { ...base, attempts: [{ provider: "p", ok: true, latencyMs: 1 }], winner: "p", ok: true, failedOver: false, costUsd: 0 },
      { color: true },
    );
    expect(line.startsWith("\x1b[32m")).toBe(true);
    expect(line.endsWith("\x1b[0m")).toBe(true);
  });
});
