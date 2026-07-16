const SPEECH_OPTIONS = Object.freeze({
  lang: "en-US",
  rate: 0.85,
  pitch: 1,
  volume: 1
});

export function createVersion2SpeechController({ speechService } = {}) {
  if (!speechService || typeof speechService.speak !== "function"
    || typeof speechService.cancel !== "function") {
    throw new TypeError("A speechService with speak() and cancel() is required.");
  }

  const autoPlayedKeys = new Set();

  function startStudyEntry() {
    autoPlayedKeys.clear();
  }

  function autoPlayQuestion(presentation) {
    const presentationKey = createPresentationKey(presentation);
    if (presentationKey === null || autoPlayedKeys.has(presentationKey)) return false;
    autoPlayedKeys.add(presentationKey);

    speakFailOpen(presentation.text);
    return true;
  }

  function replay(text) {
    cancel();
    speakFailOpen(text);
  }

  function cancel() {
    runFailOpen(() => speechService.cancel());
  }

  function speakFailOpen(text) {
    runFailOpen(() => speechService.speak({
      text,
      ...SPEECH_OPTIONS,
      selectVoice: selectEnUsVoice
    }));
  }

  return Object.freeze({ startStudyEntry, autoPlayQuestion, replay, cancel });
}

function createPresentationKey({
  sessionId,
  currentPhase,
  retryRound,
  currentIndex,
  wordId
} = {}) {
  if (
    typeof sessionId !== "string"
    || sessionId.length === 0
    || (currentPhase !== "normal" && currentPhase !== "immediateRetry")
    || !Number.isSafeInteger(retryRound)
    || retryRound < 0
    || !Number.isSafeInteger(currentIndex)
    || currentIndex < 0
    || !Number.isSafeInteger(wordId)
  ) {
    return null;
  }
  return JSON.stringify([sessionId, currentPhase, retryRound, currentIndex, wordId]);
}

function selectEnUsVoice(voices) {
  return voices.find((voice) => voice?.lang?.toLowerCase() === "en-us");
}

function runFailOpen(operation) {
  try {
    const result = operation();
    if (result && typeof result.then === "function") {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Speech is optional and must never interrupt study behavior.
  }
}
