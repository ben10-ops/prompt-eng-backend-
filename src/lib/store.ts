import { CHALLENGES, createGeneratedImageUrl, getPromptPersona, scorePrompt } from "./engine";
import { loadStoreFromDisk, PromptWarsStore, saveStoreToDisk } from "./persistence";
import { PlayerSubmission } from "./types";

declare global {
  var __promptWarsStore: PromptWarsStore | undefined;
}

const store: PromptWarsStore =
  globalThis.__promptWarsStore ?? loadStoreFromDisk();

if (!globalThis.__promptWarsStore) {
  globalThis.__promptWarsStore = store;
}

function persistStore() {
  saveStoreToDisk(store);
}

export function getCurrentChallenge() {
  return CHALLENGES[store.currentChallengeIndex % CHALLENGES.length];
}

export function rotateChallenge() {
  store.currentChallengeIndex = (store.currentChallengeIndex + 1) % CHALLENGES.length;
  persistStore();
  return getCurrentChallenge();
}

export function getSubmissions() {
  return [...store.submissions].sort((a, b) => b.scores.finalScore - a.scores.finalScore);
}

export function getPendingSubmissionById(id: string) {
  return store.pendingSubmissions.find((submission) => submission.id === id) ?? null;
}

export function getRecentSubmissions(limit = 4) {
  return store.submissions.slice(0, limit);
}

export function getSubmissionById(id: string) {
  return store.submissions.find((submission) => submission.id === id) ?? null;
}

export function getPlayerSubmissionCount(playerName: string) {
  const normalized = playerName.trim().toLowerCase();
  if (!normalized) {
    return 0;
  }

  return store.submissions.filter(
    (submission) => submission.playerName.trim().toLowerCase() === normalized,
  ).length;
}

export function createPendingSubmission(input: {
  playerName: string;
  prompt: string;
  generatedImageUrl?: string;
  imageSimilarity?: number;
}) {
  const challenge = getCurrentChallenge();
  const generatedImageUrl =
    input.generatedImageUrl ?? createGeneratedImageUrl(input.prompt, challenge.id);
  const scores = scorePrompt(input.prompt, challenge, {
    imageSimilarity: input.imageSimilarity,
  });
  const persona = getPromptPersona(input.prompt, scores.finalScore);

  const submission: PlayerSubmission = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    playerName: input.playerName,
    prompt: input.prompt,
    challenge,
    generatedImageUrl,
    scores,
    persona,
    createdAt: new Date().toISOString(),
  };

  store.pendingSubmissions.unshift(submission);
  store.pendingSubmissions = store.pendingSubmissions.slice(0, 150);
  persistStore();
  return submission;
}

export function finalizePendingSubmission(id: string) {
  const pendingIndex = store.pendingSubmissions.findIndex((submission) => submission.id === id);

  if (pendingIndex === -1) {
    return null;
  }

  const [submission] = store.pendingSubmissions.splice(pendingIndex, 1);
  store.submissions.unshift(submission);
  store.submissions = store.submissions.slice(0, 50);
  persistStore();
  return submission;
}
