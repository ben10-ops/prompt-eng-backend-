import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { SubmissionEvent, SurveyFeedback } from "./types";

const DATA_DIR = path.join(process.cwd(), ".data");
const FEEDBACK_FILE = path.join(DATA_DIR, "promptwars-feedback.csv");
const SUBMISSION_FILE = path.join(DATA_DIR, "promptwars-submissions.csv");

let pool: Pool | null = null;
let feedbackTableReady = false;
let submissionTableReady = false;

function getFeedbackStorageMode(): "postgres" | "csv" {
  const mode = (process.env.FEEDBACK_STORAGE ?? "auto").trim().toLowerCase();

  if (mode === "csv") {
    return "csv";
  }

  if (mode === "postgres") {
    return "postgres";
  }

  return process.env.DATABASE_URL ? "postgres" : "csv";
}

function getPool() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required when FEEDBACK_STORAGE is postgres.");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
    });
  }

  return pool;
}

async function ensureFeedbackTable() {
  if (feedbackTableReady) {
    return;
  }

  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS survey_feedback (
        id BIGSERIAL PRIMARY KEY,
        submitted_at TIMESTAMPTZ NOT NULL,
        game_id TEXT NOT NULL DEFAULT 'main',
        submission_id TEXT NOT NULL,
        player_name TEXT NOT NULL,
        challenge_id TEXT NOT NULL,
        challenge_title TEXT NOT NULL,
        submitted_prompt TEXT NOT NULL DEFAULT '',
        final_score INTEGER NOT NULL,
        prompt_length INTEGER NOT NULL,
        app_uses_by_player INTEGER NOT NULL,
        applications_used JSONB NOT NULL DEFAULT '[]'::jsonb,
        works_well_aspects JSONB NOT NULL DEFAULT '[]'::jsonb,
        improvement_areas JSONB NOT NULL DEFAULT '[]'::jsonb,
        works_well_other TEXT,
        improvement_other TEXT,
        additional_feedback TEXT NOT NULL DEFAULT ''
      )
    `);

    await client.query(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS game_id TEXT NOT NULL DEFAULT 'main'`,
    );
    await client.query(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS submitted_prompt TEXT NOT NULL DEFAULT ''`,
    );
    await client.query(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS applications_used JSONB NOT NULL DEFAULT '[]'::jsonb`,
    );
    await client.query(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS works_well_aspects JSONB NOT NULL DEFAULT '[]'::jsonb`,
    );
    await client.query(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS improvement_areas JSONB NOT NULL DEFAULT '[]'::jsonb`,
    );
    await client.query(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS works_well_other TEXT`,
    );
    await client.query(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS improvement_other TEXT`,
    );
    await client.query(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS additional_feedback TEXT NOT NULL DEFAULT ''`,
    );

    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_survey_feedback_submission_id ON survey_feedback(submission_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_survey_feedback_player_name ON survey_feedback(player_name)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_survey_feedback_game_id ON survey_feedback(game_id)`,
    );
    feedbackTableReady = true;
  } finally {
    client.release();
  }
}

