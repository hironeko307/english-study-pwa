import { createVersion2ApiClient, createVersion2FetchTransport } from "../api/version2ApiClient.js";
import {
  getAnswerFeedbackDelayMs,
  resetAnswerFeedback,
  showAnswerFeedback
} from "../../answerFeedback.js";
import { createVersion2Repository, openVersion2Database } from "../data/index.js";
import { createCanonicalAnswerEvent } from "../events/answerEventFactory.js";
import {
  applySessionAnswer,
  createInitialWordState,
  getCurrentSessionItem,
  PRESENTATION_TYPES,
  SESSION_PHASES,
  SESSION_STATUSES,
  startOrResumeSession,
  toLearningDate,
  VERSION2_POLICY_VERSION
} from "../learning/index.js";
import {
  authenticateAndLoadContent,
  invalidateAuthSession,
  restoreStudentState
} from "../services/authContentService.js";
import {
  createHomeViewModel,
  createInvalidSessionHomeViewModel
} from "../services/homeService.js";
import { loadSafeHomeSessionPair } from "../services/homeSessionService.js";
import { createSpeechService } from "../services/speechService.js";
import {
  ANSWER_SYNC_WORKER_STATES,
  createAnswerSyncWorker,
  isSessionExpiredApiError,
  persistAnswerTransaction
} from "../sync/answerSyncService.js";
import {
  createReadyAnswerSubmission,
  markAnswerPersisted
} from "./answerSubmissionState.js";
import { createQuestionChoices } from "./version2ChoiceGenerator.js";
import { createVersion2SpeechController } from "./version2SpeechController.js";
import { createHomeView } from "../ui/homeView.js";

const elements = {
  endpoint: document.querySelector("#v2Endpoint"),
  userId: document.querySelector("#v2UserId"),
  pin: document.querySelector("#v2Pin"),
  login: document.querySelector("#v2Login"),
  loginStatus: document.querySelector("#v2LoginStatus"),
  loginPanel: document.querySelector("#v2LoginPanel"),
  homePanel: document.querySelector("#v2HomePanel"),
  homeRoot: document.querySelector("#v2HomeRoot"),
  homeStatus: document.querySelector("#v2HomeStatus"),
  homeRetrySync: document.querySelector("#v2HomeRetrySync"),
  studyPanel: document.querySelector("#v2StudyPanel"),
  questionMeta: document.querySelector("#v2QuestionMeta"),
  questionWord: document.querySelector("#v2QuestionWord"),
  replaySpeech: document.querySelector("#v2ReplaySpeech"),
  choices: document.querySelector("#v2Choices"),
  feedback: document.querySelector("#v2Feedback"),
  saveStatus: document.querySelector("#v2SaveStatus"),
  syncStatus: document.querySelector("#v2SyncStatus"),
  retrySync: document.querySelector("#v2RetrySync"),
  backHome: document.querySelector("#v2BackHome")
};

let repository;
let apiClient;
let authSession;
let syncWorker;
let homeView;
let homeContext = null;
let homeSessionPair = null;
let homeModelData = null;
let question;
let choiceIds;
let contentRecords = [];
let contentByWordId = new Map();
let learningSession = null;
let dailyQueue = null;
let sessionAnswerSequence = 1;
let retryAttemptCounts = new Map();
let questionStartedAt;
let answerLocked = false;
let answerSubmission = createReadyAnswerSubmission();
let pendingRecovery = null;
let recoveryOperationPromise = null;
let syncRetryPromise = null;
let homeTransitionPromise = null;
let answerPersistenceInProgress = false;
let loginInProgress = false;
let feedbackTimerId = null;
let feedbackDelayElapsed = false;
let feedbackAdvanceCompleted = false;
let pageHideListenerRegistered = false;
let uiListenersRegistered = false;

const SESSION_EXPIRED_MESSAGE = "セッションの有効期限が切れました。再ログインしてください";
const SERVER_STATE_STATUSES = Object.freeze({
  idle: "idle",
  loading: "loading",
  syncing: "syncing",
  restored: "restored",
  blocked: "blocked",
  error: "error"
});
const SERVER_STATE_MESSAGES = Object.freeze({
  idle: "ログインしてください。",
  loading: "学習状態を確認しています…",
  syncing: "未同期の回答を送信しています…",
  restored: "",
  blocked: "同期を完了できません。再試行してください。",
  error: "学習状態を確認できませんでした。"
});
let serverStateStatus = SERVER_STATE_STATUSES.idle;
const speechController = createVersion2SpeechController({
  speechService: createSpeechService()
});

