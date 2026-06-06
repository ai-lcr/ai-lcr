/**
 * Bundled cross-provider price reference for image & video models.
 *
 * This is the "which provider is cheapest" table, as data. Prices are in US
 * cents per native unit; `comparePrices()` (./media) normalizes them to one
 * 16:9 1080p image / 5-second 1080p clip so providers compare directly.
 *
 * PROVENANCE
 *   - fal, runware: per-image / per-second rates verified by Victor in ai-art's
 *     `@art/models` registry (audited against provider model pages 2026-05).
 *   - kunavo: read programmatically from `GET https://api.kunavo.com/v1/models`
 *     (`.kunavo.billing.perCallMicroCents` ÷ 1e6 → cents), 2026-05-29.
 *   - tokenmart: serves NO image/video models (47 text-only models) — excluded.
 *
 * Only models where 2+ providers compete are listed (that's where routing has a
 * choice). The long tail of fal/runware-only models (Flux, Seedream, Kling, WAN,
 * Sora, Hunyuan, …) lives in ai-art's registry; Kunavo does not carry them, so
 * their "cheapest provider" is the fal-vs-runware call ai-art already encodes.
 */
import type { MediaRegistry } from "./media";

export const MEDIA_PRICING: MediaRegistry = {
  // ── Google image (Gemini "Nano Banana" family) ──────────────
  "google/nano-banana": {
    id: "google/nano-banana",
    modality: "image",
    routes: [
      // Gemini Flash Image v1. Kunavo only — fal/runware carry v2/pro, not v1.
      { provider: "kunavo", externalId: "nano-banana", pricing: { unit: "image", cents: 2.73 } },
    ],
  },
  "google/nano-banana-2": {
    id: "google/nano-banana-2",
    modality: "image",
    routes: [
      { provider: "kunavo", externalId: "nano-banana-2", pricing: { unit: "image", cents: 4.69 } },
      { provider: "runware", externalId: "google:4@3", pricing: { unit: "image", cents: 6.9 }, note: "1K tier (2K 10.3¢, 4K 15.3¢)" },
      { provider: "fal", externalId: "fal-ai/nano-banana-2", pricing: { unit: "image", cents: 8 } },
    ],
  },
  "google/nano-banana-pro": {
    id: "google/nano-banana-pro",
    modality: "image",
    routes: [
      { provider: "kunavo", externalId: "nano-banana-pro", pricing: { unit: "image", cents: 6.7 } },
      { provider: "fal", externalId: "fal-ai/nano-banana-pro", pricing: { unit: "image", cents: 8 } },
    ],
  },

  // ── OpenAI image ────────────────────────────────────────────
  "openai/gpt-image-2": {
    id: "openai/gpt-image-2",
    modality: "image",
    routes: [
      // Standard quality. (fal carries only the High tier — separate SKU below.)
      { provider: "kunavo", externalId: "gpt-image-2", pricing: { unit: "image", cents: 6.33 } },
      { provider: "runware", externalId: "openai:gpt-image@2", pricing: { unit: "image", cents: 9.375 } },
    ],
  },
  "openai/gpt-image-2-high": {
    id: "openai/gpt-image-2-high",
    modality: "image",
    routes: [
      { provider: "fal", externalId: "fal-ai/gpt-image-2/high", pricing: { unit: "image", cents: 21 } },
    ],
  },

  // ── Black Forest Labs FLUX (image) ──────────────────────────
  // ⚠️ Prices need a provider-page audit before trusting the gap (same bar as
  // the rest of this table). Runware figures are anchored to a sibling repo's
  // measured cost (Schnell ~0.14¢, Kontext ~1.4¢ — Kontext ≈ 10× Schnell); the
  // fal figures are list prices pending verification. Both are per 1MP image.
  "bfl/flux-schnell": {
    id: "bfl/flux-schnell",
    modality: "image",
    routes: [
      { provider: "runware", externalId: "runware:100@1", pricing: { unit: "image", cents: 0.14 } },
      { provider: "fal", externalId: "fal-ai/flux/schnell", pricing: { unit: "megapixel", cents: 0.3 }, note: "list price, verify" },
    ],
  },
  "bfl/flux-kontext-dev": {
    id: "bfl/flux-kontext-dev",
    modality: "image",
    routes: [
      // Instruction-edit (i2i) model; restricted resolution set.
      { provider: "runware", externalId: "runware:106@1", pricing: { unit: "image", cents: 1.4 } },
      { provider: "fal", externalId: "fal-ai/flux-kontext/dev", pricing: { unit: "image", cents: 2.5 }, note: "list price, verify" },
    ],
  },

  // ── Google video (Veo) ──────────────────────────────────────
  // Kunavo video VERIFIED live 2026-06-06: veo-3-lite renders via both the async
  // path (POST /v1/videos + poll, ~80s) and the sync path (POST /v1/video/
  // generations, ~108s), real 720p mp4 out. The adapter defaults to async.
  // ⚠️ Two caveats remain on the PRICE gap, not the capability: (1) Version/SKU
  // mismatch — Kunavo bills "veo-3" per CALL (flat per clip, ~8s 720p) while fal
  // bills "veo3.1" per SECOND, so normalized to a 5s clip the per-call price wins
  // by a wide margin; (2) /v1/models exposes NO pricing, so the per-call cents
  // below are hand-entered — verify clip duration/resolution/audio before
  // trusting the gap. veo-3 / veo-3-quality capability not individually rendered.
  "google/veo-3": {
    id: "google/veo-3",
    modality: "video",
    routes: [
      { provider: "kunavo", externalId: "veo-3", pricing: { unit: "call", cents: 32 }, note: "flat per clip (~8s, SKU unverified)" },
      { provider: "fal", externalId: "fal-ai/veo3.1", pricing: { unit: "second", cents: 40 }, note: "veo3.1, 1080p audio-on (20¢/s audio-off)" },
    ],
  },
  "google/veo-3-lite": {
    id: "google/veo-3-lite",
    modality: "video",
    routes: [
      { provider: "kunavo", externalId: "veo-3-lite", pricing: { unit: "call", cents: 16 }, note: "flat per clip; rendering verified 2026-06-06 (720p, async+sync); price hand-entered" },
      { provider: "fal", externalId: "fal-ai/veo3.1/lite", pricing: { unit: "second", cents: 8 }, note: "veo3.1 lite, 1080p audio-on" },
    ],
  },
  "google/veo-3-quality": {
    id: "google/veo-3-quality",
    modality: "video",
    routes: [
      { provider: "kunavo", externalId: "veo-3-quality", pricing: { unit: "call", cents: 192 }, note: "flat per clip (SKU unverified)" },
    ],
  },
};
