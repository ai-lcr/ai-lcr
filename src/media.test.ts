import { describe, it, expect, vi } from "vitest";
import {
  normalizedCents,
  referenceMegapixels,
  rankRoutes,
  cheapestRoute,
  comparePrices,
  createMediaLCR,
  DEFAULT_REFERENCE,
  billableUnits,
  priceCents,
  durationFromInput,
  type MediaModelDef,
  type MediaRegistry,
  type MediaAdapter,
  type MediaStatusResult,
} from "./media";
import { MEDIA_PRICING } from "./media-registry";

describe("normalizedCents", () => {
  it("passes per-image and per-call prices through unchanged", () => {
    expect(normalizedCents({ unit: "image", cents: 4.69 })).toBe(4.69);
    expect(normalizedCents({ unit: "call", cents: 32 })).toBe(32);
  });

  it("scales per-second prices by the reference clip length", () => {
    // 40¢/s × 5s default = 200¢
    expect(normalizedCents({ unit: "second", cents: 40 })).toBe(200);
  });

  it("scales per-megapixel prices by the reference image megapixels", () => {
    const mp = referenceMegapixels(DEFAULT_REFERENCE); // 1920*1080/1e6 ≈ 2.0736
    expect(mp).toBeCloseTo(2.0736, 4);
    expect(normalizedCents({ unit: "megapixel", cents: 10 })).toBeCloseTo(20.736, 3);
  });

  it("respects a custom reference spec", () => {
    const ref = { image: { width: 1024, height: 1024 }, videoSeconds: 8 };
    expect(normalizedCents({ unit: "second", cents: 8 }, ref)).toBe(64);
    expect(normalizedCents({ unit: "megapixel", cents: 10 }, ref)).toBeCloseTo(
      10 * (1024 * 1024) / 1_000_000,
      3,
    );
  });
});

describe("rankRoutes / cheapestRoute", () => {
  const nb2 = MEDIA_PRICING["google/nano-banana-2"]!;

  it("orders routes cheapest reference-cost first", () => {
    const ranked = rankRoutes(nb2);
    expect(ranked.map((r) => r.provider)).toEqual(["kunavo", "runware", "fal"]);
    expect(ranked[0]!.refCents).toBe(4.69);
  });

  it("cheapestRoute returns the single best route", () => {
    expect(cheapestRoute(nb2).provider).toBe("kunavo");
  });

  it("throws for a model with no routes", () => {
    const empty: MediaModelDef = { id: "x", modality: "image", routes: [] };
    expect(() => cheapestRoute(empty)).toThrow(/no routes/);
  });

  it("a per-call video price can beat a per-second one at the reference length", () => {
    const veo = MEDIA_PRICING["google/veo-3"]!;
    // kunavo flat 32¢ vs fal 40¢/s × 5s = 200¢
    expect(cheapestRoute(veo).provider).toBe("kunavo");
  });
});

describe("comparePrices", () => {
  it("produces one row per model with the cheapest provider flagged", () => {
    const rows = comparePrices(MEDIA_PRICING);
    expect(rows).toHaveLength(Object.keys(MEDIA_PRICING).length);
    const byId = Object.fromEntries(rows.map((r) => [r.modelId, r]));
    expect(byId["google/nano-banana-2"]!.cheapest.provider).toBe("kunavo");
    expect(byId["google/nano-banana-pro"]!.cheapest.provider).toBe("kunavo");
    expect(byId["openai/gpt-image-2"]!.cheapest.provider).toBe("kunavo");
  });

  it("carries notes through for SKU caveats", () => {
    const rows = comparePrices(MEDIA_PRICING);
    const veo = rows.find((r) => r.modelId === "google/veo-3")!;
    const fal = veo.routes.find((r) => r.provider === "fal")!;
    expect(fal.note).toMatch(/veo3\.1/);
  });
});

