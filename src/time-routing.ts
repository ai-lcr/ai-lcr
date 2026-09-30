import type { LanguageModelV3 } from "@ai-sdk/provider";

/**
 * Choose a fully configured model when each request begins. A streaming call
 * keeps that choice for its entire lifetime, even if the clock crosses a
 * pricing boundary while tokens are arriving.
 */
export function createTimeRoutedModel(
  select: (at: Date) => LanguageModelV3,
  clock: () => Date = () => new Date(),
): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    get provider() { return select(clock()).provider; },
    get modelId() { return select(clock()).modelId; },
    get supportedUrls() { return select(clock()).supportedUrls; },
    doGenerate(options) {
      return select(clock()).doGenerate(options);
    },
    doStream(options) {
      return select(clock()).doStream(options);
    },
  };
}

/** DeepSeek's published peak windows, in UTC: weekdays 01–04 and 06–10. */
export function isDeepSeekPeak(at: Date): boolean {
  if (Number.isNaN(at.getTime())) throw new RangeError("Invalid date");
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}