async function ensureSubmissionTable() {
  if (submissionTableReady) {
    return;
  }

  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS game_submissions (
        id BIGSERIAL PRIMARY KEY,
        submitted_at TIMESTAMPTZ NOT NULL,
        game_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        player_name TEXT NOT NULL,
        challenge_id TEXT NOT NULL,
        challenge_title TEXT NOT NULL,
        submitted_prompt TEXT NOT NULL,
        generated_image_url TEXT NOT NULL
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_game_submissions_game_id ON game_submissions(game_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_game_submissions_submission_id ON game_submissions(submission_id)`,
    );
    submissionTableReady = true;
  } finally {
    client.release();
  }
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function escapeCsv(value: string | number | boolean): string {
  const text = String(value).replace(/\r?\n/g, " ").trim();
  if (text.includes(",") || text.includes('"')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function ensureHeader() {
  if (existsSync(FEEDBACK_FILE)) {
    return;
  }

  const header = [
    "submittedAt",
    "gameId",
    "submissionId",
    "playerName",
    "challengeId",
    "challengeTitle",
    "submittedPrompt",
    "finalScore",
    "promptLength",
    "appUsesByPlayer",
    "applicationsUsed",
    "worksWellAspects",
    "improvementAreas",
    "worksWellOther",
    "improvementOther",
    "additionalFeedback",
  ].join(",");

  writeFileSync(FEEDBACK_FILE, `${header}\n`, "utf-8");
}

function ensureSubmissionHeader() {
  if (existsSync(SUBMISSION_FILE)) {
    return;
  }

  const header = [
    "submittedAt",
    "gameId",
    "submissionId",
    "playerName",
    "challengeId",
    "challengeTitle",
    "submittedPrompt",
    "generatedImageUrl",
  ].join(",");

  writeFileSync(SUBMISSION_FILE, `${header}\n`, "utf-8");
}

export function saveFeedbackToCsv(feedback: SurveyFeedback) {
  ensureDataDir();
  ensureHeader();

  const row = [
    feedback.submittedAt,
    feedback.gameId,
    feedback.submissionId,
    feedback.playerName,
    feedback.challengeId,
    feedback.challengeTitle,
    feedback.submittedPrompt,
    feedback.finalScore,
    feedback.promptLength,
    feedback.appUsesByPlayer,
    JSON.stringify(feedback.applicationsUsed),
    JSON.stringify(feedback.worksWellAspects),
    JSON.stringify(feedback.improvementAreas),
    feedback.worksWellOther ?? "",
    feedback.improvementOther ?? "",
    feedback.additionalFeedback,
  ]
    .map(escapeCsv)
    .join(",");

  appendFileSync(FEEDBACK_FILE, `${row}\n`, "utf-8");
}

export function saveSubmissionToCsv(submission: SubmissionEvent) {
  ensureDataDir();
  ensureSubmissionHeader();

  const row = [
    submission.submittedAt,
    submission.gameId,
    submission.submissionId,
    submission.playerName,
    submission.challengeId,
    submission.challengeTitle,
    submission.submittedPrompt,
    submission.generatedImageUrl,
  ]
    .map(escapeCsv)
    .join(",");

  appendFileSync(SUBMISSION_FILE, `${row}\n`, "utf-8");
}

export async function saveSubmissionEvent(submission: SubmissionEvent) {
  const mode = getFeedbackStorageMode();

  if (mode === "csv") {
    saveSubmissionToCsv(submission);
    return;
  }

  await ensureSubmissionTable();
  await getPool().query(
    `
      INSERT INTO game_submissions (
        submitted_at,
        game_id,
        submission_id,
        player_name,
        challenge_id,
        challenge_title,
        submitted_prompt,
        generated_image_url
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8
      )
    `,
    [
      submission.submittedAt,
      submission.gameId,
      submission.submissionId,
      submission.playerName,
      submission.challengeId,
      submission.challengeTitle,
      submission.submittedPrompt,
      submission.generatedImageUrl,
    ],
  );
}

export async function saveFeedback(feedback: SurveyFeedback) {
  const mode = getFeedbackStorageMode();

  if (mode === "csv") {
    saveFeedbackToCsv(feedback);
    return;
  }

  await ensureFeedbackTable();
  await getPool().query(
    `
      INSERT INTO survey_feedback (
        submitted_at,
        game_id,
        submission_id,
        player_name,
        challenge_id,
        challenge_title,
        submitted_prompt,
        final_score,
        prompt_length,
        app_uses_by_player,
        applications_used,
        works_well_aspects,
        improvement_areas,
        works_well_other,
        improvement_other,
        additional_feedback
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15, $16
      )
    `,
    [
      feedback.submittedAt,
      feedback.gameId,
      feedback.submissionId,
      feedback.playerName,
      feedback.challengeId,
      feedback.challengeTitle,
      feedback.submittedPrompt,
      feedback.finalScore,
      feedback.promptLength,
      feedback.appUsesByPlayer,
      JSON.stringify(feedback.applicationsUsed),
      JSON.stringify(feedback.worksWellAspects),
      JSON.stringify(feedback.improvementAreas),
      feedback.worksWellOther ?? null,
      feedback.improvementOther ?? null,
      feedback.additionalFeedback,
    ],
  );
}
