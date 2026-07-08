import { AnswerHistory } from "./answerHistory.js";
import {
  createAttempt,
  createSession,
  calculateSectionProgress,
  countDueReviews,
  formatStars,
  getProgressForQuestion,
  summarizeTodayLearning,
  updateProgressWithAttempt,
  updateSessionWithAttempt,
  WORD_JA_CHOICE_MODE,
  WORD_JA_CHOICE_RETRY_MODE
} from "./learningRecords.js";
import {
  CORRECT_FEEDBACK_DELAY_MS,
  DAILY_NEW_TARGET,
  DATASET_ID,
  EXAM_DATE,
  GAS_WEB_APP_URL,
  INCORRECT_FEEDBACK_DELAY_MS,
  STUDENT_DISPLAY_NAMES
} from "./config.js";
import { GasApiClient } from "./gasApiClient.js";
import { buildHomeSummary, getStudentDisplayName } from "./homeSummary.js";
import { buildQuestion } from "./quizEngine.js";
import { getSections, normalizeVocabularyItems, wordsForSection } from "./problemData.js";
import {
  buildStudyPlan,
  getWrongQuestionIdsForSession,
  removeQuestionId
} from "./studyPlan.js";
import { NewModelSyncService } from "./newModelSyncService.js";
import { storageService } from "./storageService.js";
import { SubmissionService } from "./submissionService.js";

const elements = {
  sectionSelect: document.querySelector("#sectionSelect"),
  endpointInput: document.querySelector("#endpointInput"),
  saveEndpointButton: document.querySelector("#saveEndpointButton"),
  flushButton: document.querySelector("#flushButton"),
  homeState: document.querySelector("#homeState"),
  loginUserIdInput: document.querySelector("#loginUserIdInput"),
  loginPinInput: document.querySelector("#loginPinInput"),
  loginButton: document.querySelector("#loginButton"),
  loginStatus: document.querySelector("#loginStatus"),
  vocabularySourceStatus: document.querySelector("#vocabularySourceStatus"),
  homeDisplayName: document.querySelector("#homeDisplayName"),
  homeStudentId: document.querySelector("#homeStudentId"),
  examDaysLeft: document.querySelector("#examDaysLeft"),
  homeAnsweredCount: document.querySelector("#homeAnsweredCount"),
  homeCorrectCount: document.querySelector("#homeCorrectCount"),
  homeIncorrectCount: document.querySelector("#homeIncorrectCount"),
  homeAccuracy: document.querySelector("#homeAccuracy"),
  homeActualNewCount: document.querySelector("#homeActualNewCount"),
  homeActualReviewCount: document.querySelector("#homeActualReviewCount"),
  homeNewCount: document.querySelector("#homeNewCount"),
  homeReviewCount: document.querySelector("#homeReviewCount"),
  homeTotalCount: document.querySelector("#homeTotalCount"),
  yesterdayAnsweredCount: document.querySelector("#yesterdayAnsweredCount"),
  yesterdayAccuracy: document.querySelector("#yesterdayAccuracy"),
  yesterdayStudyTime: document.querySelector("#yesterdayStudyTime"),
  homeSectionProgress: document.querySelector("#homeSectionProgress"),
  homePendingCount: document.querySelector("#homePendingCount"),
  startLearningButton: document.querySelector("#startLearningButton"),
  statusGrid: document.querySelector("#statusGrid"),
  sectionCount: document.querySelector("#sectionCount"),
  unresolvedCount: document.querySelector("#unresolvedCount"),
  reviewCount: document.querySelector("#reviewCount"),
  todayNewCount: document.querySelector("#todayNewCount"),
  todayReviewCount: document.querySelector("#todayReviewCount"),
  sectionProgress: document.querySelector("#sectionProgress"),
  pendingCount: document.querySelector("#pendingCount"),
  runModeLabel: document.querySelector("#runModeLabel"),
  retryRemainingCount: document.querySelector("#retryRemainingCount"),
  quizPanel: document.querySelector("#quizPanel"),
  loadingState: document.querySelector("#loadingState"),
  quizState: document.querySelector("#quizState"),
  emptyState: document.querySelector("#emptyState"),
  emptyMessage: document.querySelector("#emptyMessage"),
  emptyHomeButton: document.querySelector("#emptyHomeButton"),
  completeState: document.querySelector("#completeState"),
  completeLabel: document.querySelector("#completeLabel"),
  completeTitle: document.querySelector("#completeTitle"),
  completeAnsweredCount: document.querySelector("#completeAnsweredCount"),
  completeCorrectCount: document.querySelector("#completeCorrectCount"),
  completeWrongCount: document.querySelector("#completeWrongCount"),
  completeMessage: document.querySelector("#completeMessage"),
  retryWrongButton: document.querySelector("#retryWrongButton"),
  homeButton: document.querySelector("#homeButton"),
  questionSection: document.querySelector("#questionSection"),
  questionProgress: document.querySelector("#questionProgress"),
  questionPos: document.querySelector("#questionPos"),
  questionStars: document.querySelector("#questionStars"),
  questionWord: document.querySelector("#questionWord"),
  choiceList: document.querySelector("#choiceList"),
  feedback: document.querySelector("#feedback"),
  nextButton: document.querySelector("#nextButton")
};

