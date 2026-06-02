import { describe, it, expect, vi } from "vitest";
import { createFalMediaAdapter, FalMediaError } from "./fal-media";
import { createMediaLCR, type MediaRegistry } from "../media";

/**
 * fal's queue is three calls: POST submit, GET status (polled), GET result.
 * This stub routes by URL/method so one fetch impl drives the whole flow, and
 * records calls for assertions. `statuses` is the sequence of status responses
 * returned on successive status polls.
 */
function falStub(opts: {
  submit?: unknown;
  submitInit?: { ok?: boolean; status?: number };
  statuses?: string[];
  result?: unknown;
  resultInit?: { ok?: boolean; status?: number };
}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let statusIdx = 0;
  const statuses = opts.statuses ?? ["COMPLETED"];

  const impl = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({
      url,
      method,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });

    // Submit (POST to the model path).
    if (method === "POST") {
      return {
        ok: opts.submitInit?.ok ?? true,
        status: opts.submitInit?.status ?? 200,
        json: async () =>
          opts.submit ?? {
            request_id: "req-1",
            status_url: "https://queue.fal.run/fal-ai/x/requests/req-1/status",
            response_url: "https://queue.fal.run/fal-ai/x/requests/req-1",
          },
        text: async () => JSON.stringify(opts.submit ?? {}),
      } as Response;
    }
    // Status poll.
    if (url.endsWith("/status")) {
      const status = statuses[Math.min(statusIdx, statuses.length - 1)]!;
      statusIdx++;
      return { ok: true, status: 200, json: async () => ({ status }) } as Response;
    }
    // Result fetch.
    return {
      ok: opts.resultInit?.ok ?? true,
      status: opts.resultInit?.status ?? 200,
      json: async () => opts.result ?? { images: [{ url: "https://fal.media/x.jpg" }] },
      text: async () => JSON.stringify(opts.result ?? {}),
    } as Response;
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

describe("createFalMediaAdapter", () => {
  it("submits to the model path with a Key auth header and returns the image url", async () => {
    const { impl, calls } = falStub({ result: { images: [{ url: "https://fal.media/a.jpg" }] } });
    const adapter = createFalMediaAdapter({ apiKey: "k", fetchImpl: impl, pollIntervalMs: 0 });

    const result = await adapter.run({
      externalId: "fal-ai/flux/schnell",
      input: { prompt: "a fox", image_size: "square" },
    });

    const submit = calls.find((c) => c.method === "POST")!;
    expect(submit.url).toBe("https://queue.fal.run/fal-ai/flux/schnell");
    expect(submit.body).toEqual({ prompt: "a fox", image_size: "square" }); // input passed straight through
    expect(result.outputs).toEqual([{ url: "https://fal.media/a.jpg", type: "image" }]);
    expect(result.units).toBe(1);
    expect(result.costCents).toBeUndefined(); // left to the router's estimate
  });

  it("extracts a video url from the singular `video` key", async () => {
    const { impl } = falStub({ result: { video: { url: "https://fal.media/clip.mp4" } } });
    const adapter = createFalMediaAdapter({ apiKey: "k", fetchImpl: impl, pollIntervalMs: 0 });

    const result = await adapter.run({ externalId: "fal-ai/veo3.1/lite", input: { prompt: "a wave" } });

    expect(result.outputs).toEqual([{ url: "https://fal.media/clip.mp4", type: "video" }]);
  });

  it("polls status until COMPLETED before fetching the result", async () => {
    const { impl, calls } = falStub({
      statuses: ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"],
      result: { video: { url: "https://fal.media/clip.mp4" } },
    });
    const adapter = createFalMediaAdapter({ apiKey: "k", fetchImpl: impl, pollIntervalMs: 0 });

    await adapter.run({ externalId: "fal-ai/veo3.1/lite", input: { prompt: "x" } });

    const statusPolls = calls.filter((c) => c.url.endsWith("/status"));
    expect(statusPolls).toHaveLength(3); // IN_QUEUE, IN_PROGRESS, COMPLETED
    // Result fetched only after COMPLETED.
    expect(calls[calls.length - 1]!.url).not.toContain("/status");
  });

  it("follows the status_url / response_url returned by submit (sub-path quirk)", async () => {
    const { impl, calls } = falStub({
      submit: {
        request_id: "req-9",
        status_url: "https://queue.fal.run/fal-ai/flux/requests/req-9/status",
        response_url: "https://queue.fal.run/fal-ai/flux/requests/req-9",
      },
      result: { images: [{ url: "https://fal.media/y.jpg" }] },
    });
    const adapter = createFalMediaAdapter({ apiKey: "k", fetchImpl: impl, pollIntervalMs: 0 });

    await adapter.run({ externalId: "fal-ai/flux/schnell", input: { prompt: "x" } });

    // status/result hit the fal-ai/flux base, NOT fal-ai/flux/schnell.
    expect(calls.some((c) => c.url === "https://queue.fal.run/fal-ai/flux/requests/req-9/status")).toBe(true);
    expect(calls.some((c) => c.url === "https://queue.fal.run/fal-ai/flux/requests/req-9")).toBe(true);
  });

  it("throws a status-bearing error when submit is rejected", async () => {
    const { impl } = falStub({ submitInit: { ok: false, status: 429 }, submit: { detail: "rate limited" } });
    const adapter = createFalMediaAdapter({ apiKey: "k", fetchImpl: impl, pollIntervalMs: 0 });

    await expect(
      adapter.run({ externalId: "fal-ai/flux/schnell", input: { prompt: "x" } }),
    ).rejects.toMatchObject({ status: 429, name: "FalMediaError" });
  });

  it("throws when the completed result carries no media url", async () => {
    const { impl } = falStub({ result: { images: [] } });
    const adapter = createFalMediaAdapter({ apiKey: "k", fetchImpl: impl, pollIntervalMs: 0 });

    await expect(
      adapter.run({ externalId: "fal-ai/flux/schnell", input: { prompt: "x" } }),
    ).rejects.toThrow(/no media URL/);
  });
});

// Wired through the media router on a real registry entry: the cheapest video
// route (Kunavo) caps out and falls over to the fal route — proving fal is now
// a live video execution path, not a skipped (adapter-less) route.
describe("createFalMediaAdapter via createMediaLCR (video failover)", () => {
  const registry: MediaRegistry = {
    "google/veo-3-lite": {
      id: "google/veo-3-lite",
      modality: "video",
      routes: [
        { provider: "kunavo", externalId: "veo-3-lite", pricing: { unit: "call", cents: 16 } },
        { provider: "fal", externalId: "fal-ai/veo3.1/lite", pricing: { unit: "second", cents: 8 } },
      ],
    },
  };

  it("falls over from a capped Kunavo to fal and returns a video output", async () => {
    const { impl } = falStub({ result: { video: { url: "https://fal.media/clip.mp4" } } });
    const onError = vi.fn();
    const generate = createMediaLCR({
      registry,
      adapters: {
        kunavo: {
          provider: "kunavo",
          run: async () => {
            throw new FalMediaError(402, "Insufficient credits"); // capped → retryable
          },
        },
        fal: createFalMediaAdapter({ apiKey: "k", fetchImpl: impl, pollIntervalMs: 0 }),
      },
      onError,
    });

    const result = await generate("google/veo-3-lite", { prompt: "a wave" });

    expect(result.provider).toBe("fal");
    expect(result.outputs).toEqual([{ url: "https://fal.media/clip.mp4", type: "video" }]);
    expect(onError).toHaveBeenCalledOnce();
  });
});
