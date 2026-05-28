import { Jimp } from "jimp";

const COMPARE_WIDTH = 64;
const COMPARE_HEIGHT = 64;
type JimpImage = Awaited<ReturnType<typeof Jimp.read>>;

type EmbeddingPipeline = (input: string) => Promise<unknown>;

let embeddingPipelinePromise: Promise<EmbeddingPipeline | null> | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }

  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function getEmbeddingPipeline(): Promise<EmbeddingPipeline | null> {
  if (!embeddingPipelinePromise) {
    embeddingPipelinePromise = (async () => {
      try {
        const { env, pipeline } = await import("@xenova/transformers");
        env.allowLocalModels = true;
        env.useBrowserCache = false;

        const instance = await pipeline(
          "image-feature-extraction",
          "Xenova/clip-vit-base-patch32",
        );

        return instance as EmbeddingPipeline;
      } catch {
        return null;
      }
    })();
  }

  return embeddingPipelinePromise;
}

function toVector(tensorLike: unknown): number[] {
  const data = (tensorLike as { data?: ArrayLike<number> })?.data;
  const dims = (tensorLike as { dims?: number[] })?.dims ?? [];

  if (!data) return [];

  const raw = Array.from(data);

  if (dims.length === 3) {
    const sequence = dims[1] ?? 1;
    const hidden = dims[2] ?? raw.length;
    const pooled = new Array(hidden).fill(0);

    for (let s = 0; s < sequence; s += 1) {
      const offset = s * hidden;
      for (let h = 0; h < hidden; h += 1) {
        pooled[h] += raw[offset + h] ?? 0;
      }
    }

    return pooled.map((value) => value / sequence);
  }

  if (dims.length === 2) {
    const hidden = dims[1] ?? raw.length;
    return raw.slice(0, hidden);
  }

  return raw;
}

async function embeddingSimilarity(
  targetImageUrl: string,
  generatedImageUrl: string,
): Promise<number | null> {
  const extractor = await getEmbeddingPipeline();
  if (!extractor) return null;

  try {
    const [targetTensor, generatedTensor] = await Promise.all([
      extractor(targetImageUrl),
      extractor(generatedImageUrl),
    ]);

    const targetVector = toVector(targetTensor);
    const generatedVector = toVector(generatedTensor);

    if (!targetVector.length || !generatedVector.length) return null;

    const cosine = cosineSimilarity(targetVector, generatedVector);
    const normalized = (cosine + 1) / 2;
    return clamp(Math.round(normalized * 100), 0, 100);
  } catch {
    return null;
  }
}

async function fetchImageBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(25000),
  });

  if (!response.ok) {
    throw new Error(`Failed image fetch: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function preprocess(image: JimpImage) {
  return image.clone().resize({ w: COMPARE_WIDTH, h: COMPARE_HEIGHT }).greyscale();
}

function mseSimilarity(imageA: JimpImage, imageB: JimpImage): number {
  const a = preprocess(imageA);
  const b = preprocess(imageB);
  const pixels = COMPARE_WIDTH * COMPARE_HEIGHT;

  let squaredError = 0;
  for (let i = 0; i < a.bitmap.data.length; i += 4) {
    const lumA = a.bitmap.data[i] ?? 0;
    const lumB = b.bitmap.data[i] ?? 0;
    const diff = lumA - lumB;
    squaredError += diff * diff;
  }

  const mse = squaredError / pixels;
  const normalized = 1 - mse / (255 * 255);
  return clamp(Math.round(normalized * 100), 0, 100);
}

export async function compareImageUrls(
  targetImageUrl: string,
  generatedImageUrl: string,
): Promise<number> {
  const embeddingScore = await embeddingSimilarity(targetImageUrl, generatedImageUrl);
  if (embeddingScore !== null) {
    return embeddingScore;
  }

  const [targetBuffer, generatedBuffer] = await Promise.all([
    fetchImageBuffer(targetImageUrl),
    fetchImageBuffer(generatedImageUrl),
  ]);

  const [target, generated] = await Promise.all([
    Jimp.read(targetBuffer),
    Jimp.read(generatedBuffer),
  ]);

  return mseSimilarity(target, generated);
}
