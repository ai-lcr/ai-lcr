import { describe, it, expect } from "vitest";
import { generateText, streamText, simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { createLCR, createMemoryCacheStore, type CacheStore, type CallRecord } from "./index";
import { cacheKeyOf } from "./cache";

function usage(input: number, output: number): LanguageModelV3GenerateResult["usage"] {
  return {
    inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: undefined, reasoning: undefined },
  };
}

// A model that counts how often it's actually called and serves a fixed answer.
// The point of caching is that a hit does NOT increment this.
function counting(id: string, text = "answer", out = 5) {
  const state = { calls: 0 };
  const model = new MockLanguageModelV3({
    modelId: id,
    provider: id,
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
      state.calls++;
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: usage(10, out),
        warnings: [],
      };
    },
  });
  return { model, state };
}

function countingStream(id: string, text = "answer") {
  const state = { calls: 0 };
  const model = new MockLanguageModelV3({
    modelId: id,
    provider: id,
    doStream: async () => {
      state.calls++;
      const chunks: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: text },
        { type: "text-end", id: "0" },
        { type: "finish", usage: usage(10, 5), finishReason: { unified: "stop", raw: undefined } },
      ];
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) };
    },
  });
  return { model, state };
}

const noRetry = { maxRetries: 0 as const };

describe("createLCR — exact-match response cache", () => {
  it("serves an identical generate from cache without calling the provider", async () => {
    const p = counting("p");
    const records: CallRecord[] = [];
    const lcr = createLCR({ models: { m: [p.model] }, cache: true, onCall: (r) => records.push(r) });

    const a = await generateText({ model: lcr("m"), prompt: "same", ...noRetry });
    const b = await generateText({ model: lcr("m"), prompt: "same", ...noRetry });

    expect(a.text).toBe("answer");
    expect(b.text).toBe("answer");
    expect(p.state.calls).toBe(1); // second was a cache hit
    expect(records).toHaveLength(2);
    expect(records[0]!.cacheHit).toBeUndefined();
    expect(records[1]!.cacheHit).toBe(true);
    expect(records[1]!.costUsd).toBe(0);
    expect(records[1]!.winner).toBe("p"); // the original serving provider
  });

  it("does NOT hit for a different prompt", async () => {
    const p = counting("p");
    const lcr = createLCR({ models: { m: [p.model] }, cache: true });
    await generateText({ model: lcr("m"), prompt: "one", ...noRetry });
    await generateText({ model: lcr("m"), prompt: "two", ...noRetry });
    expect(p.state.calls).toBe(2);
  });

  it("reports the avoided cost as cacheHitSavingUsd on a hit", async () => {
    const p = { model: counting("p").model, cost: { input: 3, output: 15 } };
    const records: CallRecord[] = [];
    const lcr = createLCR({ models: { m: [p] }, cache: true, onCall: (r) => records.push(r) });
    await generateText({ model: lcr("m"), prompt: "x", ...noRetry });
    await generateText({ model: lcr("m"), prompt: "x", ...noRetry });

    const original = records[0]!.costUsd;
    expect(original).toBeCloseTo((10 / 1e6) * 3 + (5 / 1e6) * 15, 12);
    const hit = records[1]!;
    expect(hit.costUsd).toBe(0);
    expect(hit.cacheHitSavingUsd).toBeCloseTo(original, 12);
  });

  it("replays a streamed response from cache", async () => {
    const s = countingStream("s", "streamed");
    const records: CallRecord[] = [];
    const lcr = createLCR({ models: { m: [s.model] }, cache: true, onCall: (r) => records.push(r) });

    const first = streamText({ model: lcr("m"), prompt: "go", ...noRetry });
    let firstText = "";
    for await (const t of first.textStream) firstText += t;

    const second = streamText({ model: lcr("m"), prompt: "go", ...noRetry });
    let secondText = "";
    for await (const t of second.textStream) secondText += t;

    expect(firstText).toBe("streamed");
    expect(secondText).toBe("streamed");
    expect(s.state.calls).toBe(1); // second replayed from cache
    expect(records[1]!.cacheHit).toBe(true);
  });

  it("never caches an empty completion", async () => {
    const empty = new MockLanguageModelV3({
      modelId: "e",
      provider: "e",
      doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
        content: [],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: usage(10, 0), // prompt billed, zero output → empty completion
        warnings: [],
      }),
    });
    let calls = 0;
    const counted = new MockLanguageModelV3({
      modelId: "e",
      provider: "e",
      doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
        calls++;
        return {
          content: [],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: usage(10, 0),
          warnings: [],
        };
      },
    });
    void empty;
    const lcr = createLCR({ models: { m: [counted] }, cache: true });
    await generateText({ model: lcr("m"), prompt: "x", ...noRetry });
    await generateText({ model: lcr("m"), prompt: "x", ...noRetry });
    expect(calls).toBe(2); // empty result was not cached → provider called again
  });

  it("ignores providerOptions.lcr.requestId in the cache key (still hits)", async () => {
    const p = counting("p");
    const lcr = createLCR({ models: { m: [p.model] }, cache: true });
    await generateText({
      model: lcr("m"),
      prompt: "x",
      providerOptions: { lcr: { requestId: "req-1" } },
      ...noRetry,
    });
    await generateText({
      model: lcr("m"),
      prompt: "x",
      providerOptions: { lcr: { requestId: "req-2" } },
      ...noRetry,
    });
    expect(p.state.calls).toBe(1); // different requestId, same logical request → hit
  });

  it("uses an injected custom store", async () => {
    const seen = { gets: 0, sets: 0 };
    const inner = createMemoryCacheStore();
    const store: CacheStore = {
      get(k) {
        seen.gets++;
        return inner.get(k);
      },
      set(k, v, ttl) {
        seen.sets++;
        return inner.set(k, v, ttl);
      },
    };
    const p = counting("p");
    const lcr = createLCR({ models: { m: [p.model] }, cache: store });
    await generateText({ model: lcr("m"), prompt: "x", ...noRetry });
    await generateText({ model: lcr("m"), prompt: "x", ...noRetry });
    expect(seen.sets).toBe(1);
    expect(seen.gets).toBe(2);
    expect(p.state.calls).toBe(1);
  });
});

