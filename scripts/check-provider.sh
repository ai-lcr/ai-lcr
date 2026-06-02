#!/usr/bin/env bash
# ai-lcr provider check — vet an OpenAI/Anthropic-compatible provider before you
# trust it in a least-cost route.
#
# "Cheapest list price" is meaningless if the provider silently deviates from the
# wire protocol. This check catches the deviations that actually cost you money or
# corrupt output: dropped tool calls, broken multi-step loops, ignored max_tokens,
# a hidden injected system prompt, and — the sneaky one — input-token over-counting
# that inflates the bill so the "discount" provider is really the expensive one.
#
# Models are generic numbered slots — works for Gemini, Claude, GPT, Llama, etc.
# Each MODEL_n may carry an optional REF_n (the matching model id on the trusted
# baseline) to enable the token-inflation comparison for that model.
#
# Usage:
#   API_KEY=sk-... BASE=https://api.kunavo.com \
#     MODEL_1=gemini-3-flash MODEL_2=claude-sonnet-4-6 \
#     bash scripts/check-provider.sh
#
#   # add a trusted baseline (e.g. OpenRouter) per model to enable token-inflation:
#   API_KEY=sk-... BASE=https://api.kunavo.com \
#     MODEL_1=gemini-3-flash    REF_1=google/gemini-3-flash-preview \
#     MODEL_2=claude-sonnet-4-6 REF_2=anthropic/claude-sonnet-4.6 \
#     CACHE_MODEL=claude-sonnet-4-6 \
#     REF_API_KEY=sk-or-... REF_BASE=https://openrouter.ai/api \
#     bash scripts/check-provider.sh
#
# CACHE_MODEL (optional): an Anthropic-style model id to run the native
#   /v1/messages prompt-caching test against. Leave unset to skip it.
# Slots MODEL_1..MODEL_8 / REF_1..REF_8 are scanned. Legacy GEMINI / CLAUDE
#   (+ REF_GEMINI / REF_CLAUDE) still work and append to the slot list.
# BASE / REF_BASE exclude /v1 (the script appends /v1/chat/completions and /v1/messages).
# Requires: bash, curl, python3.
set -uo pipefail

KEY="${API_KEY:?set API_KEY}"
BASE="${BASE:?set BASE e.g. https://api.kunavo.com}"
OAI="$BASE/v1/chat/completions"
MSG="$BASE/v1/messages"

REF_KEY="${REF_API_KEY:-}"
REF_BASE="${REF_BASE:-}"

# Collect models to probe: MODEL_1..MODEL_8 slots, each with optional REF_n.
MODELS=(); REFS=()
for i in 1 2 3 4 5 6 7 8; do
  mvar="MODEL_$i"; rvar="REF_$i"
  m="${!mvar:-}"; r="${!rvar:-}"
  [ -n "$m" ] && { MODELS+=("$m"); REFS+=("$r"); }
done
# Legacy compat: GEMINI / CLAUDE (+ REF_GEMINI / REF_CLAUDE) still accepted.
if [ -n "${GEMINI:-}" ]; then MODELS+=("$GEMINI"); REFS+=("${REF_GEMINI:-}"); fi
if [ -n "${CLAUDE:-}" ]; then MODELS+=("$CLAUDE"); REFS+=("${REF_CLAUDE:-}"); fi
# Anthropic-native prompt-caching test model; default to legacy CLAUDE if set.
CACHE_MODEL="${CACHE_MODEL:-${CLAUDE:-}}"

pass(){ echo "  ✅ PASS: $1"; }
fail(){ echo "  ❌ FAIL: $1"; }
warn(){ echo "  ⚠️  WARN: $1"; }
skip(){ echo "  ⏭️  SKIP: $1"; }

# Build a /v1/chat/completions JSON body without nested-quote hell.
# Args -> env -> python heredoc. $1=model $2=max_tokens $3=user content
mk_chat_payload(){
  MK_MODEL="$1" MK_MAX="$2" MK_CONTENT="$3" python3 - <<'PY'
import json, os
print(json.dumps({
    "model": os.environ["MK_MODEL"],
    "max_tokens": int(os.environ["MK_MAX"]),
    "messages": [{"role": "user", "content": os.environ["MK_CONTENT"]}],
}))
PY
}

