import "dotenv/config";
import cors from "cors";
import express from "express";
import { createGeneratedImageUrl } from "./lib/engine";
import { compareImageUrls } from "./lib/imageSimilarity";
import { saveFeedback, saveSubmissionEvent } from "./lib/feedback";
import {
  createSession,
  createPendingSubmission,
  finalizePendingSubmission,
  getCurrentChallenge,
  getCurrentPlayerCount,
  getPendingSubmissionById,
  getPlayerSubmissionCount,
  getRecentPendingSubmissions,
  getRecentSubmissions,
  getSessionSummary,
  getSubmissionById,
  getSubmissions,
  isSessionAtCapacity,
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

function normalizeSessionId(raw?: string): string | undefined {
  const value = raw?.trim().toLowerCase();
  return value ? value : undefined;
}

function getSessionIdFromRequest(req: express.Request): string | undefined {
  const querySession = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
  const headerSession = typeof req.headers["x-session-id"] === "string"
    ? req.headers["x-session-id"]
    : undefined;
  const bodySession =
    typeof req.body === "object" && req.body !== null && "sessionId" in req.body
      ? String((req.body as { sessionId?: string }).sessionId ?? "")
      : undefined;

  return normalizeSessionId(querySession ?? bodySession ?? headerSession);
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/session", (req, res) => {
  const body = req.body as { sessionId?: string };
  const requestedSessionId = normalizeSessionId(body.sessionId);
  const session = createSession(requestedSessionId);

  res.status(201).json({
    sessionId: session.sessionId,
    maxPlayers: session.maxPlayers,
    joinUrl: `/join?sessionId=${encodeURIComponent(session.sessionId)}`,
    screenUrl: `/screen?sessionId=${encodeURIComponent(session.sessionId)}`,
  });
});

app.get("/api/session/:id", (req, res) => {
  const sessionId = normalizeSessionId(req.params.id);
  const summary = getSessionSummary(sessionId);
  res.json(summary);
});

app.get("/api/state", (req, res) => {
  const sessionId = getSessionIdFromRequest(req);
  const submissions = getSubmissions(sessionId);
  const leaderboard = submissions.slice(0, 5);
  const recentResults = getRecentSubmissions(4, sessionId);
  const pendingResults = getRecentPendingSubmissions(4, sessionId);
  const summary = getSessionSummary(sessionId);

  res.json({
    sessionId: summary.sessionId,
    maxPlayers: summary.maxPlayers,
    currentPlayers: summary.currentPlayers,
    isAtCapacity: isSessionAtCapacity(summary.sessionId),
    challenge: getCurrentChallenge(summary.sessionId),
    submissions,
    leaderboard,
    latest: recentResults[0] ?? null,
    recentResults,
    pendingResults,
  });
});

app.post("/api/state", (_req, res) => {
  const sessionId = getSessionIdFromRequest(_req);
  const challenge = rotateChallenge(sessionId);
  const summary = getSessionSummary(sessionId);
  res.json({ challenge, sessionId: summary.sessionId });
});

app.get("/api/survey", (_req, res) => {
  res.json({ message: "Use POST /api/survey to submit feedback." });
});

app.post("/api/submit", async (req, res) => {
  try {
    const sessionId = getSessionIdFromRequest(req);
    const body = req.body as {
      sessionId?: string;
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

    const challenge = getCurrentChallenge(sessionId);
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
      sessionId,
      playerName,
      prompt,
      generatedImageUrl,
      imageSimilarity,
    });

    const summary = getSessionSummary(sessionId);

    try {
      await saveSubmissionEvent({
        gameId: pending.sessionId ?? summary.sessionId,
        submissionId: pending.id,
        playerName: pending.playerName,
        challengeId: pending.challenge.id,
        challengeTitle: pending.challenge.title,
        submittedPrompt: pending.prompt,
        generatedImageUrl: pending.generatedImageUrl,
        submittedAt: pending.createdAt,
      });
    } catch (error) {
      // Keep gameplay responsive even if telemetry write fails.
      console.error("saveSubmissionEvent failed", error);
    }

    res.status(201).json({
      pendingId: pending.id,
      sessionId: summary.sessionId,
      surveyUrl: `/survey/${pending.id}?sessionId=${encodeURIComponent(summary.sessionId)}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to submit prompt.";
    res.status(500).json({ message });
  }
});

app.post("/api/survey", async (req, res) => {
  const sessionId = getSessionIdFromRequest(req);
  const body = req.body as {
    sessionId?: string;
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

  const pending = getPendingSubmissionById(submissionId, sessionId);
  if (!pending) {
    const finalized = getSubmissionById(submissionId, sessionId);
    if (finalized) {
      const retryFeedbackPayload: SurveyFeedback = {
        gameId: finalized.sessionId ?? sessionId ?? "main",
        submissionId: finalized.id,
        playerName: finalized.playerName,
        challengeId: finalized.challenge.id,
        challengeTitle: finalized.challenge.title,
        submittedPrompt: finalized.prompt,
        finalScore: finalized.scores.finalScore,
        promptLength: finalized.prompt.length,
        appUsesByPlayer: getPlayerSubmissionCount(finalized.playerName, sessionId),
        applicationsUsed,
        worksWellAspects,
        improvementAreas,
        worksWellOther,
        improvementOther,
        additionalFeedback,
        submittedAt: new Date().toISOString(),
      };

      let feedbackStored = true;
      try {
        await saveFeedback(retryFeedbackPayload);
      } catch (error) {
        feedbackStored = false;
        console.error("saveFeedback retry failed", {
          submissionId: finalized.id,
          sessionId: finalized.sessionId ?? sessionId ?? "main",
          error,
        });
      }

      res.status(200).json({
        id: finalized.id,
        resultUrl: `/result/${finalized.id}`,
        status: "already_finalized",
        feedbackStored,
      });
      return;
    }

    res.status(404).json({ message: "Submission not found." });
    return;
  }

  const feedbackPayload: SurveyFeedback = {
    gameId: pending.sessionId ?? sessionId ?? "main",
    submissionId: pending.id,
    playerName: pending.playerName,
    challengeId: pending.challenge.id,
    challengeTitle: pending.challenge.title,
    submittedPrompt: pending.prompt,
    finalScore: pending.scores.finalScore,
    promptLength: pending.prompt.length,
    appUsesByPlayer: getPlayerSubmissionCount(pending.playerName, sessionId) + 1,
    applicationsUsed,
    worksWellAspects,
    improvementAreas,
    worksWellOther,
    improvementOther,
    additionalFeedback,
    submittedAt: new Date().toISOString(),
  };

  let feedbackStored = true;
  try {
    await saveFeedback(feedbackPayload);
  } catch (error) {
    feedbackStored = false;
    console.error("saveFeedback failed", {
      submissionId: pending.id,
      sessionId: pending.sessionId ?? sessionId ?? "main",
      error,
    });
  }

  const submission = finalizePendingSubmission(submissionId, sessionId);
  if (!submission) {
    res.status(500).json({ message: "Unable to finalize this submission." });
    return;
  }

  res.status(201).json({
    id: submission.id,
    resultUrl: `/result/${submission.id}`,
    feedbackStored,
  });
});

app.get("/api/submission/:id", (req, res) => {
  const sessionId = getSessionIdFromRequest(req);
  const id = req.params.id;

  const pending = getPendingSubmissionById(id, sessionId);
  if (pending) {
    res.json({ status: "pending", submission: pending });
    return;
  }

  const finalized = getSubmissionById(id, sessionId);
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
