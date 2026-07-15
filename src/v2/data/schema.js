export const DATABASE_NAME = "vg2500-v2";

// IndexedDB upgrade ordering is independent from the persisted data contract.
export const INDEXED_DB_VERSION = 1;
export const SCHEMA_VERSION = 2;

export const STORE_NAMES = Object.freeze({
  contentCache: "contentCache",
  wordStates: "wordStates",
  answerEvents: "answerEvents",
  sessions: "sessions",
  dailyQueues: "dailyQueues",
  syncQueue: "syncQueue",
  appMeta: "appMeta"
});

export const INDEX_NAMES = Object.freeze({
  contentCache: Object.freeze({ cachedAt: "cachedAt" }),
  wordStates: Object.freeze({
    studentId: "studentId",
    studentIdNextReviewDate: "studentId_nextReviewDate"
  }),
  answerEvents: Object.freeze({
    studentId: "studentId",
    sessionId: "sessionId",
    studentIdLearningDate: "studentId_learningDate",
    studentIdWordId: "studentId_wordId"
  }),
  sessions: Object.freeze({
    studentId: "studentId",
    studentIdLearningDate: "studentId_learningDate",
    status: "status"
  }),
  dailyQueues: Object.freeze({
    studentIdLearningDate: "studentId_learningDate"
  }),
  syncQueue: Object.freeze({
    status: "status",
    createdAt: "createdAt",
    entityType: "entityType"
  }),
  appMeta: Object.freeze({})
});

export const STORE_DEFINITIONS = Object.freeze([
  defineStore(STORE_NAMES.contentCache, "contentVersion", [
    defineIndex(INDEX_NAMES.contentCache.cachedAt, "cachedAt")
  ]),
  defineStore(STORE_NAMES.wordStates, ["studentId", "wordId"], [
    defineIndex(INDEX_NAMES.wordStates.studentId, "studentId"),
    defineIndex(
      INDEX_NAMES.wordStates.studentIdNextReviewDate,
      ["studentId", "nextReviewDate"]
    )
  ]),
  defineStore(STORE_NAMES.answerEvents, "eventId", [
    defineIndex(INDEX_NAMES.answerEvents.studentId, "studentId"),
    defineIndex(INDEX_NAMES.answerEvents.sessionId, "sessionId"),
    defineIndex(
      INDEX_NAMES.answerEvents.studentIdLearningDate,
      ["studentId", "learningDate"]
    ),
    defineIndex(
      INDEX_NAMES.answerEvents.studentIdWordId,
      ["studentId", "wordId"]
    )
  ]),
  defineStore(STORE_NAMES.sessions, "sessionId", [
    defineIndex(INDEX_NAMES.sessions.studentId, "studentId"),
    defineIndex(
      INDEX_NAMES.sessions.studentIdLearningDate,
      ["studentId", "learningDate"]
    ),
    defineIndex(INDEX_NAMES.sessions.status, "status")
  ]),
  defineStore(STORE_NAMES.dailyQueues, "sessionId", [
    defineIndex(
      INDEX_NAMES.dailyQueues.studentIdLearningDate,
      ["studentId", "learningDate"],
      { unique: true }
    )
  ]),
  defineStore(STORE_NAMES.syncQueue, "queueItemId", [
    defineIndex(INDEX_NAMES.syncQueue.status, "status"),
    defineIndex(INDEX_NAMES.syncQueue.createdAt, "createdAt"),
    defineIndex(INDEX_NAMES.syncQueue.entityType, "entityType")
  ]),
  defineStore(STORE_NAMES.appMeta, "key", [])
]);

export function getStoreDefinition(storeName) {
  return STORE_DEFINITIONS.find((definition) => definition.name === storeName) ?? null;
}

function defineStore(name, keyPath, indexes) {
  return Object.freeze({ name, keyPath, indexes: Object.freeze(indexes) });
}

function defineIndex(name, keyPath, options = {}) {
  return Object.freeze({
    name,
    keyPath,
    options: Object.freeze({ unique: false, multiEntry: false, ...options })
  });
}
