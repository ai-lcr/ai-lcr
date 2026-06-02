#!/usr/bin/env python3
"""
verify-billing.py — Is the discount real? Cross-provider price + billing audit.

For a set of models, this checks three things across TokenMart, OpenRouter and
DeepInfra:

  A. ADVERTISED price comparison  — each provider's /v1/models sticker price,
     side by side, so you see where the spread actually is.

  B. TokenMart BILLED vs advertised — using the read-only Management API
     (sk-mgmt-v1-…), reconciles a recent full day's real USD cost against the
     real token counts: effective $/1M = costByMetric / tokens. If that equals
     the sticker, the discount is real and billing is honest. (30d averages can
     look "inflated" purely because a provider recently CUT prices — always
     reconcile a single recent DAY, not the whole window.)

  C. DeepInfra BILLED self-check — DeepInfra returns `usage.estimated_cost`
     inline; we confirm it equals advertised_price x tokens, and compare token
     counts against OpenRouter (same model = same tokenizer => prompt_tokens
     must match; a higher count means the cheap sticker is clawed back).

Caveats baked in from building this:
  - TokenMart Mgmt API is BATCHED daily, not real-time — you cannot reconcile a
    call within seconds; use a recent full day.
  - Reasoning models emit hidden reasoning_tokens billed at the OUTPUT rate
    (glm-4.6 spent 132 of them to answer "OK"). That is normal and IS counted
    in the output_tokens metric — so "cheap" reasoning models cost more per
    visible answer than the sticker implies. Not inflation, but budget for it.

Keys are read from website/.env.local:
  INFERENCE_API_KEY, INFERENCE_MGMT_KEY, OPENROUTER_API_KEY, DEEPINFRA_API_KEY

Usage:
  python3 scripts/verify-billing.py                # all sections, yesterday (UTC)
  python3 scripts/verify-billing.py --date 2026-06-01
  python3 scripts/verify-billing.py --live         # also fire identical live
                                                   # calls to compare reported
                                                   # tokens across providers
"""
import json, os, sys, argparse, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = os.path.join(ROOT, "website", ".env.local")

TM_BASE = "https://model.service-inference.ai"
OR_BASE = "https://openrouter.ai/api"
DI_BASE = "https://api.deepinfra.com/v1/openai"   # note: /v1/openai, not /v1

# logical name -> per-provider model id (None = provider doesn't carry it)
MODELS = {
    "deepseek-v4-flash":          {"tm": "deepseek-v4-flash",          "or": "deepseek/deepseek-v4-flash",  "di": "deepseek-ai/DeepSeek-V4-Flash"},
    "glm-4.6":                    {"tm": "glm-4.6",                    "or": "z-ai/glm-4.6",                "di": "zai-org/GLM-4.6"},
    "gemini-2.5-flash":           {"tm": "gemini-2.5-flash",           "or": "google/gemini-2.5-flash",     "di": None},
    "gemini-2.5-pro":             {"tm": "gemini-2.5-pro",             "or": "google/gemini-2.5-pro",       "di": None},
    "claude-haiku-4-5-20251001":  {"tm": "claude-haiku-4-5-20251001",  "or": "anthropic/claude-haiku-4.5",  "di": None},
    "gpt-5.5":                    {"tm": "gpt-5.5",                    "or": "openai/gpt-5.5",              "di": None},
}


def load_env():
    env = {}
    with open(ENV) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def http(url, key, body=None, method="GET", auth="bearer"):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    # a real UA: TokenMart's edge 403s (Cloudflare 1010) on stdlib's default UA
    headers["User-Agent"] = "ai-lcr-verify-billing/1.0"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {"error": e.read()[:120].decode(errors="replace")}
    except Exception as e:
        return 0, {"error": str(e)[:120]}


def chat(base, key, model, prompt="Reply with exactly: OK", max_tokens=16):
    # DeepInfra's OpenAI base already ends in /v1/openai, so it only needs
    # /chat/completions; the others need /v1/chat/completions.
    path = "/chat/completions" if base.endswith("/v1/openai") else "/v1/chat/completions"
    _, j = http(f"{base}{path}", key,
                {"model": model, "messages": [{"role": "user", "content": prompt}],
                 "temperature": 0, "max_tokens": max_tokens}, method="POST")
    return j


def adv_prices(env):
    """Advertised $/1M (in, out) per provider, keyed by provider model id."""
    tm = {m["id"]: m.get("pricing", {}).get("tokens", {}) for m in http(f"{TM_BASE}/v1/models", env["INFERENCE_API_KEY"])[1].get("data", [])}
    di = {m["id"]: m.get("metadata", {}).get("pricing", {}) for m in http(f"{DI_BASE}/models", env["DEEPINFRA_API_KEY"])[1].get("data", [])}
    orr = {}
    for m in http(f"{OR_BASE}/v1/models", env["OPENROUTER_API_KEY"])[1].get("data", []):
        p = m.get("pricing", {})
        try:
            orr[m["id"]] = (float(p["prompt"]) * 1e6, float(p["completion"]) * 1e6)
        except Exception:
            pass
    def tmp(mid): p = tm.get(mid, {}); return (p.get("input_per_1m"), p.get("output_per_1m"))
    def dip(mid): p = di.get(mid, {}); return (p.get("input_tokens"), p.get("output_tokens")) if mid else (None, None)
    return tmp, lambda mid: orr.get(mid, (None, None)), dip


def fmt(x):
    return "—" if x is None else f"{x:.4f}"


