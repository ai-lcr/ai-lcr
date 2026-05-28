import { describe, it, expect } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createLCR } from "./index";

// ── mock helpers ──────────────────────────────────────────────
// A model that returns `text`, counting how many times it was called.
function okModel(id: string, text: string) {
  const calls = { count: 0 };
  const model = new MockLanguageModelV3({
    modelId: id,
    doGenerate: async () => {
      calls.count++;
      return {
        content: [{ type: "text", text }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  });
  return { model, calls };
}

// A model that always throws. statusCode controls whether ai-fallback treats
// it as retryable (5xx/429/... → switch; 400 → surface immediately).
function failModel(id: string, statusCode: number, message = "boom") {
  const calls = { count: 0 };
  const model = new MockLanguageModelV3({
    modelId: id,
    doGenerate: async () => {
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
      onError: (_e, id) => {
        switchedFrom = id;
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

  it("does NOT fail over on a non-retryable error (400)", async () => {
    const bad = failModel("bad", 400, "bad request");
    const backup = okModel("backup", "should-not-be-reached");
    const lcr = createLCR({ models: { m: [bad.model, backup.model] } });

    await expect(
      generateText({ model: lcr("m"), prompt: "hi", ...noRetry }),
    ).rejects.toThrow();

    expect(bad.calls.count).toBe(1);
    expect(backup.calls.count).toBe(0); // a 400 is the caller's fault — don't waste the fallback
  });

  it("throws for an unknown model name", () => {
    const lcr = createLCR({ models: { m: [okModel("x", "y").model] } });
    expect(() => lcr("nope")).toThrow(/unknown model/);
  });

  it("throws when a model is configured with no providers", () => {
    expect(() => createLCR({ models: { m: [] } })).toThrow(/no providers/);
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
});
