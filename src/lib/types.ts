export type ScoreBreakdown = {
  similarity: number;
  promptQuality: number;
  styleAlignment: number;
  detailCoverage: number;
  finalScore: number;
};

export type PromptPersona = {
  tier: string;
  styleTag: string;
  characterName: string;
  characterUrl: string;
  dnaInsight: string;
};

export type Challenge = {
  id: string;
  title: string;
  imageUrl: string;
  category: "easy" | "medium" | "hard";
};

export type PlayerSubmission = {
  id: string;
  playerName: string;
  prompt: string;
  challenge: Challenge;
  generatedImageUrl: string;
  scores: ScoreBreakdown;
  persona: PromptPersona;
  createdAt: string;
};

export type SurveyFeedback = {
  submissionId: string;
  playerName: string;
  challengeId: string;
  challengeTitle: string;
  finalScore: number;
  promptLength: number;
  appUsesByPlayer: number;
  applicationsUsed: string[];
  worksWellAspects: string[];
  improvementAreas: string[];
  worksWellOther?: string;
  improvementOther?: string;
  additionalFeedback: string;
  submittedAt: string;
};