describe("cacheKeyOf", () => {
  const base = {
    prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  } as unknown as LanguageModelV3CallOptions;

  it("is stable for identical inputs", () => {
    expect(cacheKeyOf("m", base)).toBe(cacheKeyOf("m", base));
  });

  it("differs by logical model name", () => {
    expect(cacheKeyOf("a", base)).not.toBe(cacheKeyOf("b", base));
  });

  it("differs by temperature", () => {
    const hot = { ...base, temperature: 0.9 };
    expect(cacheKeyOf("m", base)).not.toBe(cacheKeyOf("m", hot));
  });

  it("is unaffected by the lcr provider-options namespace", () => {
    const withId = {
      ...base,
      providerOptions: { lcr: { requestId: "abc" } },
    } as unknown as LanguageModelV3CallOptions;
    expect(cacheKeyOf("m", base)).toBe(cacheKeyOf("m", withId));
  });
});

describe("createMemoryCacheStore", () => {
  const entry = (cost: number) =>
    ({
      kind: "generate" as const,
      result: {} as LanguageModelV3GenerateResult,
      meta: { winner: "p", costUsd: cost, inputTokens: 1, outputTokens: 1 },
    });

  it("expires entries after ttl", async () => {
    const store = createMemoryCacheStore();
    store.set("k", entry(1), 20);
    expect(await store.get("k")).toBeDefined();
    await new Promise((r) => setTimeout(r, 30));
    expect(await store.get("k")).toBeUndefined();
  });

  it("evicts the oldest entry past maxEntries", async () => {
    const store = createMemoryCacheStore({ maxEntries: 2 });
    store.set("a", entry(1));
    store.set("b", entry(2));
    store.set("c", entry(3)); // evicts "a"
    expect(await store.get("a")).toBeUndefined();
    expect(await store.get("b")).toBeDefined();
    expect(await store.get("c")).toBeDefined();
  });
});
