import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { SurveyFeedback } from "./types";

const DATA_DIR = path.join(process.cwd(), ".data");
const FEEDBACK_FILE = path.join(DATA_DIR, "promptwars-feedback.csv");

let pool: Pool | null = null;
let feedbackTableReady = false;

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
        submission_id TEXT NOT NULL,
        player_name TEXT NOT NULL,
        challenge_id TEXT NOT NULL,
        challenge_title TEXT NOT NULL,
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
    feedbackTableReady = true;
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
    "submissionId",
    "playerName",
    "challengeId",
    "challengeTitle",
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

export function saveFeedbackToCsv(feedback: SurveyFeedback) {
  ensureDataDir();
  ensureHeader();

  const row = [
    feedback.submittedAt,
    feedback.submissionId,
    feedback.playerName,
    feedback.challengeId,
    feedback.challengeTitle,
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

export async function saveFeedback(feedback: SurveyFeedback) {
  const mode = getFeedbackStorageMode();

  if (mode === "csv") {
    saveFeedbackToCsv(feedback);
    return;
  }

  try {
    await ensureFeedbackTable();
    await getPool().query(
      `
        INSERT INTO survey_feedback (
          submitted_at,
          submission_id,
          player_name,
          challenge_id,
          challenge_title,
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
          $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14
        )
      `,
      [
        feedback.submittedAt,
        feedback.submissionId,
        feedback.playerName,
        feedback.challengeId,
        feedback.challengeTitle,
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
  } catch {
    saveFeedbackToCsv(feedback);
  }
}
