export function createReadyAnswerSubmission() {
  return freezeState(null, "ready", "回答を選択してください", false, false);
}

export function markAnswerPersisted(eventId) {
  assertEventId(eventId);
  return freezeState(eventId, "pending", "端末に保存済み・未同期", true, true);
}

export function markAnswerPending(state) {
  assertPersistedState(state);
  return freezeState(state.eventId, "pending", "端末に保存済み・未同期", true, true);
}

export function markAnswerSynced(state) {
  assertPersistedState(state);
  return freezeState(state.eventId, "saved", "保存済み", true, false);
}

function freezeState(eventId, status, message, choicesLocked, retryVisible) {
  return Object.freeze({ eventId, status, message, choicesLocked, retryVisible });
}

function assertPersistedState(state) {
  if (!state || typeof state.eventId !== "string" || state.eventId.length === 0) {
    throw new Error("A persisted answer event is required.");
  }
}

function assertEventId(eventId) {
  if (typeof eventId !== "string" || eventId.length === 0) {
    throw new TypeError("eventId is required.");
  }
}