const params = new URLSearchParams(window.location.search);
let studentId = params.get("student")?.trim() || "guest";

let words = [];
let history = null;
let submission = null;
let newModelSync = null;
let gasApi = null;
let activeSession = null;
let activeRun = null;
let pendingRetryQuestionIds = [];
let progressByQuestionId = {};
let currentQuestion = null;
let questionStartedAt = null;
let lastQuestionId = null;
let isLearningStarted = false;
let isAnswerLocked = false;
let autoAdvanceTimerId = null;
let isIncorrectTapAdvanceEnabled = false;

init();

async function init() {
  setupStudentContext(studentId);
  const cachedSession = storageService.app.loadAuthSession();
  if (cachedSession?.userId) {
    setupStudentContext(cachedSession.userId);
  }

  bindEvents();

  try {
    words = await loadInitialVocabulary();
    populateSections(words);
    progressByQuestionId = storageService.future.loadStudentProgress(studentId);
    updateLoginStatus();
    refreshHome();
    refreshStatus();
  } catch (error) {
    words = [];
    populateSections(words);
    updateLoginStatus();
    elements.vocabularySourceStatus.textContent = `教材未取得。GASログインで取得してください。${error.message}`;
  }
}

function bindEvents() {
  elements.loginButton.addEventListener("click", handleLogin);

  elements.sectionSelect.addEventListener("change", () => {
    lastQuestionId = null;
    if (isLearningStarted) {
      resetToHome();
    } else {
      refreshHome();
      refreshStatus();
    }
  });

  elements.saveEndpointButton.addEventListener("click", () => {
    submission.setEndpoint(elements.endpointInput.value);
    gasApi.setEndpoint(elements.endpointInput.value);
    refreshStatus();
  });

  elements.flushButton.addEventListener("click", async () => {
    await tryFlush();
  });

  elements.startLearningButton.addEventListener("click", startLearning);
  elements.nextButton.addEventListener("click", showNextQuestion);
  elements.retryWrongButton.addEventListener("click", startRetryLearning);
  elements.homeButton.addEventListener("click", resetToHome);
  elements.emptyHomeButton.addEventListener("click", resetToHome);
  elements.quizPanel.addEventListener("click", handleQuizPanelTap);
}

function setupStudentContext(nextStudentId) {
  studentId = nextStudentId || "guest";
  history = new AnswerHistory(studentId);
  submission = new SubmissionService(studentId);
  newModelSync = new NewModelSyncService(studentId);
  gasApi = new GasApiClient({
    endpoint: storageService.legacy.getGasEndpoint() || GAS_WEB_APP_URL
  });
  progressByQuestionId = storageService.future.loadStudentProgress(studentId);
  elements.endpointInput.value = storageService.legacy.getGasEndpoint() || GAS_WEB_APP_URL;
  elements.loginUserIdInput.value = studentId === "guest" ? "" : studentId;
  updateStudentDisplay(getStudentDisplayName(studentId, STUDENT_DISPLAY_NAMES), studentId);
}

async function loadInitialVocabulary() {
  const cached = storageService.app.loadVocabularyCache(DATASET_ID);
  if (cached?.items?.length) {
    elements.vocabularySourceStatus.textContent = `キャッシュ教材 ${cached.datasetVersion} を使用中`;
    return normalizeVocabularyItems(cached.items);
  }

  throw new Error("キャッシュ教材がありません。GASログインで教材を取得してください。");
}

