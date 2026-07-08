import { REVIEW_INTERVAL_DAYS } from "./config.js";
import { storageService } from "./storageService.js";

export class AnswerHistory {
  constructor(studentId) {
    this.studentId = studentId;
    this.records = storageService.legacy.loadAnswerHistory(studentId);
  }

  add(record) {
    this.records.push(record);
    storageService.legacy.saveAnswerHistory(this.studentId, this.records);
  }

  getStats(now = new Date()) {
    const todayKey = toDateKey(now);
    const stats = new Map();

    for (const record of this.records) {
      const current = stats.get(record.questionId) ?? createEmptyStats();
      const answeredAt = new Date(record.answeredAt);
      current.attempts += 1;
      current.lastAnsweredAt = answeredAt;
      current.lastAnswerCorrect = Boolean(record.isCorrect);

      if (record.isCorrect) {
        current.correctCount += 1;
        current.wrongTodayUnresolved = false;
        const intervalDays = REVIEW_INTERVAL_DAYS[Math.min(current.reviewLevel, REVIEW_INTERVAL_DAYS.length - 1)];
        current.nextReviewAt = addDays(answeredAt, intervalDays);
        current.reviewLevel = Math.min(current.reviewLevel + 1, REVIEW_INTERVAL_DAYS.length - 1);
      } else {
        current.wrongCount += 1;
        current.reviewLevel = 0;
        current.nextReviewAt = null;
        current.lastWrongAt = answeredAt;
        if (toDateKey(answeredAt) === todayKey) {
          current.wrongTodayUnresolved = true;
        }
      }

      stats.set(record.questionId, current);
    }

    return stats;
  }

  countTodayUnresolved(questionIds, now = new Date()) {
    const stats = this.getStats(now);
    return questionIds.filter((questionId) => stats.get(questionId)?.wrongTodayUnresolved).length;
  }

  countDueReviews(questionIds, now = new Date()) {
    const stats = this.getStats(now);
    return questionIds.filter((questionId) => {
      const item = stats.get(questionId);
      return item?.nextReviewAt && item.nextReviewAt <= now;
    }).length;
  }
}

export function toDateKey(date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function createEmptyStats() {
  return {
    attempts: 0,
    correctCount: 0,
    wrongCount: 0,
    reviewLevel: 0,
    nextReviewAt: null,
    lastAnsweredAt: null,
    lastAnswerCorrect: null,
    lastWrongAt: null,
    wrongTodayUnresolved: false
  };
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