TOOL='[{"type":"function","function":{"name":"get_weather","description":"Get current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]'
# A neutral message with NO system prompt, NO instructions, NO XML. If the model
# starts talking about "injection", "system prompt", "confidential" or "XML tags",
# the provider injected a hidden prompt that the model is now reacting to.
NEUTRAL="The quick brown fox jumps over the lazy dog. This is a simple sentence used to measure tokenization accuracy across providers."

# prompt_tokens for an OpenAI-compatible /v1/chat/completions response on $1=base $2=key $3=model $4=text
# stdout = the integer (or empty if genuinely absent); a *parse failure* prints a
# diagnostic to stderr instead of silently returning empty — otherwise a crashed
# parse is indistinguishable from "provider reported nothing" and the inflation
# check shows a misleading "this= ref=" inconclusive.
oai_prompt_tokens(){
  curl -s --max-time 40 "$1/v1/chat/completions" -H "Authorization: Bearer $2" -H "Content-Type: application/json" \
    -d "$(mk_chat_payload "$3" 5 "$4")" \
  | python3 -c '
import sys, json
raw = sys.stdin.read()
try:
    i = raw.index("{")
    obj, _ = json.JSONDecoder().raw_decode(raw[i:])
except Exception as e:
    sys.stderr.write("  [token-parse] could not parse usage (%s); body head: %s\n"
                     % (e, raw[:160].replace(chr(10), " ")))
    sys.exit(0)
pt = obj.get("usage", {}).get("prompt_tokens", "")
if pt == "":
    sys.stderr.write("  [token-parse] response carried no usage.prompt_tokens\n")
print(pt)
'
}

echo "===== ai-lcr provider check ====="
echo "BASE=$BASE  models: ${MODELS[*]:-<none>}"
[ -n "$REF_BASE" ] && echo "REF =$REF_BASE (token-inflation baseline enabled)" || echo "REF =<none> (token-inflation check skipped — set REF_* to enable)"
[ -n "$CACHE_MODEL" ] && echo "CACHE_MODEL=$CACHE_MODEL (native /v1/messages caching test enabled)"
echo

