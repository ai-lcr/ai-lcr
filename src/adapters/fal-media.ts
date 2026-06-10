/**
 * fal media adapter — image (queue) + video (queue, async poll).
 *
 * fal serves every model through one async queue API, so a single submit→poll→
 * fetch-result path covers both image and video. That is the whole reason this
 * adapter exists: it is ai-lcr's first VIDEO-capable execution path. (The
 * Runware adapter is image-only; the Kunavo one's video poll loop is unverified.)
 *
 * Implementation note: ai-art's fal adapter uses the `@fal-ai/client` SDK, but
 * ai-lcr deliberately keeps zero provider SDKs — every adapter is raw `fetch`
 * with an injectable `fetchImpl` for testing (see runware-media, kunavo-media).
 * So this re-implements the three queue calls against fal's REST endpoints:
 *
 *   1. submit  POST https://queue.fal.run/{model}        → { request_id, status_url, response_url }
 *   2. status  GET  {status_url}                         → { status: IN_QUEUE | IN_PROGRESS | COMPLETED }
 *   3. result  GET  {response_url}                        → { images:[…] } | { video:{url} } | …
 *
 * We follow the `status_url` / `response_url` returned by submit rather than
 * rebuilding them, which sidesteps fal's sub-path quirk (a model like
 * `fal-ai/flux/schnell` submits to the full path but its status/result live
 * under the `fal-ai/flux` base).
 *
 * Auth: fal uses `Authorization: Key {FAL_KEY}` (NOT Bearer).
 *
 * Cost: fal's queue result does not carry a per-call price, so cost is left to
 * the router's normalized estimate (costCents stays undefined; `units` is the
 * output count — one image, or one clip).
 */
import type {
  MediaAdapter,
  MediaGenerateRequest,
  MediaGenerateResult,
  MediaModality,
  MediaOutput,
  MediaStatusRequest,
  MediaStatusResult,
  MediaSubmitRequest,
  MediaSubmitResult,
} from "../media";

