import { describe, it, expect } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { classifyErrorKind } from "./fallback";
import { createLCR, type CallRecord } from "./index";

const noRetry = { maxRetries: 0 as const };

function usage(input: number, output: number): LanguageModelV3GenerateResult["usage"] {
  return {
    inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: undefined, reasoning: undefined },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A model whose behavior is controlled by a live ref, with an optional delay so
// concurrent requests genuinely overlap at the await point.
function controllable(
  id: string,
  behavior: () => "ok" | { status: number },
  delayMs = 0,
) {
  const calls = { count: 0 };
  const model = new MockLanguageModelV3({
    modelId: id,
    provider: id,
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
      calls.count++;
      if (delayMs) await sleep(delayMs);
      const b = behavior();
      if (b === "ok") {
        return {
          content: [{ type: "text", text: id }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: usage(10, 5),
          warnings: [],
        };
      }
      const err = new Error(`boom-${b.status}`) as Error & { statusCode: number };
      err.statusCode = b.status;
      throw err;
    },
  });
  return { model, calls };
}

describe("concurrency isolation (#4 — no shared per-request cursor)", () => {
  it("20 overlapping requests all fail over correctly to the backup", async () => {
    // Primary always 503, with a delay so all 20 requests are in flight at once
    // and would interleave on any shared mutable cursor.
    const primary = controllable("primary", () => ({ status: 503 }), 5);
    const backup = controllable("backup", () => "ok", 5);
    const lcr = createLCR({ models: { m: [primary.model, backup.model] } });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        generateText({ model: lcr("m"), prompt: "hi", ...noRetry }).then((r) => r.text),
      ),
    );

    expect(results).toHaveLength(20);
    expect(results.every((t) => t === "backup")).toBe(true);
    // Every request tried the primary exactly once and then the backup — no
    // request skipped a provider or looped because another mutated the cursor.
    expect(primary.calls.count).toBe(20);
    expect(backup.calls.count).toBe(20);
  });
});

describe("cheap-source re-probe under traffic (#5 — timer measures from failover, not last call)", () => {
  it("re-probes the cheapest provider after the interval despite continuous calls", async () => {
    let primaryHealthy = false;
    const primary = controllable("primary", () => (primaryHealthy ? "ok" : { status: 503 }));
    const backup = controllable("backup", () => "ok");
    const lcr = createLCR({
      models: { m: [primary.model, backup.model] },
      resetIntervalMs: 40,
    });

    // 1) Primary down → fail over to backup, and stay parked on it.
    const r1 = await generateText({ model: lcr("m"), prompt: "x", ...noRetry });
    expect(r1.text).toBe("backup");

    // 2) Primary is healthy again now, but within the window we stay sticky on
    //    the backup (no needless re-probe of a recently-dead provider).
    primaryHealthy = true;
    const r2 = await generateText({ model: lcr("m"), prompt: "x", ...noRetry });
    expect(r2.text).toBe("backup"); // still parked — this call is the "traffic"

    // 3) After the interval, the next request re-probes the cheapest. The bug
    //    was that step 2's call kept pushing the timer forward so this never
    //    happened under load; now it does.
    await sleep(60);
    const r3 = await generateText({ model: lcr("m"), prompt: "x", ...noRetry });
    expect(r3.text).toBe("primary"); // snapped back to the cheap source
  });
});

describe("auth/billing visibility (#6 — failover survives, but is flagged)", () => {
  it("classifyErrorKind separates transient / auth / billing / client", () => {
    expect(classifyErrorKind({ statusCode: 503 })).toBe("transient");
    expect(classifyErrorKind({ statusCode: 429 })).toBe("transient");
    expect(classifyErrorKind({ statusCode: 401 })).toBe("auth");
    expect(classifyErrorKind({ statusCode: 403 })).toBe("auth");
    expect(classifyErrorKind({ statusCode: 402 })).toBe("billing");
    expect(classifyErrorKind(new Error("Insufficient credits"))).toBe("billing");
    expect(classifyErrorKind({ statusCode: 400 })).toBe("client");
    expect(classifyErrorKind(new Error("invalid prompt"))).toBe("client");
  });

  it("a 401 still fails over (request survives) and is recorded as kind 'auth'", async () => {
    const records: CallRecord[] = [];
    const badKey = controllable("misconfigured", () => ({ status: 401 }));
    const backup = controllable("backup", () => "ok");
    const lcr = createLCR({
      models: { m: [badKey.model, backup.model] },
      onCall: (r) => records.push(r),
    });

    const { text } = await generateText({ model: lcr("m"), prompt: "x", ...noRetry });

    expect(text).toBe("backup"); // request did NOT die on the bad key
    expect(records).toHaveLength(1);
    const failed = records[0]!.attempts.find((a) => !a.ok)!;
    expect(failed.provider).toBe("misconfigured");
    expect(failed.kind).toBe("auth"); // the loud signal to alert on
  });
});
