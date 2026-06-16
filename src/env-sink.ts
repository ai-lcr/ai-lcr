/**
 * Convention-based sink — reads LCR_INGEST_URL / LCR_PROJECT / LCR_INGEST_KEY
 * from env and returns a ready-to-use `onCall` handler (or undefined when
 * LCR_INGEST_URL is unset, so local dev / CI stays quiet by default).
 *
 * Every portfolio app had an identical 30-line sink.ts that did exactly this.
 * Now it's one import:
 *
 *   import { createEnvSink } from "ai-lcr";
 *   import { after } from "next/server";
 *   export const lcrCallSink = createEnvSink(after);
 *
 * `dispatch` is the only required arg because it's framework-specific (Next.js
 * `after`, Cloudflare `ctx.waitUntil`, plain `(fn) => void fn()` for long-lived
 * servers). Everything else comes from env.
 */
import { createHttpSink } from "./sink";
import type { CallRecord } from "./fallback";

/**
 * Build an `onCall` sink from env vars, or return undefined when
 * `LCR_INGEST_URL` is not set.
 *
 * Env vars read:
 *   - `LCR_INGEST_URL`  — dashboard origin (required for the sink to activate)
 *   - `LCR_PROJECT`     — project tag; falls back to `SITE_KEY` (freeart compat)
 *   - `LCR_INGEST_KEY`  — optional Bearer token
 */
export function createEnvSink(
  dispatch: (task: () => void | Promise<void>) => void,
): ((record: CallRecord) => void) | undefined {
  const base = process.env.LCR_INGEST_URL?.replace(/\/+$/, "");
  if (!base) return undefined;
  return createHttpSink({
    url: `${base}/api/ingest`,
    headers: process.env.LCR_INGEST_KEY
      ? { authorization: `Bearer ${process.env.LCR_INGEST_KEY}` }
      : undefined,
    project: process.env.LCR_PROJECT ?? process.env.SITE_KEY,
    dispatch,
    onError: (err) => console.error("[lcr] ingest POST failed:", err),
  });
}
