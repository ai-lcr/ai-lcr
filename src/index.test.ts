import { describe, it, expect } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createLCR, isRetryableError, type CostEvent } from "./index";

// ── mock helpers ──────────────────────────────────────────────
function usage(input: number, output: number): LanguageModelV3GenerateResult["usage"] {
  return {
    inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: undefined, reasoning: undefined },
  };
}

// A model that returns `text`, counting calls and reporting token usage.
function okModel(id: string, text: string, tokens = { input: 10, output: 5 }) {
  const calls = { count: 0 };
  const model = new MockLanguageModelV3({
    modelId: id,
    provider: id,
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
      calls.count++;
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: usage(tokens.input, tokens.output),
        warnings: [],
      };
    },
  });
  return { model, calls };
}

// A model that always throws. statusCode controls retryability (5xx/429 → switch).
function failModel(id: string, statusCode: number, message = "boom") {
  const calls = { count: 0 };
  const model = new MockLanguageModelV3({
    modelId: id,
    provider: id,
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
      calls.count++;
      const err = new Error(message) as Error & { statusCode: number };
      err.statusCode = statusCode;
      throw err;
    },
  });
  return { model, calls };
}

// maxRetries: 0 so the AI SDK's own retry loop doesn't muddy call counts —
// we want to exercise ai-lcr's provider switching, nothing else.
const noRetry = { maxRetries: 0 as const };

describe("createLCR — routing & failover (mocked)", () => {
  it("routes to the first (cheapest) provider on success", async () => {
    const cheap = okModel("cheap", "from-cheap");
    const pricey = okModel("pricey", "from-pricey");
    const lcr = createLCR({ models: { m: [cheap.model, pricey.model] } });

    const { text } = await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });

    expect(text).toBe("from-cheap");
    expect(cheap.calls.count).toBe(1);
    expect(pricey.calls.count).toBe(0); // never touched
  });

  it("fails over to the next provider on a retryable error (503)", async () => {
    const down = failModel("cheap-down", 503, "service overloaded");
    const backup = okModel("backup", "recovered");
    let switchedFrom: string | undefined;
    const lcr = createLCR({
      models: { m: [down.model, backup.model] },
      onError: (_e, provider) => {
        switchedFrom = provider;
      },
    });

    const { text } = await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });

    expect(text).toBe("recovered"); // served by the backup
    expect(down.calls.count).toBe(1); // tried first, failed
    expect(backup.calls.count).toBe(1); // took over
    expect(switchedFrom).toBe("cheap-down"); // onError fired for the failed one
  });

  it("walks the whole chain, then throws when every provider fails", async () => {
    const a = failModel("a", 503);
    const b = failModel("b", 429);
    const c = failModel("c", 500);
    const lcr = createLCR({ models: { m: [a.model, b.model, c.model] } });

    await expect(
      generateText({ model: lcr("m"), prompt: "hi", ...noRetry }),
    ).rejects.toThrow();

    expect(a.calls.count).toBe(1);
    expect(b.calls.count).toBe(1);
    expect(c.calls.count).toBe(1);
  });

  it("fails over on a provider 400 — the next provider may accept the request", async () => {
    // In the OpenAI-compatible aggregator world a 400 is usually "THIS provider
    // won't take this request" (unsupported param / unlisted model / stricter
    // schema), not a universally-broken request — so try the next one.
    const bad = failModel("bad", 400, "bad request");
    const backup = okModel("backup", "recovered");
    const lcr = createLCR({ models: { m: [bad.model, backup.model] } });

    const { text } = await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });

    expect(text).toBe("recovered");
    expect(bad.calls.count).toBe(1); // tried first, 400'd
    expect(backup.calls.count).toBe(1); // failed over and served
  });

  it("when every provider 400s, throws the FIRST (original) error", async () => {
    const a = failModel("a", 400, "first-error");
    const b = failModel("b", 400, "second-error");
    const lcr = createLCR({ models: { m: [a.model, b.model] } });

    // A genuinely-bad request that no provider accepts still fails — surfacing
    // the original reason, not whatever the last fallback happened to say.
    await expect(
      generateText({ model: lcr("m"), prompt: "hi", ...noRetry }),
    ).rejects.toThrow("first-error");

    expect(a.calls.count).toBe(1);
    expect(b.calls.count).toBe(1);
  });

  it("does NOT fail over on a deliberate caller cancellation (AbortError)", async () => {
    const calls = { count: 0 };
    const aborter = new MockLanguageModelV3({
      modelId: "aborter",
      provider: "aborter",
      doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
        calls.count++;
        throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      },
    });
    const backup = okModel("backup", "should-not-be-reached");
    const lcr = createLCR({ models: { m: [aborter, backup.model] } });

    await expect(
      generateText({ model: lcr("m"), prompt: "hi", ...noRetry }),
    ).rejects.toThrow();

    expect(calls.count).toBe(1);
    expect(backup.calls.count).toBe(0); // a cancel must not be re-issued elsewhere
  });

  it("honors a custom shouldRetry that opts back into strict 400 fail-fast", async () => {
    const bad = failModel("bad", 400, "bad request");
    const backup = okModel("backup", "should-not-be-reached");
    const lcr = createLCR({
      models: { m: [bad.model, backup.model] },
      shouldRetry: isRetryableError, // restore "client errors fail fast"
    });

    await expect(
      generateText({ model: lcr("m"), prompt: "hi", ...noRetry }),
    ).rejects.toThrow();

    expect(bad.calls.count).toBe(1);
    expect(backup.calls.count).toBe(0); // strict mode: a 400 does not fail over
  });

  it("throws for an unknown model name", () => {
    const lcr = createLCR({ models: { m: [okModel("x", "y").model] } });
    expect(() => lcr("nope")).toThrow(/unknown model/);
  });

  it("throws when a model is configured with no providers", () => {
    expect(() => createLCR({ models: { m: [] } })).toThrow(/no providers/);
  });
});