async function handleLogin() {
  const requestedUserId = elements.loginUserIdInput.value.trim();
  const pin = elements.loginPinInput.value;

  if (!requestedUserId || !pin) {
    setLoginMessage("User ID と PIN を入力してください。", true);
    return;
  }

  setLoginBusy(true, "ログイン中...");

  try {
    const loginData = await gasApi.login({ userId: requestedUserId, pin });
    storageService.app.saveAuthSession({
      userId: loginData.userId,
      displayName: loginData.displayName,
      sessionToken: loginData.sessionToken,
      sessionTokenExpiresAt: loginData.sessionTokenExpiresAt,
      savedAt: new Date().toISOString()
    });
    elements.loginPinInput.value = "";
    setupStudentContext(loginData.userId);
    updateStudentDisplay(loginData.displayName, loginData.userId);

    const versionData = await gasApi.version({ datasetId: DATASET_ID });
    const cached = storageService.app.loadVocabularyCache(DATASET_ID);
    const datasetVersion = versionData.currentVersion;

    if (cached?.datasetVersion === datasetVersion && cached.items?.length) {
      words = normalizeVocabularyItems(cached.items);
      if (!words.length) {
        throw new Error("キャッシュ教材が空です。Vocabularyを再取得してください。");
      }
      setLoginMessage(`ログイン済み。キャッシュ教材 ${datasetVersion} を使用中。`, false);
    } else {
      const vocabularyData = await gasApi.vocabulary({
        userId: loginData.userId,
        sessionToken: loginData.sessionToken,
        datasetId: DATASET_ID,
        version: datasetVersion
      });
      const cache = {
        datasetId: vocabularyData.datasetId || DATASET_ID,
        datasetVersion: vocabularyData.version || datasetVersion,
        cachedAt: new Date().toISOString(),
        items: vocabularyData.items || []
      };
      storageService.app.saveVocabularyCache(DATASET_ID, cache);
      words = normalizeVocabularyItems(cache.items);
      if (!words.length) {
        throw new Error("Vocabularyが空です。Google SheetsのVocabularyシートを確認してください。");
      }
      setLoginMessage(`ログイン済み。Sheets教材 ${cache.datasetVersion} を取得しました。`, false);
    }

    populateSections(words);
    progressByQuestionId = storageService.future.loadStudentProgress(studentId);
    refreshHome();
    refreshStatus();
  } catch (error) {
    setLoginMessage(error.message || "ログインまたは教材取得に失敗しました。", true);
  } finally {
    setLoginBusy(false);
  }
}

function updateStudentDisplay(displayName, nextStudentId) {
  elements.homeDisplayName.textContent = displayName || nextStudentId;
  elements.homeStudentId.textContent = nextStudentId;
}

function updateLoginStatus() {
  const session = storageService.app.loadAuthSession();
  if (!session?.sessionToken || !session?.sessionTokenExpiresAt) {
    setLoginMessage("未ログイン", true);
    return;
  }

  if (new Date(session.sessionTokenExpiresAt) <= new Date()) {
    setLoginMessage("ログイン期限切れ。再ログインしてください。", true);
    return;
  }

  setLoginMessage(`ログイン済み: ${session.displayName || session.userId}`, false);
}

function setLoginBusy(isBusy, message = null) {
  elements.loginButton.disabled = isBusy;
  if (message) {
    elements.loginStatus.textContent = message;
  }
}

function setLoginMessage(message, isError) {
  elements.loginStatus.textContent = message;
  elements.loginStatus.classList.toggle("error", isError);
  elements.vocabularySourceStatus.textContent = message;
}

function populateSections(allWords) {
  const sections = getSections(allWords);
  const preferredSection = params.get("section");

  elements.sectionSelect.replaceChildren(
    ...sections.map((section) => {
      const option = document.createElement("option");
      option.value = section;
      option.textContent = `Section ${section}`;
      option.selected = section === preferredSection;
      return option;
    })
  );
}

function startSession({ plannedCount, mode }) {
  progressByQuestionId = storageService.future.loadStudentProgress(studentId);
  activeSession = createSession({
    studentId,
    plannedCount,
    mode
  });
  storageService.future.saveSession(activeSession);
}

