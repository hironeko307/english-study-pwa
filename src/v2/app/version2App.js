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
  findActiveSession,
  findSessionByLearningDate,
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
import { createHomeViewModel } from "../services/homeService.js";
import {
  isSessionExpiredApiError,
  persistAnswerTransaction,
  syncPendingAnswerEvents,
  syncPersistedAnswer
} from "../sync/answerSyncService.js";
import {
  createReadyAnswerSubmission,
  markAnswerPending,
  markAnswerPersisted,
  markAnswerSynced
} from "./answerSubmissionState.js";
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
  studyPanel: document.querySelector("#v2StudyPanel"),
  questionMeta: document.querySelector("#v2QuestionMeta"),
  questionWord: document.querySelector("#v2QuestionWord"),
  choices: document.querySelector("#v2Choices"),
  feedback: document.querySelector("#v2Feedback"),
  saveStatus: document.querySelector("#v2SaveStatus"),
  retrySync: document.querySelector("#v2RetrySync")
};

let repository;
let apiClient;
let authSession;
let homeView;
let homeContext = null;
let homeSessionPair = null;
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
let recoverySyncing = false;
let loginInProgress = false;
let feedbackTimerId = null;
let feedbackIsCorrect = null;
let feedbackDelayElapsed = false;
let feedbackSynchronized = false;
let feedbackAdvanceCompleted = false;

const SESSION_EXPIRED_MESSAGE = "セッションの有効期限が切れました。再ログインしてください";

export const version2AppReady = initialize();

async function initialize() {
  const database = await openVersion2Database();
  repository = createVersion2Repository(database);
  await repository.assertSchemaVersion();
  await repository.recoverSendingSyncItems();
  elements.endpoint.value = localStorage.getItem("vg2500.v2.endpoint") ?? "";
  elements.login.addEventListener("click", handleLogin);
  elements.retrySync.addEventListener("click", handleRetrySync);
  elements.studyPanel.addEventListener("click", handleStudyPanelTap);
  elements.homeRoot.addEventListener("homeactionerror", handleHomeActionError);
  homeView = createHomeView({
    root: elements.homeRoot,
    onStart: handleHomeStart,
    onResume: handleHomeResume
  });
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
      enterPendingRecovery(result);
      return;
    }
    if (!result.ok) {
      setLoginStatus(result.error.message, "error");
      return;
    }
    pendingRecovery = null;
    await prepareHome(result.content, result.meta);
    elements.retrySync.hidden = true;
    setLoginStatus("認証済み", "saved");
  } catch (error) {
    setLoginStatus(safeClientMessage(error), "error");
  } finally {
    loginInProgress = false;
    elements.login.disabled = false;
  }
}

function enterPendingRecovery(result) {
  clearFeedbackTransition();
  resetAnswerFeedback(elements.feedback);
  pendingRecovery = Object.freeze({
    content: result.content,
    meta: result.meta,
    pendingCount: result.pendingEvents.length
  });
  answerLocked = true;
  answerSubmission = markAnswerPersisted(result.pendingEvents[0].event.eventId);
  elements.loginPanel.hidden = true;
  elements.homePanel.hidden = true;
  elements.studyPanel.hidden = false;
  elements.questionMeta.textContent = "同期の復旧";
  elements.questionWord.textContent = `未同期 ${pendingRecovery.pendingCount}件`;
  elements.choices.replaceChildren();
  renderAnswerSubmission();
  elements.retrySync.disabled = false;
  setLoginStatus("認証済み・復旧待ち", "pending");
}

async function prepareHome(content, meta) {
  if (!Array.isArray(content) || content.length < 4) {
    throw new Error("出題に必要な教材を取得できませんでした。");
  }
  contentRecords = content.filter((item) => item.isActive === true);
  contentByWordId = new Map(contentRecords.map((item) => [item.wordId, item]));
  const wordStates = await repository.wordStates.getAllByIndex("studentId", authSession.studentId);
  const now = new Date(currentTimestamp());
  const learningDate = toLearningDate(now);
  const activePair = await findActiveSession(repository, authSession.studentId);
  const existingPair = activePair ?? await findSessionByLearningDate(
    repository,
    authSession.studentId,
    learningDate
  );

  homeContext = Object.freeze({
    contentVersion: meta.contentVersion,
    learningDate
  });
  homeSessionPair = existingPair === null
    ? null
    : Object.freeze({ session: existingPair.session, queue: existingPair.queue });
  const model = createHomeViewModel({
    contentItems: contentRecords,
    wordStates,
    session: homeSessionPair?.session ?? null,
    dailyQueue: homeSessionPair?.queue ?? null,
    learningDate
  });

  answerLocked = true;
  elements.homeStatus.textContent = "";
  elements.homeStatus.dataset.state = "idle";
  homeView.render(model);
  elements.loginPanel.hidden = true;
  elements.homePanel.hidden = false;
  elements.studyPanel.hidden = true;
}

