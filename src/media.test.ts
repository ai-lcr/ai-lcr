import { describe, it, expect, vi } from "vitest";
import {
  normalizedCents,
  referenceMegapixels,
  rankRoutes,
  cheapestRoute,
  comparePrices,
  createMediaLCR,
  DEFAULT_REFERENCE,
  type MediaModelDef,
  type MediaRegistry,
  type MediaAdapter,
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
});
