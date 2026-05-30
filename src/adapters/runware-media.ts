/**
 * Runware media adapter — image generation (sync).
 *
 * Runware exposes a single REST endpoint that takes an array of tasks. This
 * adapter wraps the `imageInference` task: it adds the boilerplate every call
 * needs (taskType, a taskUUID, single result, URL output, cost reporting) and
 * passes the caller's `input` straight through, so any Runware image model and
 * any of its parameters (positivePrompt, width/height, steps, CFGScale,
 * seedImage/strength for i2i, referenceImages for edit models, …) work without
 * this adapter knowing about them. That keeps it generic — it is NOT tied to
 * any one model family.
 *
 * Cost: Runware returns `cost` in US DOLLARS (when `includeCost` is on). The
 * media router works in CENTS, so we convert (×100) before reporting it as the
 * provider-reported actual cost.
 *
 * Video: Runware video is a different, async task type and is out of scope here
 * — this adapter handles image inference only.
 */
import type {
  MediaAdapter,
  MediaGenerateRequest,
  MediaGenerateResult,
  MediaOutput,
} from "../media";

export interface RunwareMediaConfig {
  apiKey: string;
  /** Override for testing. Defaults to https://api.runware.ai/v1. */
  baseUrl?: string;
  /** Injected for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = "https://api.runware.ai/v1";

interface RunwareImageResult {
  imageURL?: string;
  imageUrl?: string;
  url?: string;
  width?: number;
  height?: number;
  /** US dollars (Runware's includeCost field). */
  cost?: number;
}

interface RunwareResponse {
  data?: RunwareImageResult[];
  errors?: { code?: string; message?: string }[];
  error?: string;
  message?: string;
}

function imageUrl(r: RunwareImageResult): string | undefined {
  return r.imageURL || r.imageUrl || r.url;
}

function errorMessage(body: RunwareResponse): string {
  const errs = body.errors?.map((e) => e.message || e.code).filter(Boolean);
  return errs?.join("; ") || body.error || body.message || "unknown";
}

export function createRunwareMediaAdapter(config: RunwareMediaConfig): MediaAdapter {
  const { apiKey, baseUrl = DEFAULT_BASE, fetchImpl = fetch } = config;

  return {
    provider: "runware",
    async run(req: MediaGenerateRequest): Promise<MediaGenerateResult> {
      // Defaults first so the caller's `input` can override them; the infra
      // fields (taskType / taskUUID / model) are re-asserted afterwards so they
      // can't be clobbered.
      const task = {
        numberResults: 1,
        outputType: "URL",
        includeCost: true,
        ...req.input,
        taskType: "imageInference",
        taskUUID: crypto.randomUUID(),
        model: req.externalId,
      };

      const res = await fetchImpl(baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
        },
        body: JSON.stringify([task]),
      });

      let body: RunwareResponse;
      try {
        body = (await res.json()) as RunwareResponse;
      } catch {
        body = {};
      }

      // Runware can report failure either via a non-2xx status OR an `errors`
      // array on a 200. Surface a status so the router's isRetryableError can
      // classify it; for an error-on-200 use 502 (provider-side failure →
      // retryable → fall over to the next provider).
      if (!res.ok || body.errors?.length || body.error) {
        throw new RunwareMediaError(res.ok ? 502 : res.status, errorMessage(body));
      }

      const images = (body.data ?? []).filter((r) => imageUrl(r));
      if (images.length === 0) {
        throw new Error(`ai-lcr: Runware returned no image URL for "${req.externalId}"`);
      }

      const outputs: MediaOutput[] = images.map((r) => ({ url: imageUrl(r)!, type: "image" }));

      // Sum the per-image USD cost (when present) and convert dollars → cents.
      const costUsd = images.reduce<number | undefined>((sum, r) => {
        if (typeof r.cost !== "number") return sum;
        return (sum ?? 0) + r.cost;
      }, undefined);

      return {
        outputs,
        units: images.length,
        ...(costUsd !== undefined ? { costCents: costUsd * 100 } : {}),
      };
    },
  };
}

/** Carries the HTTP status so the router's `isRetryableError` can classify it. */
export class RunwareMediaError extends Error {
  constructor(
    public status: number,
    body: string,
  ) {
    super(`Runware media HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "RunwareMediaError";
  }
}
