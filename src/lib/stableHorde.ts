/**
 * Stable Horde image generation
 * https://stablehorde.net — completely free, crowdsourced GPU workers
 *
 * Flow:
 *   1. Submit generation job → get job ID
 *   2. Poll /check/:id until done (5 s intervals, 2 min max)
 *   3. Fetch /status/:id → get base64 PNG
 *   4. Cache buffer in memory (survives the session, cleared on restart)
 *
 * Anonymous key "0000000000" is allowed but has lowest priority.
 * Set STABLE_HORDE_KEY env var with a registered key for faster queuing.
 */

const BASE = "https://stablehorde.net/api/v2";
const API_KEY = process.env.STABLE_HORDE_KEY ?? "0000000000";

// In-memory image store: submissionId → PNG buffer
// Images only need to survive until the result page is viewed (minutes).
const imageCache = new Map<string, Buffer>();

export function getCachedImage(submissionId: string): Buffer | null {
  return imageCache.get(submissionId) ?? null;
}

// ── Step 1: submit job ────────────────────────────────────────────────────────
async function submitJob(prompt: string): Promise<string> {
  const res = await fetch(`${BASE}/generate/async`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: API_KEY,
      "Client-Agent": "PromptWars:1.0:promptwars",
    },
    body: JSON.stringify({
      prompt,
      params: {
        width: 512,
        height: 512,
        steps: 20,
        n: 1,
        cfg_scale: 7,
        sampler_name: "k_euler",
        karras: true,
      },
      // Try FLUX first (best quality), fall back to SDXL / Deliberate
      models: [
        "Flux.1-Schnell fp8 (Compact)",
        "AlbedoBase XL (SDXL)",
        "Deliberate",
      ],
      slow_workers: true, // use all available workers including slow ones
      r2: false,          // return base64, not presigned URL
      shared: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.status.toString());
    throw new Error(`Stable Horde submit failed ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { id: string };
  if (!data.id) throw new Error("Stable Horde returned no job ID");
  return data.id;
}

// ── Step 2 & 3: poll + retrieve ───────────────────────────────────────────────
async function waitForImage(jobId: string): Promise<Buffer> {
  const MAX_MS = 2 * 60 * 1000; // 2 minutes
  const POLL_MS = 5_000;
  const deadline = Date.now() + MAX_MS;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));

    const checkRes = await fetch(`${BASE}/generate/check/${jobId}`, {
      headers: { apikey: API_KEY },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);

    if (!checkRes?.ok) continue;

    const check = (await checkRes.json()) as {
      done: boolean;
      faulted?: boolean;
      waiting?: number;
      queue_position?: number;
    };

    if (check.faulted) throw new Error("Stable Horde: generation faulted");
    if (!check.done) continue;

    // Job done — fetch the actual image
    const statusRes = await fetch(`${BASE}/generate/status/${jobId}`, {
      headers: { apikey: API_KEY },
      signal: AbortSignal.timeout(15_000),
    });

    if (!statusRes.ok) throw new Error(`Status fetch failed: ${statusRes.status}`);

    const status = (await statusRes.json()) as {
      generations: Array<{ img: string; censored?: boolean }>;
    };

    const gen = status.generations[0];
    if (!gen?.img) throw new Error("No image in Stable Horde response");
    if (gen.censored) throw new Error("Image was censored by safety filter");

    return Buffer.from(gen.img, "base64");
  }

  throw new Error("Stable Horde: timed out after 2 minutes");
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Generates an image from the user's prompt and caches it by submissionId.
 * Returns the image buffer (PNG).
 */
export async function generateImage(
  submissionId: string,
  userPrompt: string,
): Promise<Buffer> {
  // Append quality modifiers to the user's raw prompt
  const fullPrompt = [
    userPrompt.replace(/\s+/g, " ").trim(),
    "photorealistic, high detail, professional color grading, sharp focus",
  ].join(", ");

  const jobId = await submitJob(fullPrompt);
  console.log(`[StableHorde] job ${jobId} submitted for submission ${submissionId}`);

  const buffer = await waitForImage(jobId);
  imageCache.set(submissionId, buffer);
  console.log(`[StableHorde] job ${jobId} done — ${buffer.length} bytes cached`);
  return buffer;
}
