import {
  findActiveSession,
  findSessionByLearningDate
} from "../learning/sessionEngine.js";

const INVALID_SESSION_MESSAGE = "保存済みの学習状態を確認できませんでした。データを変更せず停止しています。";

export async function loadSafeHomeSessionPair({
  repository,
  studentId,
  learningDate,
  findActive = findActiveSession,
  findByLearningDate = findSessionByLearningDate
}) {
  assertDependencies({ repository, findActive, findByLearningDate });

  try {
    const activePair = await findActive(repository, studentId);
    if (activePair !== null) return freezeResult(activePair, "active");

    const currentDatePair = await findByLearningDate(
      repository,
      studentId,
      learningDate
    );
    return freezeResult(currentDatePair, currentDatePair === null ? "none" : "learningDate");
  } catch {
    return Object.freeze({
      pair: null,
      source: "invalid",
      error: INVALID_SESSION_MESSAGE
    });
  }
}

function freezeResult(pair, source) {
  return Object.freeze({
    pair: pair === null
      ? null
      : Object.freeze({ session: pair.session, queue: pair.queue }),
    source,
    error: null
  });
}

function assertDependencies({ repository, findActive, findByLearningDate }) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("repository is required.");
  }
  if (typeof findActive !== "function" || typeof findByLearningDate !== "function") {
    throw new TypeError("Session lookup functions are required.");
  }
}