describe("createMediaLCR routing", () => {
  const registry: MediaRegistry = {
    "x/img": {
      id: "x/img",
      modality: "image",
      routes: [
        { provider: "cheap", externalId: "c", pricing: { unit: "image", cents: 2 } },
        { provider: "pricey", externalId: "p", pricing: { unit: "image", cents: 9 } },
      ],
    },
  };

  const okAdapter = (provider: string): MediaAdapter => ({
    provider,
    run: vi.fn(async () => ({ outputs: [{ url: `https://x/${provider}.png`, type: "image" as const }] })),
  });

  it("routes to the cheapest provider and estimates cost from the ref price", async () => {
    const onCost = vi.fn();
    const generate = createMediaLCR({
      registry,
      adapters: { cheap: okAdapter("cheap"), pricey: okAdapter("pricey") },
      onCost,
    });
    const result = await generate("x/img", { prompt: "hi" });
    expect(result.provider).toBe("cheap");
    expect(result.costCents).toBe(2);
    expect(result.estimated).toBe(true);
    expect(onCost).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "cheap", estimated: true }),
    );
  });

  it("uses the provider-reported cost when present", async () => {
    const generate = createMediaLCR({
      registry,
      adapters: {
        cheap: {
          provider: "cheap",
          run: async () => ({
            outputs: [{ url: "https://x/c.png", type: "image" }],
            costCents: 1.5,
          }),
        },
        pricey: okAdapter("pricey"),
      },
    });
    const result = await generate("x/img", { prompt: "hi" });
    expect(result.estimated).toBe(false);
    expect(result.costCents).toBe(1.5);
  });

  it("falls through to the next provider on a retryable error", async () => {
    const onError = vi.fn();
    const generate = createMediaLCR({
      registry,
      adapters: {
        cheap: {
          provider: "cheap",
          run: async () => {
            throw Object.assign(new Error("rate limited"), { status: 429 });
          },
        },
        pricey: okAdapter("pricey"),
      },
      onError,
    });
    const result = await generate("x/img", { prompt: "hi" });
    expect(result.provider).toBe("pricey");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("falls through when the cheapest provider is unreachable (network error)", async () => {
    const generate = createMediaLCR({
      registry,
      adapters: {
        cheap: {
          provider: "cheap",
          run: async () => {
            // No HTTP status — the provider's fetch died at the transport layer.
            throw Object.assign(new TypeError("fetch failed"), {
              cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
                code: "ECONNREFUSED",
              }),
            });
          },
        },
        pricey: okAdapter("pricey"),
      },
    });
    const result = await generate("x/img", { prompt: "hi" });
    expect(result.provider).toBe("pricey");
  });

  it("does not let a throwing observer turn a success into a failure", async () => {
    const generate = createMediaLCR({
      registry,
      adapters: { cheap: okAdapter("cheap"), pricey: okAdapter("pricey") },
      onCall: () => {
        throw new Error("logging sink is down");
      },
      onCost: () => {
        throw new Error("metrics sink is down");
      },
    });
    const result = await generate("x/img", { prompt: "hi" });
    expect(result.provider).toBe("cheap");
  });

  it("does NOT fall through on a non-retryable (caller) error", async () => {
    const generate = createMediaLCR({
      registry,
      adapters: {
        cheap: {
          provider: "cheap",
          run: async () => {
            throw Object.assign(new Error("bad prompt"), { status: 400 });
          },
        },
        pricey: okAdapter("pricey"),
      },
    });
    await expect(generate("x/img", { prompt: "" })).rejects.toThrow(/bad prompt/);
  });

  it("skips providers with no wired adapter", async () => {
    const generate = createMediaLCR({
      registry,
      adapters: { pricey: okAdapter("pricey") }, // no "cheap" adapter
    });
    const result = await generate("x/img", { prompt: "hi" });
    expect(result.provider).toBe("pricey");
  });

  it("throws for an unknown model", async () => {
    const generate = createMediaLCR({ registry, adapters: {} });
    await expect(generate("nope", {})).rejects.toThrow(/unknown media model/);
  });

  it("fires onCall with one correlated record on success", async () => {
    const onCall = vi.fn();
    const generate = createMediaLCR({
      registry,
      adapters: { cheap: okAdapter("cheap"), pricey: okAdapter("pricey") },
      onCall,
    });
    await generate("x/img", { prompt: "hi" });
    expect(onCall).toHaveBeenCalledOnce();
    const rec = onCall.mock.calls[0]![0];
    expect(rec).toMatchObject({
      model: "x/img",
      winner: "cheap",
      ok: true,
      failedOver: false,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(rec.costUsd).toBeCloseTo(0.02, 6); // cheapest 2¢ -> $0.02
    expect(rec.baselineUsd).toBeCloseTo(0.09, 6); // priciest 9¢ -> $0.09 (savings story)
    expect(rec.attempts).toEqual([
      expect.objectContaining({ provider: "cheap", ok: true }),
    ]);
    expect(typeof rec.id).toBe("string");
  });

  it("onCall captures the full failover chain (failedOver=true)", async () => {
    const onCall = vi.fn();
    const generate = createMediaLCR({
      registry,
      adapters: {
        cheap: {
          provider: "cheap",
          run: async () => {
            throw Object.assign(new Error("rate limited"), { status: 429 });
          },
        },
        pricey: okAdapter("pricey"),
      },
      onCall,
    });
    await generate("x/img", { prompt: "hi" });
    const rec = onCall.mock.calls[0]![0];
    expect(rec.ok).toBe(true);
    expect(rec.winner).toBe("pricey");
    expect(rec.failedOver).toBe(true);
    expect(
      rec.attempts.map((a: { provider: string; ok: boolean }) => [a.provider, a.ok]),
    ).toEqual([
      ["cheap", false],
      ["pricey", true],
    ]);
    expect(rec.attempts[0].errorClass).toBeTruthy();
  });

  it("baselines against an inline official price (the go-direct cost), not the priciest route", async () => {
    const onCall = vi.fn();
    const generate = createMediaLCR({
      registry: {
        "x/img": {
          ...registry["x/img"]!,
          official: { unit: "image", cents: 20 }, // direct price 20¢ ≫ priciest route 9¢
        },
      },
      adapters: { cheap: okAdapter("cheap"), pricey: okAdapter("pricey") },
      onCall,
    });
    await generate("x/img", { prompt: "hi" });
    const rec = onCall.mock.calls[0]![0];
    expect(rec.costUsd).toBeCloseTo(0.02, 6); // served by cheapest, 2¢
    expect(rec.baselineUsd).toBeCloseTo(0.2, 6); // savings vs official 20¢, not 9¢
  });

  it("baselines from the officialPrices map when the def carries no inline price", async () => {
    const onCall = vi.fn();
    const generate = createMediaLCR({
      registry,
      adapters: { cheap: okAdapter("cheap"), pricey: okAdapter("pricey") },
      officialPrices: { "x/img": { unit: "image", cents: 15 } },
      onCall,
    });
    await generate("x/img", { prompt: "hi" });
    expect(onCall.mock.calls[0]![0].baselineUsd).toBeCloseTo(0.15, 6);
  });
});