function startLearning() {
  if (!words.length || isLearningStarted) return;

  const section = elements.sectionSelect.value;
  const sectionWords = wordsForSection(words, section);
  const plan = buildStudyPlan({
    sectionWords,
    progressByQuestionId,
    legacyStats: history.getStats(new Date()),
    dailyNewTarget: DAILY_NEW_TARGET
  });

  if (plan.plannedQuestionIds.length === 0) {
    showEmpty("今日の学習対象はありません。Sectionを変更するか、復習日以降に再開してください。");
    return;
  }

  isLearningStarted = true;
  setQuizFocusMode(true);
  elements.homeState.classList.add("hidden");
  elements.statusGrid.classList.add("hidden");
  elements.quizPanel.classList.remove("hidden");
  startSession({
    plannedCount: plan.plannedQuestionIds.length,
    mode: WORD_JA_CHOICE_MODE
  });
  activeRun = {
    type: "normal",
    sessionId: activeSession.sessionId,
    remainingQuestionIds: [...plan.plannedQuestionIds]
  };
  pendingRetryQuestionIds = [];
  showNextQuestion();
}

function showNextQuestion() {
  clearAutoAdvanceTimer();
  isAnswerLocked = false;

  if (!activeRun) {
    showEmpty("学習開始ボタンから開始してください。");
    return;
  }

  if (activeRun.remainingQuestionIds.length === 0) {
    showCompletion();
    return;
  }

  const section = elements.sectionSelect.value;
  const result = buildQuestion({
    words,
    section,
    history,
    progressByQuestionId,
    candidateQuestionIds: activeRun.remainingQuestionIds,
    lastQuestionId
  });
  refreshStatus();

  if (!result.question) {
    const message = result.nextAvailableAt
      ? `直近で間違えた問題は ${formatTime(result.nextAvailableAt)} 以降に再出題されます。`
      : "このSectionには出題対象がありません。";
    showEmpty(message);
    return;
  }

  currentQuestion = result.question;
  questionStartedAt = new Date();
  renderQuestion(currentQuestion);
}

function renderQuestion(question) {
  if (document.activeElement?.classList?.contains("choice-button")) {
    document.activeElement.blur();
  }

  setIncorrectTapAdvanceEnabled(false);
  elements.loadingState.classList.add("hidden");
  elements.emptyState.classList.add("hidden");
  elements.completeState.classList.add("hidden");
  elements.quizState.classList.remove("hidden");
  elements.nextButton.disabled = true;
  elements.nextButton.textContent = "自動で次へ";
  elements.feedback.className = "feedback";
  elements.feedback.textContent = "";

  elements.questionSection.textContent = `Section ${question.target.section}`;
  elements.questionProgress.textContent = questionProgressText();
  elements.questionPos.textContent = question.target.pos;
  elements.questionStars.textContent = formatStars(
    getProgressForQuestion(progressByQuestionId, question.target.questionId)?.starRating ?? 0
  );
  elements.questionWord.textContent = question.target.word;

  elements.choiceList.replaceChildren(
    ...question.choices.map((choice) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "choice-button";
      button.disabled = false;
      button.setAttribute("aria-pressed", "false");
      button.textContent = choice;
      button.addEventListener("click", () => answer(choice));
      return button;
    })
  );
}

