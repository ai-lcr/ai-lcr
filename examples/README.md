# Examples

Runnable snippets for `ai-lcr`. Each file is self-contained and reads its API
keys from the environment — set only the ones an example needs.

```bash
# from the repo root
npm install
OPENROUTER_API_KEY=sk-... KUNAVO_API_KEY=... npx tsx examples/basic.ts
```

| File | What it shows | Keys |
|------|---------------|------|
| [`basic.ts`](./basic.ts) | One model, two providers, cheapest-first with `autoSort` + `onCost` | `OPENROUTER_API_KEY`, `KUNAVO_API_KEY` |
| [`native-provider-fallback.ts`](./native-provider-fallback.ts) | A vendor's official API first, an aggregator as fallback | `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY` |
| [`migrate-from-openrouter.ts`](./migrate-from-openrouter.ts) | Drop-in migration from `@openrouter/ai-sdk-provider` — before/after | `OPENROUTER_API_KEY`, `KUNAVO_API_KEY` |

> Prices in these examples are illustrative — verify current rates before relying
> on the cheapest-first ordering. See the [pricing tables](../README.md#text-model-pricing).

`tsx` is the easiest way to run a single `.ts` file (`npx tsx <file>`). These
examples import `ai-lcr` by name; from inside this repo that resolves to the
local build, so run `npm run build` first if you've changed `src/`.
