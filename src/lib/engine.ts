import { Challenge, PromptPersona, ScoreBreakdown } from "./types";

export const CHALLENGES: Challenge[] = [
  {
    id: "futuristic-mobility-hub",
    title: "Futuristic Mobility Hub",
    category: "easy",
    imageUrl: "/vw1.jpg",
  },
  {
    id: "enterprise-command-center",
    title: "Enterprise AI Command Center",
    category: "medium",
    imageUrl: "/1087477.jpg",
  },
  {
    id: "holographic-operations-lab",
    title: "Holographic Operations Lab",
    category: "hard",
    imageUrl: "/1087484.jpg",
  },
];

export function seededNumber(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export function createGeneratedImageUrl(prompt: string, challengeId: string): string {
  const challenge = CHALLENGES.find((item) => item.id === challengeId);
  const challengeTitle = challenge?.title ?? "";
  const seed = seededNumber(`${challengeId}:${prompt}`);
  const userPrompt = prompt.replace(/\s+/g, " ").trim();
  const target = challengeTitle.replace(/\s+/g, " ").trim();
  const optimizedPrompt = [
    target ? `Target scene: ${target}. User intent: ${userPrompt}.` : `User intent: ${userPrompt}.`,
    "Recreate the target scene as closely as possible while preserving realism.",
    "Photorealistic, physically based rendering, high detail textures.",
    "Accurate perspective, coherent composition, natural lighting, realistic shadows and reflections.",
    "Cinematic but faithful to prompt details, no text overlays, no watermark.",
    "Sharp focus, 8k quality, professional color grading.",
  ].join(" ");

  return `https://image.pollinations.ai/prompt/${encodeURIComponent(
    optimizedPrompt,
  )}?model=flux&width=1280&height=720&seed=${seed}&enhance=true&nologo=true&safe=true`;
}

export function createFallbackImageUrl(prompt: string, challengeId: string): string {
  const seed = `${challengeId}-${prompt.toLowerCase().trim().replace(/\s+/g, "-")}`;
  return `https://picsum.photos/seed/${encodeURIComponent(seed)}/1280/720`;
}

export function scorePrompt(
  prompt: string,
  challenge: Challenge,
  options?: {
    imageSimilarity?: number;
  },
): ScoreBreakdown {
  const text = prompt.trim().toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  const tokenCount = words.length;

  const cinematicTerms = [
    "cinematic",
    "lighting",
    "volumetric",
    "composition",
    "depth of field",
    "reflection",
    "realistic",
    "ultra detailed",
    "camera",
  ];

  const technicalTerms = [
    "enterprise",
    "dashboard",
    "holographic",
    "systems",
    "control",
    "workspace",
    "operations",
    "architecture",
    "infrastructure",
  ];

  const cinematicHits = cinematicTerms.filter((t) => text.includes(t)).length;
  const technicalHits = technicalTerms.filter((t) => text.includes(t)).length;
  const richness = clamp(Math.round((tokenCount / 45) * 100), 20, 100);
  const seeded = seededNumber(`${prompt}:${challenge.id}`) % 100;

  const heuristicSimilarity = clamp(
    Math.round(55 + seeded * 0.4 + cinematicHits * 3),
    45,
    98,
  );
  const similarity = clamp(
    Math.round(options?.imageSimilarity ?? heuristicSimilarity),
    0,
    100,
  );
  const promptQuality = clamp(Math.round(40 + richness * 0.55 + technicalHits * 2), 35, 99);
  const styleAlignment = clamp(
    Math.round(45 + cinematicHits * 6 + (challenge.category === "hard" ? 5 : 0)),
    35,
    99,
  );
  const detailCoverage = clamp(Math.round(35 + tokenCount * 1.2 + technicalHits * 4), 20, 99);

  const finalScore = Math.round(
    similarity * 0.5 +
      promptQuality * 0.2 +
      styleAlignment * 0.2 +
      detailCoverage * 0.1,
  );

  return {
    similarity,
    promptQuality,
    styleAlignment,
    detailCoverage,
    finalScore,
  };
}

export function getPromptPersona(prompt: string, finalScore: number): PromptPersona {
  const text = prompt.toLowerCase();

  const styleTag = text.includes("cinematic") || text.includes("lighting")
    ? "Cinematic Thinker"
    : text.includes("system") || text.includes("enterprise")
      ? "Structured Thinker"
      : text.includes("minimal")
        ? "Minimalist Thinker"
        : "Experimental Thinker";

  if (finalScore >= 93) {
    return {
      tier: "Neural Commander",
      styleTag,
      characterName: "Astra Prime",
      characterUrl: "https://api.dicebear.com/9.x/bottts/svg?seed=AstraPrime",
      dnaInsight:
        "Your prompt DNA combines precision and visual storytelling, producing highly aligned outputs.",
    };
  }

  if (finalScore >= 85) {
    return {
      tier: "Systems Director",
      styleTag,
      characterName: "Vector Marshal",
      characterUrl: "https://api.dicebear.com/9.x/bottts/svg?seed=VectorMarshal",
      dnaInsight:
        "Your prompt DNA is strategic and balanced, with strong control of environment and style.",
    };
  }

  if (finalScore >= 75) {
    return {
      tier: "Prompt Strategist",
      styleTag,
      characterName: "Pulse Architect",
      characterUrl: "https://api.dicebear.com/9.x/bottts/svg?seed=PulseArchitect",
      dnaInsight:
        "Your prompt DNA shows good structure and detail layering with room to sharpen specificity.",
    };
  }

  if (finalScore >= 60) {
    return {
      tier: "Visual Operator",
      styleTag,
      characterName: "Nova Operator",
      characterUrl: "https://api.dicebear.com/9.x/bottts/svg?seed=NovaOperator",
      dnaInsight:
        "Your prompt DNA is directionally strong; adding camera and material detail will boost alignment.",
    };
  }

  return {
    tier: "Signal Starter",
    styleTag,
    characterName: "Echo Unit",
    characterUrl: "https://api.dicebear.com/9.x/bottts/svg?seed=EchoUnit",
    dnaInsight:
      "Your prompt DNA has clear intent; expand atmosphere, composition, and technical cues for stronger results.",
  };
}