export const version2AppReady = initialize();

async function initialize() {
  const database = await openVersion2Database();
  repository = createVersion2Repository(database);
  await repository.assertSchemaVersion();
  await repository.recoverSendingSyncItems();
  syncWorker = createAnswerSyncWorker({
    repository,
    getApiClient: () => apiClient,
    now: currentTimestamp,
    onReauthenticationRequired: async (expiredSession) => {
      await requireReauthentication(expiredSession);
    }
  });
  homeView = createHomeView({
    root: elements.homeRoot,
    onStart: handleHomeStart,
    onResume: handleHomeResume
  });
  elements.endpoint.value = localStorage.getItem("vg2500.v2.endpoint") ?? "";
  registerUiListeners();
  registerPageHideListener();
  syncWorker.subscribe(handleSyncSnapshot);
}

function registerUiListeners() {
  if (uiListenersRegistered) return;
  elements.login.addEventListener("click", handleLogin);
  elements.retrySync.addEventListener("click", handleRetrySync);
  elements.homeRetrySync?.addEventListener("click", handleRetrySync);
  elements.backHome?.addEventListener("click", handleBackHome);
  elements.replaySpeech.addEventListener("click", handleReplaySpeech);
  elements.homeRoot.addEventListener("homeactionerror", handleHomeActionError);
  uiListenersRegistered = true;
}

async function handleLogin() {
  if (!repository || loginInProgress) return;
  loginInProgress = true;
  elements.login.disabled = true;
  const endpoint = elements.endpoint.value.trim();
  const userId = elements.userId.value.trim();
  const pin = elements.pin.value;
  elements.pin.value = "";
  setLoginStatus("認証中", "working");

  try {
    apiClient = createVersion2ApiClient({
      transport: createVersion2FetchTransport({ endpoint })
    });
    localStorage.setItem("vg2500.v2.endpoint", endpoint);
    const result = await authenticateAndLoadContent({
      apiClient,
      repository,
      userId,
      pin,
      now: currentTimestamp
    });
    if (!result.ok && isSessionExpiredApiError(result.error)) {
      await requireReauthentication(result.authSession ?? authSession);
      return;
    }
    if (result.authSession) authSession = result.authSession;
    if (!result.ok && result.error.code === "LOCAL_UNSYNCED_EVENTS" && authSession) {
      await enterPendingRecovery(result);
      void syncWorker.resume(authSession);
      return;
    }
    if (!result.ok) {
      transitionServerState(SERVER_STATE_STATUSES.idle);
      setLoginStatus(result.error.message, "error");
      return;
    }
    pendingRecovery = null;
    transitionServerState(SERVER_STATE_STATUSES.loading);
    await prepareHome(result.content, result.meta);
    if (serverStateStatus !== SERVER_STATE_STATUSES.error) {
      transitionServerState(SERVER_STATE_STATUSES.restored);
    }
    void syncWorker.resume(authSession);
    setLoginStatus("認証済み", "saved");
  } catch (error) {
    if ([
      SERVER_STATE_STATUSES.loading,
      SERVER_STATE_STATUSES.syncing
    ].includes(serverStateStatus)) {
      transitionServerState(SERVER_STATE_STATUSES.error);
    }
    setLoginStatus(safeClientMessage(error), "error");
  } finally {
    loginInProgress = false;
    elements.login.disabled = false;
  }
}

async function enterPendingRecovery(result) {
  clearFeedbackTransition();
  resetAnswerFeedback(elements.feedback);
  elements.replaySpeech.hidden = true;
  elements.replaySpeech.disabled = true;
  pendingRecovery = Object.freeze({
    content: result.content,
    meta: result.meta
  });
  transitionServerState(SERVER_STATE_STATUSES.syncing);
  answerLocked = true;
  answerSubmission = createReadyAnswerSubmission();
  await prepareHome(result.content, result.meta);
  setLoginStatus("認証済み・復旧中", "pending");
}

