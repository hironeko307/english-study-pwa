import { VERSION2_POLICY_VERSION } from "../learning/policy.js";

export const ANSWER_EVENT_SCHEMA_VERSION = 2;

export function createCanonicalAnswerEvent({
  studentId,
  sessionId,
  sessionAnswerSequence,
  question,
  choiceIds,
  selectedChoiceId,
  stateBefore,
  stateAfter,
  learningDate,
  answeredAt,
  answerTimeMs,
  presentationType = "new",
  retryRound = 0,
  retryAttemptNumber = 0,
  randomUuid = () => crypto.randomUUID()
}) {
  const eventId = String(randomUuid()).toLowerCase();
  const correctChoiceId = question.wordId;
  return Object.freeze({
    eventId,
    studentId,
    sessionId,
    sessionAnswerSequence,
    wordId: question.wordId,
    contentVersion: question.contentVersion,
    policyVersion: VERSION2_POLICY_VERSION,
    schemaVersion: ANSWER_EVENT_SCHEMA_VERSION,
    learningDate,
    answeredAt,
    answerTimeMs,
    presentationType,
    questionType: "word-ja-choice",
    choiceIds: Object.freeze(choiceIds.slice()),
    selectedChoiceId,
    correctChoiceId,
    isCorrect: selectedChoiceId === correctChoiceId,
    retryRound,
    retryAttemptNumber,
    stateRevisionBefore: stateBefore.stateRevision,
    stateRevisionAfter: stateAfter.stateRevision,
    starBefore: stateBefore.star,
    starAfter: stateAfter.star,
    ghostBefore: stateBefore.ghost,
    ghostAfter: stateAfter.ghost,
    consecutiveCorrectBefore: stateBefore.consecutiveCorrect,
    consecutiveCorrectAfter: stateAfter.consecutiveCorrect,
    nextReviewDateBefore: stateBefore.nextReviewDate,
    nextReviewDateAfter: stateAfter.nextReviewDate,
    createdAt: answeredAt
  });
}
