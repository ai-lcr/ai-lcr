/**
 * Kunavo media adapter — image (sync) + video (async poll, sync fallback).
 *
 * Kunavo is NOT an AI-SDK chat provider for media: image/video generation uses
 * its own REST endpoints, not `/v1/chat/completions`. So this is a hand-rolled
 * `MediaAdapter`, not a `createOpenAICompatible` wrapper. All paths VERIFIED
 * live against the real API (image 2026-05-31, edit + async video 2026-06-06).
 *
 *   - Image gen:  POST /v1/images/generations  → { created, data:[{url}] }.
 *                 Synchronous (~11s nano-banana, ~42s nano-banana-2).
 *   - Image edit: POST /v1/images/edits         → same shape. Triggered for
 *                 `*-edit` slugs (nano-banana-edit, gpt-image-2-edit); the
 *                 caller supplies `image` (url/data-uri) or `image_urls[]`.
 *   - Video:      Kunavo has TWO video endpoints; this adapter defaults to the
 *                 ASYNC one (Kunavo's own "recommended for production"):
 *                   submit  POST /v1/videos        → { id:"vid_…", status }
 *                   poll    GET  /v1/videos/{id}    → status queued→in_progress
 *                                                     →completed, output:{url,urls}
 *                 Set `videoMode:"sync"` to use the blocking single-call path
 *                 POST /v1/video/generations instead (returns { data:[{url}] }
 *                 inline, ~108s for veo-3-lite; longer SKUs need a long timeout).
 *
 * Kunavo does NOT return a per-call cost in the generation response, and
 * `GET /v1/models` carries no pricing — so cost is left to the router's
 * normalized estimate (MediaGenerateResult.costCents stays undefined; `units`
 * defaults to 1 — one image / one clip per call).
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
  /**
   * Video execution path. "async" (default) submits to POST /v1/videos and
   * polls GET /v1/videos/{id} — non-blocking, survives proxy/LB connection
   * limits, and is Kunavo's recommended production path. "sync" uses the
   * blocking POST /v1/video/generations single call.
   */
  videoMode?: "async" | "sync";
  /** Async-video poll cadence (ms). Default 5000. */
  pollIntervalMs?: number;
  /** Max time to wait for an async video job before giving up (ms). Default 600000 (10m). */
  pollTimeoutMs?: number;
  /** Hard cap for the blocking sync-video HTTP call (ms). Default 600000 (10m). */
  syncVideoTimeoutMs?: number;
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

/**
 * Pull video URLs out of an async-poll body. A completed job carries
 * `output: { url, urls:[…] }`; we also accept a few defensive fallbacks
 * (top-level `url`, or an images-style `data[]`) in case the shape drifts.
 */
function extractVideoUrls(body: Record<string, unknown>): string[] {
  const output = body.output as { url?: string; urls?: unknown } | undefined;
  if (output) {
    if (Array.isArray(output.urls)) {
      const urls = output.urls.filter((u): u is string => typeof u === "string" && u.length > 0);
      if (urls.length > 0) return urls;
    }
    if (typeof output.url === "string" && output.url.length > 0) return [output.url];
  }
  if (typeof body.url === "string" && body.url.length > 0) return [body.url];
  return extractImageUrls(body);
}

