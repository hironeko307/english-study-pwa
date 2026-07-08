import { storageService } from "./storageService.js";

const API_VERSION = 2;
const SCHEMA_VERSION = 1;
const SOURCE = "vocab-app";

export class NewModelSyncService {
  constructor(studentId) {
    this.studentId = studentId;
    this.inFlight = null;
    this.flushRequested = false;
  }

  getPendingCount() {
    return storageService.future.countPendingNewModelSyncItems(this.studentId);
  }

  async flush() {
    if (this.inFlight) {
      this.flushRequested = true;
      return this.inFlight;
    }

    this.inFlight = this.flushLoop();

    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  async flushLoop() {
    let sent = 0;
    let pending = 0;

    do {
      this.flushRequested = false;
      const result = await this.flushOnce();
      sent += result.sent;
      pending = result.pending;
    } while (this.flushRequested);

    return { sent, pending };
  }

  async flushOnce() {
    const endpoint = storageService.legacy.getGasEndpoint().trim();
    const pendingItems = storageService.future.loadPendingNewModelSyncItems(this.studentId);
    const pendingCount = countSyncItems(pendingItems);

    if (!endpoint || pendingCount === 0) {
      return { sent: 0, pending: pendingCount };
    }

    const sentAt = new Date().toISOString();
    const itemRefs = buildNewModelSyncItemRefs(pendingItems);
    const payload = buildNewModelSyncPayload({
      studentId: this.studentId,
      sentAt,
      items: pendingItems
    });

    try {
      await postNewModelPayload(endpoint, payload);
      storageService.future.markNewModelItemsSynced(this.studentId, itemRefs, sentAt);
      return {
        sent: pendingCount,
        pending: storageService.future.countPendingNewModelSyncItems(this.studentId)
      };
    } catch (error) {
      storageService.future.markNewModelItemsSyncFailed(
        this.studentId,
        itemRefs,
        new Date().toISOString(),
        errorMessage(error)
      );
      throw error;
    }
  }
}

export function buildNewModelSyncPayload({ studentId, sentAt, items }) {
  return {
    apiVersion: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    source: SOURCE,
    studentId,
    sentAt,
    attempts: items.attempts.map(toSyncRecord),
    sessions: items.sessions.map(toSyncRecord),
    studentProgress: items.studentProgress.map(toSyncRecord),
    settings: []
  };
}

export function buildNewModelSyncItemRefs(items) {
  return {
    attempts: items.attempts.map((attempt) => createItemRef(attempt, "attemptId")),
    sessions: items.sessions.map((session) => createItemRef(session, "sessionId")),
    studentProgress: items.studentProgress.map((progress) => createItemRef(progress, "questionId"))
  };
}

export async function postNewModelPayload(endpoint, payload) {
  await fetch(endpoint, {
    method: "POST",
    mode: "no-cors",
    cache: "no-store",
    keepalive: true,
    headers: {
      "Content-Type": "text/plain;charset=utf-8"
    },
    body: JSON.stringify(payload)
  });
}

function createItemRef(item, idKey) {
  return {
    [idKey]: item[idKey],
    syncFingerprint: createSyncFingerprint(item)
  };
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

function countSyncItems(items) {
  return items.attempts.length + items.sessions.length + items.studentProgress.length;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
