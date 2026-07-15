export const VERSION2_POLICY_VERSION = "2.1.0";

export const DEFAULT_NEW_PER_DAY = 50;
export const DAILY_NORMAL_QUESTION_CAP = 250;

export const PRESENTATION_TYPES = Object.freeze({
  new: "new",
  review: "review",
  immediateRetry: "immediateRetry"
});

export const SESSION_STATUSES = Object.freeze({
  active: "active",
  completed: "completed",
  abandoned: "abandoned"
});

export const SESSION_PHASES = Object.freeze({
  normal: "normal",
  immediateRetry: "immediateRetry",
  completed: "completed"
});

export const STAR_MIN = 0;
export const STAR_MAX = 5;
export const GHOST_MIN = 0;
export const GHOST_MAX = 5;
