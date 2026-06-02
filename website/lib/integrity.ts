import { PROVIDERS, type IntegrityModel, type Provider } from "./providers";

/**
 * Daily integrity suite — a TypeScript port of scripts/check-provider.sh.
 *
 * "Cheapest list price" is meaningless if a provider silently deviates from the
 * wire protocol. These checks catch the deviations that cost money or corrupt
 * output: dropped tool calls, broken multi-step loops, ignored max_tokens, a
 * hidden injected system prompt, input-token over-counting (inflates the bill so
 * the "discount" is illusory), and missing prompt caching.
 */

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export type CheckResult = {
  provider: string;
  model: string;
  check_name: string;
  status: CheckStatus;
  detail: string | null;
};

const CALL_TIMEOUT_MS = 30_000;

const TOOL = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get current weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];

// A neutral message with NO system prompt, NO instructions, NO XML. If the model
// starts talking about "injection", "system prompt", "confidential" or "XML
// tags", the provider injected a hidden prompt the model is now reacting to.
const NEUTRAL =
  "The quick brown fox jumps over the lazy dog. This is a simple sentence used to measure tokenization accuracy across providers.";

const INJECTION_RE = /injection|system prompt|confidential|hidden prompt|xml tag/i;

function errMsg(e: unknown): string {
  const err = e as Error;
  return err?.name === "AbortError" ? `timeout (${CALL_TIMEOUT_MS / 1000}s)` : err?.message ?? String(e);
}

