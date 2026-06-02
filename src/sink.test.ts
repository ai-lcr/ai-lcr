import { describe, it, expect, vi } from "vitest";
import { createHttpSink, type CallRecord } from "./index";

function record(over: Partial<CallRecord> = {}): CallRecord {
  return {
    id: "abc",
    model: "text",
    attempts: [{ provider: "tokenmart", ok: true, latencyMs: 10 }],
    winner: "tokenmart",
    ok: true,
    failedOver: false,
    latencyMs: 10,
    inputTokens: 5,
    outputTokens: 3,
    costUsd: 0.0001,
    ...over,
  };
}

describe("createHttpSink", () => {
  it("POSTs the record as JSON to the configured url with headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("ok");
    }) as unknown as typeof fetch;

    const sink = createHttpSink({
      url: "https://collector.example/api/ingest",
      headers: { authorization: "Bearer k" },
      fetchImpl,
    });
    sink(record());
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget settle

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://collector.example/api/ingest");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer k");
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ id: "abc", winner: "tokenmart" });
  });

  it("merges the project tag into the payload", async () => {
    let body = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = init.body as string;
      return new Response("ok");
    }) as unknown as typeof fetch;

    createHttpSink({ url: "u", project: "freediagram", fetchImpl })(record());
    await new Promise((r) => setTimeout(r, 0));

    expect(JSON.parse(body)).toMatchObject({ project: "freediagram", id: "abc" });
  });

  it("never throws out of the handler when the POST fails; calls onError", async () => {
    const onError = vi.fn();
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const sink = createHttpSink({ url: "u", fetchImpl, onError });
    expect(() => sink(record())).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledOnce();
  });

  it("routes the POST through a custom dispatch (e.g. Next.js `after`)", async () => {
    const queued: Array<() => void | Promise<void>> = [];
    const dispatch = (task: () => void | Promise<void>) => queued.push(task);
    const fetchImpl = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;

    createHttpSink({ url: "u", dispatch, fetchImpl })(record());
    expect(fetchImpl).not.toHaveBeenCalled(); // deferred — not fired inline
    expect(queued).toHaveLength(1);
    await queued[0]!();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
