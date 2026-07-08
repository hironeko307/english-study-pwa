import {
  getProgressForQuestion,
  isReviewDue,
  isStudiedProgress
} from "./learningRecords.js";

export function buildStudyPlan({
  sectionWords,
  progressByQuestionId,
  legacyStats,
  dailyNewTarget,
  now = new Date()
}) {
  const reviewQuestionIds = sectionWords
    .filter((word) => isReviewTarget(word, progressByQuestionId, legacyStats, now))
    .map((word) => word.questionId);
  const reviewSet = new Set(reviewQuestionIds);
  const newQuestionIds = sectionWords
    .filter((word) => (
      !reviewSet.has(word.questionId) &&
      !isStudiedProgress(getProgressForQuestion(progressByQuestionId, word.questionId)) &&
      !legacyStats.has(word.questionId)
    ))
    .slice(0, dailyNewTarget)
    .map((word) => word.questionId);

  return {
    reviewQuestionIds,
    newQuestionIds,
    plannedQuestionIds: [...reviewQuestionIds, ...newQuestionIds]
  };
}

export function getWrongQuestionIdsForSession(attempts, sessionId) {
  const wrongQuestionIds = new Set();

  for (const attempt of attempts) {
    if (attempt.sessionId === sessionId && attempt.isCorrect === false) {
      wrongQuestionIds.add(attempt.questionId);
    }
  }

  return [...wrongQuestionIds];
}

export function removeQuestionId(questionIds, questionId) {
  return questionIds.filter((item) => item !== questionId);
}

function isReviewTarget(word, progressByQuestionId, legacyStats, now) {
  const progress = getProgressForQuestion(progressByQuestionId, word.questionId);

  if (isStudiedProgress(progress)) {
    return isReviewDue(progress, now);
  }

  const legacyItem = legacyStats.get(word.questionId);
  return Boolean(legacyItem?.nextReviewAt && legacyItem.nextReviewAt <= now);
}
