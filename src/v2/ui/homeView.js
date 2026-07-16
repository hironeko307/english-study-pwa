import { HOME_MODES } from "../services/homeService.js";

const SUPPORTED_MODES = new Set(Object.values(HOME_MODES));

export function createHomeView({ root, onStart = () => undefined, onResume = () => undefined }) {
  assertRoot(root);
  assertHandler(onStart, "onStart");
  assertHandler(onResume, "onResume");

  const document = root.ownerDocument;
  const card = element(document, "section", "home-v2-card");
  card.setAttribute("aria-label", "今日の学習");

  const headingGroup = element(document, "div", "home-v2-heading");
  const eyebrow = element(document, "p", "home-v2-eyebrow", "Vocabulary Grid 2500");
  const title = element(document, "h1", "home-v2-title", "今日の学習");
  headingGroup.append(eyebrow, title);

  const metrics = element(document, "dl", "home-v2-metrics");
  const rows = Object.freeze({
    dueReviewCount: metricRow(document, "今日の復習語数", "dueReviewCount"),
    newCount: metricRow(document, "今日の新規語数", "newCount"),
    normalQuestionCount: metricRow(document, "今日の通常問題合計", "normalQuestionCount"),
    progress: metricRow(document, "今日の進捗", "progress"),
    completedCount: metricRow(document, "回答済み数", "completedCount"),
    remainingCount: metricRow(document, "残り通常問題数", "remainingCount"),
    retryRemainingCount: metricRow(document, "即時再出題残数", "retryRemainingCount")
  });
  metrics.append(...Object.values(rows).map(({ row }) => row));

  const message = element(document, "p", "home-v2-message");
  message.dataset.homeField = "message";
  message.setAttribute("role", "status");
  const spacer = element(document, "div", "home-v2-spacer");
  const cta = element(document, "button", "home-v2-cta");
  cta.type = "button";
  cta.dataset.homeField = "cta";
  cta.setAttribute("aria-busy", "false");
  card.append(headingGroup, metrics, message, spacer, cta);
  root.classList.add("home-v2-host");
  root.replaceChildren(card);

  let currentModel = null;
  let pending = false;

  cta.addEventListener("click", handleCtaClick);

  function render(model) {
    assertModel(model);
    currentModel = model;
    pending = false;

    const isNew = model.mode === HOME_MODES.newStart;
    const isResume = model.mode === HOME_MODES.resume;
    setRow(rows.dueReviewCount, isNew, model.dueReviewCount);
    setRow(rows.newCount, isNew, model.newCount);
    setRow(rows.normalQuestionCount, isNew, model.normalQuestionCount);
    setRow(
      rows.progress,
      isResume,
      isResume ? `${model.completedCount} / ${model.normalQuestionCount}` : null
    );
    setRow(rows.completedCount, isResume, model.completedCount);
    setRow(rows.remainingCount, isResume, model.remainingCount);
    setRow(
      rows.retryRemainingCount,
      isResume && model.retryRemainingCount !== null,
      model.retryRemainingCount
    );

    message.hidden = model.message === null;
    message.textContent = model.message ?? "";
    updateCta();
    root.dataset.homeMode = model.mode;
  }

  function setCtaPending(value) {
    pending = Boolean(value);
    updateCta();
  }

  function updateCta() {
    const actionable = Boolean(currentModel?.canStart || currentModel?.canResume);
    const visible = typeof currentModel?.ctaLabel === "string";
    cta.hidden = !visible;
    cta.disabled = !actionable || pending;
    cta.textContent = pending ? "準備中…" : currentModel?.ctaLabel ?? "";
    cta.setAttribute("aria-busy", String(pending));
  }

  async function handleCtaClick() {
    if (pending || cta.disabled || currentModel === null) return;
    const handler = currentModel.canResume ? onResume : onStart;
    setCtaPending(true);
    try {
      await handler(currentModel);
    } catch (error) {
      setCtaPending(false);
      const EventConstructor = document.defaultView?.CustomEvent;
      if (EventConstructor) {
        root.dispatchEvent(new EventConstructor("homeactionerror", { detail: error }));
      }
    }
  }

  function destroy() {
    cta.removeEventListener("click", handleCtaClick);
    root.replaceChildren();
    root.classList.remove("home-v2-host");
    delete root.dataset.homeMode;
  }

  return Object.freeze({ render, setCtaPending, destroy });
}

function metricRow(document, label, field) {
  const row = element(document, "div", "home-v2-metric");
  row.dataset.homeRow = field;
  const term = element(document, "dt", "home-v2-metric-label", label);
  const value = element(document, "dd", "home-v2-metric-value");
  value.dataset.homeField = field;
  row.append(term, value);
  return Object.freeze({ row, value });
}

function setRow(entry, visible, value) {
  entry.row.hidden = !visible;
  entry.value.textContent = visible ? String(value) : "";
}

function element(document, tagName, className, text = null) {
  const node = document.createElement(tagName);
  node.className = className;
  if (text !== null) node.textContent = text;
  return node;
}

function assertRoot(root) {
  if (!root?.ownerDocument || typeof root.replaceChildren !== "function") {
    throw new TypeError("root must be a DOM Element.");
  }
}

function assertHandler(handler, fieldName) {
  if (typeof handler !== "function") throw new TypeError(`${fieldName} must be a function.`);
}

function assertModel(model) {
  if (!model || !SUPPORTED_MODES.has(model.mode)) {
    throw new TypeError("A supported Home view model is required.");
  }
}
