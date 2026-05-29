/**
 * Kunavo media adapter — image (sync) + video (async poll).
 *
 * Kunavo is NOT an AI-SDK chat provider for media: image/video generation uses
 * its own REST endpoints, not `/v1/chat/completions`. So this is a hand-rolled
 * `MediaAdapter`, not a `createOpenAICompatible` wrapper.
 *
 *   - Image:  POST /v1/images/generations  → returns a files.kunavo.com URL.
 *             Synchronous (~11s for nano-banana). VERIFIED end-to-end.
 *   - Video:  POST /v1/video/generations   (singular "video"; /videos/ → 405).
 *             Long-running. The submit→poll path here is IMPLEMENTED FROM THE
 *             DOCS SHAPE BUT NOT YET RUN against a real job (veo-3 generation
 *             was skipped to save cost). Treat the poll loop as unverified:
 *             the field names (`id`/`status`/`url`) may differ from what the
 *             live API returns. Verify before relying on video in production.
 *
 * Kunavo does NOT return a per-call cost in the generation response, so cost is
 * left to the router's normalized estimate (MediaGenerateResult.costCents
 * stays undefined; `units` defaults to 1 — one image / one clip per call).
 */
import type {
  MediaAdapter,
  MediaGenerateRequest,
  MediaGenerateResult,
  MediaOutput,
} from "../media";

export interface KunavoMediaConfig {
  apiKey: string;
  /** Override for testing. Defaults to https://api.kunavo.com. */
  baseUrl?: string;
  /** Video poll cadence (ms). Default 5000. */
  pollIntervalMs?: number;
  /** Max time to wait for a video job before giving up (ms). Default 300000 (5m). */
  pollTimeoutMs?: number;
  /** Injected for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = "https://api.kunavo.com";

/** Pull every URL out of an OpenAI-images-style `{ data: [{ url }] }` body. */
function extractImageUrls(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((d) => (d as { url?: string })?.url)
    .filter((u): u is string => typeof u === "string" && u.length > 0);
}

export function createKunavoMediaAdapter(config: KunavoMediaConfig): MediaAdapter {
  const {
    apiKey,
    baseUrl = DEFAULT_BASE,
    pollIntervalMs = 5000,
    pollTimeoutMs = 300_000,
    fetchImpl = fetch,
  } = config;

  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };

  async function runImage(req: MediaGenerateRequest): Promise<MediaGenerateResult> {
    const res = await fetchImpl(`${baseUrl}/v1/images/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: req.externalId, ...req.input }),
    });
    if (!res.ok) {
      throw new KunavoMediaError(res.status, await safeText(res));
    }
    const body = await res.json();
    const urls = extractImageUrls(body);
    if (urls.length === 0) {
      throw new Error(`ai-lcr: Kunavo returned no image URL for "${req.externalId}"`);
    }
    const outputs: MediaOutput[] = urls.map((url) => ({ url, type: "image" }));
    return { outputs };
  }

  async function runVideo(req: MediaGenerateRequest): Promise<MediaGenerateResult> {
    // ⚠️ Unverified poll path — see file header.
    const submit = await fetchImpl(`${baseUrl}/v1/video/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: req.externalId, ...req.input }),
    });
    if (!submit.ok) {
      throw new KunavoMediaError(submit.status, await safeText(submit));
    }
    const submitBody = (await submit.json()) as Record<string, unknown>;

    // Some video APIs return the finished clip inline; if so, take it.
    const inlineUrls = extractImageUrls(submitBody);
    if (inlineUrls.length > 0) {
      return { outputs: inlineUrls.map((url) => ({ url, type: "video" })) };
    }

    const jobId = (submitBody.id ?? submitBody.task_id ?? submitBody.request_id) as
      | string
      | undefined;
    if (!jobId) {
      throw new Error(
        `ai-lcr: Kunavo video submit returned no job id (got keys: ${Object.keys(
          submitBody,
        ).join(", ")})`,
      );
    }

    const deadline = Date.now() + pollTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      const poll = await fetchImpl(`${baseUrl}/v1/video/generations/${jobId}`, {
        headers,
      });
      if (!poll.ok) {
        throw new KunavoMediaError(poll.status, await safeText(poll));
      }
      const pollBody = (await poll.json()) as Record<string, unknown>;
      const status = String(pollBody.status ?? "").toLowerCase();
      if (status === "succeeded" || status === "completed" || status === "success") {
        const urls = extractImageUrls(pollBody);
        const direct = pollBody.url as string | undefined;
        const all = urls.length > 0 ? urls : direct ? [direct] : [];
        if (all.length === 0) {
          throw new Error(`ai-lcr: Kunavo video job ${jobId} finished with no URL`);
        }
        return { outputs: all.map((url) => ({ url, type: "video" })) };
      }
      if (status === "failed" || status === "error") {
        throw new Error(
          `ai-lcr: Kunavo video job ${jobId} failed: ${JSON.stringify(pollBody)}`,
        );
      }
    }
    throw new Error(`ai-lcr: Kunavo video job ${jobId} timed out after ${pollTimeoutMs}ms`);
  }

  return {
    provider: "kunavo",
    async run(req: MediaGenerateRequest): Promise<MediaGenerateResult> {
      // Video model ids on Kunavo are the veo-* family; everything else is image.
      const isVideo = /(^|\/)veo/i.test(req.externalId);
      return isVideo ? runVideo(req) : runImage(req);
    },
  };
}

/** Carries the HTTP status so the router's `isRetryableError` can classify it. */
export class KunavoMediaError extends Error {
  constructor(
    public status: number,
    body: string,
  ) {
    super(`Kunavo media HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "KunavoMediaError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}
