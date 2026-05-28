import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PlayerSubmission } from "./types";

export type PromptWarsStore = {
  currentChallengeIndex: number;
  submissions: PlayerSubmission[];
  pendingSubmissions: PlayerSubmission[];
};

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "promptwars-store.json");
const TEMP_FILE = path.join(DATA_DIR, "promptwars-store.tmp.json");

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function defaultStore(): PromptWarsStore {
  return {
    currentChallengeIndex: 0,
    submissions: [],
    pendingSubmissions: [],
  };
}

function isStoreShape(value: unknown): value is PromptWarsStore {
  const candidate = value as Partial<PromptWarsStore>;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.currentChallengeIndex === "number" &&
    Array.isArray(candidate.submissions)
  );
}

export function loadStoreFromDisk(): PromptWarsStore {
  ensureDataDir();

  if (!existsSync(DATA_FILE)) {
    return defaultStore();
  }

  try {
    const raw = readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (!isStoreShape(parsed)) {
      return defaultStore();
    }

    return {
      currentChallengeIndex: parsed.currentChallengeIndex,
      submissions: parsed.submissions,
      pendingSubmissions: Array.isArray(parsed.pendingSubmissions)
        ? parsed.pendingSubmissions
        : [],
    };
  } catch {
    return defaultStore();
  }
}

export function saveStoreToDisk(store: PromptWarsStore) {
  ensureDataDir();

  const serialized = JSON.stringify(store, null, 2);
  writeFileSync(TEMP_FILE, serialized, "utf-8");

  if (existsSync(DATA_FILE)) {
    unlinkSync(DATA_FILE);
  }

  renameSync(TEMP_FILE, DATA_FILE);
}
