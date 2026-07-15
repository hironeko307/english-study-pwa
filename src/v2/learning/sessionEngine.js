import { INDEX_NAMES, STORE_NAMES } from "../data/schema.js";
import {
  PRESENTATION_TYPES,
  SESSION_PHASES,
  SESSION_STATUSES
} from "./policy.js";
import { deterministicShuffle, generateNormalQueue } from "./queueGenerator.js";
import { assertDateOnly, toLearningDate } from "./rule2n.js";
import { applyAnswerToWordState } from "./wordState.js";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function startOrResumeSession({
  repository,
  studentId,
  sessionId,
  contentItems,
  wordStates,
  contentVersion,
  policyVersion,
  queueSeed,
  now = new Date()
}) {
  assertRepository(repository);
  assertUuidV4(studentId, "studentId");

  const active = await findActiveSession(repository, studentId);
  if (active) return { ...active, resumed: true, reason: "activeSession" };

  const learningDate = toLearningDate(now);
  const existing = await findSessionByLearningDate(repository, studentId, learningDate);
  if (existing) return { ...existing, resumed: true, reason: "dailyQueueExists" };

  assertUuidV4(sessionId, "sessionId");
  assertNonEmptyString(contentVersion, "contentVersion");
  assertNonEmptyString(policyVersion, "policyVersion");
  assertNonEmptyString(queueSeed, "queueSeed");
  const timestamp = toIsoTimestamp(now);
  const plan = generateNormalQueue({
    contentItems,
    wordStates,
    learningDate,
    queueSeed
  });

  if (plan.normalQuestionCount === 0) {
    return {
      session: null,
      queue: null,
      resumed: false,
      reason: "noQuestions",
      learningDate
    };
  }

  const session = {
    sessionId,
    studentId,
    learningDate,
    startedAt: timestamp,
    completedAt: null,
    status: SESSION_STATUSES.active,
    currentPhase: SESSION_PHASES.normal,
    normalQuestionCount: plan.normalQuestionCount,
    normalCompletedCount: 0,
    immediateRetryCount: 0,
    retryRound: 0,
    policyVersion,
    contentVersion,
    updatedAt: timestamp
  };
  const queue = {
    sessionId,
    studentId,
    learningDate,
    normalQueueWordIds: plan.normalQueueWordIds,
    normalCurrentIndex: 0,
    incorrectWordIds: [],
    retryQueueWordIds: [],
    retryCurrentIndex: 0,
    completedWordIds: [],
    queueSeed,
    updatedAt: timestamp
  };

  await repository.runTransaction(
    [STORE_NAMES.sessions, STORE_NAMES.dailyQueues],
    "readwrite",
    async ({ store }) => {
      await store(STORE_NAMES.sessions).add(session);
      await store(STORE_NAMES.dailyQueues).add(queue);
    }
  );

  return { session, queue, resumed: false, reason: "created" };
}

export async function findActiveSession(repository, studentId) {
  assertRepository(repository);
  assertUuidV4(studentId, "studentId");
  const activeSessions = (
    await repository.sessions.getAllByIndex(
      INDEX_NAMES.sessions.status,
      SESSION_STATUSES.active
    )
  ).filter((session) => session.studentId === studentId);

  if (activeSessions.length > 1) {
    throw new Error(`Multiple active sessions found for studentId: ${studentId}`);
  }
  if (activeSessions.length === 0) return null;
  return loadSessionPair(repository, activeSessions[0]);
}

export async function findSessionByLearningDate(repository, studentId, learningDate) {
  assertRepository(repository);
  assertUuidV4(studentId, "studentId");
  assertDateOnly(learningDate, "learningDate");
  const queues = await repository.dailyQueues.getAllByIndex(
    INDEX_NAMES.dailyQueues.studentIdLearningDate,
    [studentId, learningDate]
  );
  if (queues.length === 0) return null;
  if (queues.length > 1) {
    throw new Error(`Multiple daily queues found for ${studentId} on ${learningDate}.`);
  }
  const session = await repository.sessions.get(queues[0].sessionId);
  if (!session) throw new Error(`Session not found for queue: ${queues[0].sessionId}`);
  return { session, queue: queues[0] };
}