async function prepareHome(content, meta) {
  speechController.cancel();
  elements.replaySpeech.hidden = true;
  elements.replaySpeech.disabled = true;
  if (!Array.isArray(content) || content.length < 4) {
    throw new Error("出題に必要な教材を取得できませんでした。");
  }
  contentRecords = content.filter((item) => item.isActive === true);
  contentByWordId = new Map(contentRecords.map((item) => [item.wordId, item]));
  const wordStates = await repository.wordStates.getAllByIndex("studentId", authSession.studentId);
  const now = new Date(currentTimestamp());
  const learningDate = toLearningDate(now);
  const savedSessionResult = await loadSafeHomeSessionPair({
    repository,
    studentId: authSession.studentId,
    learningDate
  });

  homeContext = Object.freeze({
    contentVersion: meta.contentVersion,
    learningDate
  });
  homeSessionPair = savedSessionResult.pair === null
    ? null
    : Object.freeze({
      session: savedSessionResult.pair.session,
      queue: savedSessionResult.pair.queue
    });
  homeModelData = Object.freeze({
    wordStates: Object.freeze([...wordStates]),
    learningDate,
    invalidSessionMessage: savedSessionResult.error
  });

  answerLocked = true;
  renderCurrentHomeModel();
  elements.loginPanel.hidden = true;
  elements.homePanel.hidden = false;
  elements.studyPanel.hidden = true;
  setBackHomeState({ hidden: true, disabled: true });
  updateOperationalStatus(syncWorker.getSnapshot());
}

async function handleHomeStart() {
  if (
    !homeContext
    || !authSession
    || serverStateStatus !== SERVER_STATE_STATUSES.restored
  ) {
    throw new Error("Home is not ready to start learning.");
  }
  const wordStates = await repository.wordStates.getAllByIndex("studentId", authSession.studentId);
  const createdSessionId = crypto.randomUUID().toLowerCase();
  const result = await startOrResumeSession({
    repository,
    studentId: authSession.studentId,
    sessionId: createdSessionId,
    contentItems: contentRecords,
    wordStates,
    contentVersion: homeContext.contentVersion,
    policyVersion: VERSION2_POLICY_VERSION,
    queueSeed: createdSessionId,
    now: new Date(currentTimestamp())
  });

  if (result.session === null || result.session.status === SESSION_STATUSES.completed) {
    await prepareHome(contentRecords, homeContext);
    return;
  }
  await openSavedSession(result.session, result.queue);
}

async function handleHomeResume() {
  if (
    serverStateStatus !== SERVER_STATE_STATUSES.restored
    || !homeSessionPair
    || homeSessionPair.session.status !== SESSION_STATUSES.active
  ) {
    throw new Error("An active saved Session is required to resume.");
  }
  await openSavedSession(homeSessionPair.session, homeSessionPair.queue);
}

async function openSavedSession(session, queue) {
  speechController.startStudyEntry();
  learningSession = session;
  dailyQueue = queue;

  const sessionEvents = await repository.answerEvents.getAllByIndex(
    "sessionId",
    learningSession.sessionId
  );
  sessionAnswerSequence = sessionEvents.reduce(
    (maximum, event) => Math.max(maximum, event.sessionAnswerSequence),
    0
  ) + 1;
  retryAttemptCounts = countRetryAttempts(sessionEvents);
  answerLocked = false;
  elements.loginPanel.hidden = true;
  elements.homePanel.hidden = true;
  elements.studyPanel.hidden = false;
  setBackHomeState({ hidden: false, disabled: false });
  renderActiveQuestion();
}

function renderCurrentHomeModel() {
  if (!homeView || !homeModelData) return;
  if (homeModelData.invalidSessionMessage !== null) {
    serverStateStatus = SERVER_STATE_STATUSES.error;
    homeView.render(createInvalidSessionHomeViewModel(homeModelData.invalidSessionMessage));
    return;
  }

  const actionsAllowed = serverStateStatus === SERVER_STATE_STATUSES.restored;
  const actionBlockedReason = actionsAllowed
    ? null
    : getServerStateMessage(serverStateStatus, syncWorker?.getSnapshot() ?? null);
  try {
    homeView.render(createHomeViewModel({
      contentItems: contentRecords,
      wordStates: homeModelData.wordStates,
      session: homeSessionPair?.session ?? null,
      dailyQueue: homeSessionPair?.queue ?? null,
      learningDate: homeModelData.learningDate,
      newSessionAllowed: actionsAllowed,
      savedSessionResumeAllowed: actionsAllowed,
      actionBlockedReason
    }));
  } catch {
    serverStateStatus = SERVER_STATE_STATUSES.error;
    homeView.render(createInvalidSessionHomeViewModel(
      "保存済みの学習状態が不整合のため、データを変更せず停止しています。"
    ));
  }
}

