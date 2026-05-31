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

  it("color option wraps the line in ANSI", () => {
    const line = formatCallRecord(
      { ...base, attempts: [{ provider: "p", ok: true, latencyMs: 1 }], winner: "p", ok: true, failedOver: false, costUsd: 0 },
      { color: true },
    );
    expect(line.startsWith("\x1b[32m")).toBe(true);
    expect(line.endsWith("\x1b[0m")).toBe(true);
  });
});