async function answer(selectedChoice) {
  if (!currentQuestion || isAnswerLocked) return;
  isAnswerLocked = true;

  const answeredAt = new Date();
  const answerTimeSec = Math.max(1, Math.round((answeredAt - questionStartedAt) / 1000));
  const isCorrect = selectedChoice === currentQuestion.correctChoice;
  const questionId = currentQuestion.target.questionId;
  const previousProgress = getProgressForQuestion(progressByQuestionId, questionId);
  const previousStarRating = Number(previousProgress?.starRating ?? 0);
  const isRetryLastCorrect = activeRun?.type === "retry" &&
    isCorrect &&
    activeRun.remainingQuestionIds.length === 1 &&
    activeRun.remainingQuestionIds[0] === questionId;
  const record = {
    studentId,
    questionId,
    section: currentQuestion.target.section,
    word: currentQuestion.target.word,
    correctMeaning: currentQuestion.target.japanese,
    selectedChoice,
    isCorrect,
    answerTimeSec,
    answeredAt: answeredAt.toISOString()
  };
  const attempt = createAttempt({
    studentId,
    sessionId: activeSession.sessionId,
    question: currentQuestion,
    selectedChoice,
    questionStartedAt,
    answeredAt,
    mode: activeSession.mode
  });

  history.add(record);
  storageService.future.saveAttempt(attempt);
  activeSession = updateSessionWithAttempt(activeSession, attempt);
  storageService.future.saveSession(activeSession);
  progressByQuestionId = updateProgressWithAttempt(progressByQuestionId, attempt);
  storageService.future.saveStudentProgress(studentId, progressByQuestionId);
  const updatedProgress = getProgressForQuestion(progressByQuestionId, questionId);
  const updatedStarRating = Number(updatedProgress?.starRating ?? 0);
  elements.questionStars.textContent = formatStars(
    updatedStarRating
  );
  updateActiveRunWithAttempt(attempt);
  lastQuestionId = currentQuestion.target.questionId;
  markAnswered(selectedChoice, {
    isCorrect,
    showSparkle: isCorrect && (isRetryLastCorrect || updatedStarRating > previousStarRating)
  });
  refreshStatus();
  scheduleAutoAdvance(isCorrect);
  flushAfterAnswer(record).finally(refreshStatus);
}

function markAnswered(selectedChoice, feedbackEffect) {
  const { isCorrect, showSparkle } = feedbackEffect;

  for (const button of elements.choiceList.querySelectorAll("button")) {
    button.disabled = true;
    if (button.textContent === currentQuestion.correctChoice) {
      button.classList.add("correct");
    } else if (button.textContent === selectedChoice) {
      button.classList.add("incorrect");
    }
  }

  elements.feedback.classList.add(isCorrect ? "correct" : "incorrect");
  elements.feedback.replaceChildren(
    ...buildFeedbackNodes({ isCorrect, showSparkle })
  );
  elements.nextButton.textContent = activeRun?.remainingQuestionIds.length ? "自動で次へ" : "結果へ進みます";
  elements.nextButton.disabled = true;
}

function buildFeedbackNodes({ isCorrect, showSparkle }) {
  const message = document.createElement("span");
  message.className = "feedback-message";

  const resultText = document.createElement("span");
  resultText.textContent = isCorrect ? "正解" : `不正解。正解: ${currentQuestion.correctChoice}`;
  message.append(resultText);

  if (!isCorrect) {
    const skipPrompt = document.createElement("span");
    skipPrompt.className = "feedback-skip";
    skipPrompt.textContent = "タップして次へ ▶";
    message.append(skipPrompt);
  }

  const effect = document.createElement("span");
  effect.className = "feedback-effect";

  if (isCorrect) {
    effect.append(createFeedbackIcon("⚔️", "sword-effect"));
    if (showSparkle) {
      effect.append(createFeedbackIcon("✨", "sparkle-effect"));
    }
  } else {
    effect.append(createFeedbackIcon("👻", "ghost-effect"));
  }

  return [message, effect];
}

function createFeedbackIcon(text, className) {
  const icon = document.createElement("span");
  icon.className = className;
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = text;
  return icon;
}

function scheduleAutoAdvance(isCorrect) {
  clearAutoAdvanceTimer();
  setIncorrectTapAdvanceEnabled(!isCorrect);
  const delayMs = isCorrect ? CORRECT_FEEDBACK_DELAY_MS : INCORRECT_FEEDBACK_DELAY_MS;
  autoAdvanceTimerId = window.setTimeout(() => {
    autoAdvanceTimerId = null;
    setIncorrectTapAdvanceEnabled(false);
    showNextQuestion();
  }, delayMs);
}

function clearAutoAdvanceTimer() {
  if (autoAdvanceTimerId) {
    window.clearTimeout(autoAdvanceTimerId);
    autoAdvanceTimerId = null;
  }
  setIncorrectTapAdvanceEnabled(false);
}

function handleQuizPanelTap(event) {
  if (!isIncorrectTapAdvanceEnabled) return;
  if (event.target.closest("button, input, select")) return;

  clearAutoAdvanceTimer();
  showNextQuestion();
}

