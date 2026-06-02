/**
 * fal.ai media adapter — image generation (synchronous).
 *
 * fal exposes every model at `https://fal.run/<model-id>` (the synchronous API):
 * POST the model's inputs as a flat JSON body, get the result back in the same
 * response. This adapter passes the caller's `input` straight through, so any
 * fal image model and any of its parameters (prompt, image_size, num_images,
 * image_url for i2i/edit, …) work without this adapter knowing about them — it
 * stays generic, not tied to one model family.
 *
 * Auth: fal uses `Authorization: Key <FAL_KEY>` (NOT a Bearer token).
 *
 * Errors: fal returns a proper HTTP status — 401 (bad key), 403 (insufficient
 * balance / no permission), 422 (bad input), 429 (rate limit), 5xx. We surface
 * the status on the thrown error so the router's `isRetryableError` can decide
 * whether to fail over. A 403 "exhausted balance" is retryable (fall over to the
 * next provider); a 422 bad-input is not (don't waste the fallbacks).
 *
 * Cost: the synchronous response does NOT carry a per-call price (fal billing is
 * a separate account-level API), so `costCents` stays undefined and the router
 * falls back to its normalized estimate — same contract as the Kunavo adapter.
 *
 * Video: fal video (e.g. veo3.1) is a long-running queue job, a different code
 * path — out of scope here, like the Runware adapter. Image inference only.
 */
import type {
  MediaAdapter,
  MediaGenerateRequest,
  MediaGenerateResult,
  MediaOutput,
} from "../media";

export interface FalMediaConfig {
  apiKey: string;
  /** Override for testing. Defaults to https://fal.run. */
  baseUrl?: string;
  /** Injected for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = "https://fal.run";

interface FalImage {
  url?: string;
}

interface FalResponse {
  /** The common shape: an array of generated images. */
  images?: FalImage[];
  /** Some single-output models return one image/file directly. */
  image?: FalImage;
  /** Validation / error bodies. `detail` may be a string or an array of issues. */
  detail?: string | { msg?: string }[];
  message?: string;
  error?: string;
}

/** Pull every image URL out of a fal response (`images[]`, then a lone `image`). */
function extractImageUrls(body: FalResponse): string[] {
  const fromArray = (body.images ?? [])
    .map((im) => im?.url)
    .filter((u): u is string => typeof u === "string" && u.length > 0);
  if (fromArray.length > 0) return fromArray;
  const single = body.image?.url;
  return typeof single === "string" && single.length > 0 ? [single] : [];
}

/** Best-effort human message from a fal error body. */
function errorMessage(body: FalResponse): string {
  if (typeof body.detail === "string") return body.detail;
  if (Array.isArray(body.detail)) {
    const msgs = body.detail.map((d) => d?.msg).filter(Boolean);
    if (msgs.length > 0) return msgs.join("; ");
  }
  return body.error || body.message || "unknown";
}

export function createFalMediaAdapter(config: FalMediaConfig): MediaAdapter {
  const { apiKey, baseUrl = DEFAULT_BASE, fetchImpl = fetch } = config;

  return {
    provider: "fal",
    async run(req: MediaGenerateRequest): Promise<MediaGenerateResult> {
      // fal takes the model inputs as a flat body at https://fal.run/<model-id>.
      const res = await fetchImpl(`${baseUrl}/${req.externalId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Key ${apiKey}`,
          accept: "application/json",
        },
        body: JSON.stringify(req.input),
      });

      let body: FalResponse;
      try {
        body = (await res.json()) as FalResponse;
      } catch {
        body = {};
      }

      if (!res.ok) {
        // Status carries the failover signal: 403 "exhausted balance" / 429 /
        // 5xx are retryable (→ next provider); 401/422 classify accordingly.
        throw new FalMediaError(res.status, errorMessage(body));
      }

      const urls = extractImageUrls(body);
      if (urls.length === 0) {
        throw new Error(`ai-lcr: fal returned no image URL for "${req.externalId}"`);
      }

      const outputs: MediaOutput[] = urls.map((url) => ({ url, type: "image" }));
      return { outputs, units: outputs.length };
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