export function createKunavoMediaAdapter(config: KunavoMediaConfig): MediaAdapter {
  const {
    apiKey,
    baseUrl = DEFAULT_BASE,
    videoMode = "async",
    pollIntervalMs = 5000,
    pollTimeoutMs = 600_000,
    syncVideoTimeoutMs = 600_000,
    fetchImpl = fetch,
  } = config;

  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };

  async function runImage(req: MediaGenerateRequest): Promise<MediaGenerateResult> {
    // `*-edit` slugs (nano-banana-edit, gpt-image-2-edit) take a reference image
    // and route to the edits endpoint; everything else is text-to-image.
    const path = /-edit$/i.test(req.externalId) ? "/v1/images/edits" : "/v1/images/generations";
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: req.externalId, ...req.input }),
    });
    if (!res.ok) {
      throw new KunavoMediaError(res.status, await safeText(res));
    }
    const urls = extractImageUrls(await res.json());
    if (urls.length === 0) {
      throw new Error(`ai-lcr: Kunavo returned no image URL for "${req.externalId}"`);
    }
    const outputs: MediaOutput[] = urls.map((url) => ({ url, type: "image" }));
    return { outputs };
  }

  /** Async path: POST /v1/videos → poll GET /v1/videos/{id} until terminal. */
  async function runVideoAsync(req: MediaGenerateRequest): Promise<MediaGenerateResult> {
    const submit = await fetchImpl(`${baseUrl}/v1/videos`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: req.externalId, ...req.input }),
    });
    if (!submit.ok) {
      throw new KunavoMediaError(submit.status, await safeText(submit));
    }
    const submitBody = (await submit.json()) as Record<string, unknown>;
    const jobId = submitBody.id as string | undefined;
    if (!jobId) {
      throw new Error(
        `ai-lcr: Kunavo video submit returned no job id (got keys: ${Object.keys(submitBody).join(
          ", ",
        )})`,
      );
    }

    const deadline = Date.now() + pollTimeoutMs;
    while (Date.now() < deadline) {
      const poll = await fetchImpl(`${baseUrl}/v1/videos/${jobId}`, { headers });
      if (!poll.ok) {
        throw new KunavoMediaError(poll.status, await safeText(poll));
      }
      const body = (await poll.json()) as Record<string, unknown>;
      const status = String(body.status ?? "").toLowerCase();
      if (status === "completed" || status === "succeeded" || status === "success") {
        const urls = extractVideoUrls(body);
        if (urls.length === 0) {
          throw new Error(`ai-lcr: Kunavo video job ${jobId} completed with no URL`);
        }
        return { outputs: urls.map((url) => ({ url, type: "video" })) };
      }
      if (status === "failed" || status === "error") {
        const err = body.error as { message?: string } | undefined;
        throw new Error(
          `ai-lcr: Kunavo video job ${jobId} failed: ${err?.message ?? JSON.stringify(body)}`,
        );
      }
      // queued / in_progress → keep waiting.
      await sleep(pollIntervalMs);
    }
    // Surface as a 504 so the router classifies it retryable and fails over.
    throw new KunavoMediaError(
      504,
      `Kunavo video job ${jobId} timed out after ${pollTimeoutMs}ms`,
    );
  }

  /** Sync path: POST /v1/video/generations blocks and returns the clip inline. */
  async function runVideoSync(req: MediaGenerateRequest): Promise<MediaGenerateResult> {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/v1/video/generations`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: req.externalId, ...req.input }),
        signal: AbortSignal.timeout(syncVideoTimeoutMs),
      });
    } catch (err) {
      // AbortSignal.timeout fires a TimeoutError with no HTTP status; remap to a
      // 504 so the router treats it as retryable and fails over.
      if ((err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError") {
        throw new KunavoMediaError(
          504,
          `Kunavo sync video timed out after ${syncVideoTimeoutMs}ms`,
        );
      }
      throw err;
    }
    if (!res.ok) {
      throw new KunavoMediaError(res.status, await safeText(res));
    }
    const urls = extractImageUrls(await res.json());
    if (urls.length === 0) {
      throw new Error(`ai-lcr: Kunavo sync video returned no URL for "${req.externalId}"`);
    }
    return { outputs: urls.map((url) => ({ url, type: "video" })) };
  }

  return {
    provider: "kunavo",
    async run(req: MediaGenerateRequest): Promise<MediaGenerateResult> {
      // Video model ids on Kunavo are the veo-* family; everything else is image.
      const isVideo = /(^|\/)veo/i.test(req.externalId);
      if (!isVideo) return runImage(req);
      return videoMode === "sync" ? runVideoSync(req) : runVideoAsync(req);
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
