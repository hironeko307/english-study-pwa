export const SPEECH_RESULT_REASONS = Object.freeze({
  ended: "ENDED",
  cancelled: "CANCELLED",
  unsupported: "UNSUPPORTED",
  emptyText: "EMPTY_TEXT",
  constructorFailed: "CONSTRUCTOR_FAILED",
  configurationFailed: "CONFIGURATION_FAILED",
  speakFailed: "SPEAK_FAILED",
  utteranceError: "UTTERANCE_ERROR",
  utteranceTimeout: "UTTERANCE_TIMEOUT",
  cancelFailed: "CANCEL_FAILED"
});

const UTTERANCE_RESULT_TIMEOUT_MS = 30000;

export function createSpeechService({
  getSpeechSynthesis = defaultGetSpeechSynthesis,
  getUtteranceConstructor = defaultGetUtteranceConstructor
} = {}) {
  const synthesisProvider = typeof getSpeechSynthesis === "function"
    ? getSpeechSynthesis
    : () => undefined;
  const constructorProvider = typeof getUtteranceConstructor === "function"
    ? getUtteranceConstructor
    : () => undefined;
  let activeSpeech = null;

  function isSupported() {
    return resolveDependencies() !== null;
  }

  function speak({
    text,
    lang,
    rate,
    pitch,
    volume,
    selectVoice = null
  } = {}) {
    if (typeof text !== "string" || text.trim().length === 0) {
      return resolvedResult(false, SPEECH_RESULT_REASONS.emptyText);
    }
    const dependencies = resolveDependencies();
    if (dependencies === null) {
      cancelActiveSpeech();
      return resolvedResult(false, SPEECH_RESULT_REASONS.unsupported);
    }

    const cancelResult = cancelBeforeSpeech(dependencies.synthesis);
    if (!cancelResult.ok) return Promise.resolve(cancelResult);

    let utterance;
    try {
      utterance = new dependencies.UtteranceConstructor(text);
    } catch {
      return resolvedResult(false, SPEECH_RESULT_REASONS.constructorFailed);
    }

    try {
      utterance.text = text;
      if (lang !== undefined) utterance.lang = lang;
      if (rate !== undefined) utterance.rate = rate;
      if (pitch !== undefined) utterance.pitch = pitch;
      if (volume !== undefined) utterance.volume = volume;
      applySelectedVoice(utterance, dependencies.synthesis, selectVoice);
    } catch {
      return resolvedResult(false, SPEECH_RESULT_REASONS.configurationFailed);
    }

    let settle;
    const resultPromise = new Promise((resolve) => {
      settle = resolve;
    });
    const speechRecord = {
      synthesis: dependencies.synthesis,
      utterance,
      settle,
      timeoutId: null
    };
    activeSpeech = speechRecord;
    try {
      utterance.onend = () => settleSpeech(utterance, true, SPEECH_RESULT_REASONS.ended);
      utterance.onerror = () => settleSpeech(
        utterance,
        false,
        SPEECH_RESULT_REASONS.utteranceError
      );
    } catch {
      settleSpeech(utterance, false, SPEECH_RESULT_REASONS.configurationFailed);
      return resultPromise;
    }

    try {
      speechRecord.timeoutId = globalThis.setTimeout(
        () => timeoutSpeech(speechRecord),
        UTTERANCE_RESULT_TIMEOUT_MS
      );
      if (activeSpeech !== speechRecord) return resultPromise;
      dependencies.synthesis.speak(utterance);
    } catch {
      settleSpeech(utterance, false, SPEECH_RESULT_REASONS.speakFailed);
    }
    return resultPromise;
  }

  function cancel() {
    if (activeSpeech !== null) {
      const activeSynthesis = activeSpeech.synthesis;
      settleActiveSpeech(false, SPEECH_RESULT_REASONS.cancelled);
      return cancelSynthesis(activeSynthesis);
    }
    const dependencies = resolveDependencies();
    if (dependencies === null) return freezeResult(false, SPEECH_RESULT_REASONS.unsupported);
    return cancelSynthesis(dependencies.synthesis);
  }

  function resolveDependencies() {
    try {
      const synthesis = synthesisProvider();
      const UtteranceConstructor = constructorProvider();
      if (
        synthesis === null
        || typeof synthesis !== "object"
        || typeof synthesis.speak !== "function"
        || typeof synthesis.cancel !== "function"
        || typeof UtteranceConstructor !== "function"
      ) {
        return null;
      }
      return { synthesis, UtteranceConstructor };
    } catch {
      return null;
    }
  }

  function cancelBeforeSpeech(nextSynthesis) {
    if (activeSpeech === null) return cancelSynthesis(nextSynthesis);

    const activeSynthesis = activeSpeech.synthesis;
    settleActiveSpeech(false, SPEECH_RESULT_REASONS.cancelled);
    const activeCancelResult = cancelSynthesis(activeSynthesis);
    if (!activeCancelResult.ok || activeSynthesis === nextSynthesis) return activeCancelResult;
    return cancelSynthesis(nextSynthesis);
  }

  function cancelActiveSpeech() {
    if (activeSpeech === null) return;
    const activeSynthesis = activeSpeech.synthesis;
    settleActiveSpeech(false, SPEECH_RESULT_REASONS.cancelled);
    try {
      activeSynthesis.cancel();
    } catch {
      // Losing API availability must not leave an active speech Promise unresolved.
    }
  }

  function cancelSynthesis(synthesis) {
    try {
      synthesis.cancel();
      return freezeResult(true, SPEECH_RESULT_REASONS.cancelled);
    } catch {
      return freezeResult(false, SPEECH_RESULT_REASONS.cancelFailed);
    }
  }

  function settleSpeech(utterance, ok, reason) {
    if (activeSpeech?.utterance !== utterance) return;
    settleActiveSpeech(ok, reason);
  }

  function settleActiveSpeech(ok, reason) {
    if (activeSpeech === null) return;
    const speechRecord = activeSpeech;
    activeSpeech = null;
    clearSpeechTimeout(speechRecord);
    speechRecord.settle(freezeResult(ok, reason));
  }

  function timeoutSpeech(speechRecord) {
    if (activeSpeech !== speechRecord) return;
    activeSpeech = null;
    clearSpeechTimeout(speechRecord);
    try {
      speechRecord.synthesis.cancel();
    } catch {
      // The timeout result remains fail-open even when cleanup also fails.
    }
    speechRecord.settle(freezeResult(false, SPEECH_RESULT_REASONS.utteranceTimeout));
  }

  function clearSpeechTimeout(speechRecord) {
    if (speechRecord.timeoutId === null) return;
    try {
      globalThis.clearTimeout(speechRecord.timeoutId);
    } catch {
      // Result settlement must not depend on timer cleanup support.
    }
    speechRecord.timeoutId = null;
  }

  return Object.freeze({ isSupported, speak, cancel });
}

function applySelectedVoice(utterance, synthesis, selectVoice) {
  if (typeof selectVoice !== "function" || typeof synthesis.getVoices !== "function") return;
  let voices;
  try {
    voices = synthesis.getVoices();
  } catch {
    return;
  }
  if (!Array.isArray(voices) || voices.length === 0) return;

  let selectedVoice;
  try {
    selectedVoice = selectVoice(Object.freeze([...voices]));
  } catch {
    return;
  }
  if (voices.includes(selectedVoice)) utterance.voice = selectedVoice;
}

function defaultGetSpeechSynthesis() {
  return globalThis.speechSynthesis;
}

function defaultGetUtteranceConstructor() {
  return globalThis.SpeechSynthesisUtterance;
}

function resolvedResult(ok, reason) {
  return Promise.resolve(freezeResult(ok, reason));
}

function freezeResult(ok, reason) {
  return Object.freeze({ ok, reason });
}
