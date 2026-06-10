import { describe, it, expect, vi } from "vitest";
import { createRunwareMediaAdapter, RunwareMediaError } from "./runware-media";
import { createMediaLCR, type MediaRegistry } from "../media";

// A fetch stub that records the request and returns a canned Runware response.
function stubFetch(response: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: { url: string; body: unknown }[] = [];
  const impl = vi.fn(async (url: string, opts: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(opts.body)) });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => response,
    } as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("createRunwareMediaAdapter", () => {
  it("wraps the input in an imageInference task and returns the image url", async () => {
    const { impl, calls } = stubFetch({
      data: [{ imageURL: "https://im.runware.ai/x.jpg", width: 1024, height: 1024, cost: 0.0013 }],
    });
    const adapter = createRunwareMediaAdapter({ apiKey: "k", fetchImpl: impl });

    const result = await adapter.run({
      externalId: "runware:100@1",
      input: { positivePrompt: "a fox", width: 1024, height: 1024, steps: 4 },
    });

    // Request shape: a single-element array with the infra fields filled in.
    const task = (calls[0]!.body as Record<string, unknown>[])[0]!;
    expect(task.taskType).toBe("imageInference");
    expect(task.model).toBe("runware:100@1");
    expect(task.positivePrompt).toBe("a fox");
    expect(task.includeCost).toBe(true);
    expect(typeof task.taskUUID).toBe("string");

    expect(result.outputs).toEqual([{ url: "https://im.runware.ai/x.jpg", type: "image" }]);
    expect(result.units).toBe(1);
  });

  it("converts Runware's USD-dollar cost to cents", async () => {
    const { impl } = stubFetch({
      data: [{ imageURL: "https://im.runware.ai/x.jpg", cost: 0.0013 }], // $0.0013
    });
    const adapter = createRunwareMediaAdapter({ apiKey: "k", fetchImpl: impl });

    const result = await adapter.run({ externalId: "runware:100@1", input: { positivePrompt: "x" } });

    expect(result.costCents).toBeCloseTo(0.13, 6); // 0.13¢, not 0.0013¢
  });

  it("lets the caller override defaults but not the infra fields", async () => {
    const { impl, calls } = stubFetch({ data: [{ imageURL: "https://im.runware.ai/x.jpg" }] });
    const adapter = createRunwareMediaAdapter({ apiKey: "k", fetchImpl: impl });

    await adapter.run({
      externalId: "runware:106@1",
      input: { positivePrompt: "edit", numberResults: 2, taskType: "ignored", model: "ignored" },
    });

    const task = (calls[0]!.body as Record<string, unknown>[])[0]!;
    expect(task.numberResults).toBe(2); // caller default override honored
    expect(task.taskType).toBe("imageInference"); // infra field NOT clobbered
    expect(task.model).toBe("runware:106@1"); // model comes from the route
  });

  it("throws a status-bearing error on a non-2xx response", async () => {
    const { impl } = stubFetch({ errors: [{ message: "rate limited" }] }, { ok: false, status: 429 });
    const adapter = createRunwareMediaAdapter({ apiKey: "k", fetchImpl: impl });

    await expect(
      adapter.run({ externalId: "runware:100@1", input: { positivePrompt: "x" } }),
    ).rejects.toMatchObject({ status: 429, name: "RunwareMediaError" });
  });

  it("treats an errors-array on a 200 as a retryable (502) provider failure", async () => {
    const { impl } = stubFetch({ errors: [{ code: "serverError", message: "oops" }] }, { ok: true, status: 200 });
    const adapter = createRunwareMediaAdapter({ apiKey: "k", fetchImpl: impl });

    await expect(
      adapter.run({ externalId: "runware:100@1", input: { positivePrompt: "x" } }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("throws when the response carries no image url", async () => {
    const { impl } = stubFetch({ data: [{ width: 1024 }] });
    const adapter = createRunwareMediaAdapter({ apiKey: "k", fetchImpl: impl });

    await expect(
      adapter.run({ externalId: "runware:100@1", input: { positivePrompt: "x" } }),
    ).rejects.toThrow(/no image URL/);
  });
});

describe("createRunwareMediaAdapter — async video submit/checkStatus", () => {
  // Routes by taskType: videoInference (submit ack) vs getResponse (poll).
  function videoStub(getResponseData: unknown) {
    const calls: { taskType: string; body: Record<string, unknown> }[] = [];
    const impl = vi.fn(async (_url: string, opts: RequestInit) => {
      const task = (JSON.parse(String(opts.body)) as Record<string, unknown>[])[0]!;
      calls.push({ taskType: String(task.taskType), body: task });
      const data = task.taskType === "getResponse" ? getResponseData : [{ taskUUID: task.taskUUID }];
      return { ok: true, status: 200, json: async () => ({ data }) } as Response;
    });
    return { impl: impl as unknown as typeof fetch, calls };
  }

  it("submit sends a videoInference async task and returns its taskUUID", async () => {
    const { impl, calls } = videoStub([]);
    const adapter = createRunwareMediaAdapter({ apiKey: "k", fetchImpl: impl });

    const r = await adapter.submit!({ externalId: "runware:200@1", input: { positivePrompt: "a wave", duration: 5 } });

    expect(calls[0]!.taskType).toBe("videoInference");
    expect(calls[0]!.body).toMatchObject({ model: "runware:200@1", deliveryMethod: "async", positivePrompt: "a wave" });
    expect(typeof r.requestId).toBe("string");
    expect(calls[0]!.body.taskUUID).toBe(r.requestId); // requestId IS the taskUUID
  });

  it("checkStatus polls via getResponse and maps success → done with cost", async () => {
    const { impl, calls } = videoStub([
      { taskUUID: "t1", status: "success", videoURL: "https://im.runware.ai/clip.mp4", cost: 0.5 },
    ]);
    const adapter = createRunwareMediaAdapter({ apiKey: "k", fetchImpl: impl });

    const r = await adapter.checkStatus!({ externalId: "runware:200@1", requestId: "t1" });

    expect(calls[0]!.taskType).toBe("getResponse");
    expect(r).toEqual({
      status: "done",
      outputs: [{ url: "https://im.runware.ai/clip.mp4", type: "video" }],
      usage: { outputs: 1 },
      costCents: 50, // $0.50 → 50¢
    });
  });

  it("checkStatus maps processing → running and error → error", async () => {
    const proc = videoStub([{ taskUUID: "t", status: "processing" }]);
    const aP = createRunwareMediaAdapter({ apiKey: "k", fetchImpl: proc.impl });
    expect(await aP.checkStatus!({ externalId: "runware:200@1", requestId: "t" })).toEqual({ status: "running" });

    const empty = videoStub([]); // no data row yet → still running
    const aE = createRunwareMediaAdapter({ apiKey: "k", fetchImpl: empty.impl });
    expect(await aE.checkStatus!({ externalId: "runware:200@1", requestId: "t" })).toEqual({ status: "running" });

    const err = videoStub([{ taskUUID: "t", status: "error", errorMessage: "render failed" }]);
    const aErr = createRunwareMediaAdapter({ apiKey: "k", fetchImpl: err.impl });
    expect(await aErr.checkStatus!({ externalId: "runware:200@1", requestId: "t" })).toMatchObject({
      status: "error",
      error: "render failed",
    });
  });

  it("checkStatus THROWS a status-bearing error on an HTTP failure", async () => {
    const { impl } = stubFetch({ errors: [{ message: "boom" }] }, { ok: false, status: 503 });
    const adapter = createRunwareMediaAdapter({ apiKey: "k", fetchImpl: impl });
    await expect(
      adapter.checkStatus!({ externalId: "runware:200@1", requestId: "t" }),
    ).rejects.toMatchObject({ status: 503, name: "RunwareMediaError" });
  });
});

// Wired through the media router: a capped Runware route falls over to fal,
// exercising RunwareMediaError(429) → isRetryableError → next provider.
describe("createRunwareMediaAdapter via createMediaLCR", () => {
  const registry: MediaRegistry = {
    "bfl/flux-schnell": {
      id: "bfl/flux-schnell",
      modality: "image",
      routes: [
        { provider: "runware", externalId: "runware:100@1", pricing: { unit: "image", cents: 0.14 } },
        { provider: "fal", externalId: "fal-ai/flux/schnell", pricing: { unit: "image", cents: 0.3 } },
      ],
    },
  };

  it("falls over from a capped Runware to the next provider", async () => {
    const { impl } = stubFetch({ error: "Insufficient credits" }, { ok: false, status: 402 });
    const onError = vi.fn();
    const generate = createMediaLCR({
      registry,
      adapters: {
        runware: createRunwareMediaAdapter({ apiKey: "k", fetchImpl: impl }),
        fal: { provider: "fal", run: async () => ({ outputs: [{ url: "https://fal.media/x.jpg", type: "image" }] }) },
      },
      onError,
    });

    const result = await generate("bfl/flux-schnell", { positivePrompt: "x" });

    expect(result.provider).toBe("fal"); // Runware capped (402) → fell over
    expect(onError).toHaveBeenCalledOnce();
  });
});