describe("createMediaLCR async (submit / poll)", () => {
  // Two-provider video model: cheap per-call 30¢, pricey per-second 40¢×5s=200¢.
  const registry: MediaRegistry = {
    "x/vid": {
      id: "x/vid",
      modality: "video",
      official: { unit: "call", cents: 300 },
      routes: [
        { provider: "cheap", externalId: "c-vid", pricing: { unit: "call", cents: 30 } },
        { provider: "pricey", externalId: "p-vid", pricing: { unit: "second", cents: 40 } },
      ],
    },
  };

  /**
   * A scriptable async adapter. `statuses` is the sequence checkStatus walks
   * through (one per poll); `onSubmit` lets a test make submit throw. The sync
   * `run` is present but unused by these tests.
   */
  function asyncAdapter(
    provider: string,
    statuses: MediaStatusResult[],
    opts: { submit?: () => void } = {},
  ): MediaAdapter & { submitCount: () => number } {
    let i = 0;
    let submits = 0;
    return {
      provider,
      run: vi.fn(async () => ({ outputs: [{ url: `https://x/${provider}.mp4`, type: "video" as const }] })),
      submit: vi.fn(async () => {
        submits++;
        opts.submit?.();
        return { requestId: `${provider}-req-${submits}` };
      }),
      checkStatus: vi.fn(async () => statuses[Math.min(i++, statuses.length - 1)]!),
      submitCount: () => submits,
    };
  }

  type Status = MediaStatusResult;
  const done = (units?: number, costCents?: number): Status => ({
    status: "done",
    outputs: [{ url: "https://x/out.mp4", type: "video" }],
    ...(units !== undefined ? { units } : {}),
    ...(costCents !== undefined ? { costCents } : {}),
  });

  it("submit routes to the cheapest async-capable provider and returns a handle", async () => {
    const lcr = createMediaLCR({
      registry,
      adapters: { cheap: asyncAdapter("cheap", [done()]), pricey: asyncAdapter("pricey", [done()]) },
    });
    const handle = await lcr.submit("x/vid", { prompt: "hi" });
    expect(handle.provider).toBe("cheap");
    expect(handle.requestId).toBe("cheap-req-1");
    expect(handle.fallbacks.map((f) => f.provider)).toEqual(["pricey"]);
    expect(handle.input).toEqual({ prompt: "hi" });
  });

  it("submit does NOT emit a CallRecord (telemetry lands at the terminal poll)", async () => {
    const onCall = vi.fn();
    const lcr = createMediaLCR({
      registry,
      adapters: { cheap: asyncAdapter("cheap", [done()]), pricey: asyncAdapter("pricey", [done()]) },
      onCall,
    });
    await lcr.submit("x/vid", { prompt: "hi" });
    expect(onCall).not.toHaveBeenCalled();
  });

  it("poll returns pending while queued/running, then done with outputs + cost", async () => {
    const onCall = vi.fn();
    const onCost = vi.fn();
    const lcr = createMediaLCR({
      registry,
      adapters: {
        cheap: asyncAdapter("cheap", [{ status: "queued" }, { status: "running" }, done()]),
        pricey: asyncAdapter("pricey", [done()]),
      },
      onCall,
      onCost,
    });
    let handle = await lcr.submit("x/vid", { prompt: "hi" });
    let r = await lcr.poll(handle);
    expect(r.done).toBe(false);
    if (!r.done) {
      expect(r.status).toBe("queued");
      handle = r.handle;
    }
    r = await lcr.poll(handle);
    expect(r.done).toBe(false);
    r = await lcr.poll(handle);
    expect(r.done).toBe(true);
    if (r.done) {
      expect(r.provider).toBe("cheap");
      expect(r.outputs).toHaveLength(1);
      expect(r.estimated).toBe(true);
      expect(r.costCents).toBe(30); // per-call ref price, estimated
    }
    expect(onCall).toHaveBeenCalledOnce();
    const rec = onCall.mock.calls[0]![0];
    expect(rec).toMatchObject({ model: "x/vid", winner: "cheap", ok: true, failedOver: false });
    expect(rec.costUsd).toBeCloseTo(0.3, 6);
    expect(rec.baselineUsd).toBeCloseTo(3, 6); // official 300¢ → $3
    expect(onCost).toHaveBeenCalledWith(expect.objectContaining({ provider: "cheap", estimated: true }));
  });

  it("estimates a per-call video clip at the FLAT ref price, not × duration", async () => {
    // Regression guard: refCents is normalized to ONE reference clip and `units`
    // means output count. An adapter returning seconds-as-units would multiply a
    // flat per-call price by the clip length (an 8× overcharge for an 8s clip).
    const onCost = vi.fn();
    const lcr = createMediaLCR({
      registry: {
        "x/clip": {
          id: "x/clip",
          modality: "video",
          routes: [{ provider: "cheap", externalId: "c-vid", pricing: { unit: "call", cents: 16 } }],
        },
      },
      adapters: { cheap: asyncAdapter("cheap", [done()]) }, // done() carries NO units
      onCost,
    });
    const handle = await lcr.submit("x/clip", { prompt: "a wave" });
    const r = await lcr.poll(handle);
    expect(r.done).toBe(true);
    if (r.done) expect(r.costCents).toBe(16); // flat — NOT 16 × seconds
    expect(onCost).toHaveBeenCalledWith(expect.objectContaining({ costCents: 16 }));
  });

  it("uses provider-reported cost + units when checkStatus returns them", async () => {
    const lcr = createMediaLCR({
      registry,
      adapters: {
        cheap: asyncAdapter("cheap", [done(8, 12.5)]),
        pricey: asyncAdapter("pricey", [done()]),
      },
    });
    const handle = await lcr.submit("x/vid", { prompt: "hi" });
    const r = await lcr.poll(handle);
    expect(r.done).toBe(true);
    if (r.done) {
      expect(r.estimated).toBe(false);
      expect(r.costCents).toBe(12.5);
    }
  });

  it("re-submits to the next provider when a job fails mid-poll (failover)", async () => {
    const onCall = vi.fn();
    const cheap = asyncAdapter("cheap", [{ status: "running" }, { status: "error", error: "model crashed" }]);
    const pricey = asyncAdapter("pricey", [done()]);
    const lcr = createMediaLCR({ registry, adapters: { cheap, pricey }, onCall });

    let handle = await lcr.submit("x/vid", { prompt: "hi" });
    let r = await lcr.poll(handle); // running
    if (!r.done) handle = r.handle;
    r = await lcr.poll(handle); // cheap errors → re-submit to pricey
    expect(r.done).toBe(false);
    if (!r.done) {
      expect(r.failedOver).toBe(true);
      expect(r.handle.provider).toBe("pricey");
      handle = r.handle;
    }
    expect(pricey.submitCount()).toBe(1);
    expect(onCall).not.toHaveBeenCalled(); // not terminal yet
    r = await lcr.poll(handle); // pricey done
    expect(r.done).toBe(true);
    if (r.done) expect(r.provider).toBe("pricey");
    const rec = onCall.mock.calls[0]![0];
    expect(rec.ok).toBe(true);
    expect(rec.winner).toBe("pricey");
    expect(rec.failedOver).toBe(true);
    expect(rec.attempts.map((a: { provider: string; ok: boolean }) => [a.provider, a.ok])).toEqual([
      ["cheap", false],
      ["pricey", true],
    ]);
  });

  it("fails over on a thrown retryable poll error (e.g. a 504 timeout remap)", async () => {
    const cheap: MediaAdapter = {
      provider: "cheap",
      run: vi.fn(),
      submit: vi.fn(async () => ({ requestId: "c1" })),
      checkStatus: vi.fn(async () => {
        throw Object.assign(new Error("gateway timeout"), { status: 504 });
      }),
    };
    const pricey = asyncAdapter("pricey", [done()]);
    const lcr = createMediaLCR({ registry, adapters: { cheap, pricey } });
    let handle = await lcr.submit("x/vid", { prompt: "hi" });
    let r = await lcr.poll(handle);
    expect(r.done).toBe(false);
    if (!r.done) {
      expect(r.failedOver).toBe(true);
      handle = r.handle;
    }
    r = await lcr.poll(handle);
    expect(r.done).toBe(true);
    if (r.done) expect(r.provider).toBe("pricey");
  });

  it("settles a fail record and throws when poll exhausts every provider", async () => {
    const onCall = vi.fn();
    const lcr = createMediaLCR({
      registry,
      adapters: {
        cheap: asyncAdapter("cheap", [{ status: "error", error: "boom" }]),
        pricey: asyncAdapter("pricey", [{ status: "error", error: "boom2" }]),
      },
      onCall,
    });
    const handle = await lcr.submit("x/vid", { prompt: "hi" });
    const r1 = await lcr.poll(handle); // cheap errors → re-submit pricey
    expect(r1.done).toBe(false);
    await expect(lcr.poll((r1 as { handle: typeof handle }).handle)).rejects.toThrow(/boom2/);
    const rec = onCall.mock.calls.at(-1)![0];
    expect(rec.ok).toBe(false);
    expect(rec.winner).toBeUndefined();
    expect(rec.failedOver).toBe(true);
  });

  it("the handle survives a JSON round-trip (cross-process submit→poll)", async () => {
    const lcr = createMediaLCR({
      registry,
      adapters: { cheap: asyncAdapter("cheap", [done()]), pricey: asyncAdapter("pricey", [done()]) },
    });
    const handle = await lcr.submit("x/vid", { prompt: "hi" });
    const rehydrated = JSON.parse(JSON.stringify(handle));
    const r = await lcr.poll(rehydrated);
    expect(r.done).toBe(true);
    if (r.done) expect(r.provider).toBe("cheap");
  });

  it("submit skips providers without an async adapter, using the next that has submit", async () => {
    const lcr = createMediaLCR({
      registry,
      adapters: {
        cheap: okAdapterSyncOnly("cheap"), // sync only — no submit
        pricey: asyncAdapter("pricey", [done()]),
      },
    });
    const handle = await lcr.submit("x/vid", { prompt: "hi" });
    expect(handle.provider).toBe("pricey");
    expect(handle.fallbacks).toHaveLength(0);
  });

  it("submit throws when no provider supports async at all", async () => {
    const lcr = createMediaLCR({
      registry,
      adapters: { cheap: okAdapterSyncOnly("cheap"), pricey: okAdapterSyncOnly("pricey") },
    });
    await expect(lcr.submit("x/vid", { prompt: "hi" })).rejects.toThrow(/no provider .* supports async/);
  });

  it("submit fails over on a retryable submit error and records the failed leg", async () => {
    const onCall = vi.fn();
    const cheap = asyncAdapter("cheap", [done()], {
      submit: () => {
        throw Object.assign(new Error("overloaded"), { status: 429 });
      },
    });
    const pricey = asyncAdapter("pricey", [done()]);
    const lcr = createMediaLCR({ registry, adapters: { cheap, pricey }, onCall });
    const handle = await lcr.submit("x/vid", { prompt: "hi" });
    expect(handle.provider).toBe("pricey");
    expect(handle.attempts).toEqual([
      expect.objectContaining({ provider: "cheap", ok: false }),
    ]);
    expect(onCall).not.toHaveBeenCalled(); // still not terminal
  });

  it("submit emits a fail record + throws when every provider rejects the submit", async () => {
    const onCall = vi.fn();
    const boom = () => {
      throw Object.assign(new Error("overloaded"), { status: 429 });
    };
    const lcr = createMediaLCR({
      registry,
      adapters: {
        cheap: asyncAdapter("cheap", [done()], { submit: boom }),
        pricey: asyncAdapter("pricey", [done()], { submit: boom }),
      },
      onCall,
    });
    await expect(lcr.submit("x/vid", { prompt: "hi" })).rejects.toThrow(/overloaded/);
    const rec = onCall.mock.calls[0]![0];
    expect(rec.ok).toBe(false);
    expect(rec.failedOver).toBe(true);
    expect(rec.attempts).toHaveLength(2);
  });

  it("does not fail over on a non-retryable submit error (caller bug)", async () => {
    const onCall = vi.fn();
    const cheap = asyncAdapter("cheap", [done()], {
      submit: () => {
        throw Object.assign(new Error("bad prompt"), { status: 400 });
      },
    });
    const pricey = asyncAdapter("pricey", [done()]);
    const lcr = createMediaLCR({ registry, adapters: { cheap, pricey }, onCall });
    await expect(lcr.submit("x/vid", { prompt: "" })).rejects.toThrow(/bad prompt/);
    expect(pricey.submitCount()).toBe(0); // never tried the fallback
  });

  it("poll throws a clear error when the serving provider has no checkStatus", async () => {
    const lcr = createMediaLCR({
      registry,
      adapters: { cheap: asyncAdapter("cheap", [done()]), pricey: asyncAdapter("pricey", [done()]) },
    });
    const handle = await lcr.submit("x/vid", { prompt: "hi" });
    // Re-poll through a router whose adapter lacks checkStatus.
    const lcr2 = createMediaLCR({
      registry,
      adapters: {
        cheap: { provider: "cheap", run: vi.fn(), submit: vi.fn(async () => ({ requestId: "x" })) },
        pricey: asyncAdapter("pricey", [done()]),
      },
    });
    await expect(lcr2.poll(handle)).rejects.toThrow(/no checkStatus/);
  });
});

