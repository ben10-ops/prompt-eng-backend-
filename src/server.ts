import "dotenv/config";
import cors from "cors";
import express from "express";
import { createGeneratedImageUrl, scorePrompt } from "./lib/engine";
import { cacheImageBuffer, fetchPollinationsBuffer, generateImageViaHF, getImageBuffer, isHFConfigured } from "./lib/imageGeneration";
import { compareImageUrls, compareTargetUrlWithBuffer } from "./lib/imageSimilarity";
import { getFeedbackEntries, saveFeedback, saveSubmissionEvent } from "./lib/feedback";
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
  startNextBatch,
  getSubmissionById,
  getSubmissions,
  isSessionAtCapacity,
  rotateChallenge,
  updatePendingSubmission,
} from "./lib/store";
import { SurveyFeedback } from "./lib/types";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const frontendUrl =
  process.env.FRONTEND_URL ?? "https://prompt-war-six.vercel.app";

// Public URL of THIS backend — used to build absolute /api/image/:id URLs.
// Render sets RENDER_EXTERNAL_URL automatically; fall back to localhost for dev.
const backendPublicUrl = (
  process.env.RENDER_EXTERNAL_URL ??
  process.env.BACKEND_PUBLIC_URL ??
  `http://localhost:${port}`
).replace(/\/$/, "");

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

  return true;
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
  const body = _req.body as { resetLeaderboard?: boolean | string };
  const resetLeaderboard =
    body.resetLeaderboard === true || body.resetLeaderboard === "true";
  const challenge = resetLeaderboard ? startNextBatch(sessionId) : rotateChallenge(sessionId);
  const summary = getSessionSummary(sessionId);
  res.json({ challenge, sessionId: summary.sessionId, resetLeaderboard });
});

app.get("/api/survey", (_req, res) => {
  res.json({ message: "Use POST /api/survey to submit feedback." });
});

app.get("/api/feedback", async (req, res) => {
  try {
    const querySession = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    const sessionId = normalizeSessionId(querySession);
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;

    const payload = await getFeedbackEntries({
      sessionId,
      limit,
    });

    res.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to fetch feedback entries.";
    res.status(500).json({ message });
  }
});

app.post("/api/submit", async (req, res) => {
  try {
    const sessionId = getSessionIdFromRequest(req);
    const body = req.body as {
      sessionId?: string;
      playerName?: string;
      prompt?: string;
      autoSubmitted?: boolean | string;
    };

    const playerName = body.playerName?.trim();
    const prompt = body.prompt?.trim() ?? "";
    const autoSubmitted = body.autoSubmitted === true || body.autoSubmitted === "true";

    if (!playerName) {
      res.status(400).json({ message: "playerName is required." });
      return;
    }

    // Allow empty or short prompts when this request was triggered by the
    // client's auto-submit (timer). In that case we accept the submission
    // and later mark the score as zero. For manual submits, enforce length.
    if (!prompt && !autoSubmitted) {
      res.status(400).json({ message: "prompt is required." });
      return;
    }

    if (prompt.length < 15 && !autoSubmitted) {
      res.status(400).json({ message: "Prompt is too short. Add more scene detail." });
      return;
    }

    const challenge = getCurrentChallenge(sessionId);

    // ── Immediate: create pending submission with Pollinations fallback URL ──
    // The response is sent right away so the browser is never blocked by
    // slow image generation (Render free tier drops requests after 30 s).
    const pollinationsUrl = toAbsoluteUrl(createGeneratedImageUrl(prompt, challenge.id));

    const pending = createPendingSubmission({
      sessionId,
      playerName,
      prompt,
      generatedImageUrl: pollinationsUrl,
      imageSimilarity: undefined,
      forceZeroScore: autoSubmitted && !prompt,
    });

    const summary = getSessionSummary(sessionId);

    // Return to the client immediately — do NOT await image generation.
    res.status(201).json({
      pendingId: pending.id,
      sessionId: summary.sessionId,
      surveyUrl: `/survey/${pending.id}?sessionId=${encodeURIComponent(summary.sessionId)}`,
    });

    // ── Background: image generation + comparison (fire-and-forget) ────────────
    // Runs after the response is sent. Updates the pending submission in-place
    // so the result page (loaded after the user completes the survey) has the
    // real image and scored values.
    if (!autoSubmitted && prompt) {
      void (async () => {
        try {
          const imageId = `img-${pending.id}`;
          let generatedBuffer: Buffer | null = null;

          // 1. Try HF FLUX (needs HF_TOKEN env var)
          if (process.env.HF_TOKEN?.trim()) {
            const finalPrompt = `${prompt.trim()}, photorealistic, high quality, professional photography`;
            logMemory("bg:before-hf-generate");
            generatedBuffer = await generateImageViaHF(finalPrompt);
            logMemory("bg:after-hf-generate");
          }

          // 2. Fallback: fetch Pollinations server-side from Render's IP.
          //    Render's outbound IP is NOT the same as the office/home network IP
          //    that gets rate-limited, so this reliably returns an image.
          if (!generatedBuffer) {
            logMemory("bg:before-pollinations-fetch");
            generatedBuffer = await fetchPollinationsBuffer(pollinationsUrl);
            logMemory("bg:after-pollinations-fetch");
          }

          let generatedImageUrl = pollinationsUrl;
          if (generatedBuffer) {
            cacheImageBuffer(imageId, generatedBuffer);
            generatedImageUrl = `${backendPublicUrl}/api/image/${imageId}`;
          }

          let imageSimilarity: number | undefined;
          if (shouldRunImageSimilarity()) {
            try {
              logMemory("bg:before-compare");
              if (generatedBuffer) {
                imageSimilarity = await compareTargetUrlWithBuffer(
                  toAbsoluteUrl(challenge.imageUrl),
                  generatedBuffer,
                );
              } else {
                imageSimilarity = await compareImageUrls(
                  toAbsoluteUrl(challenge.imageUrl),
                  generatedImageUrl,
                );
              }
              logMemory(`bg:after-compare score=${imageSimilarity}`);
            } catch {
              imageSimilarity = undefined;
            }
          }

          const updatedScores = scorePrompt(prompt, challenge, { imageSimilarity });
          updatePendingSubmission(pending.id, {
            generatedImageUrl,
            scores: updatedScores,
          });
          console.log(`[bg] Updated submission ${pending.id}: image=${generatedImageUrl.slice(0, 60)} score=${updatedScores.finalScore}`);
        } catch (bgError) {
          console.error(`[bg] Background image gen failed for ${pending.id}:`, bgError);
        }
      })();
    }

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
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to submit prompt.";
    res.status(500).json({ message });
  }
});