async function handleHomeStart() {
  if (!homeContext || !authSession) throw new Error("Home is not ready to start learning.");
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
  if (!homeSessionPair || homeSessionPair.session.status !== SESSION_STATUSES.active) {
    throw new Error("An active saved Session is required to resume.");
  }
  await openSavedSession(homeSessionPair.session, homeSessionPair.queue);
}

async function openSavedSession(session, queue) {
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
  renderActiveQuestion();
}

function handleHomeActionError() {
  elements.homeStatus.textContent = "学習を開始できませんでした。もう一度お試しください。";
  elements.homeStatus.dataset.state = "error";
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
  const choices = [
    question,
    ...contentRecords.filter((item) => item.wordId !== question.wordId)
  ].slice(0, 4);
  if (choices.length < 4) {
    throw new Error("出題に必要な選択肢を取得できませんでした。");
  }
  choiceIds = choices.map((item) => item.wordId);
  questionStartedAt = performance.now();
  answerSubmission = createReadyAnswerSubmission();
  elements.questionMeta.textContent = createQuestionProgressText();
  elements.questionWord.textContent = question.word;
  elements.saveStatus.textContent = "回答を選択してください";
  elements.saveStatus.dataset.state = "idle";
  elements.retrySync.hidden = true;
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
}

async function handleAnswer(selectedChoiceId) {
  if (answerLocked || answerSubmission.eventId !== null) return;
  answerLocked = true;
  setChoiceDisabled(true);
  const isCorrect = selectedChoiceId === question.wordId;
  beginAnswerFeedback(selectedChoiceId, isCorrect);
  const answeredAt = currentTimestamp();
  const answerTimeMs = Math.max(0, Math.round(performance.now() - questionStartedAt));
  elements.saveStatus.textContent = "保存中";
  elements.saveStatus.dataset.state = "working";

  let persisted = false;
  try {
    const storedState = await repository.wordStates.get([authSession.studentId, question.wordId]);
    const stateBefore = storedState ?? createInitialWordState({
      studentId: authSession.studentId,
      wordId: question.wordId,
      policyVersion: VERSION2_POLICY_VERSION,
      updatedAt: answeredAt
    });
    const sessionUpdate = applySessionAnswer({
      session: learningSession,
      queue: dailyQueue,
      wordState: stateBefore,
      isCorrect,
      answeredAt
    });
    const retryAttemptNumber = sessionUpdate.presentationType === PRESENTATION_TYPES.immediateRetry
      ? (retryAttemptCounts.get(question.wordId) ?? 0) + 1
      : 0;
    const event = createCanonicalAnswerEvent({
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
    persisted = true;
    learningSession = sessionUpdate.session;
    dailyQueue = sessionUpdate.queue;
    if (retryAttemptNumber > 0) retryAttemptCounts.set(question.wordId, retryAttemptNumber);
    answerSubmission = markAnswerPersisted(event.eventId);
    renderAnswerSubmission();
    await synchronizeActiveAnswer();
  } catch (error) {
    if (persisted || answerSubmission.eventId !== null) {
      answerSubmission = markAnswerPending(answerSubmission);
      renderAnswerSubmission();
    } else {
      clearFeedbackTransition();
      resetAnswerFeedback(elements.feedback);
      elements.saveStatus.textContent = "端末への保存に失敗しました";
      elements.saveStatus.dataset.state = "error";
      answerLocked = false;
      setChoiceDisabled(false);
    }
  }
}

async function retryPersistedAnswer() {
  if (!answerSubmission.eventId) return;
  elements.retrySync.disabled = true;
  try {
    await synchronizeActiveAnswer();
  } catch (error) {
    answerSubmission = markAnswerPending(answerSubmission);
    renderAnswerSubmission();
  } finally {
    elements.retrySync.disabled = authSession === null;
  }
}

async function handleRetrySync() {
  if (pendingRecovery) {
    await retryPendingAnswers();
    return;
  }
  await retryPersistedAnswer();
}

async function retryPendingAnswers() {
  if (recoverySyncing || !pendingRecovery || !authSession) return;
  recoverySyncing = true;
  elements.retrySync.disabled = true;
  elements.saveStatus.textContent = "再送中";
  elements.saveStatus.dataset.state = "working";

  try {
    const result = await syncPendingAnswerEvents({
      repository,
      apiClient,
      authSession,
      now: currentTimestamp
    });
    if (!result.complete) {
      answerSubmission = markAnswerPending(answerSubmission);
      renderAnswerSubmission();
      if (result.requiresReauthentication) {
        await requireReauthentication(authSession);
        return;
      }
      setLoginStatus("再送に失敗しました。再試行できます", "error");
      return;
    }

    const restored = await restoreStudentState({ apiClient, repository, authSession });
    if (!restored.ok) {
      if (isSessionExpiredApiError(restored.error)) {
        await requireReauthentication(authSession);
        return;
      }
      elements.saveStatus.textContent = "保存済み";
      elements.saveStatus.dataset.state = "saved";
      elements.retrySync.hidden = false;
      setLoginStatus("学習状態の復元に失敗・再試行できます", "error");
      return;
    }

    const content = pendingRecovery.content;
    const meta = pendingRecovery.meta;
    pendingRecovery = null;
    await prepareHome(content, meta);
    elements.saveStatus.textContent = "保存済み";
    elements.saveStatus.dataset.state = "saved";
    elements.retrySync.hidden = true;
    setLoginStatus("認証済み", "saved");
  } catch (error) {
    answerSubmission = markAnswerPending(answerSubmission);
    renderAnswerSubmission();
    setLoginStatus("再送に失敗しました。再試行できます", "error");
  } finally {
    recoverySyncing = false;
    elements.retrySync.disabled = authSession === null;
  }
}

async function synchronizeActiveAnswer() {
  const syncResult = await syncPersistedAnswer({
    repository,
    apiClient,
    authSession,
    eventId: answerSubmission.eventId,
    now: currentTimestamp
  });
  answerSubmission = syncResult.saved
    ? markAnswerSynced(answerSubmission)
    : markAnswerPending(answerSubmission);
  renderAnswerSubmission();
  if (syncResult.saved) {
    markFeedbackSynchronized();
  }
  if (syncResult.requiresReauthentication) {
    await requireReauthentication(authSession);
  }
}

function advanceAfterSuccessfulSync() {
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
  answerLocked = true;
  question = null;
  choiceIds = [];
  clearFeedbackTransition();
  resetAnswerFeedback(elements.feedback);
  elements.questionMeta.textContent = learningSession ? "本日のSession / 完了" : "本日のSession";
  elements.questionWord.textContent = message;
  elements.choices.replaceChildren();
  elements.saveStatus.textContent = "保存済み";
  elements.saveStatus.dataset.state = "saved";
  elements.retrySync.hidden = true;
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
  elements.retrySync.disabled = true;
  elements.retrySync.hidden = true;
  const sessionToInvalidate = expiredSession;
  authSession = null;
  if (sessionToInvalidate) {
    await invalidateAuthSession({ repository, authSession: sessionToInvalidate });
  }
  answerLocked = true;
  elements.loginPanel.hidden = false;
  elements.homePanel.hidden = true;
  elements.studyPanel.hidden = false;
  setChoiceDisabled(true);
  setLoginStatus(SESSION_EXPIRED_MESSAGE, "error");
}

function renderAnswerSubmission() {
  elements.saveStatus.textContent = answerSubmission.message;
  elements.saveStatus.dataset.state = answerSubmission.status;
  elements.retrySync.hidden = !answerSubmission.retryVisible;
  setChoiceDisabled(answerSubmission.choicesLocked);
}

function setChoiceDisabled(disabled) {
  for (const button of elements.choices.querySelectorAll("button")) button.disabled = disabled;
}

function beginAnswerFeedback(selectedChoiceId, isCorrect) {
  clearFeedbackTransition();
  feedbackIsCorrect = isCorrect;
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

function markFeedbackSynchronized() {
  feedbackSynchronized = true;
  elements.studyPanel.classList.toggle("tap-advance-enabled", feedbackIsCorrect === false);
  advanceAfterFeedbackIfReady();
}

function advanceAfterFeedbackIfReady() {
  if (!feedbackSynchronized || !feedbackDelayElapsed || feedbackAdvanceCompleted) return;
  feedbackAdvanceCompleted = true;
  advanceAfterSuccessfulSync();
}

function handleStudyPanelTap(event) {
  if (feedbackIsCorrect !== false || !feedbackSynchronized || feedbackAdvanceCompleted) return;
  if (event.target.closest("button, input, select")) return;
  if (feedbackTimerId !== null) {
    window.clearTimeout(feedbackTimerId);
    feedbackTimerId = null;
  }
  feedbackDelayElapsed = true;
  advanceAfterFeedbackIfReady();
}

function clearFeedbackTransition() {
  if (feedbackTimerId !== null) {
    window.clearTimeout(feedbackTimerId);
    feedbackTimerId = null;
  }
  feedbackIsCorrect = null;
  feedbackDelayElapsed = false;
  feedbackSynchronized = false;
  feedbackAdvanceCompleted = false;
  elements.studyPanel.classList.remove("tap-advance-enabled");
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