/** A media adapter that only serves the sync `run` path (no submit/checkStatus). */
function okAdapterSyncOnly(provider: string): MediaAdapter {
  return {
    provider,
    run: vi.fn(async () => ({ outputs: [{ url: `https://x/${provider}.mp4`, type: "video" as const }] })),
  };
}

// ── Settle-time billing v2: actual usage, not the reference ──────────────────
describe("billableUnits / priceCents / durationFromInput", () => {
  it("per-second pricing bills usage.seconds, then input.duration, then the reference", () => {
    const pricing = { unit: "second" as const, cents: 40 };
    expect(priceCents(pricing, { usage: { seconds: 8 } })).toBe(320);
    expect(priceCents(pricing, { input: { duration: 8 } })).toBe(320);
    expect(priceCents(pricing, { input: { duration: "8s" } })).toBe(320); // Veo-style string
    expect(priceCents(pricing, {})).toBe(40 * DEFAULT_REFERENCE.videoSeconds); // assumed
    expect(billableUnits("second", {}).assumed).toBe(true);
    expect(billableUnits("second", { usage: { seconds: 8 } }).assumed).toBe(false);
  });

  it("per-call pricing bills output count and NEVER seconds — the 8× bug class", () => {
    const flat = { unit: "call" as const, cents: 16 };
    // An adapter reporting an 8-second clip must still bill ONE call.
    expect(priceCents(flat, { usage: { seconds: 8, outputs: 1 } })).toBe(16);
    expect(priceCents(flat, { usage: { seconds: 8 }, outputCount: 1 })).toBe(16);
    // Legacy bare `units` is honored as a count for per-image SKUs.
    expect(priceCents({ unit: "image", cents: 2 }, { units: 3 })).toBe(6);
  });

  it("per-megapixel pricing bills usage.megapixels, else the reference image", () => {
    const mp = { unit: "megapixel" as const, cents: 10 };
    expect(priceCents(mp, { usage: { megapixels: 4.2 } })).toBe(42);
    expect(priceCents(mp, {})).toBeCloseTo(10 * referenceMegapixels(DEFAULT_REFERENCE), 6);
  });

  it("durationFromInput parses numbers and numeric-ish strings only", () => {
    expect(durationFromInput({ duration: 5 })).toBe(5);
    expect(durationFromInput({ duration: "4s" })).toBe(4);
    expect(durationFromInput({ duration: "7.5" })).toBe(7.5);
    expect(durationFromInput({ duration: "long" })).toBeUndefined();
    expect(durationFromInput({ duration: -1 })).toBeUndefined();
    expect(durationFromInput({})).toBeUndefined();
    expect(durationFromInput(undefined)).toBeUndefined();
  });
});

