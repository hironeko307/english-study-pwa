import {
  DAILY_NORMAL_QUESTION_CAP,
  DEFAULT_NEW_PER_DAY,
  SESSION_PHASES,
  SESSION_STATUSES
} from "../learning/policy.js";
import { assertDateOnly } from "../learning/rule2n.js";

export const HOME_MODES = Object.freeze({
  newStart: "newStart",
  resume: "resume",
  completed: "completed",
  noLearning: "noLearning"
});

const HOME_MESSAGES = Object.freeze({
  completed: "本日の学習は完了しました。",
  noLearning: "本日の学習はありません"
});

export function createHomeViewModel({
  contentItems = [],
  wordStates = [],
  session = null,
  dailyQueue = null,
  learningDate,
  defaultNewPerDay = DEFAULT_NEW_PER_DAY,
  dailyNormalQuestionCap = DAILY_NORMAL_QUESTION_CAP
}) {
  assertDateOnly(learningDate, "learningDate");
  assertNonNegativeInteger(defaultNewPerDay, "defaultNewPerDay");
  assertNonNegativeInteger(dailyNormalQuestionCap, "dailyNormalQuestionCap");

  if (session !== null) {
    return createSessionModel(session, dailyQueue);
  }
  if (dailyQueue !== null) {
    throw new Error("dailyQueue cannot exist without a Session.");
  }

  const counts = calculateNewSessionCounts({
    contentItems,
    wordStates,
    learningDate,
    defaultNewPerDay,
    dailyNormalQuestionCap
  });
  if (counts.normalQuestionCount === 0) {
    return freezeModel({
      mode: HOME_MODES.noLearning,
      dueReviewCount: 0,
      newCount: 0,
      normalQuestionCount: 0,
      completedCount: 0,
      remainingCount: 0,
      retryRemainingCount: null,
      ctaLabel: null,
      canStart: false,
      canResume: false,
      message: HOME_MESSAGES.noLearning
    });
  }

  return freezeModel({
    mode: HOME_MODES.newStart,
    ...counts,
    completedCount: 0,
    remainingCount: counts.normalQuestionCount,
    retryRemainingCount: null,
    ctaLabel: "学習を始める",
    canStart: true,
    canResume: false,
    message: null
  });
}

function calculateNewSessionCounts({
  contentItems,
  wordStates,
  learningDate,
  defaultNewPerDay,
  dailyNormalQuestionCap
}) {
  if (!Array.isArray(contentItems)) {
    throw new TypeError("contentItems must be an array.");
  }
  const states = wordStates instanceof Map ? [...wordStates.values()] : wordStates;
  if (!Array.isArray(states)) {
    throw new TypeError("wordStates must be an array or Map.");
  }

  const activeItems = contentItems.filter((item) => item?.isActive === true);
  assertUniqueWordIds(activeItems, "contentItems");
  assertUniqueWordIds(states, "wordStates");
  const stateByWordId = new Map(states.map((state) => [state.wordId, state]));

  let dueReviewCount = 0;
  let unseenWordCount = 0;
  for (const item of activeItems) {
    const state = stateByWordId.get(item.wordId);
    if (state == null || state.firstSeenAt == null) {
      unseenWordCount += 1;
    } else if (state.nextReviewDate != null && state.nextReviewDate <= learningDate) {
      dueReviewCount += 1;
    }
  }

  const plannedNewCount = Math.min(defaultNewPerDay, unseenWordCount);
  const availableForNew = Math.max(0, dailyNormalQuestionCap - dueReviewCount);
  const newCount = Math.min(plannedNewCount, availableForNew);
  return Object.freeze({
    dueReviewCount,
    newCount,
    normalQuestionCount: dueReviewCount + newCount
  });
}

