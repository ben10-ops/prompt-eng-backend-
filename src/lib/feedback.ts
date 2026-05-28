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
let feedbackColumnsCache: Set<string> | null = null;

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
    const runBestEffort = async (query: string) => {
      try {
        await client.query(query);
      } catch (error) {
        console.warn("survey_feedback schema sync warning", error);
      }
    };

    await runBestEffort(`
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

    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS game_id TEXT NOT NULL DEFAULT 'main'`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS room_id TEXT NOT NULL DEFAULT 'main'`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'main'`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS submitted_prompt TEXT NOT NULL DEFAULT ''`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS applications_used JSONB NOT NULL DEFAULT '[]'::jsonb`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS works_well_aspects JSONB NOT NULL DEFAULT '[]'::jsonb`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS improvement_areas JSONB NOT NULL DEFAULT '[]'::jsonb`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS works_well_other TEXT`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS improvement_other TEXT`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS additional_feedback TEXT NOT NULL DEFAULT ''`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS apps_used TEXT[] NOT NULL DEFAULT '{}'::text[]`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS aspects_well TEXT[] NOT NULL DEFAULT '{}'::text[]`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS aspects_well_other TEXT`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS improvements_needed TEXT[] NOT NULL DEFAULT '{}'::text[]`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS improvements_other TEXT`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS additional_suggestions TEXT`,
    );

    await runBestEffort(
      `CREATE INDEX IF NOT EXISTS idx_survey_feedback_submission_id ON survey_feedback(submission_id)`,
    );
    try {
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_feedback_submission_id ON survey_feedback(submission_id)`,
      );
    } catch (error) {
      // Older hosted datasets can contain duplicate submission_id values.
      // Keep writes working by falling back to delete+insert idempotency.
      console.warn("Unable to create unique index uq_survey_feedback_submission_id", error);
    }
    await runBestEffort(
      `CREATE INDEX IF NOT EXISTS idx_survey_feedback_player_name ON survey_feedback(player_name)`,
    );
    await runBestEffort(
      `CREATE INDEX IF NOT EXISTS idx_survey_feedback_game_id ON survey_feedback(game_id)`,
    );
    feedbackTableReady = true;
  } finally {
    client.release();
  }
}

async function getFeedbackColumns(): Promise<Set<string>> {
  if (feedbackColumnsCache) {
    return feedbackColumnsCache;
  }

  const result = await getPool().query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'survey_feedback'
    `,
  );

  feedbackColumnsCache = new Set(result.rows.map((row) => row.column_name));
  return feedbackColumnsCache;
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

  try {
    await ensureFeedbackTable();
  } catch (error) {
    console.error("saveFeedback: ensureFeedbackTable failed, falling back to CSV", error);
    saveFeedbackToCsv(feedback);
    return;
  }
  feedbackColumnsCache = null;

  let columns: Set<string>;
  try {
    columns = await getFeedbackColumns();
  } catch (error) {
    console.error("saveFeedback: getFeedbackColumns failed, falling back to CSV", error);
    saveFeedbackToCsv(feedback);
    return;
  }

  if (!columns.has("submission_id")) {
    console.error("saveFeedback: submission_id column missing, falling back to CSV");
    saveFeedbackToCsv(feedback);
    return;
  }

  const values: unknown[] = [];
  const valueExpressions: string[] = [];
  const insertColumns: string[] = [];

  const pushValue = (column: string, value: unknown, cast?: string) => {
    if (!columns.has(column)) {
      return;
    }

    values.push(value);
    const index = values.length;
    valueExpressions.push(cast ? `$${index}::${cast}` : `$${index}`);
    insertColumns.push(column);
  };

  pushValue("submitted_at", feedback.submittedAt);
  pushValue("game_id", feedback.gameId);
  pushValue("room_id", feedback.gameId);
  pushValue("session_id", feedback.gameId);
  pushValue("submission_id", feedback.submissionId);
  pushValue("player_name", feedback.playerName);
  pushValue("challenge_id", feedback.challengeId);
  pushValue("challenge_title", feedback.challengeTitle);
  pushValue("submitted_prompt", feedback.submittedPrompt);
  pushValue("final_score", feedback.finalScore);
  pushValue("prompt_length", feedback.promptLength);
  pushValue("app_uses_by_player", feedback.appUsesByPlayer);
  pushValue("applications_used", JSON.stringify(feedback.applicationsUsed), "jsonb");
  pushValue("works_well_aspects", JSON.stringify(feedback.worksWellAspects), "jsonb");
  pushValue("improvement_areas", JSON.stringify(feedback.improvementAreas), "jsonb");
  pushValue("works_well_other", feedback.worksWellOther ?? null);
  pushValue("improvement_other", feedback.improvementOther ?? null);
  pushValue("additional_feedback", feedback.additionalFeedback);
  pushValue("apps_used", feedback.applicationsUsed, "text[]");
  pushValue("aspects_well", feedback.worksWellAspects, "text[]");
  pushValue("aspects_well_other", feedback.worksWellOther ?? null);
  pushValue("improvements_needed", feedback.improvementAreas, "text[]");
  pushValue("improvements_other", feedback.improvementOther ?? null);
  pushValue("additional_suggestions", feedback.additionalFeedback || null);

  if (insertColumns.length === 0) {
    console.error("saveFeedback: no writable columns, falling back to CSV");
    saveFeedbackToCsv(feedback);
    return;
  }

  try {
    await getPool().query(`DELETE FROM survey_feedback WHERE submission_id = $1`, [feedback.submissionId]);

    await getPool().query(
      `
        INSERT INTO survey_feedback (${insertColumns.join(", ")})
        VALUES (${valueExpressions.join(", ")})
      `,
      values,
    );
  } catch (error) {
    console.error("saveFeedback: postgres insert failed, falling back to CSV", error);
    saveFeedbackToCsv(feedback);
  }
}
