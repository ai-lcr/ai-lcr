import { describe, expect, it, vi } from "vitest";
import { createMediaLCR } from "../media";
import { MEDIA_PRICING } from "../media-registry";
import { createRunwareMediaAdapter } from "./runware-media";
import { createTokenifyVideoAdapter } from "./tokenify-video";

const model = "bytedance/seedance-2-0-mini";
const videoUrl = "https://example.test/out.mp4";
const sourceUrl = "https://example.test/source.mp4";

describe("Tokenify Seedance Mini video", () => {
  it("selects the video-input tier and settles the reported charge after a transient poll error", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "job" }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        status: "succeeded",
        content: { video_url: videoUrl },
        pricing: { cost_micro: 53_887 },
        usage: { completion_tokens: 42_768 },
      }));
    const onCost = vi.fn();
    const lcr = createMediaLCR({
      registry: MEDIA_PRICING,
      adapters: { tokenify: createTokenifyVideoAdapter({ apiKey: "test", fetchImpl }) },
      onCost,
    });
    const handle = await lcr.submit(model, {
      prompt: "Continue the shot",
      video_url: sourceUrl,
      resolution: "480p",
      aspect_ratio: "16:9",
      duration: 4,
      generate_audio: false,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.tokenify.dev/contents/generations/tasks");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      model: "bytedance/seedance-2.0-mini",
      content: [
        { type: "text", text: "Continue the shot" },
        { type: "video_url", role: "reference_video", video_url: { url: sourceUrl } },
      ],
      resolution: "480p",
      ratio: "16:9",
      duration: 4,
      generate_audio: false,
      watermark: false,
    });
    expect(handle.pricing?.cents).toBeCloseTo(1.347175);
    expect(await lcr.poll(handle)).toMatchObject({ done: false, status: "running" });
    expect(await lcr.poll(JSON.parse(JSON.stringify(handle)))).toMatchObject({
      done: true, costCents: 5.3887, outputs: [{ type: "video", url: videoUrl }],
    });
    expect(onCost).toHaveBeenCalledWith(expect.objectContaining({ provider: "tokenify", estimated: false }));
  });

  it("uses the same resolution and frame on Runware after a terminal job failure", async () => {
    const tokenifyFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "job" }))
      .mockResolvedValueOnce(Response.json({ status: "failed", error: { code: "queue_wait_exceeded" } }));
    const runwareFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data: [] }));
    const lcr = createMediaLCR({
      registry: MEDIA_PRICING,
      adapters: {
        tokenify: createTokenifyVideoAdapter({ apiKey: "test", fetchImpl: tokenifyFetch }),
        runware: createRunwareMediaAdapter({ apiKey: "test", fetchImpl: runwareFetch }),
      },
    });
    const imageUrl = "https://example.test/first.jpg";
    const handle = await lcr.submit(model, { prompt: "Drift", image_url: imageUrl, resolution: "480p", duration: 4 });
    expect(handle.provider).toBe("tokenify");
    expect(await lcr.poll(handle)).toMatchObject({
      done: false, failedOver: true, handle: { provider: "runware", pricing: { cents: 3.6 } },
    });
    expect(JSON.parse(String(runwareFetch.mock.calls[0]?.[1]?.body))).toMatchObject([{
      model: "bytedance:seedance@2.0-mini",
      positivePrompt: "Drift",
      resolution: "480p",
      duration: 4,
      inputs: { frameImages: [{ image: imageUrl, frame: "first" }] },
    }]);
  });

  it("does not start a second job when an accepted Tokenify job is still running at the deadline", async () => {
    const tokenifyFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "job" }))
      .mockResolvedValueOnce(Response.json({ status: "running" }));
    const runwareFetch = vi.fn<typeof fetch>();
    let now = 10;
    const lcr = createMediaLCR({
      registry: MEDIA_PRICING,
      adapters: {
        tokenify: createTokenifyVideoAdapter({ apiKey: "test", fetchImpl: tokenifyFetch }),
        runware: createRunwareMediaAdapter({ apiKey: "test", fetchImpl: runwareFetch }),
      },
      now: () => now,
    });
    const handle = await lcr.submit(model, { prompt: "Drift", resolution: "480p", duration: 4 }, { deadlineMs: 1000 });
    now += 1001;
    await expect(lcr.poll(handle)).rejects.toThrow("hit its timeout");
    expect(runwareFetch).not.toHaveBeenCalled();
  });
});