def section_a(env, tm_adv, or_adv, di_adv):
    print("\n══ A. ADVERTISED price ($/1M in/out) — where's the spread? ══")
    print(f"{'model':28} | {'TokenMart':>15} | {'OpenRouter':>15} | {'DeepInfra':>15}")
    print("-" * 82)
    for name, ids in MODELS.items():
        ta = tm_adv(ids["tm"]); oa = or_adv(ids["or"]); da = di_adv(ids["di"])
        di_s = f"{fmt(da[0])}/{fmt(da[1])}" if ids["di"] else "n/a (closed)"
        print(f"{name:28} | {fmt(ta[0])}/{fmt(ta[1]):>7} | {fmt(oa[0])}/{fmt(oa[1]):>7} | {di_s:>15}")


def section_b(env, day, tm_adv):
    print(f"\n══ B. TokenMart BILLED vs advertised — real money for {day} (UTC) ══")
    mgmt = env.get("INFERENCE_MGMT_KEY")
    if not mgmt:
        print("  (skipped — no INFERENCE_MGMT_KEY in website/.env.local)")
        return
    _, cost = http(f"{TM_BASE}/manage/cost/breakdown?date={day}", mgmt)
    _, ts = http(f"{TM_BASE}/manage/usage/timeseries?period=7d&groupBy=model", mgmt)
    cost = {x["model"]: x["costByMetric"] for x in cost.get("breakdown", [])}
    usage = {r["group"]: r["byMetric"] for r in (ts if isinstance(ts, list) else []) if r.get("date") == day}
    print(f"{'model':28} | {'advertised':>15} | {'billed':>15} | {'in/out tok':>14} | verdict")
    print("-" * 95)
    for name, ids in MODELS.items():
        mid = ids["tm"]; u = usage.get(mid); c = cost.get(mid); ai, ao = tm_adv(mid)
        if not u or not c:
            print(f"{name:28} | {fmt(ai)}/{fmt(ao):>7} | {'no data this day':>15}")
            continue
        it, ot = u.get("input_tokens", 0), u.get("output_tokens", 0)
        ei = c.get("input_tokens", 0) / it * 1e6 if it else None
        eo = c.get("output_tokens", 0) / ot * 1e6 if ot else None
        near = lambda a, b: a is not None and b and abs(a - b) / b < 0.05
        v = "MATCH ✓ discount real" if near(ei, ai) and near(eo, ao) else "DIVERGES — investigate"
        print(f"{name:28} | {fmt(ai)}/{fmt(ao)} | {fmt(ei)}/{fmt(eo)} | {it:>6}/{ot:<7} | {v}")


def section_c(env, di_adv):
    print("\n══ C. DeepInfra BILLED self-check (estimated_cost vs sticker) + token honesty vs OpenRouter ══")
    print(f"{'model':28} | {'est_cost':>11} | {'expected':>11} | {'DI in/out tok':>14} | {'OR in/out tok':>14} | verdict")
    print("-" * 110)
    for name, ids in MODELS.items():
        if not ids["di"]:
            continue
        di = chat(DI_BASE, env["DEEPINFRA_API_KEY"], ids["di"])
        du = di.get("usage", {})
        est = du.get("estimated_cost")
        pit, pot = du.get("prompt_tokens", 0), du.get("completion_tokens", 0)
        ai, ao = di_adv(ids["di"])
        expected = (pit * ai + pot * ao) / 1e6 if ai is not None else None
        orr = chat(OR_BASE, env["OPENROUTER_API_KEY"], ids["or"])
        ou = orr.get("usage", {})
        oit, oot = ou.get("prompt_tokens", 0), ou.get("completion_tokens", 0)
        cost_ok = est is not None and expected is not None and (expected == 0 or abs(est - expected) / max(expected, 1e-12) < 0.02)
        tok_ok = oit and pit and abs(pit - oit) / oit < 0.05   # input tokens must match (same tokenizer)
        v = ("cost✓" if cost_ok else "cost✗") + " " + ("tokens✓" if tok_ok else f"tokens✗ (DI {pit} vs OR {oit})")
        es = f"{est:.2e}" if est is not None else "—"
        xs = f"{expected:.2e}" if expected is not None else "—"
        print(f"{name:28} | {es:>11} | {xs:>11} | {pit:>6}/{pot:<7} | {oit:>6}/{oot:<7} | {v}")


def section_live(env):
    print("\n══ LIVE: identical prompt, reported tokens across all three (input must match) ══")
    print(f"{'model':28} | {'TokenMart in/out':>17} | {'OpenRouter in/out':>18} | {'DeepInfra in/out':>17}")
    print("-" * 92)
    prompt = ("Neutral filler for tokenization. " * 8) + "\nOutput only: OK"
    for name, ids in MODELS.items():
        def usg(base, key, mid):
            if not mid: return "n/a"
            u = chat(base, key, mid, prompt=prompt).get("usage", {})
            return f"{u.get('prompt_tokens','?')}/{u.get('completion_tokens','?')}"
        tm = usg(TM_BASE, env["INFERENCE_API_KEY"], ids["tm"])
        orr = usg(OR_BASE, env["OPENROUTER_API_KEY"], ids["or"])
        di = usg(DI_BASE, env["DEEPINFRA_API_KEY"], ids["di"])
        print(f"{name:28} | {tm:>17} | {orr:>18} | {di:>17}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="UTC day YYYY-MM-DD for TokenMart billed reconciliation (default: yesterday)")
    ap.add_argument("--live", action="store_true", help="also fire identical live calls to compare reported tokens")
    args = ap.parse_args()

    env = load_env()
    day = args.date or (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")

    tm_adv, or_adv, di_adv = adv_prices(env)
    section_a(env, tm_adv, or_adv, di_adv)
    section_b(env, day, tm_adv)
    section_c(env, di_adv)
    if args.live:
        section_live(env)
    print("\nDone. Re-run periodically — provider prices drift; reconcile a recent DAY, not a 30d mean.")


if __name__ == "__main__":
    main()