describe("createMediaLCR settle-time billing (v2)", () => {
  const doneWith = (extra: Partial<MediaStatusResult> = {}): MediaStatusResult => ({
    status: "done",
    outputs: [{ url: "https://x/out.mp4", type: "video" }],
    ...extra,
  });

  function asyncAdapter(provider: string, statuses: MediaStatusResult[]): MediaAdapter {
    let i = 0;
    return {
      provider,
      run: vi.fn(async () => ({ outputs: [{ url: `https://x/${provider}.mp4`, type: "video" as const }] })),
      submit: vi.fn(async () => ({ requestId: `${provider}-req` })),
      checkStatus: vi.fn(async () => statuses[Math.min(i++, statuses.length - 1)]!),
    };
  }

  // Per-second route 40¢/s, official per-second 60¢/s.
  const perSecondRegistry: MediaRegistry = {
    "x/vid8": {
      id: "x/vid8",
      modality: "video",
      official: { unit: "second", cents: 60 },
      routes: [{ provider: "cheap", externalId: "c", pricing: { unit: "second", cents: 40 } }],
    },
  };

  it("bills a per-second route by the ACTUAL duration, not the 5s reference", async () => {
    const onCall = vi.fn();
    const lcr = createMediaLCR({
      registry: perSecondRegistry,
      adapters: { cheap: asyncAdapter("cheap", [doneWith({ usage: { outputs: 1, seconds: 8 } })]) },
      onCall,
    });
    const handle = await lcr.submit("x/vid8", { prompt: "a wave", duration: 8 });
    const r = await lcr.poll(handle);
    expect(r.done).toBe(true);
    if (r.done) {
      expect(r.costCents).toBe(320); // 40¢ × 8s — NOT 40 × 5 (reference)
      expect(r.usage).toEqual({ outputs: 1, seconds: 8 });
    }
  });

  it("baselines an off-reference clip at the official price for the SAME usage", async () => {
    const onCall = vi.fn();
    const lcr = createMediaLCR({
      registry: perSecondRegistry,
      adapters: { cheap: asyncAdapter("cheap", [doneWith({ usage: { outputs: 1, seconds: 8 } })]) },
      onCall,
    });
    const handle = await lcr.submit("x/vid8", { prompt: "a wave", duration: 8 });
    await lcr.poll(handle);
    const rec = onCall.mock.calls[0]![0];
    expect(rec.costUsd).toBeCloseTo(3.2, 6); // 40¢ × 8s
    expect(rec.baselineUsd).toBeCloseTo(4.8, 6); // official 60¢ × 8s — same usage
    expect(rec.baselineKind).toBe("official");
    expect(rec.officialUsd).toBeCloseTo(4.8, 6);
    expect(rec.modality).toBe("video");
    expect(rec.usage).toEqual({ outputs: 1, seconds: 8 });
    expect(rec.estCostUsd).toBeCloseTo(3.2, 6); // estimate IS the cost (nothing reported)
  });

  it("falls back to input.duration when the adapter reports no usage", async () => {
    const lcr = createMediaLCR({
      registry: perSecondRegistry,
      adapters: { cheap: asyncAdapter("cheap", [doneWith()]) },
    });
    const handle = await lcr.submit("x/vid8", { prompt: "a wave", duration: 8 });
    const r = await lcr.poll(handle);
    expect(r.done).toBe(true);
    if (r.done) expect(r.costCents).toBe(320); // duration read from the input
  });

  it("marks priciest-route baselines so a dashboard can tell them from official prices", async () => {
    const onCall = vi.fn();
    const lcr = createMediaLCR({
      registry: {
        "x/open": {
          id: "x/open",
          modality: "video",
          // no official price → baseline degrades to the priciest route
          routes: [
            { provider: "cheap", externalId: "c", pricing: { unit: "call", cents: 30 } },
            { provider: "pricey", externalId: "p", pricing: { unit: "call", cents: 90 } },
          ],
        },
      },
      adapters: {
        cheap: asyncAdapter("cheap", [doneWith({ usage: { outputs: 1 } })]),
        pricey: asyncAdapter("pricey", [doneWith()]),
      },
      officialPrices: {},
      onCall,
    });
    const handle = await lcr.submit("x/open", { prompt: "hi" });
    await lcr.poll(handle);
    const rec = onCall.mock.calls[0]![0];
    expect(rec.baselineKind).toBe("priciest-route");
    expect(rec.baselineUsd).toBeCloseTo(0.9, 6);
    expect(rec.officialUsd).toBeUndefined();
  });

  it("flags a wildly off provider-reported cost via onError (USD-vs-cents bug class)", async () => {
    const onError = vi.fn();
    const lcr = createMediaLCR({
      registry: perSecondRegistry,
      adapters: {
        // Reports 32000¢ ($320) where the table predicts 320¢ — a 100× unit slip.
        cheap: asyncAdapter("cheap", [doneWith({ usage: { seconds: 8 }, costCents: 32000 })]),
      },
      onError,
    });
    const handle = await lcr.submit("x/vid8", { prompt: "a wave", duration: 8 });
    const r = await lcr.poll(handle);
    expect(r.done).toBe(true);
    if (r.done) expect(r.costCents).toBe(32000); // the reported bill still stands
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/price table predicts/) }),
      "cheap",
    );
  });

  it("sync image records carry modality, usage and estCostUsd", async () => {
    const onCall = vi.fn();
    const lcr = createMediaLCR({
      registry: {
        "x/img": {
          id: "x/img",
          modality: "image",
          routes: [{ provider: "cheap", externalId: "c", pricing: { unit: "image", cents: 2 } }],
        },
      },
      adapters: {
        cheap: {
          provider: "cheap",
          run: async () => ({
            outputs: [
              { url: "https://x/1.png", type: "image" },
              { url: "https://x/2.png", type: "image" },
            ],
          }),
        },
      },
      officialPrices: {},
      onCall,
    });
    const result = await lcr("x/img", { prompt: "hi" });
    expect(result.costCents).toBe(4); // 2¢ × 2 outputs
    expect(result.usage).toEqual({ outputs: 2 });
    const rec = onCall.mock.calls[0]![0];
    expect(rec.modality).toBe("image");
    expect(rec.usage).toEqual({ outputs: 2 });
    expect(rec.estCostUsd).toBeCloseTo(0.04, 6);
  });

  it("a pre-0.6 handle (no pricing/baseline) still polls and settles", async () => {
    const onCall = vi.fn();
    const lcr = createMediaLCR({
      registry: perSecondRegistry,
      adapters: { cheap: asyncAdapter("cheap", [doneWith()]) },
      onCall,
    });
    const handle = await lcr.submit("x/vid8", { prompt: "hi" });
    // Simulate a handle serialized by an older version: strip the v2 fields.
    const legacy = JSON.parse(JSON.stringify(handle));
    delete legacy.pricing;
    delete legacy.baseline;
    const r = await lcr.poll(legacy);
    expect(r.done).toBe(true);
    if (r.done) expect(r.costCents).toBe(handle.refCents); // legacy ref-price estimate
    const rec = onCall.mock.calls[0]![0];
    expect(rec.baselineUsd).toBeCloseTo(legacy.baselineUsd, 6); // submit-time estimate
  });
});