function handleHomeActionError() {
  elements.homeStatus.textContent = "学習を開始できませんでした。もう一度お試しください。";
  elements.homeStatus.dataset.state = "error";
}

function handleBackHome() {
  if (
    !authSession
    || !homeContext
    || elements.studyPanel.hidden
    || answerPersistenceInProgress
    || homeTransitionPromise !== null
  ) {
    return;
  }

  setBackHomeState({ hidden: false, disabled: true });
  speechController.cancel();
  clearFeedbackTransition();
  resetAnswerFeedback(elements.feedback);
  const task = prepareHome(contentRecords, homeContext).catch(() => {
    elements.saveStatus.textContent = "Homeへ戻れませんでした。もう一度お試しください";
    elements.saveStatus.dataset.state = "error";
  });
  const trackedTask = task.finally(() => {
    if (homeTransitionPromise !== trackedTask) return;
    homeTransitionPromise = null;
    if (!elements.studyPanel.hidden) {
      setBackHomeState({ hidden: false, disabled: false });
    }
  });
  homeTransitionPromise = trackedTask;
}

function renderActiveQuestion() {
  clearFeedbackTransition();
  resetAnswerFeedback(elements.feedback);
  if (learningSession?.status === SESSION_STATUSES.completed) {
    renderSessionComplete("学習完了");
    return;
  }
  const currentWordId = getCurrentSessionItem(learningSession, dailyQueue);
  question = contentByWordId.get(currentWordId);
  if (!question) {
    throw new Error("出題対象の単語を教材から確認できませんでした。");
  }
  let choices;
  try {
    choices = createQuestionChoices({
      contentItems: contentRecords,
      questionWordId: question.wordId,
      sessionId: learningSession.sessionId,
      currentPhase: learningSession.currentPhase,
      retryRound: learningSession.currentPhase === SESSION_PHASES.immediateRetry
        ? learningSession.retryRound
        : 0,
      currentIndex: learningSession.currentPhase === SESSION_PHASES.immediateRetry
        ? dailyQueue.retryCurrentIndex
        : dailyQueue.normalCurrentIndex
    });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    renderQuestionChoiceFailure();
    return;
  }
  choiceIds = choices.map((item) => item.wordId);
  questionStartedAt = performance.now();
  answerSubmission = createReadyAnswerSubmission();
  elements.questionMeta.textContent = createQuestionProgressText();
  elements.questionWord.textContent = question.word;
  elements.saveStatus.textContent = "回答を選択してください";
  elements.saveStatus.dataset.state = "idle";
  elements.choices.replaceChildren(...choices.map((choice) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice-button";
    button.dataset.choiceId = String(choice.wordId);
    button.setAttribute("aria-pressed", "false");
    button.textContent = choice.meaningJa;
    button.addEventListener("click", () => handleAnswer(choice.wordId));
    return button;
  }));
  elements.replaySpeech.hidden = false;
  elements.replaySpeech.disabled = false;
  setBackHomeState({ hidden: false, disabled: false });
  speechController.autoPlayQuestion({
    sessionId: learningSession.sessionId,
    currentPhase: learningSession.currentPhase,
    retryRound: learningSession.currentPhase === SESSION_PHASES.immediateRetry
      ? learningSession.retryRound
      : 0,
    currentIndex: learningSession.currentPhase === SESSION_PHASES.immediateRetry
      ? dailyQueue.retryCurrentIndex
      : dailyQueue.normalCurrentIndex,
    wordId: question.wordId,
    text: question.word
  });
}

function renderQuestionChoiceFailure() {
  answerLocked = true;
  question = null;
  choiceIds = [];
  elements.replaySpeech.hidden = true;
  elements.replaySpeech.disabled = true;
  elements.questionMeta.textContent = "出題エラー";
  elements.questionWord.textContent = "出題に必要な選択肢を取得できませんでした。";
  elements.choices.replaceChildren();
  elements.saveStatus.textContent = "教材データを確認してください";
  elements.saveStatus.dataset.state = "error";
  setBackHomeState({ hidden: false, disabled: false });
}

