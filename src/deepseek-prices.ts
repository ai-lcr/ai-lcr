/** USD per million tokens, checked against DeepSeek and Tokenify on 2026-09-29. */
export const DEEPSEEK_PRICES = {
  flash: {
    officialOffPeak: { input: 0.15, output: 0.60, cacheRead: 0.003 },
    officialPeak: { input: 0.30, output: 1.20, cacheRead: 0.006 },
    tokenifyOffPeak: { input: 0.09, output: 0.36, cacheRead: 0.003 },
    tokenifyPeak: { input: 0.15, output: 0.60, cacheRead: 0.006 },
  },
  pro: {
    officialOffPeak: { input: 0.66, output: 1.98, cacheRead: 0.022 },
    officialPeak: { input: 1.32, output: 3.96, cacheRead: 0.044 },
    tokenify: { input: 0.66, output: 1.98, cacheRead: 0.044 },
  },
} as const;
