import { describe, it, expect, vi } from "vitest";
import { createKunavoMediaAdapter, KunavoMediaError } from "./kunavo-media";
import { createMediaLCR, type MediaRegistry } from "../media";

/**
 * Kunavo media is plain REST. Image is one POST. Async video is POST /v1/videos
 * then GET /v1/videos/{id} polled until terminal. This stub routes by URL/method
 * so one fetch impl drives every path; `videoStatuses` is the sequence of
 * `status` values returned on successive poll calls.
 */
function kunavoStub(opts: {
  imageBody?: unknown;
  imageInit?: { ok?: boolean; status?: number };
  submitBody?: unknown;
  submitInit?: { ok?: boolean; status?: number };
  videoStatuses?: string[];
  pollBody?: (status: string) => unknown;
  pollInit?: { ok?: boolean; status?: number };
  syncVideoBody?: unknown;
}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let pollIdx = 0;
  const statuses = opts.videoStatuses ?? ["completed"];

  const impl = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });

    // Image generation / edit.
    if (url.includes("/v1/images/")) {
      return resp(opts.imageInit, opts.imageBody ?? { created: 1, data: [{ url: "https://files.kunavo.com/i.png" }] });
    }
    // Sync video.
    if (url.endsWith("/v1/video/generations")) {
      return resp(undefined, opts.syncVideoBody ?? { created: 1, data: [{ url: "https://files.kunavo.com/sync.mp4" }] });
    }
    // Async submit (POST /v1/videos).
    if (method === "POST" && url.endsWith("/v1/videos")) {
      return resp(opts.submitInit, opts.submitBody ?? { id: "vid_abc", status: "queued", progress: 0 });
    }
    // Async poll (GET /v1/videos/{id}).
    const status = statuses[Math.min(pollIdx, statuses.length - 1)]!;
    pollIdx++;
    const body =
      opts.pollBody?.(status) ??
      (status === "completed"
        ? { status, progress: 100, output: { url: "https://files.kunavo.com/v.mp4", urls: ["https://files.kunavo.com/v.mp4"] } }
        : status === "failed"
          ? { status, error: { code: "x", message: "render failed" } }
          : { status, progress: 0 });
    return resp(opts.pollInit, body);
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

function resp(init: { ok?: boolean; status?: number } | undefined, body: unknown): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("createKunavoMediaAdapter — image", () => {
  it("text-to-image hits /v1/images/generations and returns the url", async () => {
    const { impl, calls } = kunavoStub({});
    const adapter = createKunavoMediaAdapter({ apiKey: "k", fetchImpl: impl });

    const result = await adapter.run({ externalId: "nano-banana-2", input: { prompt: "an apple" } });

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://api.kunavo.com/v1/images/generations");
    expect(post.body).toEqual({ model: "nano-banana-2", prompt: "an apple" }); // model injected
    expect(result.outputs).toEqual([{ url: "https://files.kunavo.com/i.png", type: "image" }]);
    expect(result.costCents).toBeUndefined(); // left to the router estimate
  });

  it("a *-edit slug routes to /v1/images/edits with the reference image", async () => {
    const { impl, calls } = kunavoStub({});
    const adapter = createKunavoMediaAdapter({ apiKey: "k", fetchImpl: impl });

    await adapter.run({
      externalId: "nano-banana-edit",
      input: { prompt: "make it green", image: "https://files.kunavo.com/src.png" },
    });

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://api.kunavo.com/v1/images/edits");
    expect(post.body).toMatchObject({ model: "nano-banana-edit", image: "https://files.kunavo.com/src.png" });
  });

  it("throws a status-bearing error when image generation is rejected", async () => {
    const { impl } = kunavoStub({ imageInit: { ok: false, status: 400 }, imageBody: { error: { message: "bad" } } });
    const adapter = createKunavoMediaAdapter({ apiKey: "k", fetchImpl: impl });

    await expect(adapter.run({ externalId: "nano-banana-2", input: { prompt: "x" } })).rejects.toMatchObject({
      status: 400,
      name: "KunavoMediaError",
    });
  });
});