function handleReplaySpeech() {
  if (elements.studyPanel.hidden || elements.replaySpeech.hidden || !question) return;
  speechController.replay(question.word);
}

async function handleAnswer(selectedChoiceId) {
  if (answerLocked || answerSubmission.eventId !== null) return;
  answerLocked = true;
  answerPersistenceInProgress = true;
  setChoiceDisabled(true);
  setBackHomeState({ hidden: false, disabled: true });
  const isCorrect = selectedChoiceId === question.wordId;
  const answeredAt = currentTimestamp();
  const answerTimeMs = Math.max(0, Math.round(performance.now() - questionStartedAt));
  elements.saveStatus.textContent = "保存中";
  elements.saveStatus.dataset.state = "working";

  let event;
  let sessionUpdate;
  let retryAttemptNumber;
  try {
    const storedState = await repository.wordStates.get([authSession.studentId, question.wordId]);
    const stateBefore = storedState ?? createInitialWordState({
      studentId: authSession.studentId,
      wordId: question.wordId,
      policyVersion: VERSION2_POLICY_VERSION,
      updatedAt: answeredAt
    });
    sessionUpdate = applySessionAnswer({
      session: learningSession,
      queue: dailyQueue,
      wordState: stateBefore,
      isCorrect,
      answeredAt
    });
    retryAttemptNumber = sessionUpdate.presentationType === PRESENTATION_TYPES.immediateRetry
      ? (retryAttemptCounts.get(question.wordId) ?? 0) + 1
      : 0;
    event = createCanonicalAnswerEvent({
      studentId: authSession.studentId,
      sessionId: learningSession.sessionId,
      sessionAnswerSequence,
      question,
      choiceIds,
      selectedChoiceId,
      stateBefore,
      stateAfter: sessionUpdate.wordState,
      learningDate: learningSession.learningDate,
      answeredAt,
      answerTimeMs,
      presentationType: sessionUpdate.presentationType,
      retryRound: sessionUpdate.retryRound,
      retryAttemptNumber
    });

    await persistAnswerTransaction(repository, {
      event,
      stateAfter: sessionUpdate.wordState,
      session: sessionUpdate.session,
      queue: sessionUpdate.queue
    });
  } catch (error) {
    clearFeedbackTransition();
    resetAnswerFeedback(elements.feedback);
    elements.saveStatus.textContent = "端末への保存に失敗しました。もう一度回答してください";
    elements.saveStatus.dataset.state = "error";
    answerPersistenceInProgress = false;
    answerLocked = false;
    setChoiceDisabled(false);
    setBackHomeState({ hidden: false, disabled: false });
    return;
  }

  answerPersistenceInProgress = false;
  learningSession = sessionUpdate.session;
  dailyQueue = sessionUpdate.queue;
  if (retryAttemptNumber > 0) retryAttemptCounts.set(question.wordId, retryAttemptNumber);
  answerSubmission = markAnswerPersisted(event.eventId);
  elements.saveStatus.textContent = "端末に保存済み";
  elements.saveStatus.dataset.state = "saved";
  setBackHomeState({ hidden: false, disabled: false });
  beginAnswerFeedback(selectedChoiceId, isCorrect);
  void syncWorker.notifyPending();
}

function handleRetrySync() {
  if (!syncWorker || !authSession || syncRetryPromise !== null) return;
  const snapshot = syncWorker.getSnapshot();
  if (pendingRecovery && snapshot.pendingCount === 0) {
    void completePendingRecovery();
    return;
  }
  if (
    snapshot.status === ANSWER_SYNC_WORKER_STATES.failed
    && !snapshot.canRetryFailed
  ) {
    updateOperationalStatus(snapshot);
    return;
  }
  const task = snapshot.status === ANSWER_SYNC_WORKER_STATES.failed
    ? syncWorker.retryFailed()
    : syncWorker.notifyPending();
  const trackedTask = task.finally(() => {
    if (syncRetryPromise !== trackedTask) return;
    syncRetryPromise = null;
    updateOperationalStatus(syncWorker.getSnapshot());
  });
  syncRetryPromise = trackedTask;
  setRetryButtonsDisabled(true);
  if (pendingRecovery) transitionServerState(SERVER_STATE_STATUSES.syncing);
}

