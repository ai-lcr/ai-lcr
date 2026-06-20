import { describe, it, expect } from "vitest";
import { generateText, streamText, simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { createLCR, type CallRecord } from "./index";

const noRetry = { maxRetries: 0 as const };

function usage(input: number, output: number): LanguageModelV3GenerateResult["usage"] {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: undefined, reasoning: undefined },
  };
}

// usage with a provider-specific `raw` body (e.g. DeepInfra's estimated_cost).
function usageRaw(input: number, output: number, raw: Record<string, unknown>) {
  return { ...usage(input, output), raw } as LanguageModelV3GenerateResult["usage"];
}

// OpenRouter's providerMetadata shape (@openrouter/ai-sdk-provider v2.x): the
// real cost lives under openrouter.usage.{cost, costDetails.upstreamInferenceCost}.
function orMeta(cost?: number, upstream?: number): LanguageModelV3GenerateResult["providerMetadata"] {
  const u: Record<string, unknown> = {};
  if (cost !== undefined) u.cost = cost;
  if (upstream !== undefined) u.costDetails = { upstreamInferenceCost: upstream };
  return { openrouter: { usage: u } } as unknown as LanguageModelV3GenerateResult["providerMetadata"];
}

function genModel(opts: {
  id: string;
  u?: LanguageModelV3GenerateResult["usage"];
  providerMetadata?: LanguageModelV3GenerateResult["providerMetadata"];
}) {
  return new MockLanguageModelV3({
    modelId: opts.id,
    provider: opts.id,
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: opts.u ?? usage(1000, 500),
      warnings: [],
      ...(opts.providerMetadata ? { providerMetadata: opts.providerMetadata } : {}),
    }),
  });
}

function streamModel(opts: {
  id: string;
  u?: LanguageModelV3GenerateResult["usage"];
  providerMetadata?: LanguageModelV3GenerateResult["providerMetadata"];
}) {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: "ok" },
    { type: "text-end", id: "0" },
    {
      type: "finish",
      usage: opts.u ?? usage(1000, 500),
      finishReason: { unified: "stop", raw: undefined },
      ...(opts.providerMetadata ? { providerMetadata: opts.providerMetadata } : {}),
    } as LanguageModelV3StreamPart,
  ];
  return new MockLanguageModelV3({
    modelId: opts.id,
    provider: opts.id,
    doStream: async () => ({
      stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }),
    }),
  });
}

// Table estimate for cost {input:1, output:2}/1M on 1000 in / 500 out tokens:
//   1000/1e6 * 1 + 500/1e6 * 2 = 0.001 + 0.001 = 0.002
const TABLE = { input: 1, output: 2 };
const TABLE_EST = 0.002;

async function record(model: MockLanguageModelV3, cost?: { input: number; output: number }, stream = false) {
  const records: CallRecord[] = [];
  const lcr = createLCR({
    models: { m: [{ model, label: model.provider, ...(cost ? { cost } : {}) }] },
    onCall: (r) => records.push(r),
  });
  if (stream) {
    const res = streamText({ model: lcr("m"), prompt: "x", ...noRetry });
    for await (const _ of res.textStream) void _;
  } else {
    await generateText({ model: lcr("m"), prompt: "x", ...noRetry });
  }
  return records[0]!;
}

describe("reported provider cost wins over the price table (generate)", () => {
  it("uses OpenRouter's reported cost, keeps the table value as estCostUsd (drift signal)", async () => {
    const r = await record(genModel({ id: "openrouter", providerMetadata: orMeta(0.005) }), TABLE);
    expect(r.costUsd).toBeCloseTo(0.005, 9); // billed, not the 0.002 estimate
    expect(r.estCostUsd).toBeCloseTo(TABLE_EST, 9);
  });

  it("BYOK: prefers upstreamInferenceCost when the OpenRouter credit charge is 0", async () => {
    // gemini-via-BYOK case: cost=$0 (paid upstream, not OR credits), upstream=real
    const r = await record(genModel({ id: "openrouter", providerMetadata: orMeta(0, 0.00027) }), TABLE);
    expect(r.costUsd).toBeCloseTo(0.00027, 9);
  });

  it("BYOK: prefers the real upstream model cost over the OR credit fee when both > 0", async () => {
    const r = await record(genModel({ id: "openrouter", providerMetadata: orMeta(0.001, 0.004) }), TABLE);
    expect(r.costUsd).toBeCloseTo(0.004, 9);
  });

  it("falls back to the table estimate when the provider reports no cost (behavior unchanged)", async () => {
    const r = await record(genModel({ id: "openrouter" }), TABLE); // no providerMetadata
    expect(r.costUsd).toBeCloseTo(TABLE_EST, 9);
    expect(r.estCostUsd).toBeCloseTo(TABLE_EST, 9); // cost == est → dashboard shows no drift
  });

  it("reads an OpenAI-compatible provider's estimated_cost from the raw usage body", async () => {
    const r = await record(genModel({ id: "deepinfra", u: usageRaw(1000, 500, { estimated_cost: 0.00016 }) }), TABLE);
    expect(r.costUsd).toBeCloseTo(0.00016, 9);
  });

  it("records the reported cost even on an UNPRICED route (the $0-model class)", async () => {
    // No `cost` in the route (would log $0 today), but the provider reports the bill.
    const r = await record(genModel({ id: "openrouter", providerMetadata: orMeta(0.003) }), undefined);
    expect(r.costUsd).toBeCloseTo(0.003, 9);
    expect(r.estCostUsd).toBeUndefined();
  });
});

describe("reported provider cost wins over the price table (stream)", () => {
  it("reads the reported cost from the finish chunk's providerMetadata", async () => {
    const r = await record(streamModel({ id: "openrouter", providerMetadata: orMeta(0.005, 0.005) }), TABLE, true);
    expect(r.costUsd).toBeCloseTo(0.005, 9);
    expect(r.estCostUsd).toBeCloseTo(TABLE_EST, 9);
  });
});