export interface FalMediaConfig {
  apiKey: string;
  /** Override for testing. Defaults to https://queue.fal.run. */
  baseUrl?: string;
  /** Video/job poll cadence (ms). Default 3000. */
  pollIntervalMs?: number;
  /** Max time to wait for a job before giving up (ms). Default 300000 (5m). */
  pollTimeoutMs?: number;
  /** Injected for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = "https://queue.fal.run";

/** fal's submit response — only the fields we follow. */
interface FalSubmitResponse {
  request_id?: string;
  status_url?: string;
  response_url?: string;
}

interface FalStatusResponse {
  status?: string; // IN_QUEUE | IN_PROGRESS | COMPLETED
}

/**
 * Pull file URLs out of a fal result payload. fal returns outputs under a model-
 * dependent key: images as `images:[{url}]` or singular `image:{url}`; video as
 * `video:{url}` or `videos:[{url}]`. Returns typed MediaOutputs.
 */
function extractOutputs(raw: unknown): MediaOutput[] {
  if (!raw || typeof raw !== "object") return [];
  const data = raw as Record<string, unknown>;
  const out: MediaOutput[] = [];

  const pushUrl = (url: unknown, type: MediaModality) => {
    if (typeof url === "string" && url.length > 0) out.push({ url, type });
  };

  // Image (plural / singular).
  if (Array.isArray(data.images)) {
    for (const img of data.images) pushUrl((img as { url?: string })?.url, "image");
  }
  pushUrl((data.image as { url?: string } | undefined)?.url, "image");

  // Video (plural / singular).
  if (Array.isArray(data.videos)) {
    for (const v of data.videos) pushUrl((v as { url?: string })?.url, "video");
  }
  pushUrl((data.video as { url?: string } | undefined)?.url, "video");

  return out;
}

export function createFalMediaAdapter(config: FalMediaConfig): MediaAdapter {
  const {
    apiKey,
    baseUrl = DEFAULT_BASE,
    pollIntervalMs = 3000,
    pollTimeoutMs = 300_000,
    fetchImpl = fetch,
  } = config;

  const headers = {
    "content-type": "application/json",
    authorization: `Key ${apiKey}`,
  };

  /**
   * fal's queue base for a model id. fal hosts status/result under the app's
   * owner/app pair, NOT the full endpoint path — `fal-ai/flux/schnell` polls
   * under `fal-ai/flux`. The blocking `run()` dodges this by following submit's
   * returned `status_url`/`response_url`; the cross-process `checkStatus` has only
   * the id, so it reconstructs the documented queue path from the first two
   * segments. (Single-segment ids are passed through unchanged.)
   */
  const queueBase = (externalId: string) => externalId.split("/").slice(0, 2).join("/");

  /** Async submit: POST queue.fal.run/{model} → { request_id }. */
  async function submit(req: MediaSubmitRequest): Promise<MediaSubmitResult> {
    const submitRes = await fetchImpl(`${baseUrl}/${req.externalId}`, {
      method: "POST",
      headers,
      body: JSON.stringify(req.input),
    });
    if (!submitRes.ok) {
      throw new FalMediaError(submitRes.status, await safeText(submitRes));
    }
    const body = (await submitRes.json()) as FalSubmitResponse;
    if (!body.request_id) {
      throw new Error(
        `ai-lcr: fal submit for "${req.externalId}" returned no request_id (keys: ${Object.keys(
          body,
        ).join(", ")})`,
      );
    }
    return { requestId: body.request_id };
  }

  /**
   * Poll one queued job. A non-2xx on the status or result fetch THROWS a
   * {@link FalMediaError} (carrying the HTTP status) so the router classifies it
   * and fails over; a COMPLETED job with no extractable output RETURNS
   * `{ status:"error" }`.
   */
  async function checkStatus(req: MediaStatusRequest): Promise<MediaStatusResult> {
    const base = queueBase(req.externalId);
    const statusRes = await fetchImpl(
      `${baseUrl}/${base}/requests/${req.requestId}/status`,
      { headers },
    );
    if (!statusRes.ok) {
      throw new FalMediaError(statusRes.status, await safeText(statusRes));
    }
    const status = String(((await statusRes.json()) as FalStatusResponse).status ?? "");
    if (status !== "COMPLETED") {
      // IN_QUEUE → queued; IN_PROGRESS / anything else in-flight → running.
      return { status: status === "IN_QUEUE" ? "queued" : "running" };
    }
    const resultRes = await fetchImpl(`${baseUrl}/${base}/requests/${req.requestId}`, { headers });
    if (!resultRes.ok) {
      throw new FalMediaError(resultRes.status, await safeText(resultRes));
    }
    const outputs = extractOutputs(await resultRes.json());
    if (outputs.length === 0) {
      return { status: "error", error: `fal job ${req.requestId} completed with no media URL` };
    }
    return { status: "done", outputs, units: outputs.length, usage: { outputs: outputs.length } };
  }

  return {
    provider: "fal",
    submit,
    checkStatus,
    async run(req: MediaGenerateRequest): Promise<MediaGenerateResult> {
      // 1. Submit to the queue. The model id IS the path, e.g. fal-ai/veo3.1.
      const submitRes = await fetchImpl(`${baseUrl}/${req.externalId}`, {
        method: "POST",
        headers,
        body: JSON.stringify(req.input),
      });
      if (!submitRes.ok) {
        throw new FalMediaError(submitRes.status, await safeText(submitRes));
      }
      const submit = (await submitRes.json()) as FalSubmitResponse;

      const statusUrl = submit.status_url;
      const responseUrl = submit.response_url;
      if (!statusUrl || !responseUrl) {
        throw new Error(
          `ai-lcr: fal submit for "${req.externalId}" returned no status/response URL (keys: ${Object.keys(
            submit,
          ).join(", ")})`,
        );
      }

      // 2. Poll status until COMPLETED.
      const deadline = Date.now() + pollTimeoutMs;
      let completed = false;
      while (Date.now() < deadline) {
        const statusRes = await fetchImpl(statusUrl, { headers });
        if (!statusRes.ok) {
          throw new FalMediaError(statusRes.status, await safeText(statusRes));
        }
        const status = String(((await statusRes.json()) as FalStatusResponse).status ?? "");
        if (status === "COMPLETED") {
          completed = true;
          break;
        }
        // IN_QUEUE / IN_PROGRESS → keep waiting. (fal has no terminal "FAILED"
        // status here; a failed job surfaces as a non-2xx on the result fetch.)
        await sleep(pollIntervalMs);
      }
      if (!completed) {
        throw new Error(
          `ai-lcr: fal job for "${req.externalId}" timed out after ${pollTimeoutMs}ms`,
        );
      }

      // 3. Fetch the result.
      const resultRes = await fetchImpl(responseUrl, { headers });
      if (!resultRes.ok) {
        throw new FalMediaError(resultRes.status, await safeText(resultRes));
      }
      const outputs = extractOutputs(await resultRes.json());
      if (outputs.length === 0) {
        throw new Error(`ai-lcr: fal returned no media URL for "${req.externalId}"`);
      }

      return { outputs, units: outputs.length, usage: { outputs: outputs.length } };
    },
  };
}

/** Carries the HTTP status so the router's `isRetryableError` can classify it. */
export class FalMediaError extends Error {
  constructor(
    public status: number,
    body: string,
  ) {
    super(`fal media HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "FalMediaError";
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