function setIncorrectTapAdvanceEnabled(isEnabled) {
  isIncorrectTapAdvanceEnabled = isEnabled;
  elements.quizPanel.classList.toggle("tap-advance-enabled", isEnabled);
}

function updateActiveRunWithAttempt(attempt) {
  if (!activeRun) return;

  if (activeRun.type === "retry" && !attempt.isCorrect) {
    return;
  }

  activeRun = {
    ...activeRun,
    remainingQuestionIds: removeQuestionId(activeRun.remainingQuestionIds, attempt.questionId)
  };
}

function startRetryLearning() {
  if (!pendingRetryQuestionIds.length) return;

  startSession({
    plannedCount: pendingRetryQuestionIds.length,
    mode: WORD_JA_CHOICE_RETRY_MODE
  });
  activeRun = {
    type: "retry",
    sessionId: activeSession.sessionId,
    remainingQuestionIds: [...pendingRetryQuestionIds]
  };
  pendingRetryQuestionIds = [];
  isLearningStarted = true;
  lastQuestionId = null;
  setQuizFocusMode(true);
  elements.homeState.classList.add("hidden");
  elements.statusGrid.classList.add("hidden");
  elements.quizPanel.classList.remove("hidden");
  showNextQuestion();
}

function showCompletion() {
  const attempts = storageService.future.loadAttempts(studentId);
  const sessionAttempts = attempts.filter((attempt) => attempt.sessionId === activeRun.sessionId);
  const wrongQuestionIds = activeRun.type === "normal"
    ? getWrongQuestionIdsForSession(attempts, activeRun.sessionId)
    : [...activeRun.remainingQuestionIds];
  const correctCount = sessionAttempts.filter((attempt) => attempt.isCorrect).length;

  pendingRetryQuestionIds = activeRun.type === "normal" ? wrongQuestionIds : [];
  currentQuestion = null;
  questionStartedAt = null;

  elements.loadingState.classList.add("hidden");
  elements.quizState.classList.add("hidden");
  elements.emptyState.classList.add("hidden");
  elements.completeState.classList.remove("hidden");
  elements.completeLabel.textContent = activeRun.type === "retry" ? "Retry Complete" : "Session Complete";
  elements.completeTitle.textContent = activeRun.type === "retry" ? "誤答再挑戦が完了しました" : "今日の学習が完了しました";
  elements.completeAnsweredCount.textContent = `${sessionAttempts.length}`;
  elements.completeCorrectCount.textContent = `${correctCount}`;
  elements.completeWrongCount.textContent = `${wrongQuestionIds.length}`;
  elements.completeMessage.textContent = wrongQuestionIds.length
    ? "間違えた問題だけをもう一度解けます。"
    : "未修了の誤答はありません。";
  elements.retryWrongButton.classList.toggle("hidden", activeRun.type !== "normal" || wrongQuestionIds.length === 0);
  refreshStatus();
}

function resetToHome() {
  clearAutoAdvanceTimer();
  isLearningStarted = false;
  setQuizFocusMode(false);
  activeSession = null;
  activeRun = null;
  pendingRetryQuestionIds = [];
  currentQuestion = null;
  questionStartedAt = null;
  lastQuestionId = null;
  isAnswerLocked = false;
  progressByQuestionId = storageService.future.loadStudentProgress(studentId);
  elements.homeState.classList.remove("hidden");
  elements.statusGrid.classList.add("hidden");
  elements.quizPanel.classList.add("hidden");
  elements.loadingState.classList.add("hidden");
  elements.quizState.classList.add("hidden");
  elements.emptyState.classList.add("hidden");
  elements.completeState.classList.add("hidden");
  refreshHome();
  refreshStatus();
}

function setQuizFocusMode(isFocused) {
  document.body.classList.toggle("quiz-focus-mode", isFocused);
}

function questionProgressText() {
  const plannedCount = Number(activeSession?.plannedCount ?? 0);
  if (!plannedCount) return "0/0";

  const currentNumber = Math.min(
    plannedCount,
    Number(activeSession?.answeredCount ?? 0) + 1
  );

  return `${currentNumber}/${plannedCount}`;
}

