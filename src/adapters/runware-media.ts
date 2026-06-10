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
 * Video: Runware video is a different, ASYNC task type (`videoInference` with
 * `deliveryMethod:"async"`, polled via `getResponse`). It is exposed through the
 * adapter's `submit`/`checkStatus` — the image path stays the synchronous
 * `run()`. As with images, input is passed straight through, so the caller
 * decides the video params (duration, resolution, frameImages, …).
 */
import type {
  MediaAdapter,
  MediaGenerateRequest,
  MediaGenerateResult,
  MediaOutput,
  MediaStatusRequest,
  MediaStatusResult,
  MediaSubmitRequest,
  MediaSubmitResult,
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
  videoURL?: string;
  videoUrl?: string;
  url?: string;
  width?: number;
  height?: number;
  /** Async poll status: "processing" | "success" | "error". */
  status?: string;
  error?: string;
  errorMessage?: string;
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

function mediaUrl(r: RunwareImageResult): string | undefined {
  return r.videoURL || r.videoUrl || imageUrl(r);
}

function errorMessage(body: RunwareResponse): string {
  const errs = body.errors?.map((e) => e.message || e.code).filter(Boolean);
  return errs?.join("; ") || body.error || body.message || "unknown";
}

export function createRunwareMediaAdapter(config: RunwareMediaConfig): MediaAdapter {
  const { apiKey, baseUrl = DEFAULT_BASE, fetchImpl = fetch } = config;

  /**
   * POST one Runware task array and return the parsed body. Runware can report
   * failure either via a non-2xx status OR an `errors` array on a 200 — both
   * throw a {@link RunwareMediaError} carrying a status (502 for error-on-200)
   * so the router classifies it and fails over.
   */
  async function postTask(task: Record<string, unknown>): Promise<RunwareResponse> {
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
    if (!res.ok || body.errors?.length || body.error) {
      throw new RunwareMediaError(res.ok ? 502 : res.status, errorMessage(body));
    }
    return body;
  }

  /** Sum per-item USD `cost` (when present) → cents. */
  function costCentsOf(items: RunwareImageResult[]): number | undefined {
    const costUsd = items.reduce<number | undefined>((sum, r) => {
      if (typeof r.cost !== "number") return sum;
      return (sum ?? 0) + r.cost;
    }, undefined);
    return costUsd === undefined ? undefined : costUsd * 100;
  }

  return {
    provider: "runware",
    async run(req: MediaGenerateRequest): Promise<MediaGenerateResult> {
      // Defaults first so the caller's `input` can override them; the infra
      // fields (taskType / taskUUID / model) are re-asserted afterwards so they
      // can't be clobbered.
      const body = await postTask({
        numberResults: 1,
        outputType: "URL",
        includeCost: true,
        ...req.input,
        taskType: "imageInference",
        taskUUID: crypto.randomUUID(),
        model: req.externalId,
      });

      const images = (body.data ?? []).filter((r) => imageUrl(r));
      if (images.length === 0) {
        throw new Error(`ai-lcr: Runware returned no image URL for "${req.externalId}"`);
      }
      const outputs: MediaOutput[] = images.map((r) => ({ url: imageUrl(r)!, type: "image" }));
      const cents = costCentsOf(images);
      return {
        outputs,
        units: images.length,
        usage: { outputs: images.length },
        ...(cents !== undefined ? { costCents: cents } : {}),
      };
    },

    // Async video: submit a `videoInference` task with our own taskUUID as the
    // request id; the async ack carries no URL — completion comes via checkStatus
    // (a `getResponse` poll). Image generation stays on the synchronous `run()`.
    async submit(req: MediaSubmitRequest): Promise<MediaSubmitResult> {
      const taskUUID = crypto.randomUUID();
      await postTask({
        outputType: "URL",
        includeCost: true,
        ...req.input,
        taskType: "videoInference",
        taskUUID,
        model: req.externalId,
        deliveryMethod: "async",
      });
      return { requestId: taskUUID };
    },

    async checkStatus(req: MediaStatusRequest): Promise<MediaStatusResult> {
      const body = await postTask({ taskType: "getResponse", taskUUID: req.requestId });
      const item = (body.data ?? [])[0];
      if (!item) return { status: "running" }; // not ready yet
      if (item.status === "success") {
        const url = mediaUrl(item);
        if (!url) return { status: "error", error: `Runware job ${req.requestId} succeeded with no URL` };
        const cents = costCentsOf([item]);
        return {
          status: "done",
          outputs: [{ url, type: "video" }],
          usage: { outputs: 1 },
          ...(cents !== undefined ? { costCents: cents } : {}),
        };
      }
      if (item.status === "error" || item.status === "failed") {
        return { status: "error", error: item.error ?? item.errorMessage ?? "generation failed" };
      }
      // "processing" / queued / anything else → keep polling.
      return { status: "running" };
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
