#!/usr/bin/env bash
# ai-lcr Kunavo MEDIA integrity check — live probe of image + video endpoints.
#
# Unlike check-provider.sh (chat/text wire protocol), this vets Kunavo's media
# REST endpoints against what the docs claim, so we can trust the adapter:
#   1. Image gen   — POST /v1/images/generations  (sync, returns data[].url)
#   2. Image edit  — POST /v1/images/edits         (sync, reference image)
#   3. Video async — POST /v1/videos  +  GET /v1/videos/{id}  (submit → poll)
#   (bonus) price cross-check against /v1/models
#
# Spends real money: ~4.7¢ (nano-banana-2) + ~4.7¢ (edit) + 16¢ (veo-3-lite) ≈ 26¢.
#
# Usage:
#   KUNAVO_API_KEY=sk-kn-... bash scripts/check-kunavo-media.sh
#   # or it auto-reads ../chat-diagram/.env.local
set -uo pipefail

BASE="${KUNAVO_BASE:-https://api.kunavo.com}"

# ── Resolve key ──────────────────────────────────────────────────────────────
KEY="${KUNAVO_API_KEY:-}"
if [ -z "$KEY" ]; then
  ENVF="$(dirname "$0")/../../chat-diagram/.env.local"
  if [ -f "$ENVF" ]; then
    KEY=$(grep -E "^KUNAVO_API_KEY=" "$ENVF" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n')
  fi
fi
if [ -z "$KEY" ]; then echo "✗ no KUNAVO_API_KEY"; exit 1; fi
echo "Kunavo media check → $BASE  (key ${KEY:0:8}...)"
echo

AUTH=(-H "authorization: Bearer $KEY" -H "content-type: application/json")
PASS=0; FAIL=0
ok(){ echo "  ✅ $1"; PASS=$((PASS+1)); }
bad(){ echo "  ❌ $1"; FAIL=$((FAIL+1)); }

# ── 0. Price cross-check (registry source of truth) ──────────────────────────
echo "[0] GET /v1/models — price cross-check"
MODELS=$(curl -s "${AUTH[@]}" "$BASE/v1/models")
for slug in nano-banana-2:0.0469 nano-banana-pro veo-3-lite:0.16 veo-3-quality; do
  name="${slug%%:*}"
  price=$(echo "$MODELS" | jq -r --arg m "$name" '.data[]? | select(.id==$m) | (.pricing // .price // empty)' 2>/dev/null | head -1)
  echo "    $name → pricing: ${price:-<none in /v1/models>}"
done
echo

# ── 1. Image generation (sync) ───────────────────────────────────────────────
echo "[1] POST /v1/images/generations  model=nano-banana-2"
t0=$(date +%s)
IMG=$(curl -s "${AUTH[@]}" "$BASE/v1/images/generations" -d '{
  "model":"nano-banana-2",
  "prompt":"a single red apple on a white table, studio lighting",
  "size":"1024x1024"
}')
t1=$(date +%s)
echo "    ($((t1-t0))s)  raw keys: $(echo "$IMG" | jq -r 'keys|join(",")' 2>/dev/null)"
IMG_URL=$(echo "$IMG" | jq -r '.data[0].url // empty' 2>/dev/null)
if [ -n "$IMG_URL" ]; then
  ok "got image url: ${IMG_URL:0:60}..."
  ctype=$(curl -s -o /dev/null -w '%{content_type} %{size_download}' "$IMG_URL")
  echo "       fetched: $ctype bytes"
  echo "$IMG_URL" | grep -q "files.kunavo.com" && ok "url is files.kunavo.com (permanent host)" || echo "  ℹ url host: $(echo "$IMG_URL" | sed -E 's#https?://([^/]+)/.*#\1#')"
else
  bad "no data[0].url — body: $(echo "$IMG" | head -c 300)"
fi
echo

# ── 2. Image edit (reference image) ──────────────────────────────────────────
echo "[2] POST /v1/images/edits  model=nano-banana-edit"
if [ -n "${IMG_URL:-}" ]; then
  EDIT=$(curl -s "${AUTH[@]}" "$BASE/v1/images/edits" -d "$(jq -n --arg u "$IMG_URL" '{
    model:"nano-banana-edit",
    prompt:"change the apple to a green apple, keep everything else identical",
    image:$u
  }')")
  echo "    raw keys: $(echo "$EDIT" | jq -r 'keys|join(",")' 2>/dev/null)"
  EDIT_URL=$(echo "$EDIT" | jq -r '.data[0].url // empty' 2>/dev/null)
  if [ -n "$EDIT_URL" ]; then ok "edit returned url: ${EDIT_URL:0:60}..."; else bad "no edit url — body: $(echo "$EDIT" | head -c 300)"; fi
else
  echo "    ⊘ skipped (no source image from step 1)"
fi
echo

# ── 3. Video ASYNC (submit → poll) ───────────────────────────────────────────
echo "[3] POST /v1/videos  model=veo-3-lite  (async submit)"
SUB=$(curl -s "${AUTH[@]}" "$BASE/v1/videos" -d '{
  "model":"veo-3-lite",
  "prompt":"a calm ocean wave rolling onto a sandy beach at sunset",
  "aspect_ratio":"16:9"
}')
echo "    raw keys: $(echo "$SUB" | jq -r 'keys|join(",")' 2>/dev/null)"
echo "    body: $(echo "$SUB" | head -c 400)"
VID=$(echo "$SUB" | jq -r '.id // empty' 2>/dev/null)
VSTATUS=$(echo "$SUB" | jq -r '.status // empty' 2>/dev/null)
if [ -n "$VID" ]; then
  ok "async submit returned id=$VID  status=$VSTATUS"
  echo "$VID" | grep -q '^vid_' && ok "id has vid_ prefix (matches docs)" || echo "  ℹ id prefix differs from docs' vid_"

  echo "    polling GET /v1/videos/$VID ..."
  deadline=$(( $(date +%s) + 600 ))
  final=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 6
    P=$(curl -s "${AUTH[@]}" "$BASE/v1/videos/$VID")
    st=$(echo "$P" | jq -r '.status // empty' 2>/dev/null)
    echo "      status=$st"
    case "$st" in
      completed|succeeded|success)
        final="$P"; break ;;
      failed|error)
        final="$P"; break ;;
    esac
  done
  if [ -z "$final" ]; then
    bad "video poll TIMED OUT after 600s (last status above)"
  else
    fst=$(echo "$final" | jq -r '.status' 2>/dev/null)
    if [ "$fst" = "completed" ] || [ "$fst" = "succeeded" ] || [ "$fst" = "success" ]; then
      VURL=$(echo "$final" | jq -r '.output.url // .output.urls[0] // .url // empty' 2>/dev/null)
      if [ -n "$VURL" ]; then
        ok "video completed → $VURL"
        echo "       output: $(echo "$final" | jq -c '.output // {url:.url}' 2>/dev/null)"
        vctype=$(curl -s -o /dev/null -w '%{content_type} %{size_download}' "$VURL")
        echo "       fetched: $vctype bytes"
      else
        bad "completed but no output.url — body: $(echo "$final" | head -c 400)"
      fi
    else
      bad "video job failed: $(echo "$final" | jq -c '.error // .' 2>/dev/null | head -c 300)"
    fi
  fi
else
  # async endpoint may not exist → fall back to documenting what we got
  bad "POST /v1/videos returned no id (async may be unsupported on this key)"
fi
echo

echo "──────────────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "✅ Kunavo media: integrable" || echo "⚠️  review failures above"