function refreshStatus() {
  if (!words.length || !history || !submission) return;

  const section = elements.sectionSelect.value;
  const sectionWords = wordsForSection(words, section);
  const questionIds = sectionWords.map((word) => word.questionId);
  const now = new Date();
  const legacyStats = history.getStats(now);
  const todayCounts = summarizeTodayLearning({
    attempts: storageService.future.loadAttempts(studentId),
    legacyRecords: history.records,
    now
  });
  const sectionProgress = calculateSectionProgress(sectionWords, progressByQuestionId, legacyStats);

  elements.sectionCount.textContent = `${sectionWords.length}`;
  elements.unresolvedCount.textContent = `${history.countTodayUnresolved(questionIds)}`;
  elements.reviewCount.textContent = `${countDueReviews(sectionWords, progressByQuestionId, legacyStats, now)}`;
  elements.todayNewCount.textContent = `${todayCounts.newCount}`;
  elements.todayReviewCount.textContent = `${todayCounts.reviewCount}`;
  elements.sectionProgress.textContent = sectionProgress.text;
  const pendingCount = submission.getPending().length + newModelSync.getPendingCount();
  elements.pendingCount.textContent = `${pendingCount}`;
  elements.homePendingCount.textContent = `${pendingCount}`;
  elements.runModeLabel.textContent = runModeLabel(activeRun);
  elements.retryRemainingCount.textContent = activeRun?.type === "retry"
    ? `${activeRun.remainingQuestionIds.length}`
    : "0";
}

function refreshHome() {
  if (!words.length || !history) return;

  const section = elements.sectionSelect.value;
  const sectionWords = wordsForSection(words, section);
  const now = new Date();
  const summary = buildHomeSummary({
    studentId,
    displayNames: STUDENT_DISPLAY_NAMES,
    examDate: EXAM_DATE,
    dailyNewTarget: DAILY_NEW_TARGET,
    sectionWords,
    progressByQuestionId,
    legacyStats: history.getStats(now),
    attempts: storageService.future.loadAttempts(studentId),
    legacyRecords: history.records,
    now
  });

  elements.homeDisplayName.textContent = summary.studentDisplayName;
  elements.homeStudentId.textContent = summary.studentId;
  elements.examDaysLeft.textContent = `${summary.daysUntilExam}`;
  elements.homeAnsweredCount.textContent = `${summary.today.answeredCount}`;
  elements.homeCorrectCount.textContent = `${summary.today.correctCount}`;
  elements.homeIncorrectCount.textContent = `${summary.today.incorrectCount}`;
  elements.homeAccuracy.textContent = `${summary.today.accuracyPercent}%`;
  elements.homeActualNewCount.textContent = `${summary.today.newCount}`;
  elements.homeActualReviewCount.textContent = `${summary.today.reviewCount}`;
  elements.homeNewCount.textContent = `${summary.planned.newCount}`;
  elements.homeReviewCount.textContent = `${summary.planned.reviewCount}`;
  elements.homeTotalCount.textContent = `${summary.planned.totalCount}`;
  elements.yesterdayAnsweredCount.textContent = `${summary.yesterday.answeredCount}`;
  elements.yesterdayAccuracy.textContent = `${summary.yesterday.accuracyPercent}%`;
  elements.yesterdayStudyTime.textContent = summary.yesterday.studyTimeText;
  elements.homeSectionProgress.textContent = summary.sectionProgress.text;
}

async function tryFlush() {
  await flushBoth();
  refreshStatus();
}

async function flushAfterAnswer(record) {
  await Promise.all([
    submission.enqueue(record).catch(() => null),
    newModelSync.flush().catch(() => null)
  ]);
}

async function flushBoth() {
  await Promise.all([
    submission.flush().catch(() => null),
    newModelSync.flush().catch(() => null)
  ]);
}

function showEmpty(message) {
  clearAutoAdvanceTimer();
  isAnswerLocked = false;
  elements.homeState.classList.add("hidden");
  elements.quizPanel.classList.remove("hidden");
  elements.loadingState.classList.add("hidden");
  elements.quizState.classList.add("hidden");
  elements.completeState.classList.add("hidden");
  elements.emptyState.classList.remove("hidden");
  elements.emptyMessage.textContent = message;
  refreshStatus();
}

function runModeLabel(run) {
  if (!run) return "-";
  return run.type === "retry" ? "誤答再挑戦" : "通常学習";
}

function formatTime(date) {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
