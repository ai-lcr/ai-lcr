import { describe, expect, it } from "vitest";
import { generateText, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { createLCR, createTimeRoutedModel, DEEPSEEK_PRICES, isDeepSeekPeak, type CallRecord } from "./index";

const usage: LanguageModelV3GenerateResult["usage"] = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 500, text: undefined, reasoning: undefined },
};

function model(id: string) {
  return new MockLanguageModelV3({
    modelId: id,
    provider: id,
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: id }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage,
      warnings: [],
    }),
    doStream: async () => {
      const chunks: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: id },
        { type: "text-end", id: "0" },
        { type: "finish", usage, finishReason: { unified: "stop", raw: undefined } },
      ];
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    },
  });
}

describe("DeepSeek scheduled routing", () => {
  it("uses the published UTC boundaries, including weekend and partial hours", () => {
    const peak = ["2026-09-28T01:00:00Z", "2026-09-28T03:59:59Z", "2026-09-28T06:00:00Z", "2026-10-02T09:59:59Z"];
    const offPeak = ["2026-09-28T00:59:59Z", "2026-09-28T04:00:00Z", "2026-09-28T05:59:59Z", "2026-10-02T10:00:00Z", "2026-10-03T01:00:00Z", "2026-10-04T07:00:00Z"];
    for (const value of peak) expect(isDeepSeekPeak(new Date(value)), value).toBe(true);
    for (const value of offPeak) expect(isDeepSeekPeak(new Date(value)), value).toBe(false);
    expect(() => isDeepSeekPeak(new Date("bad"))).toThrow(RangeError);
  });

  it("reuses the same Flash model but applies Tokenify's price for each period", async () => {
    const direct = model("deepseek");
    const tokenify = model("tokenify");
    const records: CallRecord[] = [];
    const offPeak = createLCR({
      models: { flash: [
        { model: tokenify, label: "tokenify", cost: DEEPSEEK_PRICES.flash.tokenifyOffPeak },
        { model: direct, label: "deepseek", cost: DEEPSEEK_PRICES.flash.officialOffPeak },
      ] },
      onCall: (record) => records.push(record),
    });
    const peak = createLCR({
      models: { flash: [
        { model: tokenify, label: "tokenify", cost: DEEPSEEK_PRICES.flash.tokenifyPeak },
        { model: direct, label: "deepseek", cost: DEEPSEEK_PRICES.flash.officialPeak },
      ] },
      onCall: (record) => records.push(record),
    });
    let now = new Date("2026-09-28T00:59:59Z");
    const routed = createTimeRoutedModel((at) => isDeepSeekPeak(at) ? peak("flash") : offPeak("flash"), () => now);

    expect((await generateText({ model: routed, prompt: "hi", maxRetries: 0 })).text).toBe("tokenify");
    now = new Date("2026-09-28T01:00:00Z");
    expect((await generateText({ model: routed, prompt: "hi", maxRetries: 0 })).text).toBe("tokenify");
    expect(records.map((record) => record.winner)).toEqual(["tokenify", "tokenify"]);
    expect(records[0]?.costUsd).toBeCloseTo(0.00027, 9);
    expect(records[1]?.costUsd).toBeCloseTo(0.00045, 9);
  });

  it("selects each stream at invocation and keeps that selection across the boundary", async () => {
    const direct = model("deepseek");
    const tokenify = model("tokenify");
    const offPeak = createLCR({ models: { flash: [direct] } });
    const peak = createLCR({ models: { flash: [tokenify] } });
    let now = new Date("2026-09-28T00:59:59Z");
    const routed = createTimeRoutedModel((at) => isDeepSeekPeak(at) ? peak("flash") : offPeak("flash"), () => now);

    const first = streamText({ model: routed, prompt: "hi", maxRetries: 0 });
    const firstChunks: string[] = [];
    for await (const chunk of first.textStream) {
      firstChunks.push(chunk);
      now = new Date("2026-09-28T01:00:00Z");
    }
    expect(firstChunks.join("")).toBe("deepseek");
    const second = streamText({ model: routed, prompt: "hi", maxRetries: 0 });
    expect(await second.text).toBe("tokenify");
  });

  it("uses peak official pricing when Tokenify fails over during peak", async () => {
    const down = new MockLanguageModelV3({
      modelId: "tokenify",
      provider: "tokenify",
      doGenerate: async () => {
        throw Object.assign(new Error("overloaded"), { statusCode: 503 });
      },
    });
    const records: CallRecord[] = [];
    const peak = createLCR({
      models: { flash: [
        { model: down, label: "tokenify", cost: DEEPSEEK_PRICES.flash.tokenifyPeak },
        { model: model("deepseek"), label: "deepseek", cost: DEEPSEEK_PRICES.flash.officialPeak },
      ] },
      onCall: (record) => records.push(record),
    });
    const routed = createTimeRoutedModel(() => peak("flash"));
    expect((await generateText({ model: routed, prompt: "hi", maxRetries: 0 })).text).toBe("deepseek");
    expect(records[0]?.attempts).toHaveLength(2);
    expect(records[0]?.winner).toBe("deepseek");
    expect(records[0]?.costUsd).toBe(0.0009);
  });
});
