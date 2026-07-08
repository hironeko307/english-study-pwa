export const WORD_JA_CHOICE_MODE = "word-ja-choice";
export const WORD_JA_CHOICE_RETRY_MODE = "word-ja-choice-retry";

const SCHEMA_VERSION = 1;
const STAR_INTERVAL_DAYS = {
  1: 1,
  2: 3,
  3: 7,
  4: 14
};

export function createSession({ studentId, plannedCount = 0, mode = WORD_JA_CHOICE_MODE, now = new Date() }) {
  const startedAt = now.toISOString();

  return {
    sessionId: createId("session", now),
    studentId,
    startedAt,
    endedAt: null,
    mode,
    plannedCount,
    answeredCount: 0,
    correctCount: 0,
    synced: false,
    syncedAt: null,
    syncAttemptedAt: null,
    syncError: null,
    schemaVersion: SCHEMA_VERSION
  };
}

export function createAttempt({
  studentId,
  sessionId,
  question,
  selectedChoice,
  questionStartedAt,
  answeredAt,
  mode = WORD_JA_CHOICE_MODE
}) {
  const target = question.target;
  const elapsedMs = Math.max(0, answeredAt.getTime() - questionStartedAt.getTime());

  return {
    attemptId: createId("attempt", answeredAt),
    sessionId,
    studentId,
    questionId: target.questionId,
    section: target.section,
    step: String(target.stage ?? ""),
    mode,
    questionStartedAt: questionStartedAt.toISOString(),
    answeredAt: answeredAt.toISOString(),
    elapsedMs,
    isCorrect: selectedChoice === question.correctChoice,
    selectedChoice,
    correctChoice: question.correctChoice,
    choiceOrder: [...question.choices],
    choiceOrderStatus: "recorded",
    synced: false,
    syncedAt: null,
    syncAttemptedAt: null,
    syncError: null,
    schemaVersion: SCHEMA_VERSION
  };
}

export function updateSessionWithAttempt(session, attempt) {
  return {
    ...session,
    endedAt: attempt.answeredAt,
    answeredCount: session.answeredCount + 1,
    correctCount: session.correctCount + (attempt.isCorrect ? 1 : 0),
    synced: false,
    syncedAt: null,
    syncAttemptedAt: null,
    syncError: null
  };
}

export function updateProgressWithAttempt(progressByQuestionId, attempt) {
  const current = progressByQuestionId[attempt.questionId] ?? {};
  const updated = updateProgressItem(current, attempt);

  return {
    ...progressByQuestionId,
    [attempt.questionId]: updated
  };
}

export function getProgressForQuestion(progressByQuestionId, questionId) {
  return progressByQuestionId[questionId] ?? null;
}

export function formatStars(starRating = 0) {
  const filled = Math.max(0, Math.min(5, Number(starRating) || 0));
  return `${"★".repeat(filled)}${"☆".repeat(5 - filled)}`;
}

export function isStudiedProgress(progress) {
  return Number(progress?.attemptCount ?? 0) > 0;
}

export function isReviewDue(progress, now = new Date()) {
  if (!isStudiedProgress(progress) || !progress.nextReviewAt) return false;
  return new Date(progress.nextReviewAt) <= now;
}

export function calculateSectionProgress(sectionWords, progressByQuestionId, legacyStats = new Map()) {
  const total = sectionWords.length;
  const learned = sectionWords.filter((word) => (
    isStudiedProgress(getProgressForQuestion(progressByQuestionId, word.questionId)) ||
    legacyStats.has(word.questionId)
  )).length;
  const percent = total ? Math.round((learned / total) * 100) : 0;

  return {
    learned,
    total,
    percent,
    text: `${learned}/${total} ${percent}%`
  };
}

export function countDueReviews(sectionWords, progressByQuestionId, legacyStats = new Map(), now = new Date()) {
  return sectionWords.filter((word) => {
    const progress = getProgressForQuestion(progressByQuestionId, word.questionId);
    if (isStudiedProgress(progress)) {
      return isReviewDue(progress, now);
    }

    const legacyItem = legacyStats.get(word.questionId);
    return Boolean(legacyItem?.nextReviewAt && legacyItem.nextReviewAt <= now);
  }).length;
}

