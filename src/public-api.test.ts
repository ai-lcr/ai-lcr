import { describe, it, expect } from "vitest";
import * as api from "./index";

/**
 * Pins the public runtime export surface. A removed export — the kind of slip
 * that shipped as a regression before there was any test that named every
 * symbol — fails here loudly. Type-only exports can't be checked at runtime;
 * `tsc --noEmit` (run in CI) is their guard. Adding a new export means adding
 * it to this list on purpose.
 */
const EXPECTED_EXPORTS = [
  // text router
  "createLCR",
  // bundled price table (zero-config pricing)
  "MODEL_PRICES",
  "getModelPrice",
  // response cache (exact-match, pluggable store)
  "createMemoryCacheStore",
  // observability
  "classifyError",
  "classifyErrorKind",
  "formatCallRecord",
  "createHttpSink",
  // error predicates (failover policy / custom shouldRetry building blocks)
  "isRetryableError",
  "isNetworkError",
  "isAbortError",
  "shouldFailover",
  // media router
  "createMediaLCR",
  "comparePrices",
  "rankRoutes",
  "cheapestRoute",
  "normalizedCents",
  "referenceMegapixels",
  "DEFAULT_REFERENCE",
  // settle-time billing (actual usage, not the reference)
  "billableUnits",
  "priceCents",
  "durationFromInput",
  "MEDIA_PRICING",
  "OFFICIAL_PRICES",
  "createKunavoMediaAdapter",
  "createRunwareMediaAdapter",
  "createFalMediaAdapter",
] as const;

describe("public API surface", () => {
  for (const name of EXPECTED_EXPORTS) {
    it(`exports ${name}`, () => {
      expect(api[name as keyof typeof api]).toBeDefined();
    });
  }

  it("exports nothing unexpected without updating this list", () => {
    const actual = Object.keys(api).sort();
    const expected = [...EXPECTED_EXPORTS].sort();
    expect(actual).toEqual(expected);
  });
});