app.post("/api/survey", async (req, res) => {
  try {
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

        try {
          await saveFeedback(retryFeedbackPayload);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to store feedback.";
          res.status(500).json({ message });
          return;
        }

        res.status(200).json({
          id: finalized.id,
          resultUrl: `/result/${finalized.id}`,
          status: "already_finalized",
        });
        return;
      }

      // Submission not found — server likely restarted and lost ephemeral store.
      // Save the feedback with whatever we have and return success so the user
      // is not blocked.
      const orphanFeedbackPayload: SurveyFeedback = {
        gameId: sessionId ?? "main",
        submissionId: submissionId,
        playerName: "unknown",
        challengeId: "unknown",
        challengeTitle: "unknown",
        submittedPrompt: "",
        finalScore: 0,
        promptLength: 0,
        appUsesByPlayer: 0,
        applicationsUsed,
        worksWellAspects,
        improvementAreas,
        worksWellOther,
        improvementOther,
        additionalFeedback,
        submittedAt: new Date().toISOString(),
      };

      try {
        await saveFeedback(orphanFeedbackPayload);
      } catch (error) {
        console.warn("Unable to save orphan feedback", { submissionId, error });
      }

      res.status(200).json({
        id: submissionId,
        resultUrl: null,
        status: "submission_expired",
      });
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

    try {
      await saveFeedback(feedbackPayload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to store feedback.";
      res.status(500).json({ message });
      return;
    }

    const submission = finalizePendingSubmission(submissionId, sessionId);
    if (!submission) {
      res.status(500).json({ message: "Unable to finalize this submission." });
      return;
    }

    res.status(201).json({
      id: submission.id,
      resultUrl: `/result/${submission.id}`,
    });
  } catch (error) {
    console.error("Unhandled /api/survey error", {
      sessionId: getSessionIdFromRequest(req),
      body: req.body,
      error,
    });
    const message = error instanceof Error ? error.message : "Unable to submit survey feedback.";
    res.status(500).json({ message });
  }
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

// Serve HF-generated images from the in-memory buffer cache.
// CORS is already handled globally so the frontend can load these cross-origin.
app.get("/api/image/:id", (req, res) => {
  const buffer = getImageBuffer(req.params.id);
  if (!buffer) {
    res.status(404).json({ message: "Image not found or expired." });
    return;
  }
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=3600, immutable");
  res.end(buffer);
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Internal server error.";
  res.status(500).json({ message });
});

function logMemory(label: string) {
  const mem = process.memoryUsage();
  const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`;
  console.log(
    `[MEM] ${label} | RSS: ${mb(mem.rss)} | Heap: ${mb(mem.heapUsed)}/${mb(mem.heapTotal)} | External: ${mb(mem.external)}`
  );
}

app.listen(port, () => {
  console.log(`Prompt Wars backend running on http://localhost:${port}`);
  logMemory("startup");
  setInterval(() => logMemory("heartbeat"), 60_000);
});
