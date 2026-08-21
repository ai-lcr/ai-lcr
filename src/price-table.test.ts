import { describe, it, expect } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { createLCR, getModelPrice, MODEL_PRICES, type CostEvent } from "./index";

function usage(input: number, output: number): LanguageModelV3GenerateResult["usage"] {
  return {
    inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: undefined, reasoning: undefined },
  };
}

// A model whose modelId is what getModelPrice keys on. `provider` is the label.
function model(modelId: string, provider: string, tokens = { input: 10, output: 5 }) {
  return new MockLanguageModelV3({
    modelId,
    provider,
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: usage(tokens.input, tokens.output),
      warnings: [],
    }),
  });
}

const noRetry = { maxRetries: 0 as const };

describe("MODEL_PRICES (bundled table)", () => {
  it("is a non-empty table of well-formed prices", () => {
    const ids = Object.keys(MODEL_PRICES);
    expect(ids.length).toBeGreaterThan(50);
    for (const id of ids) {
      const c = MODEL_PRICES[id]!;
      expect(c.input).toBeGreaterThanOrEqual(0);
      expect(c.output).toBeGreaterThanOrEqual(0);
      if (c.cacheRead !== undefined) expect(c.cacheRead).toBeGreaterThanOrEqual(0);
    }
  });

  it("includes documented native-maker models", () => {
    // These are in the README pricing table — guard against a generator that
    // silently drops the very models the docs promise.
    expect(MODEL_PRICES["claude-haiku-4-5"]).toBeDefined();
    expect(MODEL_PRICES["deepseek-chat"]).toBeDefined();
  });

  it("includes the open-weights makers (Qwen · Kimi · MiniMax · GLM)", () => {
    // The generator's ALLOW set must keep covering the open-weights labs the
    // README names alongside DeepSeek — guard against a refresh that drops them.
    expect(MODEL_PRICES["qwen-plus"]).toBeDefined(); // Qwen (Alibaba / dashscope)
    expect(MODEL_PRICES["kimi-k2.5"]).toBeDefined(); // Kimi (Moonshot)
    expect(MODEL_PRICES["MiniMax-M2"]).toBeDefined(); // MiniMax
    expect(MODEL_PRICES["glm-4.6"]).toBeDefined(); // GLM (Z.ai)
  });
});

describe("getModelPrice", () => {
  it("resolves a bare model id", () => {
    expect(getModelPrice("claude-haiku-4-5")).toEqual(MODEL_PRICES["claude-haiku-4-5"]);
  });

  it("resolves an id with a leading provider/ segment stripped", () => {
    expect(getModelPrice("anthropic/claude-haiku-4-5")).toEqual(MODEL_PRICES["claude-haiku-4-5"]);
  });

  it("returns undefined for unknown models and empty input", () => {
    expect(getModelPrice("totally-made-up-model")).toBeUndefined();
    expect(getModelPrice("")).toBeUndefined();
  });
});

