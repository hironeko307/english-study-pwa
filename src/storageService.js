import { STORAGE_KEYS } from "./config.js";

export const storageService = {
  app: {
    loadAuthSession,
    saveAuthSession,
    clearAuthSession,
    loadVocabularyCache,
    saveVocabularyCache
  },
  legacy: {
    getGasEndpoint,
    setGasEndpoint,
    loadAnswerHistory,
    saveAnswerHistory,
    loadPendingSubmissions,
    savePendingSubmissions
  },
  future: {
    saveAttempt,
    loadAttempts,
    saveSession,
    loadSessions,
    saveStudentProgress,
    loadStudentProgress,
    loadPendingNewModelSyncItems,
    markNewModelItemsSynced,
    markNewModelItemsSyncFailed,
    countPendingNewModelSyncItems
  }
};

function loadAuthSession() {
  return readJson(STORAGE_KEYS.authSession, null);
}

function saveAuthSession(session) {
  writeJson(STORAGE_KEYS.authSession, session);
  return session;
}

function clearAuthSession() {
  localStorage.removeItem(STORAGE_KEYS.authSession);
}

function loadVocabularyCache(datasetId) {
  return readJson(STORAGE_KEYS.vocabularyCache(datasetId), null);
}

function saveVocabularyCache(datasetId, cache) {
  // TODO: 教材量が増えたら localStorage から IndexedDB へ移行する。
  writeJson(STORAGE_KEYS.vocabularyCache(datasetId), cache);
  return cache;
}

function getGasEndpoint() {
  return localStorage.getItem(STORAGE_KEYS.endpoint) ?? "";
}

function setGasEndpoint(endpoint) {
  localStorage.setItem(STORAGE_KEYS.endpoint, endpoint.trim());
}

function loadAnswerHistory(studentId) {
  return readJson(STORAGE_KEYS.history(studentId), []);
}

function saveAnswerHistory(studentId, records) {
  writeJson(STORAGE_KEYS.history(studentId), records);
}

function loadPendingSubmissions(studentId) {
  return readJson(STORAGE_KEYS.pending(studentId), []);
}

function savePendingSubmissions(studentId, records) {
  writeJson(STORAGE_KEYS.pending(studentId), records);
}

function saveAttempt(attempt) {
  const attempts = loadAttempts(attempt.studentId);
  attempts.push(attempt);
  writeJson(STORAGE_KEYS.attempts(attempt.studentId), attempts);
  return attempt;
}

function loadAttempts(studentId) {
  return readJson(STORAGE_KEYS.attempts(studentId), []);
}

function saveSession(session) {
  const sessions = loadSessions(session.studentId);
  const existingIndex = sessions.findIndex((item) => item.sessionId === session.sessionId);

  if (existingIndex >= 0) {
    sessions[existingIndex] = session;
  } else {
    sessions.push(session);
  }

  writeJson(STORAGE_KEYS.sessions(session.studentId), sessions);
  return session;
}

function loadSessions(studentId) {
  return readJson(STORAGE_KEYS.sessions(studentId), []);
}

function saveStudentProgress(studentId, progressByQuestionId) {
  writeJson(STORAGE_KEYS.studentProgress(studentId), progressByQuestionId);
  return progressByQuestionId;
}

function loadStudentProgress(studentId) {
  return readJson(STORAGE_KEYS.studentProgress(studentId), {});
}

function loadPendingNewModelSyncItems(studentId) {
  const attempts = loadAttempts(studentId).filter(isPendingSync);
  const sessions = loadSessions(studentId).filter(isPendingSync);
  const studentProgress = Object.values(loadStudentProgress(studentId)).filter(isPendingSync);

  return {
    attempts,
    sessions,
    studentProgress
  };
}

function markNewModelItemsSynced(studentId, itemRefs, syncedAt) {
  updateNewModelSyncState(studentId, itemRefs, (item) => ({
    ...item,
    synced: true,
    syncedAt,
    syncAttemptedAt: syncedAt,
    syncError: null
  }));
}

function markNewModelItemsSyncFailed(studentId, itemRefs, attemptedAt, errorMessage) {
  updateNewModelSyncState(studentId, itemRefs, (item) => ({
    ...item,
    synced: false,
    syncAttemptedAt: attemptedAt,
    syncError: errorMessage
  }));
}

function countPendingNewModelSyncItems(studentId) {
  const pending = loadPendingNewModelSyncItems(studentId);
  return pending.attempts.length + pending.sessions.length + pending.studentProgress.length;
}

function updateNewModelSyncState(studentId, itemRefs = {}, updateItem) {
  const attemptRefs = toRefMap(itemRefs.attempts, "attemptId");
  const sessionRefs = toRefMap(itemRefs.sessions, "sessionId");
  const progressRefs = toRefMap(itemRefs.studentProgress, "questionId");

  if (attemptRefs.size) {
    const attempts = loadAttempts(studentId);
    const updatedAttempts = attempts.map((attempt) => (
      shouldUpdateSyncItem(attempt, "attemptId", attemptRefs) ? updateItem(attempt) : attempt
    ));
    writeJson(STORAGE_KEYS.attempts(studentId), updatedAttempts);
  }

  if (sessionRefs.size) {
    const sessions = loadSessions(studentId);
    const updatedSessions = sessions.map((session) => (
      shouldUpdateSyncItem(session, "sessionId", sessionRefs) ? updateItem(session) : session
    ));
    writeJson(STORAGE_KEYS.sessions(studentId), updatedSessions);
  }

  if (progressRefs.size) {
    const progressByQuestionId = loadStudentProgress(studentId);
    const updatedProgress = Object.fromEntries(
      Object.entries(progressByQuestionId).map(([questionId, progress]) => [
        questionId,
        shouldUpdateSyncItem({ ...progress, questionId: progress.questionId ?? questionId }, "questionId", progressRefs)
          ? updateItem(progress)
          : progress
      ])
    );
    writeJson(STORAGE_KEYS.studentProgress(studentId), updatedProgress);
  }
}

function toRefMap(refs = [], idKey) {
  return new Map(
    refs
      .map((ref) => {
        const id = typeof ref === "string" ? ref : ref?.[idKey];
        return id ? [id, ref?.syncFingerprint ?? null] : null;
      })
      .filter(Boolean)
  );
}

function shouldUpdateSyncItem(item, idKey, refs) {
  const id = item?.[idKey];
  if (!refs.has(id)) return false;

  const expectedFingerprint = refs.get(id);
  return !expectedFingerprint || expectedFingerprint === createSyncFingerprint(item);
}

function createSyncFingerprint(item) {
  return JSON.stringify(toSyncRecord(item));
}

function toSyncRecord(item) {
  const {
    synced,
    syncedAt,
    syncAttemptedAt,
    syncError,
    ...record
  } = item;

  return record;
}

function isPendingSync(item) {
  return item?.synced !== true;
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
