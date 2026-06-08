import { describe, it, expect } from "vitest";
import { MEDIA_PRICING } from "./media-registry";
import { OFFICIAL_PRICES } from "./media-official";
import {
  cheapestRoute,
  comparePrices,
  normalizedCents,
  rankRoutes,
  type MediaPricing,
  type MediaUnit,
} from "./media";

/**
 * Contract test for the bundled price data (MEDIA_PRICING + OFFICIAL_PRICES) —
 * the media analogue of an engine-registry contract. It can't check a number is
 * *correct* (a price audit is a human/probe job), but it pins the SHAPE so a
 * malformed or half-added entry fails CI instead of silently mis-routing or
 * mis-billing: a route with no provider, a typo'd unit, a zero/negative price, a
 * model listed under the wrong id, or two routes from the same provider (which
 * would make "cheapest" ambiguous). Add a model wrong → red here.
 */

const VALID_UNITS: ReadonlySet<MediaUnit> = new Set(["image", "megapixel", "second", "call"]);

function isValidPricing(p: MediaPricing): boolean {
  return VALID_UNITS.has(p.unit) && typeof p.cents === "number" && Number.isFinite(p.cents) && p.cents > 0;
}

describe("MEDIA_PRICING contract", () => {
  const entries = Object.entries(MEDIA_PRICING);

  it("is non-empty", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("every entry's map key matches its def.id", () => {
    for (const [key, def] of entries) expect(def.id).toBe(key);
  });

  it("every model has a valid modality", () => {
    for (const [, def] of entries) expect(["image", "video"]).toContain(def.modality);
  });

  it("every model has at least one route", () => {
    for (const [id, def] of entries) {
      expect(def.routes.length, `${id} has no routes`).toBeGreaterThan(0);
    }
  });

  it("every route has a provider, a non-empty externalId, and valid pricing", () => {
    for (const [id, def] of entries) {
      for (const r of def.routes) {
        expect(r.provider, `${id}: route missing provider`).toBeTruthy();
        expect(typeof r.externalId === "string" && r.externalId.length > 0, `${id}: bad externalId`).toBe(true);
        expect(isValidPricing(r.pricing), `${id}/${r.provider}: bad pricing ${JSON.stringify(r.pricing)}`).toBe(true);
      }
    }
  });

  it("no model lists the same provider twice (cheapest would be ambiguous)", () => {
    for (const [id, def] of entries) {
      const providers = def.routes.map((r) => r.provider);
      expect(new Set(providers).size, `${id} has duplicate providers: ${providers.join(", ")}`).toBe(
        providers.length,
      );
    }
  });

  it("every model ranks + resolves a cheapest route without throwing", () => {
    for (const [, def] of entries) {
      const ranked = rankRoutes(def);
      expect(ranked.length).toBe(def.routes.length);
      // refCents is finite and ordered ascending.
      for (let i = 1; i < ranked.length; i++) {
        expect(ranked[i]!.refCents).toBeGreaterThanOrEqual(ranked[i - 1]!.refCents);
      }
      expect(() => cheapestRoute(def)).not.toThrow();
    }
  });

  it("an inline official price (when present) is valid", () => {
    for (const [id, def] of entries) {
      if (def.official) {
        expect(isValidPricing(def.official), `${id}: bad inline official ${JSON.stringify(def.official)}`).toBe(
          true,
        );
      }
    }
  });

  it("comparePrices returns one row per model, each flagging a cheapest provider", () => {
    const rows = comparePrices(MEDIA_PRICING);
    expect(rows).toHaveLength(entries.length);
    for (const row of rows) {
      expect(row.cheapest.provider).toBeTruthy();
      expect(Number.isFinite(row.cheapest.refCents)).toBe(true);
      // The flagged cheapest really is the minimum of the row's routes.
      const min = Math.min(...row.routes.map((r) => r.refCents));
      expect(row.cheapest.refCents).toBeCloseTo(min, 9);
    }
  });
});

describe("OFFICIAL_PRICES contract", () => {
  const entries = Object.entries(OFFICIAL_PRICES);

  it("is non-empty", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("every official price has a valid unit and a positive cents", () => {
    for (const [id, p] of entries) {
      expect(isValidPricing(p), `${id}: bad official ${JSON.stringify(p)}`).toBe(true);
    }
  });

  it("every official price yields a positive normalized baseline", () => {
    for (const [id, p] of entries) {
      expect(normalizedCents(p), `${id}: non-positive baseline`).toBeGreaterThan(0);
    }
  });

  it("an official entry that matches a MEDIA_PRICING model shares its modality intent", () => {
    // A per-second/per-call official almost always describes video; a per-image
    // one describes image. Where a model appears in BOTH tables, the unit family
    // shouldn't contradict the registered modality (catches a copy-paste slip).
    for (const [id, p] of entries) {
      const def = MEDIA_PRICING[id];
      if (!def) continue;
      if (def.modality === "image") {
        expect(["image", "megapixel"], `${id}: image model with ${p.unit} official`).toContain(p.unit);
      } else {
        expect(["second", "call"], `${id}: video model with ${p.unit} official`).toContain(p.unit);
      }
    }
  });
});