export function getCurrentSessionItem(session, queue) {
  assertSessionPair(session, queue);
  if (session.currentPhase === SESSION_PHASES.normal) {
    return queue.normalQueueWordIds[queue.normalCurrentIndex] ?? null;
  }
  if (session.currentPhase === SESSION_PHASES.immediateRetry) {
    return queue.retryQueueWordIds[queue.retryCurrentIndex] ?? null;
  }
  return null;
}

export function applySessionAnswer({
  session,
  queue,
  wordState,
  isCorrect,
  answeredAt
}) {
  assertSessionPair(session, queue);
  if (session.status !== SESSION_STATUSES.active) {
    throw new Error("Only an active session can accept an answer.");
  }
  const wordId = getCurrentSessionItem(session, queue);
  if (wordId == null) throw new Error("The active session has no current question.");
  if (wordState?.wordId !== wordId || wordState.studentId !== session.studentId) {
    throw new Error("wordState does not match the current session item.");
  }

  const timestamp = toIsoTimestamp(answeredAt);
  if (session.currentPhase === SESSION_PHASES.normal) {
    return applyNormalAnswer({ session, queue, wordState, wordId, isCorrect, timestamp });
  }
  if (session.currentPhase === SESSION_PHASES.immediateRetry) {
    return applyImmediateRetryAnswer({
      session,
      queue,
      wordState,
      wordId,
      isCorrect,
      timestamp
    });
  }
  throw new Error(`Unsupported active session phase: ${session.currentPhase}`);
}

export async function saveSessionProgress({ repository, session, queue, wordState }) {
  assertRepository(repository);
  assertSessionPair(session, queue);
  await repository.runTransaction(
    [STORE_NAMES.sessions, STORE_NAMES.dailyQueues, STORE_NAMES.wordStates],
    "readwrite",
    async ({ store }) => {
      await store(STORE_NAMES.sessions).put(session);
      await store(STORE_NAMES.dailyQueues).put(queue);
      await store(STORE_NAMES.wordStates).put(wordState);
    }
  );
}

function applyNormalAnswer({ session, queue, wordState, wordId, isCorrect, timestamp }) {
  const presentationType = wordState.firstSeenAt == null
    ? PRESENTATION_TYPES.new
    : PRESENTATION_TYPES.review;
  const nextWordState = applyAnswerToWordState({
    state: wordState,
    presentationType,
    isCorrect,
    learningDate: session.learningDate,
    answeredAt: timestamp,
    policyVersion: session.policyVersion
  });
  let nextQueue = {
    ...queue,
    normalCurrentIndex: queue.normalCurrentIndex + 1,
    incorrectWordIds: isCorrect
      ? queue.incorrectWordIds
      : appendUnique(queue.incorrectWordIds, wordId),
    completedWordIds: appendUnique(queue.completedWordIds, wordId),
    updatedAt: timestamp
  };
  let nextSession = {
    ...session,
    normalCompletedCount: session.normalCompletedCount + 1,
    updatedAt: timestamp
  };

  if (nextQueue.normalCurrentIndex === nextQueue.normalQueueWordIds.length) {
    ({ session: nextSession, queue: nextQueue } = enterRetryOrComplete(
      nextSession,
      nextQueue,
      timestamp
    ));
  }

  return {
    session: nextSession,
    queue: nextQueue,
    wordState: nextWordState,
    wordId,
    presentationType,
    retryRound: 0
  };
}

