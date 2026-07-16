import { STORE_NAMES } from "../data/schema.js";

const UNSYNCED_ANSWER_STATUSES = Object.freeze(["pending", "sending", "failed"]);
const SESSION_EXPIRED_ERROR_CODE = "SESSION_EXPIRED";

export const ANSWER_SYNC_WORKER_STATES = Object.freeze({
  idle: "idle",
  pending: "pending",
  sending: "sending",
  failed: "failed",
  pausedAuth: "pausedAuth",
  disposed: "disposed"
});

export function isSessionExpiredApiError(error) {
  return error !== null
    && typeof error === "object"
    && !Array.isArray(error)
    && error.code === SESSION_EXPIRED_ERROR_CODE
    && typeof error.message === "string"
    && Object.prototype.hasOwnProperty.call(error, "details");
}

export async function persistAnswerTransaction(repository, {
  event,
  stateAfter,
  session = null,
  queue = null
}) {
  if ((session === null) !== (queue === null)) {
    throw new TypeError("session and queue must be persisted together.");
  }
  const queueItem = Object.freeze({
    queueItemId: `answerEvent:${event.eventId}`,
    entityType: "answerEvent",
    entityId: event.eventId,
    eventId: event.eventId,
    status: "pending",
    retryCount: 0,
    lastAttemptAt: null,
    lastErrorCode: null,
    createdAt: event.createdAt
  });

  const storeNames = [
    STORE_NAMES.wordStates,
    STORE_NAMES.answerEvents,
    STORE_NAMES.syncQueue
  ];
  if (session !== null) {
    storeNames.push(STORE_NAMES.sessions, STORE_NAMES.dailyQueues);
  }

  await repository.runTransaction(
    storeNames,
    "readwrite",
    async ({ store }) => {
      await store(STORE_NAMES.wordStates).put(stateAfter);
      await store(STORE_NAMES.answerEvents).add(event);
      await store(STORE_NAMES.syncQueue).add(queueItem);
      if (session !== null) {
        await store(STORE_NAMES.sessions).put(session);
        await store(STORE_NAMES.dailyQueues).put(queue);
      }
    }
  );
  return queueItem;
}

export async function syncPersistedAnswer({ repository, apiClient, authSession, eventId, now }) {
  const queueItemId = `answerEvent:${eventId}`;
  const event = await repository.answerEvents.get(eventId);
  const queueItem = await repository.syncQueue.get(queueItemId);
  if (!event || !queueItem) throw new Error("The persisted answer is incomplete.");

  const attemptAt = now();
  await repository.syncQueue.put({
    ...queueItem,
    status: "sending",
    lastAttemptAt: attemptAt
  });

  try {
    const response = await apiClient.request("syncAnswerEvents", {
      studentId: authSession.studentId,
      sessionToken: authSession.sessionToken,
      schemaVersion: event.schemaVersion,
      events: [event]
    });
    if (!response.ok) {
      await markPending(repository, queueItem, attemptAt, response.error.code);
      return Object.freeze({
        saved: false,
        result: null,
        error: response.error,
        requiresReauthentication: isSessionExpiredApiError(response.error),
        barrier: false
      });
    }

    const result = response.data.results?.find((item) => item.eventId === eventId);
    if (result?.result === "rejected") {
      const errorCode = result.error?.code ?? "REJECTED";
      await markFailed(repository, queueItem, attemptAt, errorCode);
      return Object.freeze({
        saved: false,
        result: result.result,
        error: result.error ?? null,
        requiresReauthentication: isSessionExpiredApiError(result.error),
        barrier: true
      });
    }
    if (!result || !["accepted", "alreadyAccepted"].includes(result.result)) {
      const errorCode = result?.error?.code ?? "INVALID_RESPONSE";
      await markPending(repository, queueItem, attemptAt, errorCode);
      return Object.freeze({
        saved: false,
        result: result?.result ?? null,
        error: result?.error ?? null,
        requiresReauthentication: isSessionExpiredApiError(result?.error),
        barrier: false
      });
    }

    await repository.syncQueue.put({
      ...queueItem,
      status: "synced",
      lastAttemptAt: attemptAt,
      lastErrorCode: null
    });
    await repository.appMeta.put({
      key: "lastSuccessfulSyncAt",
      value: attemptAt,
      updatedAt: attemptAt
    });
    return Object.freeze({
      saved: true,
      result: result.result,
      error: null,
      requiresReauthentication: false,
      barrier: false
    });
  } catch (error) {
    await markPending(
      repository,
      queueItem,
      attemptAt,
      typeof error?.reason === "string" ? error.reason : "TRANSPORT_FAILURE"
    );
    throw error;
  }
}

