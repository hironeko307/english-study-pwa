import { WRONG_RETRY_DELAY_MINUTES } from "./config.js";
import { getProgressForQuestion, isReviewDue, isStudiedProgress } from "./learningRecords.js";

const WRONG_RETRY_DELAY_MS = WRONG_RETRY_DELAY_MINUTES * 60 * 1000;

export function buildQuestion({
  words,
  section,
  history,
  progressByQuestionId = {},
  candidateQuestionIds = null,
  lastQuestionId = null,
  now = new Date()
}) {
  const candidateSet = candidateQuestionIds ? new Set(candidateQuestionIds) : null;
  const sectionWords = words.filter((word) => (
    word.section === section &&
    (!candidateSet || candidateSet.has(word.questionId))
  ));
  const stats = history.getStats(now);
  const scored = [];
  let nextAvailableAt = null;

  for (const word of sectionWords) {
    const legacyItem = stats.get(word.questionId);
    const progress = getProgressForQuestion(progressByQuestionId, word.questionId);
    const cooldownUntil = getWrongCooldownUntil(legacyItem);

    if (cooldownUntil && cooldownUntil > now) {
      nextAvailableAt = earliest(nextAvailableAt, cooldownUntil);
      continue;
    }

    let score = scoreWord({ word, progress, legacyItem, now });
    if (word.questionId === lastQuestionId && sectionWords.length > 1) {
      score -= 900;
    }

    scored.push({ word, score });
  }

  if (scored.length === 0) {
    return { question: null, nextAvailableAt };
  }

  scored.sort((a, b) => b.score - a.score);
  const target = scored[0].word;
  const choices = createChoices(target, words);

  return {
    question: {
      target,
      choices,
      correctChoice: target.japanese
    },
    nextAvailableAt
  };
}

export function createChoices(target, allWords) {
  const selected = [];
  const seenMeanings = new Set([target.japanese]);
  const addCandidates = (candidates) => {
    for (const candidate of shuffle(candidates)) {
      if (selected.length >= 3) return;
      if (candidate.questionId === target.questionId) continue;
      if (seenMeanings.has(candidate.japanese)) continue;
      seenMeanings.add(candidate.japanese);
      selected.push(candidate.japanese);
    }
  };

  addCandidates(
    allWords.filter((word) => (
      word.section === target.section &&
      word.stage === target.stage &&
      sharesPos(word, target)
    ))
  );

  addCandidates(
    allWords.filter((word) => (
      word.stage === target.stage &&
      word.section !== target.section
    ))
  );

  addCandidates(allWords);

  return shuffle([target.japanese, ...selected].slice(0, 4));
}

function scoreWord({ progress, legacyItem, now }) {
  if (legacyItem?.wrongTodayUnresolved) {
    const minutesSinceWrong = legacyItem.lastWrongAt ? (now - legacyItem.lastWrongAt) / 60000 : 0;
    return 10000 + minutesSinceWrong;
  }

  if (isReviewDue(progress, now)) {
    const overdueHours = (now - new Date(progress.nextReviewAt)) / 3600000;
    return 8500 + overdueHours;
  }

  if (!isStudiedProgress(progress)) {
    if (legacyItem?.nextReviewAt && legacyItem.nextReviewAt <= now) {
      const overdueHours = (now - legacyItem.nextReviewAt) / 3600000;
      return 8000 + overdueHours;
    }

    if (legacyItem?.lastAnswerCorrect === false) {
      return 7000 + legacyItem.wrongCount * 10;
    }

    if (legacyItem?.wrongCount > 0) {
      return 6000 + legacyItem.wrongCount * 25 - legacyItem.correctCount * 5;
    }

    return 5000 + Math.random();
  }

  return 1000 - Number(progress.attemptCount ?? 0) * 10 + Math.random();
}

function getWrongCooldownUntil(item) {
  if (!item?.wrongTodayUnresolved || !item.lastWrongAt) return null;
  return new Date(item.lastWrongAt.getTime() + WRONG_RETRY_DELAY_MS);
}

function earliest(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

function sharesPos(a, b) {
  return a.posTags.some((tag) => b.posTags.includes(tag));
}

function shuffle(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const next = Math.floor(Math.random() * (index + 1));
    [result[index], result[next]] = [result[next], result[index]];
  }
  return result;
}
