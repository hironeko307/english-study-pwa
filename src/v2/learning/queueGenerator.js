import {
  DAILY_NORMAL_QUESTION_CAP,
  DEFAULT_NEW_PER_DAY
} from "./policy.js";
import { assertDateOnly } from "./rule2n.js";

export function generateNormalQueue({
  contentItems,
  wordStates = [],
  learningDate,
  queueSeed,
  defaultNewPerDay = DEFAULT_NEW_PER_DAY,
  dailyNormalQuestionCap = DAILY_NORMAL_QUESTION_CAP
}) {
  if (!Array.isArray(contentItems)) {
    throw new TypeError("contentItems must be an array.");
  }
  assertDateOnly(learningDate, "learningDate");
  assertNonEmptyString(queueSeed, "queueSeed");
  assertNonNegativeInteger(defaultNewPerDay, "defaultNewPerDay");
  assertNonNegativeInteger(dailyNormalQuestionCap, "dailyNormalQuestionCap");

  const activeItems = contentItems.filter((item) => item?.isActive === true);
  assertUniquePositiveIntegers(activeItems.map(({ wordId }) => wordId), "content wordId");
  for (const item of activeItems) {
    assertPositiveInteger(item.contentOrder, "contentOrder");
  }
  const stateByWordId = normalizeStates(wordStates);

  const reviews = activeItems
    .filter(({ wordId }) => isDueReview(stateByWordId.get(wordId), learningDate))
    .sort((left, right) => {
      const leftDate = stateByWordId.get(left.wordId).nextReviewDate;
      const rightDate = stateByWordId.get(right.wordId).nextReviewDate;
      return leftDate.localeCompare(rightDate) || left.wordId - right.wordId;
    });

  const unseen = activeItems
    .filter(({ wordId }) => isUnseen(stateByWordId.get(wordId)))
    .sort((left, right) => {
      return left.contentOrder - right.contentOrder || left.wordId - right.wordId;
    });

  const plannedNewCount = Math.min(defaultNewPerDay, unseen.length);
  const availableForNew = Math.max(0, dailyNormalQuestionCap - reviews.length);
  const newCount = Math.min(plannedNewCount, availableForNew);
  const reviewWordIds = reviews.map(({ wordId }) => wordId);
  const newWordIds = unseen.slice(0, newCount).map(({ wordId }) => wordId);

  return {
    reviewWordIds,
    newWordIds,
    normalQueueWordIds: deterministicShuffle(
      [...reviewWordIds, ...newWordIds],
      queueSeed
    ),
    dueReviewCount: reviewWordIds.length,
    plannedNewCount,
    newCount,
    normalQuestionCount: reviewWordIds.length + newCount
  };
}

export function deterministicShuffle(values, seed) {
  if (!Array.isArray(values)) throw new TypeError("values must be an array.");
  assertNonEmptyString(seed, "seed");

  const result = [...values];
  const random = mulberry32(hashString(seed));
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function normalizeStates(wordStates) {
  const states = wordStates instanceof Map ? [...wordStates.values()] : wordStates;
  if (!Array.isArray(states)) {
    throw new TypeError("wordStates must be an array or Map.");
  }
  assertUniquePositiveIntegers(states.map(({ wordId }) => wordId), "word state wordId");
  return new Map(states.map((state) => [state.wordId, state]));
}

function isDueReview(state, learningDate) {
  return state?.firstSeenAt != null
    && state.nextReviewDate != null
    && state.nextReviewDate <= learningDate;
}

function isUnseen(state) {
  return state == null || state.firstSeenAt == null;
}

function assertUniquePositiveIntegers(values, label) {
  const seen = new Set();
  for (const value of values) {
    assertPositiveInteger(value, label);
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
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

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  return () => {
    let value = seed += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
