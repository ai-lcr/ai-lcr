/**
 * Optional HTTP sink for `onCall` — ship each {@link CallRecord} as JSON to a
 * collector (e.g. a self-hosted ai-lcr-dashboard `/api/ingest`, or any endpoint
 * that accepts the CallRecord shape).
 *
 * Fully optional and dashboard-agnostic: omit it and ai-lcr stores nothing;
 * point `url` at whatever you run. Logging must never break your app, so a
 * failed POST is swallowed by default (surface it via `onError` if you want).
 *
 *   import { createLCR, createHttpSink } from "ai-lcr";
 *   import { after } from "next/server"; // serverless: don't block the response
 *
 *   const lcr = createLCR({
 *     models: { ... },
 *     onCall: createHttpSink({
 *       url: process.env.LCR_INGEST_URL + "/api/ingest",
 *       headers: { authorization: `Bearer ${process.env.LCR_INGEST_KEY}` },
 *       project: process.env.LCR_PROJECT,
 *       dispatch: after, // run after the response is sent
 *     }),
 *   });
 */
import type { CallRecord } from "./fallback";

export interface HttpSinkOptions {
  /** Where to POST each CallRecord (a collector that accepts the JSON shape). */
  url: string;
  /** Extra headers, e.g. `{ authorization: ` + "`Bearer ${key}`" + ` }`. */
  headers?: Record<string, string>;
  /** Optional tenant/project tag merged into each payload (`{ project, ...record }`). */
  project?: string;
  /**
   * Wrap the dispatch so it survives a serverless function returning. On
   * Next.js pass `after` from "next/server"; elsewhere pass a `waitUntil`-style
   * function. Defaults to running immediately — correct for long-lived servers,
   * but on serverless an un-awaited POST may be cut off, so pass `after`.
   */
  dispatch?: (task: () => void | Promise<void>) => void;
  /** Custom fetch (tests / runtimes without a global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Called if the POST fails. Failures are swallowed by default. */
  onError?: (error: unknown) => void;
}

/**
 * Build an `onCall` handler that POSTs each {@link CallRecord} to `url`.
 * Returns a plain `(record) => void` — pass it straight to `createLCR`'s `onCall`.
 */
export function createHttpSink(options: HttpSinkOptions): (record: CallRecord) => void {
  const {
    url,
    headers,
    project,
    dispatch = (task) => {
      void task();
    },
    fetchImpl,
    onError,
  } = options;
  const doFetch = fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);

  return (record: CallRecord) => {
    if (!doFetch) {
      onError?.(new Error("ai-lcr: no fetch available for createHttpSink"));
      return;
    }
    const payload = project ? { project, ...record } : record;
    dispatch(async () => {
      try {
        await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(payload),
          keepalive: true,
        });
      } catch (err) {
        onError?.(err);
      }
    });
  };
}
