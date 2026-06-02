/**
 * Human-readable one-liner for a {@link CallRecord}.
 *
 * Turns a settled request into a single line you can scan: a status glyph, the
 * logical model, the provider chain (with arrows when a failover happened),
 * latency, cost, and — when anything failed — the reason for each failed hop.
 *
 *   ✓ text  tokenmart                      412ms  $0.0003
 *   ✓ text  tokenmart                      412ms (ttft 88ms)  $0.0003   ← streaming: TTFT shown when known
 *   ⚠ text  tokenmart→openrouter           910ms  $0.0004   ⤷ tokenmart 502
 *   ✗ text  deepseek→tokenmart→openrouter  1240ms FAILED    ⤷ deepseek 401, tokenmart 502, openrouter 429
 *
 * Pure, zero-dependency. Pipe it wherever: `onCall: (r) => console.log(formatCallRecord(r))`.
 */
import type { CallRecord } from "./fallback";

export interface FormatOptions {
  /** Wrap the line in ANSI colors (green/yellow/red by status). Default false. */
  color?: boolean;
}

const COLOR = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
} as const;

function formatCost(record: CallRecord): string {
  if (!record.ok) return "FAILED";
  return record.costUsd > 0 ? `$${record.costUsd.toFixed(4)}` : "$0";
}

export function formatCallRecord(record: CallRecord, opts: FormatOptions = {}): string {
  const glyph = !record.ok ? "✗" : record.failedOver ? "⚠" : "✓";
  const chain = record.attempts.map((a) => a.provider).join("→") || record.winner || "—";
  const status = formatCost(record);

  // TTFT (streaming only) rides alongside total latency when known.
  const timing =
    record.ttftMs !== undefined
      ? `${record.latencyMs}ms (ttft ${record.ttftMs}ms)`
      : `${record.latencyMs}ms`;
  let line = `${glyph} ${record.model}  ${chain}  ${timing}  ${status}`;

  // Savings vs the priciest priced leg — the headline the dashboard cares about.
  if (record.ok && record.baselineUsd !== undefined && record.baselineUsd > record.costUsd) {
    line += `  (saved $${(record.baselineUsd - record.costUsd).toFixed(4)})`;
  }
  // A winner that reported no usage: cost/credit metering read 0 — flag it.
  if (record.usageMissing) line += `  ⚠no-usage`;

  const failed = record.attempts.filter((a) => !a.ok);
  if (failed.length > 0) {
    const reasons = failed.map((a) => `${a.provider} ${a.errorClass ?? "error"}`).join(", ");
    line += `  ⤷ ${reasons}`;
  }

  if (opts.color) {
    const c = !record.ok ? COLOR.red : record.failedOver ? COLOR.yellow : COLOR.green;
    return `${c}${line}${COLOR.reset}`;
  }
  return line;
}