describe("createLCR — cost accounting", () => {
  it("fires onCost with the serving provider and computed USD", async () => {
    const a = okModel("a", "ok", { input: 1000, output: 500 });
    const events: CostEvent[] = [];
    const lcr = createLCR({
      models: {
        m: [{ model: a.model, label: "kunavo", cost: { input: 1, output: 2 } }],
      },
      onCost: (e) => events.push(e),
    });

    await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });

    expect(events).toHaveLength(1);
    expect(events[0]!.provider).toBe("kunavo");
    expect(events[0]!.inputTokens).toBe(1000);
    expect(events[0]!.outputTokens).toBe(500);
    // 1000/1e6 * $1 + 500/1e6 * $2 = 0.001 + 0.001 = 0.002
    expect(events[0]!.costUsd).toBeCloseTo(0.002, 6);
  });

  it("reports the provider that actually served after a failover", async () => {
    const down = failModel("down", 503);
    const backup = okModel("backup", "recovered", { input: 100, output: 100 });
    const events: CostEvent[] = [];
    const lcr = createLCR({
      models: {
        m: [
          { model: down.model, label: "cheap-but-down", cost: { input: 1, output: 1 } },
          { model: backup.model, label: "backup", cost: { input: 5, output: 5 } },
        ],
      },
      onCost: (e) => events.push(e),
    });

    await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });

    expect(events).toHaveLength(1);
    expect(events[0]!.provider).toBe("backup"); // not the failed one
    // 100/1e6 * 5 + 100/1e6 * 5 = 0.0005 + 0.0005 = 0.001
    expect(events[0]!.costUsd).toBeCloseTo(0.001, 6);
  });
});

describe("createLCR — autoSort", () => {
  it("orders providers cheapest-first by cost regardless of input order", async () => {
    const cheap = okModel("cheap", "from-cheap");
    const pricey = okModel("pricey", "from-pricey");
    const lcr = createLCR({
      autoSort: true,
      models: {
        m: [
          { model: pricey.model, label: "pricey", cost: { input: 10, output: 10 } }, // listed first
          { model: cheap.model, label: "cheap", cost: { input: 1, output: 1 } }, // but cheaper
        ],
      },
    });

    const { text } = await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });

    expect(text).toBe("from-cheap"); // cheapest served, despite being listed second
    expect(cheap.calls.count).toBe(1);
    expect(pricey.calls.count).toBe(0);
  });
});

// ── live integration (Kunavo) ─────────────────────────────────
// Skipped unless KUNAVO_API_KEY is present in the environment.
const KUNAVO_API_KEY = process.env.KUNAVO_API_KEY;

describe.skipIf(!KUNAVO_API_KEY)("Kunavo (live)", () => {
  const kunavo = createOpenAICompatible({
    name: "kunavo",
    baseURL: "https://api.kunavo.com/v1",
    apiKey: KUNAVO_API_KEY!,
  });

  it("routes a real request to Kunavo gemini-3-flash", async () => {
    const lcr = createLCR({ models: { "gemini-3-flash": [kunavo("gemini-3-flash")] } });
    const { text } = await generateText({
      model: lcr("gemini-3-flash"),
      prompt: "Reply with exactly one word: pong",
      ...noRetry,
    });
    expect(text.trim().length).toBeGreaterThan(0);
  }, 30_000);

  it("fails over from a broken provider to Kunavo (real 401 → recover)", async () => {
    const broken = createOpenAICompatible({
      name: "broken",
      baseURL: "https://api.kunavo.com/v1",
      apiKey: "sk-kn-invalid-key-to-force-failover",
    });
    let switched = false;
    const lcr = createLCR({
      models: {
        "gemini-3-flash": [broken("gemini-3-flash"), kunavo("gemini-3-flash")],
      },
      onError: () => {
        switched = true;
      },
    });

    const { text } = await generateText({
      model: lcr("gemini-3-flash"),
      prompt: "Reply with exactly one word: pong",
      ...noRetry,
    });

    expect(switched).toBe(true); // the broken provider errored and we moved on
    expect(text.trim().length).toBeGreaterThan(0); // Kunavo served it
  }, 30_000);

  it("reports real cost from Kunavo via onCost", async () => {
    const events: CostEvent[] = [];
    const lcr = createLCR({
      models: {
        "gemini-3-flash": [
          { model: kunavo("gemini-3-flash"), label: "kunavo", cost: { input: 0.35, output: 2.1 } },
        ],
      },
      onCost: (e) => events.push(e),
    });

    await generateText({
      model: lcr("gemini-3-flash"),
      prompt: "Reply with exactly one word: pong",
      ...noRetry,
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.provider).toBe("kunavo");
    expect(events[0]!.inputTokens).toBeGreaterThan(0);
    expect(events[0]!.costUsd).toBeGreaterThan(0);
  }, 30_000);
});
