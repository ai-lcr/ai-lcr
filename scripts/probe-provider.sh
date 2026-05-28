#!/usr/bin/env bash
# ai-lcr provider probe — vet an OpenAI/Anthropic-compatible provider before you
# trust it in a least-cost route.
#
# "Cheapest list price" is meaningless if the provider silently deviates from the
# wire protocol. This probe catches the deviations that actually cost you money or
# corrupt output: dropped tool calls, broken multi-step loops, ignored max_tokens,
# a hidden injected system prompt, and — the sneaky one — input-token over-counting
# that inflates the bill so the "discount" provider is really the expensive one.
#
# Usage:
#   API_KEY=sk-... BASE=https://api.kunavo.com \
#     GEMINI=gemini-3-flash CLAUDE=claude-sonnet-4-6 \
#     bash scripts/probe-provider.sh
#
#   # add a trusted baseline (e.g. OpenRouter) to enable the token-inflation check:
#   API_KEY=sk-... BASE=https://api.kunavo.com GEMINI=gemini-3-flash CLAUDE=claude-sonnet-4-6 \
#     REF_API_KEY=sk-or-... REF_BASE=https://openrouter.ai/api \
#     REF_GEMINI=google/gemini-3-flash-preview REF_CLAUDE=anthropic/claude-sonnet-4.6 \
#     bash scripts/probe-provider.sh
#
# BASE / REF_BASE exclude /v1 (the script appends /v1/chat/completions and /v1/messages).
# Requires: bash, curl, python3.
set -uo pipefail

KEY="${API_KEY:?set API_KEY}"
BASE="${BASE:?set BASE e.g. https://api.kunavo.com}"
GEMINI="${GEMINI:-}"          # a Google model id on this provider (optional)
CLAUDE="${CLAUDE:-}"          # an Anthropic model id on this provider (optional)
OAI="$BASE/v1/chat/completions"
MSG="$BASE/v1/messages"

REF_KEY="${REF_API_KEY:-}"
REF_BASE="${REF_BASE:-}"
REF_GEMINI="${REF_GEMINI:-}"
REF_CLAUDE="${REF_CLAUDE:-}"

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
oai_prompt_tokens(){
  curl -s --max-time 40 "$1/v1/chat/completions" -H "Authorization: Bearer $2" -H "Content-Type: application/json" \
    -d "$(mk_chat_payload "$3" 5 "$4")" \
  | python3 -c "import sys,json;t=sys.stdin.read();t=t[t.index('{'):] if '{' in t else t;print(json.loads(t).get('usage',{}).get('prompt_tokens',''))" 2>/dev/null
}

echo "===== ai-lcr provider probe ====="
echo "BASE=$BASE  GEMINI=${GEMINI:-<none>}  CLAUDE=${CLAUDE:-<none>}"
[ -n "$REF_BASE" ] && echo "REF =$REF_BASE (token-inflation baseline enabled)" || echo "REF =<none> (token-inflation check skipped — set REF_* to enable)"
echo

probe_model(){           # $1=model id, $2=family label (gemini|claude)
  local M="$1" FAM="$2"
  [ -z "$M" ] && return 0
  echo "── $FAM: $M ──"

  # 1) single tool call
  local R
  R=$(curl -s --max-time 40 "$OAI" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"Weather in Tokyo? Use the tool.\"}],\"tools\":$TOOL,\"tool_choice\":\"auto\",\"max_tokens\":300}")
  echo "$R" | grep -q '"tool_calls"' && pass "single tool call" || fail "single tool call (tools dropped?)"

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
  local RM CT FR
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

  # 5) token over-counting vs trusted baseline (only if REF_* provided)
  local REF_MODEL=""
  [ "$FAM" = "gemini" ] && REF_MODEL="$REF_GEMINI"
  [ "$FAM" = "claude" ] && REF_MODEL="$REF_CLAUDE"
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
    skip "token-inflation check ($FAM) — set REF_API_KEY/REF_BASE/REF_${FAM^^} to enable"
  fi
  echo
}

probe_model "$GEMINI" "gemini"
probe_model "$CLAUDE" "claude"

# 6) prompt caching (Anthropic native /v1/messages) — only meaningful for Claude
if [ -n "$CLAUDE" ]; then
  echo "── caching (native /v1/messages, $CLAUDE) ──"
  BIG=$(python3 -c "print('You are an expert assistant with detailed rules. Always be precise and consistent. ' * 250)")  # well above the 2048-token cache floor
  PC=$(python3 -c "import json,sys;print(json.dumps({'model':'$CLAUDE','max_tokens':10,'system':[{'type':'text','text':sys.argv[1],'cache_control':{'type':'ephemeral'}}],'messages':[{'role':'user','content':'OK'}]}))" "$BIG")
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
