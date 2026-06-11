import { describe, it, expect } from "vitest";
import { generateText, streamText, simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { createLCR } from "./index";
import { withPromptCacheBreakpoint, resolvePromptCache } from "./prompt-cache";

function usage(input: number, output: number): LanguageModelV3GenerateResult["usage"] {
  return {
    inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: undefined, reasoning: undefined },
  };
}

// A model that records the options it was called with, so a test can assert on
// the prompt ai-lcr actually forwarded (with or without a cache breakpoint).
function recording(id: string) {
  const seen: { options?: LanguageModelV3CallOptions } = {};
  const model = new MockLanguageModelV3({
    modelId: id,
    provider: id,
    doGenerate: async (options): Promise<LanguageModelV3GenerateResult> => {
      seen.options = options;
      return {
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: usage(10, 5),
        warnings: [],
      };
    },
    doStream: async (options) => {
      seen.options = options;
      const chunks: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: "ok" },
        { type: "text-end", id: "0" },
        { type: "finish", usage: usage(10, 5), finishReason: { unified: "stop", raw: undefined } },
      ];
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) };
    },
  });
  return { model, seen };
}

const noRetry = { maxRetries: 0 as const };

function cacheControlOf(message: { providerOptions?: Record<string, Record<string, unknown>> }) {
  return message.providerOptions?.anthropic?.cacheControl;
}

describe("createLCR — automatic prompt-cache breakpoint", () => {
  it("marks the last system message when promptCache is on", async () => {
    const r = recording("p");
    const lcr = createLCR({ models: { m: [r.model] }, promptCache: true });
    await generateText({ model: lcr("m"), system: "you are helpful", prompt: "hi", ...noRetry });

    const prompt = r.seen.options!.prompt;
    const system = prompt.find((msg) => msg.role === "system")!;
    expect(cacheControlOf(system)).toEqual({ type: "ephemeral" });
  });

  it("uses the 1h ttl when configured", async () => {
    const r = recording("p");
    const lcr = createLCR({ models: { m: [r.model] }, promptCache: { ttl: "1h" } });
    await generateText({ model: lcr("m"), system: "sys", prompt: "hi", ...noRetry });

    const system = r.seen.options!.prompt.find((msg) => msg.role === "system")!;
    expect(cacheControlOf(system)).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("does nothing when promptCache is off (default)", async () => {
    const r = recording("p");
    const lcr = createLCR({ models: { m: [r.model] } });
    await generateText({ model: lcr("m"), system: "sys", prompt: "hi", ...noRetry });

    const system = r.seen.options!.prompt.find((msg) => msg.role === "system")!;
    expect(cacheControlOf(system)).toBeUndefined();
  });

  it("also injects on the streaming path", async () => {
    const r = recording("p");
    const lcr = createLCR({ models: { m: [r.model] }, promptCache: true });
    const res = streamText({ model: lcr("m"), system: "sys", prompt: "hi", ...noRetry });
    for await (const _ of res.textStream) void _;

    const system = r.seen.options!.prompt.find((msg) => msg.role === "system")!;
    expect(cacheControlOf(system)).toEqual({ type: "ephemeral" });
  });
});

describe("withPromptCacheBreakpoint", () => {
  const cfg = resolvePromptCache(true)!;

  const sys = (text: string) =>
    ({ role: "system" as const, content: text }) as LanguageModelV3CallOptions["prompt"][number];
  const user = (text: string) =>
    ({
      role: "user" as const,
      content: [{ type: "text" as const, text }],
    }) as LanguageModelV3CallOptions["prompt"][number];
  const opts = (prompt: LanguageModelV3CallOptions["prompt"]) =>
    ({ prompt }) as LanguageModelV3CallOptions;

  it("targets the LAST system message", () => {
    const out = withPromptCacheBreakpoint(opts([sys("a"), sys("b"), user("q")]), cfg);
    expect(cacheControlOf(out.prompt[0]!)).toBeUndefined();
    expect(cacheControlOf(out.prompt[1]!)).toEqual({ type: "ephemeral" });
  });

  it("leaves a prompt with no system message untouched", () => {
    const input = opts([user("q")]);
    expect(withPromptCacheBreakpoint(input, cfg)).toBe(input);
  });

  it("steps aside when the caller already set cacheControl", () => {
    const marked = {
      role: "system" as const,
      content: "x",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
    } as unknown as LanguageModelV3CallOptions["prompt"][number];
    const input = opts([marked, user("q")]);
    expect(withPromptCacheBreakpoint(input, cfg)).toBe(input);
  });

  it("does not mutate the caller's prompt", () => {
    const original = sys("a");
    const input = opts([original, user("q")]);
    withPromptCacheBreakpoint(input, cfg);
    expect(cacheControlOf(original)).toBeUndefined();
  });
});
