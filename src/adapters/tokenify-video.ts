import type { MediaAdapter } from "../media";

export interface TokenifyVideoConfig {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface TokenifyVideoResponse {
  id?: string;
  status?: string;
  content?: { video_url?: string };
  duration?: number;
  pricing?: { cost_micro?: number };
  error?: { code?: string; message?: string };
}

export function createTokenifyVideoAdapter({
  apiKey,
  baseUrl = "https://api.tokenify.dev",
  fetchImpl = fetch,
}: TokenifyVideoConfig): MediaAdapter {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/contents/generations/tasks`;
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  return {
    provider: "tokenify",
    failoverOnTimeout: false,
    async run() {
      throw new Error("ai-lcr: Tokenify video uses submit() and poll()");
    },
    async submit({ externalId, input }) {
      const { prompt, image_url, video_url, aspect_ratio, resolution, duration, generate_audio } = input;
      if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Tokenify video requires a prompt");
      if (input.end_image_url || (Array.isArray(input.image_urls) && input.image_urls.length > 0) ||
          input.audio_url || (image_url && video_url)) {
        throw new Error("Tokenify video accepts a first image or a source video");
      }
      const content: Record<string, unknown>[] = [{ type: "text", text: prompt }];
      if (typeof image_url === "string" && image_url) content.push({ type: "image_url", image_url: { url: image_url } });
      if (typeof video_url === "string" && video_url) {
        content.push({ type: "video_url", role: "reference_video", video_url: { url: video_url } });
      }
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: externalId, content, resolution, duration,
          ratio: aspect_ratio, generate_audio, watermark: false,
        }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => {
        // A disconnected submit may already have created a billable job.
        throw new Error("Tokenify video submission outcome is unknown");
      });
      const body = await response.json().catch(() => ({})) as TokenifyVideoResponse;
      if (response.status === 408 || response.status >= 500) {
        throw new Error("Tokenify video submission outcome is unknown");
      }
      if (!response.ok) {
        throw Object.assign(
          new Error(`Tokenify video submit: ${body.error?.message ?? response.statusText}`),
          { status: response.status },
        );
      }
      if (!body.id) throw new Error("Tokenify video submission returned no job ID");
      return { requestId: body.id };
    },
    async checkStatus({ requestId }) {
      const response = await fetchImpl(`${endpoint}/${encodeURIComponent(requestId)}`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined);
      // Keep polling the accepted job through transient read failures.
      if (!response || response.status === 429 || response.status >= 500) return { status: "running" };
      const body = await response.json().catch(() => ({})) as TokenifyVideoResponse;
      if (!response.ok) {
        throw new Error(`Tokenify video poll (${response.status}): ${body.error?.code ?? response.statusText}`);
      }
      if (body.status === "queued" || body.status === "running") return { status: body.status };
      if (body.status === "failed" || body.status === "cancelled") {
        return { status: "error", error: body.error?.message ?? body.error?.code ?? `Tokenify video ${body.status}` };
      }
      if (body.status !== "succeeded") return { status: "running" };
      if (!body.content?.video_url) throw new Error("Tokenify video finished without a URL");
      const cost = body.pricing?.cost_micro;
      return {
        status: "done",
        outputs: [{ type: "video", url: body.content.video_url }],
        usage: { outputs: 1, ...(body.duration !== undefined ? { seconds: body.duration } : {}) },
        ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { costCents: cost / 10_000 } : {}),
      };
    },
  };
}
