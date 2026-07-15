import {
  CORRECT_FEEDBACK_DELAY_MS,
  INCORRECT_FEEDBACK_DELAY_MS
} from "./config.js";

export function getAnswerFeedbackDelayMs(isCorrect) {
  return isCorrect ? CORRECT_FEEDBACK_DELAY_MS : INCORRECT_FEEDBACK_DELAY_MS;
}

export function resetAnswerFeedback(feedbackElement) {
  feedbackElement.className = "feedback";
  feedbackElement.replaceChildren();
}

export function showAnswerFeedback({
  buttons,
  feedbackElement,
  selectedChoiceValue,
  correctChoiceValue,
  correctChoiceText,
  getChoiceValue,
  isCorrect,
  showSparkle = false,
  showIncorrectSkipPrompt = true
}) {
  for (const button of buttons) {
    const choiceValue = getChoiceValue(button);
    button.disabled = true;
    if (choiceValue === correctChoiceValue) {
      button.classList.add("correct");
    } else if (choiceValue === selectedChoiceValue) {
      button.classList.add("incorrect");
    }
  }

  resetAnswerFeedback(feedbackElement);
  feedbackElement.classList.add(isCorrect ? "correct" : "incorrect");
  feedbackElement.replaceChildren(
    ...buildFeedbackNodes({
      document: feedbackElement.ownerDocument,
      isCorrect,
      correctChoiceText,
      showSparkle,
      showIncorrectSkipPrompt
    })
  );
}

function buildFeedbackNodes({
  document,
  isCorrect,
  correctChoiceText,
  showSparkle,
  showIncorrectSkipPrompt
}) {
  const message = document.createElement("span");
  message.className = "feedback-message";

  const resultText = document.createElement("span");
  resultText.textContent = isCorrect ? "正解" : `不正解。正解: ${correctChoiceText}`;
  message.append(resultText);

  if (!isCorrect && showIncorrectSkipPrompt) {
    const skipPrompt = document.createElement("span");
    skipPrompt.className = "feedback-skip";
    skipPrompt.textContent = "タップして次へ ▶";
    message.append(skipPrompt);
  }

  const effect = document.createElement("span");
  effect.className = "feedback-effect";
  if (isCorrect) {
    effect.append(createFeedbackIcon(document, "⚔️", "sword-effect"));
    if (showSparkle) {
      effect.append(createFeedbackIcon(document, "✨", "sparkle-effect"));
    }
  } else {
    effect.append(createFeedbackIcon(document, "👻", "ghost-effect"));
  }

  return [message, effect];
}

function createFeedbackIcon(document, text, className) {
  const icon = document.createElement("span");
  icon.className = className;
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = text;
  return icon;
}