probe_model(){           # $1=model id, $2=ref model id on the baseline (optional)
  local M="$1" REF_MODEL="$2"
  [ -z "$M" ] && return 0
  echo "── $M ──"

  # 1) tool-calling capability — does the provider wire `tools` through at all?
  # Use tool_choice:"required" (force a call), NOT "auto". We're testing whether
  # the provider CAN call a tool, not whether a (reasoning / sometimes-chatty)
  # model DECIDES to on a single roll — under "auto" a healthy model often just
  # answers in text, which looks identical to dropped tools and yields a false
  # FAIL. With "required", no tool_calls in the raw JSON means tools really are
  # broken.
  local R
  R=$(curl -s --max-time 40 "$OAI" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"Weather in Tokyo? Use the tool.\"}],\"tools\":$TOOL,\"tool_choice\":\"required\",\"max_tokens\":300}")
  echo "$R" | grep -q '"tool_calls"' && pass "tool call (tool_choice:required)" || fail "tool call (tools dropped? required tool_choice returned none)"

  # 2) multi-step round-trip with assistant content:null (OpenAI spec allows null here)
  local TCID
  TCID=$(echo "$R" | python3 -c "import sys,json
try: print(json.load(sys.stdin)['choices'][0]['message']['tool_calls'][0]['id'])
except: print('')" 2>/dev/null)
  if [ -n "$TCID" ]; then
    local R2
    R2=$(curl -s --max-time 40 "$OAI" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"Weather in Tokyo? Use the tool.\"},{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{\"id\":\"$TCID\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"{\\\"city\\\":\\\"Tokyo\\\"}\"}}]},{\"role\":\"tool\",\"tool_call_id\":\"$TCID\",\"content\":\"18C and sunny\"}],\"tools\":$TOOL,\"max_tokens\":300}")
    echo "$R2" | grep -qiE "18|sunny" && pass "multi-step round-trip (assistant content:null)" || fail "multi-step round-trip — assistant content:null rejected (breaks tool loops)"
  else
    skip "multi-step round-trip (no tool_call id from step 1)"
  fi

  # 3) max_tokens honored
  local RM CT
  RM=$(curl -s --max-time 40 "$OAI" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"Write five paragraphs about the ocean.\"}],\"max_tokens\":8}")
  CT=$(echo "$RM" | python3 -c "import sys,json;print(json.load(sys.stdin).get('usage',{}).get('completion_tokens',0))" 2>/dev/null)
  if [ -n "$CT" ] && [ "$CT" -le 40 ] 2>/dev/null; then pass "max_tokens honored (completion_tokens=$CT for cap 8)"; else fail "max_tokens ignored (completion_tokens=$CT for cap 8)"; fi

  # 4) hidden-prompt injection — neutral message must NOT trigger injection talk
  local RI CONTENT
  RI=$(curl -s --max-time 40 "$OAI" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$(mk_chat_payload "$M" 200 "$NEUTRAL")")
  CONTENT=$(echo "$RI" | python3 -c "import sys,json
try: print(json.load(sys.stdin)['choices'][0]['message'].get('content','') or '')
except: print('')" 2>/dev/null)
  if echo "$CONTENT" | grep -qiE "injection|system prompt|confidential|hidden prompt|xml tag"; then
    fail "hidden-prompt injection — model reacts to content it was never sent:"
    echo "        \"$(echo "$CONTENT" | tr '\n' ' ' | cut -c1-140)…\""
  else
    pass "no hidden-prompt injection (clean response to neutral input)"
  fi

  # 5) token over-counting vs trusted baseline (only if REF_* + a per-model ref provided)
  if [ -n "$REF_BASE" ] && [ -n "$REF_KEY" ] && [ -n "$REF_MODEL" ]; then
    local T_THIS T_REF
    T_THIS=$(oai_prompt_tokens "$BASE" "$KEY" "$M" "$NEUTRAL")
    T_REF=$(oai_prompt_tokens "$REF_BASE" "$REF_KEY" "$REF_MODEL" "$NEUTRAL")
    if [ -n "$T_THIS" ] && [ -n "$T_REF" ] && [ "$T_REF" -gt 0 ] 2>/dev/null; then
      python3 -c "
this,ref=$T_THIS,$T_REF
r=this/ref
print(f'  -> prompt_tokens: this={this} baseline={ref}  ratio={r:.2f}x')
exit(0 if r<=1.5 else 1)" \
        && pass "token count matches baseline (no over-counting / over-billing)" \
        || fail "token OVER-COUNTING vs baseline (>1.5x) — inflates the bill; 'discount' may be illusory"
    else
      warn "token-inflation check inconclusive (this=$T_THIS ref=$T_REF)"
    fi
  else
    skip "token-inflation check — set REF_API_KEY/REF_BASE + a REF_n for this model to enable"
  fi
  echo
}

for idx in "${!MODELS[@]}"; do
  probe_model "${MODELS[$idx]}" "${REFS[$idx]}"
done

# 6) prompt caching (Anthropic native /v1/messages) — only if CACHE_MODEL set
if [ -n "$CACHE_MODEL" ]; then
  echo "── caching (native /v1/messages, $CACHE_MODEL) ──"
  BIG=$(python3 -c "print('You are an expert assistant with detailed rules. Always be precise and consistent. ' * 250)")  # well above the 2048-token cache floor
  PC=$(python3 -c "import json,sys;print(json.dumps({'model':'$CACHE_MODEL','max_tokens':10,'system':[{'type':'text','text':sys.argv[1],'cache_control':{'type':'ephemeral'}}],'messages':[{'role':'user','content':'OK'}]}))" "$BIG")
  CR=""
  for i in 1 2 3 4; do
    CR=$(echo "$PC" | curl -s --max-time 40 "$MSG" -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" -d @-)
  done
  echo "$CR" | python3 -c "import sys,json;u=json.load(sys.stdin).get('usage',{});cr=u.get('cache_read_input_tokens',0) or 0;print('  -> cache_read_input_tokens='+str(cr));exit(0 if cr>0 else 1)" 2>/dev/null \
    && pass "prompt caching applied (cache_read>0 on repeat)" \
    || fail "prompt caching NOT applied (cache_read stays 0 across 4 identical calls)"
  echo
fi

echo "===== done ====="
echo "Reminder: a FAIL on token over-counting or injection means this provider is NOT a safe"
echo "least-cost target for that model — keep it off that model's cheapest-first list until fixed."
