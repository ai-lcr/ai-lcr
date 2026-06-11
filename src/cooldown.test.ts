import { describe, it, expect } from "vitest";
import { generateText, streamText, simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { createLCR, type CallRecord } from "./index";

function usage(input: number, output: number): LanguageModelV3GenerateResult["usage"] {
  return {
    inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: undefined, reasoning: undefined },
  };
}

// A model whose pass/fail is flipped per test via `state.fail` (false = serve OK,
// a number = throw with that retryable status). Counts how often it's *called* —
// the whole point of the breaker is that a cooling provider is NOT called.
function controllable(id: string) {
  const state = { calls: 0, fail: false as boolean | number };
  const model = new MockLanguageModelV3({
    modelId: id,
    provider: id,
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
      state.calls++;
      if (state.fail) {
        const err = new Error("boom") as Error & { statusCode: number };
        err.statusCode = typeof state.fail === "number" ? state.fail : 503;
        throw err;
      }
      return {
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: usage(10, 5),
        warnings: [],
      };
    },
  });
  return { model, state };
}

// Streaming twin of `controllable`: throws a pre-stream error when `state.fail`
// is set, else emits a one-token stream. Exercises the doStream failover path.
function streamControllable(id: string) {
  const state = { calls: 0, fail: false as boolean | number };
  const model = new MockLanguageModelV3({
    modelId: id,
    provider: id,
    doStream: async () => {
      state.calls++;
      if (state.fail) {
        const err = new Error("boom") as Error & { statusCode: number };
        err.statusCode = typeof state.fail === "number" ? state.fail : 503;
        throw err;
      }
      const chunks: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: id },
        { type: "text-end", id: "0" },
        { type: "finish", usage: usage(10, 5), finishReason: { unified: "stop", raw: undefined } },
      ];
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) };
    },
  });
  return { model, state };
}

const noRetry = { maxRetries: 0 as const };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Small real-time windows keep these tests fast and free of fake-timer hazards.
// resetIntervalMs: 1 forces each request to snap back to the cheapest provider,
// so the ONLY reason a provider goes untried is the cooldown skip — not stickiness.
// windowMs is kept well above any plausible inter-request scheduling delay so a
// loaded CI can't spread two ~10ms-apart failures outside the window (which would
// stop the breaker from tripping). cooldownMs stays small so recovery is fast.
const COOLDOWN = { maxFailures: 2, windowMs: 5000, cooldownMs: 50 };

describe("createLCR — circuit breaker (cooldown)", () => {
  it("skips a provider after it trips, routing straight to the backup", async () => {
    const down = controllable("down");
    down.state.fail = 503;
    const backup = controllable("backup");
    const records: CallRecord[] = [];
    const lcr = createLCR({
      models: { m: [down.model, backup.model] },
      resetIntervalMs: 1,
      cooldown: COOLDOWN,
      onCall: (r) => records.push(r),
    });

    // Two requests, two failures → breaker trips (maxFailures: 2).
    await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });
    await sleep(5);
    await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });
    expect(down.state.calls).toBe(2); // tried-and-failed on both

    // Third request: `down` is cooling → it is SKIPPED entirely.
    await sleep(5);
    await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });
    expect(down.state.calls).toBe(2); // NOT called again
    const last = records[records.length - 1]!;
    expect(last.failedOver).toBe(false);
    expect(last.attempts.map((a) => a.provider)).toEqual(["backup"]);
  });

  it("re-tries the provider once the cooldown elapses", async () => {
    const down = controllable("down");
    down.state.fail = 503;
    const backup = controllable("backup");
    const lcr = createLCR({
      models: { m: [down.model, backup.model] },
      resetIntervalMs: 1,
      cooldown: COOLDOWN,
    });

    await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });
    await sleep(5);
    await generateText({ model: lcr("m"), prompt: "hi", ...noRetry }); // trips here
    expect(down.state.calls).toBe(2);

    // Past the cooldown window → `down` is probed again.
    await sleep(COOLDOWN.cooldownMs + 20);
    await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });
    expect(down.state.calls).toBe(3); // re-probed after recovery
  });

  it("a single success clears the failure count (trips only on sustained failure)", async () => {
    const flaky = controllable("flaky");
    const backup = controllable("backup");
    const lcr = createLCR({
      models: { m: [flaky.model, backup.model] },
      resetIntervalMs: 1,
      cooldown: COOLDOWN,
    });

    flaky.state.fail = 503; // fail #1 (count → 1)
    await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });
    await sleep(5);
    flaky.state.fail = false; // success → count reset to 0
    await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });
    await sleep(5);
    flaky.state.fail = 503; // fail #2, but counter was reset → count → 1, no trip
    await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });

    const callsBefore = flaky.state.calls;
    await sleep(5);
    flaky.state.fail = false;
    await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });
    expect(flaky.state.calls).toBe(callsBefore + 1); // still tried — never cooled
  });

  it("without cooldown, a down provider is re-probed every request (default behavior)", async () => {
    const down = controllable("down");
    down.state.fail = 503;
    const backup = controllable("backup");
    const lcr = createLCR({
      models: { m: [down.model, backup.model] },
      resetIntervalMs: 1,
    });

    for (let i = 0; i < 3; i++) {
      await generateText({ model: lcr("m"), prompt: "hi", ...noRetry });
      await sleep(2);
    }
    expect(down.state.calls).toBe(3); // re-probed every time — no breaker
  });

  it("skips a cooling provider on the streaming path too", async () => {
    const down = streamControllable("down");
    down.state.fail = 503;
    const backup = streamControllable("backup");
    const lcr = createLCR({
      models: { m: [down.model, backup.model] },
      resetIntervalMs: 1,
      cooldown: COOLDOWN,
    });

    const drain = async () => {
      const res = streamText({ model: lcr("m"), prompt: "x", ...noRetry });
      // consume the stream so the request settles
      for await (const _ of res.textStream) void _;
    };

    await drain();
    await sleep(5);
    await drain(); // second failure trips the breaker
    expect(down.state.calls).toBe(2);

    await sleep(5);
    await drain();
    expect(down.state.calls).toBe(2); // cooling → not opened a third time
  });

  it("when every provider is cooling, still attempts rather than failing outright", async () => {
    const a = controllable("a");
    const b = controllable("b");
    a.state.fail = 503;
    b.state.fail = 503;
    const lcr = createLCR({
      models: { m: [a.model, b.model] },
      resetIntervalMs: 1,
      cooldown: { maxFailures: 1, windowMs: 5000, cooldownMs: 1000 }, // trip on first fail
    });

    // First request trips BOTH (each fails once).
    await expect(generateText({ model: lcr("m"), prompt: "hi", ...noRetry })).rejects.toThrow();
    expect(a.state.calls).toBe(1);
    expect(b.state.calls).toBe(1);

    // Both are now cooling, but a request must still try something.
    await sleep(5);
    await expect(generateText({ model: lcr("m"), prompt: "hi", ...noRetry })).rejects.toThrow();
    expect(a.state.calls).toBe(2);
    expect(b.state.calls).toBe(2); // both attempted despite cooling
  });
});
