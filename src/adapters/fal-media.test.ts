import { describe, it, expect, vi } from "vitest";
import { createFalMediaAdapter, FalMediaError } from "./fal-media";
import { createMediaLCR, type MediaRegistry } from "../media";

// A fetch stub that records the request and returns a canned fal response.
function stubFetch(response: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: { url: string; headers: unknown; body: unknown }[] = [];
  const impl = vi.fn(async (url: string, opts: RequestInit) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(String(opts.body)) });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => response,
    } as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("createFalMediaAdapter", () => {
  it("POSTs inputs to fal.run/<model> with Key auth and returns the image url", async () => {
    const { impl, calls } = stubFetch({
      images: [{ url: "https://fal.media/x.png", width: 1024 }],
    });
    const adapter = createFalMediaAdapter({ apiKey: "k", fetchImpl: impl });

    const result = await adapter.run({
      externalId: "fal-ai/nano-banana-2",
      input: { prompt: "a fox", num_images: 1 },
    });

    expect(calls[0]!.url).toBe("https://fal.run/fal-ai/nano-banana-2");
    expect((calls[0]!.headers as Record<string, string>).authorization).toBe("Key k");
    expect(calls[0]!.body).toMatchObject({ prompt: "a fox", num_images: 1 });

    expect(result.outputs).toEqual([{ url: "https://fal.media/x.png", type: "image" }]);
    expect(result.units).toBe(1);
    // fal's sync response carries no price → router estimates from the ref.
    expect(result.costCents).toBeUndefined();
  });

  it("accepts a single `image` object as well as an `images` array", async () => {
    const { impl } = stubFetch({ image: { url: "https://fal.media/solo.png" } });
    const adapter = createFalMediaAdapter({ apiKey: "k", fetchImpl: impl });

    const result = await adapter.run({ externalId: "fal-ai/some-model", input: { prompt: "x" } });

    expect(result.outputs).toEqual([{ url: "https://fal.media/solo.png", type: "image" }]);
  });

  it("throws a status-bearing error when the account is out of balance (403)", async () => {
    const { impl } = stubFetch({ detail: "Exhausted balance. Please top up." }, { ok: false, status: 403 });
    const adapter = createFalMediaAdapter({ apiKey: "k", fetchImpl: impl });

    await expect(
      adapter.run({ externalId: "fal-ai/nano-banana-2", input: { prompt: "x" } }),
    ).rejects.toMatchObject({ status: 403, name: "FalMediaError" });
  });

  it("extracts the message from fal's array-shaped `detail` validation body", async () => {
    const { impl } = stubFetch({ detail: [{ msg: "prompt is required" }] }, { ok: false, status: 422 });
    const adapter = createFalMediaAdapter({ apiKey: "k", fetchImpl: impl });

    await expect(
      adapter.run({ externalId: "fal-ai/nano-banana-2", input: {} }),
    ).rejects.toThrow(/prompt is required/);
  });

  it("throws when the response carries no image url", async () => {
    const { impl } = stubFetch({ images: [] });
    const adapter = createFalMediaAdapter({ apiKey: "k", fetchImpl: impl });

    await expect(
      adapter.run({ externalId: "fal-ai/nano-banana-2", input: { prompt: "x" } }),
    ).rejects.toThrow(/no image URL/);
  });
});

// Wired through the media router: an out-of-balance fal route (403) falls over
// to the next provider — exercising FalMediaError(403) → isRetryableError → next.
describe("createFalMediaAdapter via createMediaLCR", () => {
  const registry: MediaRegistry = {
    "google/nano-banana-2": {
      id: "google/nano-banana-2",
      modality: "image",
      routes: [
        // fal is cheaper here in this test so it's tried first, then fails over.
        { provider: "fal", externalId: "fal-ai/nano-banana-2", pricing: { unit: "image", cents: 4 } },
        { provider: "runware", externalId: "google:4@3", pricing: { unit: "image", cents: 6.9 } },
      ],
    },
  };

  it("falls over from an out-of-balance fal to the next provider", async () => {
    const { impl } = stubFetch({ detail: "Exhausted balance" }, { ok: false, status: 403 });
    const onError = vi.fn();
    const generate = createMediaLCR({
      registry,
      adapters: {
        fal: createFalMediaAdapter({ apiKey: "k", fetchImpl: impl }),
        runware: {
          provider: "runware",
          run: async () => ({ outputs: [{ url: "https://im.runware.ai/y.png", type: "image" }] }),
        },
      },
      onError,
    });

    const result = await generate("google/nano-banana-2", { prompt: "x" });

    expect(result.provider).toBe("runware"); // fal out of balance (403) → fell over
    expect(onError).toHaveBeenCalledOnce();
  });
});
