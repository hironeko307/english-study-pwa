import { deterministicShuffle } from "../learning/queueGenerator.js";

const DISTRACTOR_COUNT = 3;

export function createQuestionChoices({
  contentItems,
  questionWordId,
  sessionId,
  currentPhase,
  retryRound,
  currentIndex
}) {
  assertContentItems(contentItems);
  assertPositiveInteger(questionWordId, "questionWordId");
  assertNonEmptyString(sessionId, "sessionId");
  assertNonEmptyString(currentPhase, "currentPhase");
  assertNonNegativeInteger(retryRound, "retryRound");
  assertNonNegativeInteger(currentIndex, "currentIndex");

  const orderedItems = [...contentItems].sort((left, right) => left.wordId - right.wordId);
  const question = orderedItems.find(({ wordId }) => wordId === questionWordId);
  if (!question) {
    throw new RangeError(`Question wordId is not present in contentItems: ${questionWordId}`);
  }

  const baseSeed = JSON.stringify([
    sessionId,
    currentPhase,
    retryRound,
    currentIndex,
    questionWordId
  ]);
  const candidates = deterministicShuffle(
    orderedItems.filter(({ wordId }) => wordId !== questionWordId),
    `${baseSeed}:distractors`
  );
  const usedMeanings = new Set([question.meaningJa]);
  const distractors = [];

  for (const candidate of candidates) {
    if (usedMeanings.has(candidate.meaningJa)) continue;
    usedMeanings.add(candidate.meaningJa);
    distractors.push(candidate);
    if (distractors.length === DISTRACTOR_COUNT) break;
  }

  if (distractors.length < DISTRACTOR_COUNT) {
    throw new RangeError("At least three unique distractor meanings are required.");
  }

  return Object.freeze(deterministicShuffle(
    [question, ...distractors],
    `${baseSeed}:displayOrder`
  ));
}

function assertContentItems(contentItems) {
  if (!Array.isArray(contentItems)) {
    throw new TypeError("contentItems must be an array.");
  }
  const wordIds = new Set();
  for (const item of contentItems) {
    assertPositiveInteger(item?.wordId, "contentItems wordId");
    assertNonEmptyString(item.meaningJa, "contentItems meaningJa");
    if (wordIds.has(item.wordId)) {
      throw new Error(`Duplicate contentItems wordId: ${item.wordId}`);
    }
    wordIds.add(item.wordId);
  }
}

function assertPositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${fieldName} must be a positive integer.`);
  }
}

function assertNonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer.`);
  }
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }
}
