// Hugging Face Inference API – free tier (FLUX.1-schnell)
// Sign up at huggingface.co (free), create a token, set HF_TOKEN env var.
// Falls back to Pollinations URL if HF_TOKEN is not set or generation fails.

const HF_ENDPOINT =
  "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell";

const IMAGE_GEN_TIMEOUT_MS = 50_000; // 50 s — background task, no Render request-timeout risk

// ── In-memory image buffer cache ──────────────────────────────────────────────
// Capped at MAX_CACHED entries; oldest is evicted on overflow.
// At ~200 KB per image (1024×576 JPEG), 60 entries ≈ 12 MB.
const MAX_CACHED = 60;
const bufferCache = new Map<string, Buffer>();
const cacheOrder: string[] = [];

export function cacheImageBuffer(id: string, buffer: Buffer): void {
  if (cacheOrder.length >= MAX_CACHED) {
    const evicted = cacheOrder.shift()!;
    bufferCache.delete(evicted);
  }
  bufferCache.set(id, buffer);
  cacheOrder.push(id);
}

export function getImageBuffer(id: string): Buffer | undefined {
  return bufferCache.get(id);
}

// ── HF image generation ───────────────────────────────────────────────────────

export async function generateImageViaHF(prompt: string): Promise<Buffer | null> {
  const token = process.env.HF_TOKEN?.trim();
  if (!token) {
    return null;
  }

  try {
    const response = await fetch(HF_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "image/jpeg,image/png,image/*",
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: {
          width: 1024,
          height: 576,
          num_inference_steps: 4,
          guidance_scale: 3.5,
        },
      }),
      signal: AbortSignal.timeout(IMAGE_GEN_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(no body)");
      console.error(`[HF] Image generation failed: ${response.status}`, body);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    if (!arrayBuffer.byteLength) {
      console.error("[HF] Received empty image buffer.");
      return null;
    }

    return Buffer.from(arrayBuffer);
  } catch (error) {
    console.error("[HF] Image generation error:", error);
    return null;
  }
}

export function isHFConfigured(): boolean {
  return Boolean(process.env.HF_TOKEN?.trim());
}
