import "dotenv/config";
import cors from "cors";
import express from "express";
import { createGeneratedImageUrl } from "./lib/engine";
import { compareImageUrls } from "./lib/imageSimilarity";
import { saveFeedback } from "./lib/feedback";
import {
  createPendingSubmission,
  finalizePendingSubmission,
  getCurrentChallenge,
  getPendingSubmissionById,
  getPlayerSubmissionCount,
  getRecentPendingSubmissions,
  getRecentSubmissions,
  getSubmissionById,
  getSubmissions,
  rotateChallenge,
} from "./lib/store";
import { SurveyFeedback } from "./lib/types";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const frontendUrl =
  process.env.FRONTEND_URL ?? "https://prompt-war-six.vercel.app";

const allowedOrigins = new Set([
  frontendUrl,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://prompt-war-six.vercel.app",
]);

function isLocalOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function shouldRunImageSimilarity() {
  if (process.env.DISABLE_IMAGE_SIMILARITY === "true") {
    return false;
  }

  return process.env.NODE_ENV !== "production";
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin) || isLocalOrigin(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.options("*", cors());
app.use(express.json({ limit: "1mb" }));

function toAbsoluteUrl(maybeRelative: string): string {
  if (/^https?:\/\//i.test(maybeRelative)) {
    return maybeRelative;
  }

  return new URL(maybeRelative, frontendUrl).toString();
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/state", (_req, res) => {
  const submissions = getSubmissions();
  const recentResults = getRecentSubmissions(4);
  const pendingResults = getRecentPendingSubmissions(4);

  res.json({
    challenge: getCurrentChallenge(),
    submissions,
    leaderboard: submissions.slice(0, 8),
    latest: recentResults[0] ?? null,
    recentResults,
    pendingResults,
  });
});

app.post("/api/state", (_req, res) => {
  const challenge = rotateChallenge();
  res.json({ challenge });
});

app.get("/api/survey", (_req, res) => {
  res.json({ message: "Use POST /api/survey to submit feedback." });
});

app.post("/api/submit", async (req, res) => {
  try {
    const body = req.body as {
      playerName?: string;
      prompt?: string;
    };

    const playerName = body.playerName?.trim();
    const prompt = body.prompt?.trim();

    if (!playerName || !prompt) {
      res.status(400).json({ message: "playerName and prompt are required." });
      return;
    }

    if (prompt.length < 15) {
      res.status(400).json({ message: "Prompt is too short. Add more scene detail." });
      return;
    }

    const challenge = getCurrentChallenge();
    const generatedImageUrl = toAbsoluteUrl(createGeneratedImageUrl(prompt, challenge.id));

    let imageSimilarity: number | undefined = undefined;
    if (shouldRunImageSimilarity()) {
      try {
        imageSimilarity = await compareImageUrls(
          toAbsoluteUrl(challenge.imageUrl),
          generatedImageUrl,
        );
      } catch {
        imageSimilarity = undefined;
      }
    }

    const pending = createPendingSubmission({
      playerName,
      prompt,
      generatedImageUrl,
      imageSimilarity,
    });

    res.status(201).json({
      pendingId: pending.id,
      surveyUrl: `/survey/${pending.id}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to submit prompt.";
    res.status(500).json({ message });
  }
});

app.post("/api/survey", async (req, res) => {
  const body = req.body as {
    submissionId?: string;
    applicationsUsed?: string[];
    worksWellAspects?: string[];
    improvementAreas?: string[];
    worksWellOther?: string;
    improvementOther?: string;
    additionalFeedback?: string;
  };

  const submissionId = body.submissionId?.trim();
  const applicationsUsed = Array.isArray(body.applicationsUsed)
    ? body.applicationsUsed.filter((item) => typeof item === "string" && item.trim())
    : [];
  const worksWellAspects = Array.isArray(body.worksWellAspects)
    ? body.worksWellAspects.filter((item) => typeof item === "string" && item.trim())
    : [];
  const improvementAreas = Array.isArray(body.improvementAreas)
    ? body.improvementAreas.filter((item) => typeof item === "string" && item.trim())
    : [];
  const worksWellOther = body.worksWellOther?.trim() ?? "";
  const improvementOther = body.improvementOther?.trim() ?? "";
  const additionalFeedback = body.additionalFeedback?.trim() ?? "";

  if (!submissionId) {
    res.status(400).json({ message: "submissionId is required." });
    return;
  }

  const pending = getPendingSubmissionById(submissionId);
  if (!pending) {
    res.status(404).json({ message: "Submission not found or already finalized." });
    return;
  }

  const submission = finalizePendingSubmission(submissionId);
  if (!submission) {
    res.status(500).json({ message: "Unable to finalize this submission." });
    return;
  }

  const appUsesByPlayer = getPlayerSubmissionCount(submission.playerName);

  const feedbackPayload: SurveyFeedback = {
    submissionId: submission.id,
    playerName: submission.playerName,
    challengeId: submission.challenge.id,
    challengeTitle: submission.challenge.title,
    finalScore: submission.scores.finalScore,
    promptLength: submission.prompt.length,
    appUsesByPlayer,
    applicationsUsed,
    worksWellAspects,
    improvementAreas,
    worksWellOther,
    improvementOther,
    additionalFeedback,
    submittedAt: new Date().toISOString(),
  };

  try {
    await saveFeedback(feedbackPayload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to store feedback.";
    res.status(500).json({ message });
    return;
  }

  res.status(201).json({
    id: submission.id,
    resultUrl: `/result/${submission.id}`,
  });
});

app.get("/api/submission/:id", (req, res) => {
  const id = req.params.id;

  const pending = getPendingSubmissionById(id);
  if (pending) {
    res.json({ status: "pending", submission: pending });
    return;
  }

  const finalized = getSubmissionById(id);
  if (finalized) {
    res.json({ status: "finalized", submission: finalized });
    return;
  }

  res.status(404).json({ message: "Submission not found." });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Internal server error.";
  res.status(500).json({ message });
});

app.listen(port, () => {
  console.log(`Prompt Wars backend running on http://localhost:${port}`);
});