export function summarizeTodayAttempts(attempts, now = new Date()) {
  const todayKey = toDateKey(now);
  const seenQuestionIds = new Set();
  let newCount = 0;
  let reviewCount = 0;

  for (const attempt of [...attempts].sort(compareAttemptsByAnsweredAt)) {
    const answeredAt = new Date(attempt.answeredAt);
    const isToday = toDateKey(answeredAt) === todayKey;
    const hasSeenQuestion = seenQuestionIds.has(attempt.questionId);

    if (isToday) {
      if (hasSeenQuestion) {
        reviewCount += 1;
      } else {
        newCount += 1;
      }
    }

    seenQuestionIds.add(attempt.questionId);
  }

  return { newCount, reviewCount };
}

export function summarizeTodayLearning({ attempts = [], legacyRecords = [], now = new Date() }) {
  const records = attempts.length ? attempts : legacyRecords;
  return summarizeTodayAttempts(records, now);
}

function updateProgressItem(current, attempt) {
  const previousAttemptCount = Number(current.attemptCount ?? 0);
  const previousCorrectCount = Number(current.correctCount ?? 0);
  const previousConsecutiveCorrectCount = Number(current.consecutiveCorrectCount ?? 0);
  const previousStarRating = Number(current.starRating ?? 0);
  const previousReviewLevel = Number(current.reviewLevel ?? 0);
  const answeredAt = new Date(attempt.answeredAt);

  const attemptCount = previousAttemptCount + 1;
  const correctCount = previousCorrectCount + (attempt.isCorrect ? 1 : 0);
  const consecutiveCorrectCount = attempt.isCorrect ? previousConsecutiveCorrectCount + 1 : 0;
  const reviewState = nextReviewState({
    isCorrect: attempt.isCorrect,
    previousStarRating,
    previousReviewLevel,
    answeredAt
  });

  return {
    studentId: attempt.studentId,
    questionId: attempt.questionId,
    section: attempt.section,
    step: attempt.step,
    attemptCount,
    correctCount,
    consecutiveCorrectCount,
    starRating: reviewState.starRating,
    firstStudiedAt: current.firstStudiedAt ?? attempt.questionStartedAt,
    lastStudiedAt: attempt.answeredAt,
    nextReviewAt: reviewState.nextReviewAt,
    mastered: current.mastered ?? false,
    reviewLevel: reviewState.reviewLevel,
    favorite: current.favorite ?? false,
    memo: current.memo ?? "",
    studyTimeMs: Number(current.studyTimeMs ?? 0) + attempt.elapsedMs,
    synced: false,
    syncedAt: null,
    syncAttemptedAt: null,
    syncError: null,
    schemaVersion: SCHEMA_VERSION
  };
}

function nextReviewState({ isCorrect, previousStarRating, previousReviewLevel, answeredAt }) {
  if (!isCorrect) {
    return {
      starRating: 1,
      reviewLevel: 1,
      nextReviewAt: null
    };
  }

  const starRating = Math.min(previousStarRating + 1, 5);
  const reviewLevel = nextReviewLevel({ starRating, previousStarRating, previousReviewLevel });
  const intervalDays = reviewIntervalDays(starRating, reviewLevel);

  return {
    starRating,
    reviewLevel,
    nextReviewAt: addDays(answeredAt, intervalDays).toISOString()
  };
}

function nextReviewLevel({ starRating, previousStarRating, previousReviewLevel }) {
  if (starRating < 5) {
    return starRating;
  }

  if (previousStarRating < 5) {
    return 5;
  }

  return Math.max(previousReviewLevel + 1, 6);
}

function reviewIntervalDays(starRating, reviewLevel) {
  if (starRating < 5) {
    return STAR_INTERVAL_DAYS[starRating] ?? 1;
  }

  if (reviewLevel === 5) return 30;
  if (reviewLevel === 6) return 40;
  return 50;
}

function createId(prefix, date) {
  const timestamp = date.toISOString().replace(/[-:.]/g, "").replace("Z", "");
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${timestamp}_${random}`;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function compareAttemptsByAnsweredAt(a, b) {
  return new Date(a.answeredAt) - new Date(b.answeredAt);
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