function completePendingRecovery() {
  if (recoveryOperationPromise !== null) return recoveryOperationPromise;
  if (!pendingRecovery || !authSession) return Promise.resolve();

  const task = (async () => {
    transitionServerState(SERVER_STATE_STATUSES.loading);
    setRetryButtonsDisabled(true);
    const restored = await restoreStudentState({ apiClient, repository, authSession });
    if (!restored.ok) {
      if (isSessionExpiredApiError(restored.error)) {
        await requireReauthentication(authSession);
        return;
      }
      transitionServerState(SERVER_STATE_STATUSES.error);
      setLoginStatus("学習状態の復元に失敗・再試行できます", "error");
      return;
    }

    const content = pendingRecovery.content;
    const meta = pendingRecovery.meta;
    pendingRecovery = null;
    await prepareHome(content, meta);
    if (serverStateStatus !== SERVER_STATE_STATUSES.error) {
      transitionServerState(SERVER_STATE_STATUSES.restored);
    }
    setLoginStatus("認証済み", "saved");
  })().catch(() => {
    transitionServerState(SERVER_STATE_STATUSES.error);
    setLoginStatus("学習状態の復元に失敗・再試行できます", "error");
  });
  const trackedTask = task.finally(() => {
    if (recoveryOperationPromise !== trackedTask) return;
    recoveryOperationPromise = null;
    updateOperationalStatus(syncWorker.getSnapshot());
  });
  recoveryOperationPromise = trackedTask;
  return trackedTask;
}

function advanceAfterFeedback() {
  speechController.cancel();
  clearFeedbackTransition();
  resetAnswerFeedback(elements.feedback);
  sessionAnswerSequence += 1;
  answerLocked = false;
  renderActiveQuestion();
}

function createQuestionProgressText() {
  if (learningSession.currentPhase === SESSION_PHASES.immediateRetry) {
    return `即時再出題 Round ${learningSession.retryRound} / ${dailyQueue.retryCurrentIndex + 1}問目`;
  }
  return `通常 ${learningSession.normalCompletedCount + 1}/${learningSession.normalQuestionCount}問目`;
}

function renderSessionComplete(message) {
  speechController.cancel();
  answerLocked = true;
  question = null;
  choiceIds = [];
  elements.replaySpeech.hidden = true;
  elements.replaySpeech.disabled = true;
  clearFeedbackTransition();
  resetAnswerFeedback(elements.feedback);
  elements.questionMeta.textContent = learningSession ? "本日のSession / 完了" : "本日のSession";
  elements.questionWord.textContent = message;
  elements.choices.replaceChildren();
  elements.saveStatus.textContent = "端末に保存済み";
  elements.saveStatus.dataset.state = "saved";
  setBackHomeState({ hidden: false, disabled: false });
}

function countRetryAttempts(events) {
  const counts = new Map();
  for (const event of events) {
    if (event.presentationType !== PRESENTATION_TYPES.immediateRetry) continue;
    counts.set(event.wordId, Math.max(counts.get(event.wordId) ?? 0, event.retryAttemptNumber));
  }
  return counts;
}

async function requireReauthentication(expiredSession) {
  speechController.cancel();
  clearFeedbackTransition();
  elements.replaySpeech.hidden = true;
  elements.replaySpeech.disabled = true;
  elements.retrySync.disabled = true;
  elements.retrySync.hidden = true;
  if (elements.homeRetrySync) {
    elements.homeRetrySync.disabled = true;
    elements.homeRetrySync.hidden = true;
  }
  setBackHomeState({ hidden: true, disabled: true });
  const sessionToInvalidate = expiredSession;
  authSession = null;
  if (syncWorker?.getSnapshot().status !== ANSWER_SYNC_WORKER_STATES.pausedAuth) {
    await syncWorker?.pauseAuth();
  }
  if (sessionToInvalidate) {
    await invalidateAuthSession({ repository, authSession: sessionToInvalidate });
  }
  answerLocked = true;
  pendingRecovery = null;
  transitionServerState(SERVER_STATE_STATUSES.idle);
  elements.loginPanel.hidden = false;
  elements.homePanel.hidden = true;
  elements.studyPanel.hidden = false;
  setChoiceDisabled(true);
  setLoginStatus(SESSION_EXPIRED_MESSAGE, "error");
}