type ChatResp = { ok: boolean; status: number; json: unknown; text: string };

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<ChatResp> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* leave json null; text holds the raw body */
    }
    return { ok: r.ok, status: r.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function chat(base: string, key: string, body: Record<string, unknown>) {
  return postJson(`${base}/v1/chat/completions`, { Authorization: `Bearer ${key}` }, body);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function promptTokens(base: string, key: string, model: string): Promise<number> {
  try {
    const r = await chat(base, key, {
      model,
      max_tokens: 5,
      messages: [{ role: "user", content: NEUTRAL }],
    });
    const n = (r.json as any)?.usage?.prompt_tokens;
    return typeof n === "number" ? n : 0;
  } catch {
    return 0;
  }
}

// Steps 1 + 2: single tool call, then a multi-step round-trip that feeds the
// tool result back with assistant content:null (which the OpenAI spec allows).
async function toolChecks(provider: string, base: string, key: string, model: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const mk = (check_name: string, status: CheckStatus, detail: string | null): CheckResult => ({
    provider,
    model,
    check_name,
    status,
    detail,
  });

  let r: ChatResp;
  try {
    r = await chat(base, key, {
      model,
      messages: [{ role: "user", content: "Weather in Tokyo? Use the tool." }],
      tools: TOOL,
      tool_choice: "auto",
      max_tokens: 300,
    });
  } catch (e) {
    out.push(mk("tool_call", "fail", errMsg(e)));
    out.push(mk("multi_step", "skip", "tool_call step errored"));
    return out;
  }

  const tc = (r.json as any)?.choices?.[0]?.message?.tool_calls;
  const hasTC = Array.isArray(tc) && tc.length > 0;
  out.push(mk("tool_call", hasTC ? "pass" : "fail", hasTC ? null : "no tool_calls — tools dropped?"));

  const tcid: string | undefined = hasTC ? tc[0]?.id : undefined;
  if (!tcid) {
    out.push(mk("multi_step", "skip", "no tool_call id from step 1"));
    return out;
  }

  try {
    const r2 = await chat(base, key, {
      model,
      messages: [
        { role: "user", content: "Weather in Tokyo? Use the tool." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: tcid,
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: tcid, content: "18C and sunny" },
      ],
      tools: TOOL,
      max_tokens: 300,
    });
    const echoed = /18|sunny/i.test(r2.text);
    out.push(
      mk(
        "multi_step",
        echoed ? "pass" : "fail",
        echoed ? null : "assistant content:null rejected — breaks tool loops",
      ),
    );
  } catch (e) {
    out.push(mk("multi_step", "fail", errMsg(e)));
  }
  return out;
}

async function maxTokensCheck(provider: string, base: string, key: string, model: string): Promise<CheckResult> {
  try {
    const r = await chat(base, key, {
      model,
      messages: [{ role: "user", content: "Write five paragraphs about the ocean." }],
      max_tokens: 8,
    });
    const ct = (r.json as any)?.usage?.completion_tokens;
    const ok = typeof ct === "number" && ct <= 40;
    return {
      provider,
      model,
      check_name: "max_tokens",
      status: ok ? "pass" : "fail",
      detail: `completion_tokens=${ct ?? "?"} for cap 8`,
    };
  } catch (e) {
    return { provider, model, check_name: "max_tokens", status: "fail", detail: errMsg(e) };
  }
}

async function injectionCheck(provider: string, base: string, key: string, model: string): Promise<CheckResult> {
  try {
    const r = await chat(base, key, {
      model,
      max_tokens: 200,
      messages: [{ role: "user", content: NEUTRAL }],
    });
    const content: string = (r.json as any)?.choices?.[0]?.message?.content ?? "";
    const bad = INJECTION_RE.test(content);
    return {
      provider,
      model,
      check_name: "injection",
      status: bad ? "fail" : "pass",
      detail: bad ? `model reacted to content it was never sent: "${content.slice(0, 140)}…"` : null,
    };
  } catch (e) {
    return { provider, model, check_name: "injection", status: "fail", detail: errMsg(e) };
  }
}

async function tokenInflationCheck(
  provider: string,
  base: string,
  key: string,
  m: IntegrityModel,
  refBase: string,
  refKey: string,
): Promise<CheckResult> {
  if (!m.ref || !refBase || !refKey) {
    return { provider, model: m.id, check_name: "token_inflation", status: "skip", detail: "no baseline ref configured" };
  }
  const [tThis, tRef] = await Promise.all([
    promptTokens(base, key, m.id),
    promptTokens(refBase, refKey, m.ref),
  ]);
  if (tThis <= 0 || tRef <= 0) {
    return {
      provider,
      model: m.id,
      check_name: "token_inflation",
      status: "warn",
      detail: `inconclusive (this=${tThis} baseline=${tRef})`,
    };
  }
  const ratio = tThis / tRef;
  const ok = ratio <= 1.5;
  return {
    provider,
    model: m.id,
    check_name: "token_inflation",
    status: ok ? "pass" : "fail",
    detail: `this=${tThis} baseline=${tRef} ratio=${ratio.toFixed(2)}x${ok ? "" : " — inflates the bill"}`,
  };
}

// Native Anthropic /v1/messages prompt caching: warm the cache, then confirm a
// repeat read. cache_read stuck at 0 means you pay full price every call.
async function cachingCheck(provider: string, base: string, key: string, model: string): Promise<CheckResult> {
  try {
    const big =
      "You are an expert assistant with detailed rules. Always be precise and consistent. ".repeat(250);
    const body = {
      model,
      max_tokens: 10,
      system: [{ type: "text", text: big, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "OK" }],
    };
    let last: ChatResp | null = null;
    for (let i = 0; i < 4; i++) {
      last = await postJson(
        `${base}/v1/messages`,
        { "x-api-key": key, "anthropic-version": "2023-06-01" },
        body,
      );
    }
    const cr = (last?.json as any)?.usage?.cache_read_input_tokens ?? 0;
    const ok = typeof cr === "number" && cr > 0;
    return {
      provider,
      model,
      check_name: "caching",
      status: ok ? "pass" : "fail",
      detail: `cache_read_input_tokens=${cr}${ok ? "" : " across 4 identical calls"}`,
    };
  } catch (e) {
    return { provider, model, check_name: "caching", status: "fail", detail: errMsg(e) };
  }
}

async function getJson(url: string, headers: Record<string, string>): Promise<ChatResp> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* leave json null */
    }
    return { ok: r.ok, status: r.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Derive the /models listing URL from a provider's chat path. */
function modelsUrl(p: Provider): string {
  const chatPath = p.chatPath ?? "/v1/chat/completions";
  return `${p.base}${chatPath.replace("/chat/completions", "/models")}`;
}

const BILLING_TOLERANCE = 0.06; // 6% — billed should equal sticker; allows rounding

/**
 * TokenMart-style billing audit: reconcile a recent full day's REAL USD cost
 * (Management API) against its REAL token counts. effective $/1M = cost/tokens
 * must equal the /v1/models sticker, or the "discount" is illusory. One
 * CheckResult per model with enough volume to be meaningful.
 */
async function mgmtBillingChecks(p: Provider, mgmtKeyEnv: string): Promise<CheckResult[]> {
  const mk = (model: string, status: CheckStatus, detail: string): CheckResult => ({
    provider: p.id, model, check_name: "billing_drift", status, detail,
  });
  const key = process.env[p.apiKeyEnv];
  const mgmtKey = process.env[mgmtKeyEnv];
  if (!mgmtKey) return [mk("(billing)", "skip", `missing env ${mgmtKeyEnv}`)];
  if (!key) return [mk("(billing)", "skip", `missing env ${p.apiKeyEnv}`)];

  // yesterday (UTC) — a full settled day of daily-snapshot billing data.
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const auth = { Authorization: `Bearer ${mgmtKey}` };
  try {
    const [advR, costR, usageR] = await Promise.all([
      getJson(modelsUrl(p), { Authorization: `Bearer ${key}` }),
      getJson(`${p.base}/manage/cost/breakdown?date=${day}`, auth),
      getJson(`${p.base}/manage/usage/timeseries?period=7d&groupBy=model`, auth),
    ]);
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const adv: Record<string, { i?: number; o?: number }> = {};
    for (const m of ((advR.json as any)?.data ?? [])) {
      const t = m?.pricing?.tokens;
      if (t) adv[m.id] = { i: t.input_per_1m, o: t.output_per_1m };
    }
    const cost: Record<string, any> = {};
    for (const x of ((costR.json as any)?.breakdown ?? [])) cost[x.model] = x.costByMetric;
    const usage: Record<string, any> = {};
    for (const r of (Array.isArray(usageR.json) ? (usageR.json as any[]) : [])) {
      if (r?.date === day) usage[r.group] = r.byMetric;
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const models = Object.keys(cost).filter((m) => adv[m] && usage[m]);
    if (models.length === 0) {
      return [mk("(billing)", "skip", `no billed usage for ${day}`)];
    }
    return models.map((model) => {
      const u = usage[model], c = cost[model], a = adv[model];
      const parts: string[] = [];
      let verdict: CheckStatus = "skip";
      for (const [side, tokKey, advv] of [["in", "input_tokens", a.i], ["out", "output_tokens", a.o]] as const) {
        const tok = u[tokKey] ?? 0;
        const spent = c[tokKey] ?? 0;
        if (tok < 100 || advv == null) continue; // too little volume to trust
        const eff = (spent / tok) * 1e6;
        const drift = eff / advv - 1;
        const ok = Math.abs(drift) <= BILLING_TOLERANCE;
        parts.push(`${side} $${eff.toFixed(4)} vs $${advv} (${(drift * 100).toFixed(0)}%)`);
        verdict = ok ? (verdict === "fail" ? "fail" : "pass") : "fail";
      }
      if (parts.length === 0) return mk(model, "skip", `${day}: insufficient volume`);
      return mk(model, verdict, `${day}: ${parts.join(", ")}`);
    });
  } catch (e) {
    return [mk("(billing)", "fail", errMsg(e))];
  }
}

/**
 * DeepInfra-style billing audit: the provider returns `usage.estimated_cost`
 * per response — confirm it equals advertised price × tokens. One CheckResult
 * per monitored model.
 */
async function inlineCostBillingChecks(p: Provider): Promise<CheckResult[]> {
  const mk = (model: string, status: CheckStatus, detail: string): CheckResult => ({
    provider: p.id, model, check_name: "billing_drift", status, detail,
  });
  const key = process.env[p.apiKeyEnv];
  if (!key) return [mk("(billing)", "skip", `missing env ${p.apiKeyEnv}`)];
  const chatPath = p.chatPath ?? "/v1/chat/completions";
  try {
    const advR = await getJson(modelsUrl(p), { Authorization: `Bearer ${key}` });
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const adv: Record<string, { i?: number; o?: number }> = {};
    for (const m of ((advR.json as any)?.data ?? [])) {
      const pr = m?.metadata?.pricing;
      if (pr) adv[m.id] = { i: pr.input_tokens, o: pr.output_tokens };
    }
    return await Promise.all(
      p.models.map(async ({ id }): Promise<CheckResult> => {
        const a = adv[id];
        if (!a || a.i == null || a.o == null) return mk(id, "skip", "no advertised price");
        const r = await postJson(`${p.base}${chatPath}`, { Authorization: `Bearer ${key}` }, {
          model: id, max_tokens: 16, temperature: 0,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
        });
        const u = (r.json as any)?.usage;
        const est = u?.estimated_cost;
        const pt = u?.prompt_tokens ?? 0, ct = u?.completion_tokens ?? 0;
        /* eslint-enable @typescript-eslint/no-explicit-any */
        if (typeof est !== "number") return mk(id, "skip", "no estimated_cost in usage");
        const expected = (pt * a.i + ct * a.o) / 1e6;
        const drift = expected > 0 ? est / expected - 1 : 0;
        const ok = Math.abs(drift) <= BILLING_TOLERANCE;
        return mk(id, ok ? "pass" : "fail",
          `est $${est.toExponential(2)} vs sticker $${expected.toExponential(2)} (${(drift * 100).toFixed(0)}%) on ${pt}+${ct} tok`);
      }),
    );
  } catch (e) {
    return [mk("(billing)", "fail", errMsg(e))];
  }
}

async function billingChecks(p: Provider): Promise<CheckResult[]> {
  if (!p.billing) return [];
  if (p.billing.kind === "mgmt-api") return mgmtBillingChecks(p, p.billing.mgmtKeyEnv);
  return inlineCostBillingChecks(p);
}

async function checkModel(p: Provider, m: IntegrityModel): Promise<CheckResult[]> {
  const key = process.env[p.apiKeyEnv];
  const refKey = p.integrity ? process.env[p.integrity.refApiKeyEnv] : undefined;
  if (!key) {
    return [{ provider: p.id, model: m.id, check_name: "auth", status: "fail", detail: `missing env ${p.apiKeyEnv}` }];
  }

  const tasks: Array<Promise<CheckResult | CheckResult[]>> = [
    toolChecks(p.id, p.base, key, m.id),
    maxTokensCheck(p.id, p.base, key, m.id),
    injectionCheck(p.id, p.base, key, m.id),
    tokenInflationCheck(p.id, p.base, key, m, p.integrity!.refBase, refKey ?? ""),
  ];
  if (m.anthropicNative) {
    tasks.push(cachingCheck(p.id, p.base, key, m.id));
  }

  const settled = await Promise.all(tasks);
  return settled.flat();
}

/**
 * Run the daily integrity suite: per-model wire-protocol checks for providers
 * with an `integrity` block, plus a billing-drift audit for providers with a
 * `billing` block (which may be billing-only, e.g. DeepInfra).
 */
export async function runIntegrity(): Promise<CheckResult[]> {
  const integrityTargets = PROVIDERS.filter((p) => p.integrity && p.integrity.models.length > 0);
  const billingTargets = PROVIDERS.filter((p) => p.billing);
  const [integrityResults, billingResults] = await Promise.all([
    Promise.all(
      integrityTargets.map(async (p) => {
        const perModel = await Promise.all(p.integrity!.models.map((m) => checkModel(p, m)));
        return perModel.flat();
      }),
    ),
    Promise.all(billingTargets.map((p) => billingChecks(p))),
  ]);
  return [...integrityResults.flat(), ...billingResults.flat()];
}