function applyImmediateRetryAnswer({
  session,
  queue,
  wordState,
  wordId,
  isCorrect,
  timestamp
}) {
  const nextWordState = applyAnswerToWordState({
    state: wordState,
    presentationType: PRESENTATION_TYPES.immediateRetry,
    isCorrect,
    learningDate: session.learningDate,
    answeredAt: timestamp
  });
  let nextQueue = {
    ...queue,
    retryCurrentIndex: queue.retryCurrentIndex + 1,
    incorrectWordIds: isCorrect
      ? queue.incorrectWordIds.filter((candidate) => candidate !== wordId)
      : appendUnique(queue.incorrectWordIds, wordId),
    updatedAt: timestamp
  };
  let nextSession = {
    ...session,
    immediateRetryCount: session.immediateRetryCount + 1,
    updatedAt: timestamp
  };
  const answeredRound = session.retryRound;

  if (nextQueue.retryCurrentIndex === nextQueue.retryQueueWordIds.length) {
    if (nextQueue.incorrectWordIds.length === 0) {
      nextSession = completeSession(nextSession, timestamp);
    } else {
      const nextRound = session.retryRound + 1;
      nextSession = { ...nextSession, retryRound: nextRound };
      nextQueue = {
        ...nextQueue,
        retryQueueWordIds: deterministicShuffle(
          nextQueue.incorrectWordIds,
          retrySeed(nextQueue.queueSeed, nextRound)
        ),
        retryCurrentIndex: 0
      };
    }
  }

  return {
    session: nextSession,
    queue: nextQueue,
    wordState: nextWordState,
    wordId,
    presentationType: PRESENTATION_TYPES.immediateRetry,
    retryRound: answeredRound
  };
}

function enterRetryOrComplete(session, queue, timestamp) {
  if (queue.incorrectWordIds.length === 0) {
    return { session: completeSession(session, timestamp), queue };
  }

  return {
    session: {
      ...session,
      currentPhase: SESSION_PHASES.immediateRetry,
      retryRound: 1
    },
    queue: {
      ...queue,
      retryQueueWordIds: deterministicShuffle(
        queue.incorrectWordIds,
        retrySeed(queue.queueSeed, 1)
      ),
      retryCurrentIndex: 0
    }
  };
}

function completeSession(session, timestamp) {
  return {
    ...session,
    completedAt: timestamp,
    status: SESSION_STATUSES.completed,
    currentPhase: SESSION_PHASES.completed,
    updatedAt: timestamp
  };
}

async function loadSessionPair(repository, session) {
  const queue = await repository.dailyQueues.get(session.sessionId);
  if (!queue) throw new Error(`Daily queue not found for session: ${session.sessionId}`);
  assertSessionPair(session, queue);
  return { session, queue };
}

function assertSessionPair(session, queue) {
  if (!session || !queue) throw new TypeError("Session and daily queue are required.");
  if (session.sessionId !== queue.sessionId) {
    throw new Error("Session and daily queue IDs do not match.");
  }
  if (session.studentId !== queue.studentId || session.learningDate !== queue.learningDate) {
    throw new Error("Session and daily queue ownership does not match.");
  }
  if (queue.normalCurrentIndex > queue.normalQueueWordIds.length) {
    throw new Error("normalCurrentIndex exceeds the normal queue length.");
  }
  if (queue.retryCurrentIndex > queue.retryQueueWordIds.length) {
    throw new Error("retryCurrentIndex exceeds the retry queue length.");
  }
}

function assertRepository(repository) {
  if (!repository?.sessions || !repository?.dailyQueues || !repository?.runTransaction) {
    throw new TypeError("A Version2Repository-compatible object is required.");
  }
}

function appendUnique(values, value) {
  return values.includes(value) ? values : [...values, value];
}

function retrySeed(queueSeed, round) {
  return `${queueSeed}:immediateRetry:${round}`;
}

function toIsoTimestamp(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("A valid timestamp is required.");
  return date.toISOString();
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }
}

function assertUuidV4(value, fieldName) {
  if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) {
    throw new TypeError(`${fieldName} must be a canonical lowercase UUID v4.`);
  }
}
