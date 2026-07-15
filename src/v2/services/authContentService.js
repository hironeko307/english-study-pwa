import { listPendingAnswerEvents } from "../sync/answerSyncService.js";

export async function authenticateAndLoadContent({ apiClient, repository, userId, pin, now }) {
  const authentication = await apiClient.request("authenticate", { userId, pin });
  if (!authentication.ok) return authentication;

  const authSession = Object.freeze({
    studentId: authentication.data.studentId,
    sessionToken: authentication.data.sessionToken,
    sessionTokenExpiresAt: authentication.data.sessionTokenExpiresAt
  });
  const authenticationPayload = createAuthenticationPayload(authSession);
  const metaResponse = await apiClient.request("getContentMeta", authenticationPayload);
  if (!metaResponse.ok) return withAuthSession(metaResponse, authSession);
  const contentResponse = await apiClient.request("getVocabularyContent", {
    ...authenticationPayload,
    contentVersion: metaResponse.data.contentVersion
  });
  if (!contentResponse.ok) return withAuthSession(contentResponse, authSession);
  const contentJson = contentResponse.data.contentJson;
  const hash = await sha256Hex(contentJson);
  if (hash !== contentResponse.data.meta.sha256 || hash !== metaResponse.data.sha256) {
    throw new Error("教材データの整合性を確認できませんでした。");
  }
  const content = JSON.parse(contentJson);
  if (!Array.isArray(content) || content.length !== metaResponse.data.recordCount) {
    throw new Error("教材件数がContentMetaと一致しません。");
  }

  const timestamp = now();
  await repository.runTransaction(
    ["appMeta", "contentCache"],
    "readwrite",
    async ({ store }) => {
      await store("appMeta").put({
        key: "authSession",
        value: authSession,
        updatedAt: timestamp
      });
      await store("appMeta").put({
        key: "studentId",
        value: authSession.studentId,
        updatedAt: timestamp
      });
      await store("appMeta").put({
        key: "contentVersion",
        value: metaResponse.data.contentVersion,
        updatedAt: timestamp
      });
      await store("contentCache").put({
        contentVersion: metaResponse.data.contentVersion,
        contentJson,
        sha256: hash,
        recordCount: content.length,
        schemaVersion: metaResponse.data.schemaVersion,
        cachedAt: timestamp
      });
    }
  );

  const pendingEvents = await listPendingAnswerEvents(repository, authSession.studentId);
  if (pendingEvents.length > 0) {
    return localUnsyncedResult(authSession, content, metaResponse.data, pendingEvents);
  }

  const restored = await restoreStudentState({ apiClient, repository, authSession });
  if (!restored.ok) return withAuthSession(restored, authSession);

  return Object.freeze({
    ok: true,
    authSession,
    meta: Object.freeze({ ...metaResponse.data }),
    content: Object.freeze(content),
    restoredStateCount: restored.restoredStateCount
  });
}

export async function invalidateAuthSession({ repository, authSession }) {
  if (!authSession || typeof authSession.sessionToken !== "string") return false;

  return repository.runTransaction(["appMeta"], "readwrite", async ({ store }) => {
    const appMeta = store("appMeta");
    const storedSession = await appMeta.get("authSession");
    if (!storedSession) return false;
    if (storedSession.value?.sessionToken !== authSession.sessionToken) return false;
    await appMeta.delete("authSession");
    return true;
  });
}

export async function restoreStudentState({ apiClient, repository, authSession }) {
  const pendingEvents = await listPendingAnswerEvents(repository, authSession.studentId);
  if (pendingEvents.length > 0) {
    return localUnsyncedResult(authSession, null, null, pendingEvents);
  }

  const stateResponse = await apiClient.request(
    "getStudentState",
    createAuthenticationPayload(authSession)
  );
  if (!stateResponse.ok) return stateResponse;
  if (
    !Array.isArray(stateResponse.data.states)
    || stateResponse.data.studentId !== authSession.studentId
    || stateResponse.data.states.some((state) => state.studentId !== authSession.studentId)
  ) {
    throw new Error("学習状態を確認できませんでした。");
  }

  const replaced = await replaceStudentStatesWhenQueueIsClear(
    repository,
    authSession.studentId,
    stateResponse.data.states
  );
  if (!replaced) {
    const currentPending = await listPendingAnswerEvents(repository, authSession.studentId);
    return localUnsyncedResult(authSession, null, null, currentPending);
  }
  return Object.freeze({ ok: true, restoredStateCount: stateResponse.data.states.length });
}

function createAuthenticationPayload(authSession) {
  return Object.freeze({
    studentId: authSession.studentId,
    sessionToken: authSession.sessionToken
  });
}

async function replaceStudentStatesWhenQueueIsClear(repository, studentId, serverStates) {
  return repository.runTransaction(
    ["answerEvents", "syncQueue", "wordStates"],
    "readwrite",
    async ({ store }) => {
      const syncQueue = store("syncQueue");
      const answerEvents = store("answerEvents");
      for (const status of ["pending", "sending", "failed"]) {
        const queueItems = await syncQueue.getAllByIndex("status", status);
        for (const queueItem of queueItems) {
          if (queueItem.entityType !== "answerEvent" || !queueItem.eventId) continue;
          const event = await answerEvents.get(queueItem.eventId);
          if (!event || event.studentId === studentId) return false;
        }
      }

      const wordStates = store("wordStates");
      const localStates = await wordStates.getAllByIndex("studentId", studentId);
      for (const state of localStates) {
        await wordStates.delete([state.studentId, state.wordId]);
      }
      for (const state of serverStates) await wordStates.put(state);
      return true;
    }
  );
}

function localUnsyncedResult(authSession, content, meta, pendingEvents) {
  return Object.freeze({
    ok: false,
    data: null,
    error: Object.freeze({
      code: "LOCAL_UNSYNCED_EVENTS",
      message: "未同期の回答が端末に残っています。先に再送してください。",
      details: null
    }),
    authSession,
    content: content ? Object.freeze(content) : null,
    meta: meta ? Object.freeze({ ...meta }) : null,
    pendingEvents
  });
}

function withAuthSession(response, authSession) {
  return Object.freeze({ ...response, authSession });
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