function createSessionModel(session, dailyQueue) {
  assertSession(session);
  if (session.status === SESSION_STATUSES.completed) {
    return freezeModel({
      mode: HOME_MODES.completed,
      dueReviewCount: null,
      newCount: null,
      normalQuestionCount: session.normalQuestionCount,
      completedCount: session.normalCompletedCount,
      remainingCount: 0,
      retryRemainingCount: null,
      ctaLabel: null,
      canStart: false,
      canResume: false,
      message: HOME_MESSAGES.completed
    });
  }
  if (session.status !== SESSION_STATUSES.active) {
    throw new Error(`Unsupported Home Session status: ${session.status}`);
  }
  if (![SESSION_PHASES.normal, SESSION_PHASES.immediateRetry].includes(session.currentPhase)) {
    throw new Error(`Unsupported active Session phase: ${session.currentPhase}`);
  }

  assertSessionQueuePair(session, dailyQueue);
  const retryRemainingCount = session.currentPhase === SESSION_PHASES.immediateRetry
    ? dailyQueue.retryQueueWordIds.length - dailyQueue.retryCurrentIndex
    : null;
  return freezeModel({
    mode: HOME_MODES.resume,
    dueReviewCount: null,
    newCount: null,
    normalQuestionCount: session.normalQuestionCount,
    completedCount: session.normalCompletedCount,
    remainingCount: session.normalQuestionCount - session.normalCompletedCount,
    retryRemainingCount,
    ctaLabel: "続きから",
    canStart: false,
    canResume: true,
    message: null
  });
}

function assertSession(session) {
  if (!session || typeof session !== "object") {
    throw new TypeError("session must be an object or null.");
  }
  assertNonEmptyString(session.sessionId, "session.sessionId");
  assertNonEmptyString(session.studentId, "session.studentId");
  assertDateOnly(session.learningDate, "session.learningDate");
  assertNonNegativeInteger(session.normalQuestionCount, "session.normalQuestionCount");
  assertNonNegativeInteger(session.normalCompletedCount, "session.normalCompletedCount");
  if (session.normalCompletedCount > session.normalQuestionCount) {
    throw new Error("session.normalCompletedCount exceeds normalQuestionCount.");
  }
}

function assertSessionQueuePair(session, dailyQueue) {
  if (!dailyQueue || typeof dailyQueue !== "object") {
    throw new TypeError("An active Session requires its saved dailyQueue.");
  }
  if (
    session.sessionId !== dailyQueue.sessionId
    || session.studentId !== dailyQueue.studentId
    || session.learningDate !== dailyQueue.learningDate
  ) {
    throw new Error("Session and dailyQueue do not match.");
  }
  if (!Array.isArray(dailyQueue.normalQueueWordIds)) {
    throw new TypeError("dailyQueue.normalQueueWordIds must be an array.");
  }
  if (!Array.isArray(dailyQueue.retryQueueWordIds)) {
    throw new TypeError("dailyQueue.retryQueueWordIds must be an array.");
  }
  assertNonNegativeInteger(dailyQueue.normalCurrentIndex, "dailyQueue.normalCurrentIndex");
  assertNonNegativeInteger(dailyQueue.retryCurrentIndex, "dailyQueue.retryCurrentIndex");
  if (dailyQueue.normalQueueWordIds.length !== session.normalQuestionCount) {
    throw new Error("Saved normal queue length does not match the Session.");
  }
  if (dailyQueue.normalCurrentIndex !== session.normalCompletedCount) {
    throw new Error("Saved normal queue position does not match the Session.");
  }
  if (dailyQueue.retryCurrentIndex > dailyQueue.retryQueueWordIds.length) {
    throw new Error("dailyQueue.retryCurrentIndex exceeds the retry queue length.");
  }
}

function assertUniqueWordIds(records, label) {
  const ids = new Set();
  for (const record of records) {
    const wordId = record?.wordId;
    if (!Number.isInteger(wordId) || wordId < 1) {
      throw new TypeError(`${label} wordId must be a positive integer.`);
    }
    if (ids.has(wordId)) throw new Error(`Duplicate ${label} wordId: ${wordId}`);
    ids.add(wordId);
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

function freezeModel(model) {
  return Object.freeze(model);
}