describe("createKunavoMediaAdapter — video (async, default)", () => {
  it("submits to /v1/videos and polls /v1/videos/{id} until completed", async () => {
    const { impl, calls } = kunavoStub({
      videoStatuses: ["queued", "in_progress", "completed"],
    });
    const adapter = createKunavoMediaAdapter({ apiKey: "k", fetchImpl: impl, pollIntervalMs: 0 });

    const result = await adapter.run({ externalId: "veo-3-lite", input: { prompt: "a wave" } });

    const submit = calls.find((c) => c.method === "POST")!;
    expect(submit.url).toBe("https://api.kunavo.com/v1/videos");
    const polls = calls.filter((c) => c.method === "GET");
    expect(polls).toHaveLength(3);
    expect(polls[0]!.url).toBe("https://api.kunavo.com/v1/videos/vid_abc");
    expect(result.outputs).toEqual([{ url: "https://files.kunavo.com/v.mp4", type: "video" }]);
  });

  it("prefers output.urls[] but falls back to output.url", async () => {
    const { impl } = kunavoStub({
      pollBody: () => ({ status: "completed", output: { url: "https://files.kunavo.com/only.mp4" } }),
    });
    const adapter = createKunavoMediaAdapter({ apiKey: "k", fetchImpl: impl, pollIntervalMs: 0 });

    const result = await adapter.run({ externalId: "veo-3-lite", input: { prompt: "x" } });
    expect(result.outputs).toEqual([{ url: "https://files.kunavo.com/only.mp4", type: "video" }]);
  });

  it("throws with the upstream message when the job fails", async () => {
    const { impl } = kunavoStub({ videoStatuses: ["failed"] });
    const adapter = createKunavoMediaAdapter({ apiKey: "k", fetchImpl: impl, pollIntervalMs: 0 });

    await expect(adapter.run({ externalId: "veo-3-lite", input: { prompt: "x" } })).rejects.toThrow(/render failed/);
  });

  it("times out as a retryable 504 when the job never leaves the queue", async () => {
    const { impl } = kunavoStub({ videoStatuses: ["queued"] });
    const adapter = createKunavoMediaAdapter({
      apiKey: "k",
      fetchImpl: impl,
      pollIntervalMs: 1,
      pollTimeoutMs: 5, // expire almost immediately
    });

    await expect(adapter.run({ externalId: "veo-3-lite", input: { prompt: "x" } })).rejects.toMatchObject({
      status: 504,
      name: "KunavoMediaError",
    });
  });

  it("throws a status-bearing error when submit is rejected", async () => {
    const { impl } = kunavoStub({ submitInit: { ok: false, status: 402 }, submitBody: { error: { message: "no credits" } } });
    const adapter = createKunavoMediaAdapter({ apiKey: "k", fetchImpl: impl, pollIntervalMs: 0 });

    await expect(adapter.run({ externalId: "veo-3-lite", input: { prompt: "x" } })).rejects.toMatchObject({
      status: 402,
      name: "KunavoMediaError",
    });
  });
});

describe("createKunavoMediaAdapter — video (sync mode)", () => {
  it('videoMode:"sync" uses POST /v1/video/generations and returns the clip inline', async () => {
    const { impl, calls } = kunavoStub({});
    const adapter = createKunavoMediaAdapter({ apiKey: "k", fetchImpl: impl, videoMode: "sync" });

    const result = await adapter.run({ externalId: "veo-3-lite", input: { prompt: "a wave" } });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.kunavo.com/v1/video/generations");
    expect(result.outputs).toEqual([{ url: "https://files.kunavo.com/sync.mp4", type: "video" }]);
  });
});

// A capped Kunavo video route (timeout → 504) must fall over to the next route.
describe("createKunavoMediaAdapter via createMediaLCR (video failover)", () => {
  const registry: MediaRegistry = {
    "google/veo-3-lite": {
      id: "google/veo-3-lite",
      modality: "video",
      routes: [
        { provider: "kunavo", externalId: "veo-3-lite", pricing: { unit: "call", cents: 16 } },
        { provider: "stub", externalId: "stub-veo", pricing: { unit: "call", cents: 99 } },
      ],
    },
  };

  it("a timed-out Kunavo job (504) fails over to the next provider", async () => {
    const { impl } = kunavoStub({ videoStatuses: ["queued"] });
    const onError = vi.fn();
    const generate = createMediaLCR({
      registry,
      adapters: {
        kunavo: createKunavoMediaAdapter({ apiKey: "k", fetchImpl: impl, pollIntervalMs: 1, pollTimeoutMs: 5 }),
        stub: {
          provider: "stub",
          run: async () => ({ outputs: [{ url: "https://other/clip.mp4", type: "video" }] }),
        },
      },
      onError,
    });

    const result = await generate("google/veo-3-lite", { prompt: "a wave" });

    expect(result.provider).toBe("stub");
    expect(result.outputs).toEqual([{ url: "https://other/clip.mp4", type: "video" }]);
    expect(onError).toHaveBeenCalledOnce();
  });
});