function registerPageHideListener() {
  if (pageHideListenerRegistered) return;
  window.addEventListener("pagehide", handlePageHide);
  pageHideListenerRegistered = true;
}

function handlePageHide() {
  speechController.cancel();
}

function setChoiceDisabled(disabled) {
  for (const button of elements.choices.querySelectorAll("button")) button.disabled = disabled;
}

function setBackHomeState({ hidden, disabled }) {
  if (!elements.backHome) return;
  elements.backHome.hidden = hidden;
  elements.backHome.disabled = disabled;
}

function setRetryButtonsDisabled(disabled) {
  elements.retrySync.disabled = disabled;
  if (elements.homeRetrySync) elements.homeRetrySync.disabled = disabled;
}

function beginAnswerFeedback(selectedChoiceId, isCorrect) {
  clearFeedbackTransition();
  showAnswerFeedback({
    buttons: elements.choices.querySelectorAll("button"),
    feedbackElement: elements.feedback,
    selectedChoiceValue: String(selectedChoiceId),
    correctChoiceValue: String(question.wordId),
    correctChoiceText: question.meaningJa,
    getChoiceValue: (button) => button.dataset.choiceId,
    isCorrect,
    showSparkle: false
  });
  feedbackTimerId = window.setTimeout(() => {
    feedbackTimerId = null;
    feedbackDelayElapsed = true;
    advanceAfterFeedbackIfReady();
  }, getAnswerFeedbackDelayMs(isCorrect));
}

function advanceAfterFeedbackIfReady() {
  if (!feedbackDelayElapsed || feedbackAdvanceCompleted) return;
  feedbackAdvanceCompleted = true;
  advanceAfterFeedback();
}

function clearFeedbackTransition() {
  if (feedbackTimerId !== null) {
    window.clearTimeout(feedbackTimerId);
    feedbackTimerId = null;
  }
  feedbackDelayElapsed = false;
  feedbackAdvanceCompleted = false;
  elements.studyPanel.classList.remove("tap-advance-enabled");
}

function handleSyncSnapshot(snapshot) {
  if (snapshot.status === ANSWER_SYNC_WORKER_STATES.sending) {
    setSyncStatus(`同期中・端末保存済み ${snapshot.pendingCount}件`, "working");
    elements.retrySync.hidden = true;
    elements.retrySync.disabled = true;
  } else if (snapshot.status === ANSWER_SYNC_WORKER_STATES.pending) {
    setSyncStatus(`同期待ち ${snapshot.pendingCount}件`, "pending");
    elements.retrySync.textContent = "同期を再試行";
    elements.retrySync.hidden = authSession === null;
    elements.retrySync.disabled = authSession === null || syncRetryPromise !== null;
  } else if (snapshot.status === ANSWER_SYNC_WORKER_STATES.failed) {
    setSyncStatus(getFailedSyncMessage(snapshot, snapshot.pendingCount), "error");
    elements.retrySync.textContent = "同期を再試行";
    elements.retrySync.hidden = authSession === null || !snapshot.canRetryFailed;
    elements.retrySync.disabled = (
      authSession === null
      || !snapshot.canRetryFailed
      || syncRetryPromise !== null
    );
  } else if (snapshot.status === ANSWER_SYNC_WORKER_STATES.pausedAuth) {
    setSyncStatus(`再ログインが必要・未同期 ${snapshot.pendingCount}件`, "error");
    elements.retrySync.hidden = true;
    elements.retrySync.disabled = true;
  } else if (snapshot.status === ANSWER_SYNC_WORKER_STATES.disposed) {
    setSyncStatus("同期停止", "error");
    elements.retrySync.hidden = true;
    elements.retrySync.disabled = true;
  } else {
    setSyncStatus("すべて同期済み", "saved");
    elements.retrySync.hidden = true;
    elements.retrySync.disabled = false;
  }

  if (pendingRecovery) {
    if (snapshot.status === ANSWER_SYNC_WORKER_STATES.sending) {
      transitionServerState(SERVER_STATE_STATUSES.syncing);
    } else if (
      snapshot.status === ANSWER_SYNC_WORKER_STATES.pending
      || snapshot.status === ANSWER_SYNC_WORKER_STATES.failed
      || snapshot.status === ANSWER_SYNC_WORKER_STATES.pausedAuth
    ) {
      transitionServerState(SERVER_STATE_STATUSES.blocked);
    } else if (
      snapshot.status === ANSWER_SYNC_WORKER_STATES.idle
      && snapshot.pendingCount === 0
    ) {
      void completePendingRecovery();
    }
  }
  updateOperationalStatus(snapshot);
}