export function createAnswerSyncWorker({
  repository,
  getApiClient,
  now = () => new Date().toISOString(),
  onReauthenticationRequired = null
}) {
  if (!repository || typeof getApiClient !== "function" || typeof now !== "function") {
    throw new TypeError("A repository, API client getter, and clock are required.");
  }
  if (
    onReauthenticationRequired !== null
    && typeof onReauthenticationRequired !== "function"
  ) {
    throw new TypeError("onReauthenticationRequired must be a function when provided.");
  }

  const listeners = new Set();
  let authSession = null;
  let studentId = null;
  let drainPromise = null;
  let drainRequested = false;
  let disposed = false;
  let snapshot = freezeWorkerSnapshot({
    status: ANSWER_SYNC_WORKER_STATES.idle,
    pendingCount: 0,
    failedCount: 0,
    lastErrorCode: null
  });

  function getSnapshot() {
    return snapshot;
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("A listener is required.");
    listeners.add(listener);
    listener(snapshot);
    return () => listeners.delete(listener);
  }

  function resume(nextAuthSession) {
    assertAuthSession(nextAuthSession);
    authSession = nextAuthSession;
    studentId = nextAuthSession.studentId;
    return notifyPending();
  }

  async function pauseAuth() {
    authSession = null;
    drainRequested = false;
    const records = await readRecords();
    publishFromRecords(ANSWER_SYNC_WORKER_STATES.pausedAuth, records, SESSION_EXPIRED_ERROR_CODE);
    return snapshot;
  }

  function notifyPending() {
    if (disposed) return Promise.resolve(snapshot);
    drainRequested = true;
    if (drainPromise !== null) return drainPromise;

    const task = runDrain().catch(async () => {
      const records = await readRecords().catch(() => []);
      publishFromRecords(
        ANSWER_SYNC_WORKER_STATES.failed,
        records,
        "LOCAL_SYNC_WORKER_ERROR"
      );
      return snapshot;
    });
    const trackedTask = task.finally(() => {
      if (drainPromise !== trackedTask) return;
      drainPromise = null;
      if (
        drainRequested
        && snapshot.status === ANSWER_SYNC_WORKER_STATES.idle
        && !disposed
      ) {
        void notifyPending();
      }
    });
    drainPromise = trackedTask;
    return trackedTask;
  }

  function dispose() {
    disposed = true;
    drainRequested = false;
    authSession = null;
    publish({
      status: ANSWER_SYNC_WORKER_STATES.disposed,
      pendingCount: snapshot.pendingCount,
      failedCount: snapshot.failedCount,
      lastErrorCode: snapshot.lastErrorCode
    });
    listeners.clear();
  }

  async function runDrain() {
    while (!disposed) {
      drainRequested = false;
      const outcome = await drainAvailable();
      if (outcome !== "complete" || !drainRequested) return snapshot;
    }
    return snapshot;
  }

  async function drainAvailable() {
    if (authSession === null) {
      const records = await readRecords();
      publishFromRecords(ANSWER_SYNC_WORKER_STATES.pausedAuth, records, null);
      return "pausedAuth";
    }

    while (!disposed && authSession !== null) {
      const records = await readRecords();
      if (records.length === 0) {
        publishFromRecords(ANSWER_SYNC_WORKER_STATES.idle, records, null);
        return "complete";
      }

      const nextRecord = records[0];
      if (nextRecord.queueItem.status === "failed") {
        publishFromRecords(
          ANSWER_SYNC_WORKER_STATES.failed,
          records,
          nextRecord.queueItem.lastErrorCode
        );
        return "barrier";
      }

      publishFromRecords(ANSWER_SYNC_WORKER_STATES.sending, records, null);
      const sessionUsed = authSession;
      try {
        const result = await syncPersistedAnswer({
          repository,
          apiClient: getApiClient(),
          authSession: sessionUsed,
          eventId: nextRecord.event.eventId,
          now
        });
        if (result.saved) continue;

        const currentRecords = await readRecords();
        if (result.requiresReauthentication) {
          authSession = null;
          drainRequested = false;
          publishFromRecords(
            ANSWER_SYNC_WORKER_STATES.pausedAuth,
            currentRecords,
            result.error?.code ?? SESSION_EXPIRED_ERROR_CODE
          );
          if (onReauthenticationRequired) {
            await onReauthenticationRequired(sessionUsed, result.error);
          }
          return "pausedAuth";
        }
        if (result.barrier) {
          publishFromRecords(
            ANSWER_SYNC_WORKER_STATES.failed,
            currentRecords,
            result.error?.code ?? "REJECTED"
          );
          return "barrier";
        }

        publishFromRecords(
          ANSWER_SYNC_WORKER_STATES.pending,
          currentRecords,
          result.error?.code ?? "INVALID_RESPONSE"
        );
        return "pending";
      } catch (error) {
        const currentRecords = await readRecords();
        publishFromRecords(
          ANSWER_SYNC_WORKER_STATES.pending,
          currentRecords,
          typeof error?.reason === "string" ? error.reason : "TRANSPORT_FAILURE"
        );
        return "pending";
      }
    }

    const records = await readRecords();
    publishFromRecords(ANSWER_SYNC_WORKER_STATES.pausedAuth, records, null);
    return "pausedAuth";
  }

  async function readRecords() {
    if (studentId === null) return Object.freeze([]);
    return listPendingAnswerEvents(repository, studentId);
  }

  function publishFromRecords(status, records, lastErrorCode) {
    publish({
      status,
      pendingCount: records.length,
      failedCount: records.filter(({ queueItem }) => queueItem.status === "failed").length,
      lastErrorCode: lastErrorCode ?? null
    });
  }

  function publish(nextSnapshot) {
    snapshot = freezeWorkerSnapshot(nextSnapshot);
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A view listener must not interrupt the single synchronization worker.
      }
    }
  }

  return Object.freeze({
    notifyPending,
    resume,
    pauseAuth,
    getSnapshot,
    subscribe,
    dispose
  });
}