describe("createLCR — autoPrice", () => {
  it("fills cost from the table when an entry has no explicit cost", async () => {
    const costs: CostEvent[] = [];
    const lcr = createLCR({
      autoPrice: true,
      models: { chat: [{ model: model("claude-haiku-4-5", "native"), label: "native" }] },
      onCost: (e) => costs.push(e),
    });

    await generateText({ model: lcr("chat"), prompt: "hi", ...noRetry });

    // claude-haiku-4-5 = $1/$5 per 1M; usage 10 in / 5 out.
    const expected = (10 / 1e6) * 1 + (5 / 1e6) * 5;
    expect(costs[0]!.costUsd).toBeCloseTo(expected, 12);
  });

  it("stays unpriced (cost 0) when autoPrice is off — backward compatible", async () => {
    const costs: CostEvent[] = [];
    const lcr = createLCR({
      models: { chat: [{ model: model("claude-haiku-4-5", "native"), label: "native" }] },
      onCost: (e) => costs.push(e),
    });

    await generateText({ model: lcr("chat"), prompt: "hi", ...noRetry });

    expect(costs[0]!.costUsd).toBe(0);
  });

  it("leaves an explicit cost untouched (explicit wins over the table)", async () => {
    const costs: CostEvent[] = [];
    const lcr = createLCR({
      autoPrice: true,
      models: {
        chat: [{ model: model("claude-haiku-4-5", "native"), label: "native", cost: { input: 99, output: 99 } }],
      },
      onCost: (e) => costs.push(e),
    });

    await generateText({ model: lcr("chat"), prompt: "hi", ...noRetry });

    const expected = (10 / 1e6) * 99 + (5 / 1e6) * 99;
    expect(costs[0]!.costUsd).toBeCloseTo(expected, 12);
  });

  it("applies a reseller discount to the looked-up price (Kunavo −20%)", async () => {
    const costs: CostEvent[] = [];
    const lcr = createLCR({
      autoPrice: true,
      models: { chat: [{ model: model("claude-haiku-4-5", "kunavo"), label: "kunavo", discount: 0.2 }] },
      onCost: (e) => costs.push(e),
    });

    await generateText({ model: lcr("chat"), prompt: "hi", ...noRetry });

    const list = (10 / 1e6) * 1 + (5 / 1e6) * 5;
    expect(costs[0]!.costUsd).toBeCloseTo(list * 0.8, 12);
  });

  it("leaves an unknown model unpriced under autoPrice without throwing", async () => {
    const costs: CostEvent[] = [];
    const lcr = createLCR({
      autoPrice: true,
      models: { chat: [{ model: model("made-up-xyz", "native"), label: "native" }] },
      onCost: (e) => costs.push(e),
    });

    await generateText({ model: lcr("chat"), prompt: "hi", ...noRetry });

    expect(costs[0]!.costUsd).toBe(0);
  });

  it("orders providers cheapest-first using table-filled prices (autoPrice + autoSort)", async () => {
    // haiku ($1/$5) is cheaper than opus 4.7 ($5/$25); list pricey first, expect
    // the cheap one to serve.
    const order: string[] = [];
    const lcr = createLCR({
      autoPrice: true,
      autoSort: true,
      models: {
        chat: [
          { model: model("claude-opus-4-7", "opus"), label: "opus" },
          { model: model("claude-haiku-4-5", "haiku"), label: "haiku" },
        ],
      },
      onCost: (e) => order.push(e.provider),
    });

    await generateText({ model: lcr("chat"), prompt: "hi", ...noRetry });

    expect(order[0]).toBe("haiku");
  });

  it("throws on an out-of-range discount", () => {
    expect(() =>
      createLCR({
        autoPrice: true,
        models: { chat: [{ model: model("claude-haiku-4-5", "k"), discount: 1.5 }] },
      }),
    ).toThrow(/discount must be in \[0, 1\)/);
  });
});

describe("getModelPrice — version separator", () => {
  // Aggregators and makers disagree on this character for the same model:
  // OpenRouter says `claude-sonnet-4.6`, Anthropic's API says `claude-sonnet-4-6`,
  // and the table is keyed the maker's way. A miss here is invisible — autoPrice
  // just leaves the entry unpriced and the row reports as free.
  it("resolves an aggregator's dotted version to the maker's hyphenated key", () => {
    const maker = getModelPrice("claude-sonnet-4-6");
    expect(maker).toBeDefined();
    expect(getModelPrice("claude-sonnet-4.6")).toEqual(maker);
    expect(getModelPrice("anthropic/claude-sonnet-4.6")).toEqual(maker);
    expect(getModelPrice("anthropic/claude-haiku-4.5")).toEqual(getModelPrice("claude-haiku-4-5"));
  });

  it("resolves in the other direction too, for makers keyed with dots", () => {
    // Google's own ids use dots, so the swap has to work both ways.
    const dotted = getModelPrice("gemini-3.7-flash");
    expect(dotted).toBeDefined();
    expect(getModelPrice("gemini-3-7-flash")).toEqual(dotted);
  });

  it("only swaps between digits, so other punctuation is untouched", () => {
    expect(getModelPrice("gemini-3-flash-preview")).toBeDefined();
    expect(getModelPrice("google/gemini-3-flash-preview")).toBeDefined();
  });

  it("still returns undefined for a model that is genuinely absent", () => {
    expect(getModelPrice("acme/not-a-real-model-9.9")).toBeUndefined();
    expect(getModelPrice("")).toBeUndefined();
  });
});
