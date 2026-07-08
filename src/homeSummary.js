import {
  calculateSectionProgress,
  countDueReviews,
  getProgressForQuestion,
  isStudiedProgress
} from "./learningRecords.js";

export function getStudentDisplayName(studentId, displayNames) {
  return displayNames[studentId] ?? studentId;
}

export function buildHomeSummary({
  studentId,
  displayNames,
  examDate,
  dailyNewTarget,
  sectionWords,
  progressByQuestionId,
  legacyStats,
  attempts,
  legacyRecords,
  now = new Date()
}) {
  const reviewCount = countDueReviews(sectionWords, progressByQuestionId, legacyStats, now);
  const newCount = countNewPlan(sectionWords, progressByQuestionId, legacyStats, dailyNewTarget);
  const sectionProgress = calculateSectionProgress(sectionWords, progressByQuestionId, legacyStats);
  const today = summarizeTodaySectionLearning({ attempts, legacyRecords, sectionWords, now });
  const yesterday = summarizeYesterdayLearning({ attempts, legacyRecords, sectionWords, now });

  return {
    studentDisplayName: getStudentDisplayName(studentId, displayNames),
    studentId,
    daysUntilExam: countDaysUntil(examDate, now),
    today,
    planned: {
      newCount,
      reviewCount,
      totalCount: newCount + reviewCount
    },
    yesterday,
    sectionProgress
  };
}

function countNewPlan(sectionWords, progressByQuestionId, legacyStats, dailyNewTarget) {
  const unstudiedCount = sectionWords.filter((word) => (
    !isStudiedProgress(getProgressForQuestion(progressByQuestionId, word.questionId)) &&
    !legacyStats.has(word.questionId)
  )).length;

  return Math.min(dailyNewTarget, unstudiedCount);
}

function summarizeTodaySectionLearning({ attempts = [], legacyRecords = [], sectionWords = [], now = new Date() }) {
  const todayKey = toDateKey(now);
  const records = recordsForSummary(attempts, legacyRecords);
  const questionIds = questionIdSet(sectionWords);
  const seenQuestionIds = new Set();
  let answeredCount = 0;
  let correctCount = 0;
  let newCount = 0;
  let reviewCount = 0;

  for (const record of records.filter((item) => questionIds.has(item.questionId)).sort(compareRecordsByAnsweredAt)) {
    const recordDateKey = toDateKey(new Date(record.answeredAt));
    const hasSeenQuestion = seenQuestionIds.has(record.questionId);

    if (recordDateKey === todayKey) {
      answeredCount += 1;
      correctCount += Boolean(record.isCorrect) ? 1 : 0;

      if (hasSeenQuestion) {
        reviewCount += 1;
      } else {
        newCount += 1;
      }
    }

    if (recordDateKey <= todayKey) {
      seenQuestionIds.add(record.questionId);
    }
  }

  const incorrectCount = answeredCount - correctCount;

  return {
    answeredCount,
    correctCount,
    incorrectCount,
    accuracyPercent: answeredCount ? Math.round((correctCount / answeredCount) * 100) : 0,
    newCount,
    reviewCount
  };
}

function summarizeYesterdayLearning({ attempts = [], legacyRecords = [], sectionWords = [], now = new Date() }) {
  const yesterdayKey = toDateKey(addDays(startOfLocalDay(now), -1));
  const records = recordsForSummary(attempts, legacyRecords);
  const questionIds = questionIdSet(sectionWords);
  const yesterdayRecords = records.filter((record) => (
    questionIds.has(record.questionId) &&
    toDateKey(new Date(record.answeredAt)) === yesterdayKey
  ));
  const correctCount = yesterdayRecords.filter((record) => Boolean(record.isCorrect)).length;
  const studyTimeMs = yesterdayRecords.reduce((total, record) => (
    total + elapsedMsForRecord(record)
  ), 0);

  return {
    answeredCount: yesterdayRecords.length,
    accuracyPercent: yesterdayRecords.length
      ? Math.round((correctCount / yesterdayRecords.length) * 100)
      : 0,
    studyTimeText: formatStudyTime(studyTimeMs)
  };
}

function recordsForSummary(attempts = [], legacyRecords = []) {
  return attempts.length ? attempts : legacyRecords;
}

function questionIdSet(sectionWords) {
  return new Set(sectionWords.map((word) => word.questionId));
}

function compareRecordsByAnsweredAt(a, b) {
  return new Date(a.answeredAt) - new Date(b.answeredAt);
}

function elapsedMsForRecord(record) {
  if (Number.isFinite(record.elapsedMs)) {
    return Math.max(0, record.elapsedMs);
  }

  return Math.max(0, Number(record.answerTimeSec ?? 0) * 1000);
}

function countDaysUntil(dateText, now) {
  const targetDate = parseLocalDate(dateText);
  const today = startOfLocalDay(now);
  const diffDays = Math.ceil((targetDate - today) / 86400000);
  return Math.max(0, diffDays);
}

function parseLocalDate(dateText) {
  const [year, month, day] = dateText.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatStudyTime(ms) {
  if (ms <= 0) return "0分";
  const minutes = Math.max(1, Math.round(ms / 60000));
  return `${minutes}分`;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