export async function listPendingAnswerEvents(repository, studentId) {
  const records = [];
  for (const status of UNSYNCED_ANSWER_STATUSES) {
    const queueItems = await repository.syncQueue.getAllByIndex("status", status);
    for (const queueItem of queueItems) {
      if (queueItem.entityType !== "answerEvent" || !queueItem.eventId) continue;
      const event = await repository.answerEvents.get(queueItem.eventId);
      if (!event) throw new Error("A queued answer event is incomplete.");
      if (event.studentId !== studentId) continue;
      records.push(Object.freeze({ event, queueItem }));
    }
  }

  records.sort(comparePendingAnswerRecords);
  return Object.freeze(records);
}

export async function syncPendingAnswerEvents({
  repository,
  apiClient,
  authSession,
  now,
  onEventStart = null
}) {
  const records = await listPendingAnswerEvents(repository, authSession.studentId);
  const results = [];

  for (const record of records) {
    if (onEventStart) onEventStart(record.event);
    try {
      const result = await syncPersistedAnswer({
        repository,
        apiClient,
        authSession,
        eventId: record.event.eventId,
        now
      });
      if (!result.saved) {
        return Object.freeze({
          complete: false,
          results: Object.freeze(results),
          failedEventId: record.event.eventId,
          error: result.error,
          requiresReauthentication: result.requiresReauthentication
        });
      }
      results.push(Object.freeze({ eventId: record.event.eventId, result: result.result }));
    } catch (error) {
      return Object.freeze({
        complete: false,
        results: Object.freeze(results),
        failedEventId: record.event.eventId,
        error,
        requiresReauthentication: false
      });
    }
  }

  const remaining = await listPendingAnswerEvents(repository, authSession.studentId);
  return Object.freeze({
    complete: remaining.length === 0,
    results: Object.freeze(results),
    failedEventId: remaining[0]?.event.eventId ?? null,
    error: null,
    requiresReauthentication: false
  });
}

function comparePendingAnswerRecords(left, right) {
  if (left.event.sessionId === right.event.sessionId) {
    return compareNumber(left.event.sessionAnswerSequence, right.event.sessionAnswerSequence)
      || compareText(left.queueItem.createdAt, right.queueItem.createdAt)
      || compareText(left.event.eventId, right.event.eventId);
  }
  return compareText(left.queueItem.createdAt, right.queueItem.createdAt)
    || compareText(left.event.sessionId, right.event.sessionId)
    || compareText(left.event.eventId, right.event.eventId);
}

function compareText(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function compareNumber(left, right) {
  return Number(left ?? 0) - Number(right ?? 0);
}

async function markPending(repository, queueItem, attemptAt, errorCode) {
  await repository.syncQueue.put({
    ...queueItem,
    status: "pending",
    retryCount: queueItem.retryCount + 1,
    lastAttemptAt: attemptAt,
    lastErrorCode: errorCode
  });
}

async function markFailed(repository, queueItem, attemptAt, errorCode) {
  await repository.syncQueue.put({
    ...queueItem,
    status: "failed",
    retryCount: queueItem.retryCount + 1,
    lastAttemptAt: attemptAt,
    lastErrorCode: errorCode
  });
}

function freezeWorkerSnapshot({ status, pendingCount, failedCount, lastErrorCode }) {
  return Object.freeze({
    status,
    pendingCount,
    failedCount,
    inFlight: status === ANSWER_SYNC_WORKER_STATES.sending,
    lastErrorCode
  });
}

function assertAuthSession(authSession) {
  if (
    !authSession
    || typeof authSession.studentId !== "string"
    || authSession.studentId.length === 0
    || typeof authSession.sessionToken !== "string"
    || authSession.sessionToken.length === 0
  ) {
    throw new TypeError("A valid authSession is required.");
  }
}