function transitionServerState(nextStatus) {
  if (!Object.values(SERVER_STATE_STATUSES).includes(nextStatus)) {
    throw new TypeError(`Unsupported server state status: ${nextStatus}`);
  }
  serverStateStatus = nextStatus;
  renderCurrentHomeModel();
  updateOperationalStatus(syncWorker?.getSnapshot() ?? null);
}

function updateOperationalStatus(snapshot) {
  elements.homePanel.dataset.serverState = serverStateStatus;
  const pendingCount = snapshot?.pendingCount ?? 0;
  let message = getServerStateMessage(serverStateStatus, snapshot);
  let state = "idle";

  if (serverStateStatus === SERVER_STATE_STATUSES.syncing) {
    message = pendingCount > 0
      ? `未同期の回答を送信しています… ${pendingCount}件`
      : SERVER_STATE_MESSAGES.syncing;
    state = "working";
  } else if (serverStateStatus === SERVER_STATE_STATUSES.loading) {
    state = "working";
  } else if (
    serverStateStatus === SERVER_STATE_STATUSES.blocked
    || serverStateStatus === SERVER_STATE_STATUSES.error
  ) {
    state = "error";
  } else if (
    serverStateStatus === SERVER_STATE_STATUSES.restored
    && pendingCount > 0
  ) {
    message = `同期待ち ${pendingCount}件`;
    state = "pending";
  }

  elements.homeStatus.textContent = message;
  elements.homeStatus.dataset.state = state;
  if (!elements.homeRetrySync) return;

  const canRetryPending = pendingRecovery !== null
    && snapshot?.status === ANSWER_SYNC_WORKER_STATES.pending;
  const canRetryFailed = pendingRecovery !== null
    && snapshot?.status === ANSWER_SYNC_WORKER_STATES.failed
    && snapshot.canRetryFailed;
  const canRetryRestore = pendingRecovery !== null
    && pendingCount === 0
    && serverStateStatus === SERVER_STATE_STATUSES.error;
  elements.homeRetrySync.textContent = canRetryRestore
    ? "学習状態の復元を再試行"
    : "同期を再試行";
  elements.homeRetrySync.hidden = !(canRetryPending || canRetryFailed || canRetryRestore);
  elements.homeRetrySync.disabled = (
    authSession === null
    || (snapshot?.status === ANSWER_SYNC_WORKER_STATES.failed && !snapshot.canRetryFailed)
    || syncRetryPromise !== null
    || recoveryOperationPromise !== null
    || snapshot?.status === ANSWER_SYNC_WORKER_STATES.sending
  );
}

function getServerStateMessage(status, snapshot) {
  if (
    status === SERVER_STATE_STATUSES.blocked
    && snapshot?.status === ANSWER_SYNC_WORKER_STATES.failed
  ) {
    return getFailedSyncMessage(snapshot, snapshot.pendingCount);
  }
  return SERVER_STATE_MESSAGES[status];
}

function getFailedSyncMessage(snapshot, pendingCount) {
  const errorCode = snapshot?.lastErrorCode ?? "UNKNOWN";
  return snapshot?.canRetryFailed
    ? `同期を完了できません。再試行してください。 ${pendingCount}件 (${errorCode})`
    : `同期データの確認が必要です ${pendingCount}件 (${errorCode})`;
}

function setSyncStatus(message, state) {
  elements.syncStatus.textContent = message;
  elements.syncStatus.dataset.state = state;
}

function setLoginStatus(message, state) {
  elements.loginStatus.textContent = message;
  elements.loginStatus.dataset.state = state;
}

function currentTimestamp() {
  return new Date().toISOString();
}

function safeClientMessage(error) {
  if (error?.reason === "TIMEOUT") return "接続がタイムアウトしました。";
  if (error?.name === "Version2ApiProtocolError") return "API応答を確認できませんでした。";
  return "ログインまたは教材取得に失敗しました。";
}
