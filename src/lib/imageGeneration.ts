// Hugging Face Inference API – FLUX.1-schnell
// Requires HF_TOKEN (free at huggingface.co). If not set, falls back to
// fetching Pollinations server-side from Render's IP (different from the
// office network IP that gets rate-limited), then caches and serves the buffer.

const HF_ENDPOINT =
  "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell";

const IMAGE_GEN_TIMEOUT_MS = 50_000;
const POLLINATIONS_FETCH_TIMEOUT_MS = 55_000;

// ── In-memory image buffer cache ──────────────────────────────────────────────
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

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "image/jpeg,image/png,image/*",
  };

  try {
    const response = await fetch(HF_ENDPOINT, {
      method: "POST",
      headers,
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

// ── Pollinations server-side fetch ────────────────────────────────────────────
// Render's outbound IP is different from office/home network IPs so it is not
// subject to the Pollinations per-IP rate limit (max 1 concurrent request).
// We fetch + cache the buffer so the browser loads from /api/image/:id and
// never contacts Pollinations directly.
export async function fetchPollinationsBuffer(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "image/jpeg,image/png,image/*" },
      signal: AbortSignal.timeout(POLLINATIONS_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error(`[Pollinations] Server-side fetch failed: ${response.status}`);
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      console.error(`[Pollinations] Unexpected content-type: ${contentType}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    if (!arrayBuffer.byteLength) {
      return null;
    }

    return Buffer.from(arrayBuffer);
  } catch (error) {
    console.error("[Pollinations] Server-side fetch error:", error);
    return null;
  }
}

// Always attempt server-side generation.
export function isHFConfigured(): boolean {
  return true;
}

// ── Source URL map ────────────────────────────────────────────────────────────
// Maps imageId → original Pollinations/source URL so the /api/image/:id
// endpoint can re-fetch if the buffer was evicted after a Render spin-down.
const sourceUrlMap = new Map<string, string>();

export function storeSourceUrl(id: string, url: string): void {
  sourceUrlMap.set(id, url);
}

export function getSourceUrl(id: string): string | undefined {
  return sourceUrlMap.get(id);
}
