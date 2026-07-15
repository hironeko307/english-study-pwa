import { STORE_NAMES } from "../data/schema.js";

const UNSYNCED_ANSWER_STATUSES = Object.freeze(["pending", "sending", "failed"]);
const SESSION_EXPIRED_ERROR_CODE = "SESSION_EXPIRED";

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
        requiresReauthentication: isSessionExpiredApiError(response.error)
      });
    }

    const result = response.data.results?.find((item) => item.eventId === eventId);
    if (!result || !["accepted", "alreadyAccepted"].includes(result.result)) {
      const errorCode = result?.error?.code ?? "INVALID_RESPONSE";
      await markPending(repository, queueItem, attemptAt, errorCode);
      return Object.freeze({
        saved: false,
        result: result?.result ?? null,
        error: result?.error ?? null,
        requiresReauthentication: isSessionExpiredApiError(result?.error)
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
      requiresReauthentication: false
    });
  } catch (error) {
    await markPending(repository, queueItem, attemptAt, "TRANSPORT_FAILURE");
    throw error;
  }
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
  return compareText(left.queueItem.createdAt, right.queueItem.createdAt)
    || compareText(left.event.sessionId, right.event.sessionId)
    || compareNumber(left.event.sessionAnswerSequence, right.event.sessionAnswerSequence)
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
