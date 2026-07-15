import {
  GHOST_MAX,
  GHOST_MIN,
  PRESENTATION_TYPES,
  STAR_MAX,
  STAR_MIN
} from "./policy.js";
import { assertDateOnly, calculateNextReviewDate } from "./rule2n.js";

export function createInitialWordState({
  studentId,
  wordId,
  policyVersion,
  updatedAt
}) {
  assertNonEmptyString(studentId, "studentId");
  assertPositiveInteger(wordId, "wordId");
  assertNonEmptyString(policyVersion, "policyVersion");
  assertTimestamp(updatedAt, "updatedAt");

  return {
    studentId,
    wordId,
    star: 0,
    ghost: 0,
    consecutiveCorrect: 0,
    firstSeenAt: null,
    lastAnsweredAt: null,
    lastCorrectAt: null,
    nextReviewDate: null,
    totalCorrect: 0,
    totalIncorrect: 0,
    totalImmediateRetries: 0,
    stateRevision: 0,
    policyVersion,
    updatedAt
  };
}

export function applyAnswerToWordState({
  state,
  presentationType,
  isCorrect,
  learningDate,
  answeredAt,
  policyVersion = state?.policyVersion
}) {
  assertWordState(state);
  assertPresentationType(presentationType);
  if (typeof isCorrect !== "boolean") {
    throw new TypeError("isCorrect must be boolean.");
  }
  assertDateOnly(learningDate, "learningDate");
  assertTimestamp(answeredAt, "answeredAt");
  assertNonEmptyString(policyVersion, "policyVersion");

  if (presentationType === PRESENTATION_TYPES.immediateRetry) {
    return {
      ...state,
      lastAnsweredAt: answeredAt,
      totalImmediateRetries: state.totalImmediateRetries + 1,
      updatedAt: answeredAt
    };
  }

  const star = clamp(
    state.star + (isCorrect ? 1 : -1),
    STAR_MIN,
    STAR_MAX
  );
  const ghostUpdate = updateGhost(state, isCorrect);

  return {
    ...state,
    star,
    ghost: ghostUpdate.ghost,
    consecutiveCorrect: ghostUpdate.consecutiveCorrect,
    firstSeenAt: state.firstSeenAt ?? answeredAt,
    lastAnsweredAt: answeredAt,
    lastCorrectAt: isCorrect ? answeredAt : state.lastCorrectAt,
    nextReviewDate: calculateNextReviewDate(learningDate, star),
    totalCorrect: state.totalCorrect + (isCorrect ? 1 : 0),
    totalIncorrect: state.totalIncorrect + (isCorrect ? 0 : 1),
    stateRevision: state.stateRevision + 1,
    policyVersion,
    updatedAt: answeredAt
  };
}

function updateGhost(state, isCorrect) {
  if (!isCorrect) {
    return {
      ghost: clamp(state.ghost + 1, GHOST_MIN, GHOST_MAX),
      consecutiveCorrect: 0
    };
  }

  const temporaryConsecutive = state.consecutiveCorrect + 1;
  if (temporaryConsecutive === 3) {
    return {
      ghost: clamp(state.ghost - 1, GHOST_MIN, GHOST_MAX),
      consecutiveCorrect: 0
    };
  }
  return { ghost: state.ghost, consecutiveCorrect: temporaryConsecutive };
}

function assertWordState(state) {
  if (!state || typeof state !== "object") {
    throw new TypeError("A word state is required.");
  }
  assertRangeInteger(state.star, STAR_MIN, STAR_MAX, "state.star");
  assertRangeInteger(state.ghost, GHOST_MIN, GHOST_MAX, "state.ghost");
  assertRangeInteger(state.consecutiveCorrect, 0, 2, "state.consecutiveCorrect");
  for (const field of [
    "totalCorrect",
    "totalIncorrect",
    "totalImmediateRetries",
    "stateRevision"
  ]) {
    assertRangeInteger(state[field], 0, Number.MAX_SAFE_INTEGER, `state.${field}`);
  }
}

function assertPresentationType(value) {
  if (!Object.values(PRESENTATION_TYPES).includes(value)) {
    throw new RangeError(`Unsupported presentationType: ${value}`);
  }
}

function assertTimestamp(value, fieldName) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${fieldName} must be an ISO-8601 timestamp.`);
  }
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }
}

function assertPositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${fieldName} must be a positive integer.`);
  }
}

function assertRangeInteger(value, minimum, maximum, fieldName) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${fieldName} must be an integer from ${minimum} through ${maximum}.`);
  }
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
