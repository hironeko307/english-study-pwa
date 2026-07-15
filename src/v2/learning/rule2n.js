const REVIEW_INTERVAL_DAYS = Object.freeze([1, 1, 2, 4, 8, 16]);
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function getReviewIntervalDays(star) {
  if (!Number.isInteger(star) || star < 0 || star >= REVIEW_INTERVAL_DAYS.length) {
    throw new RangeError("Star must be an integer from 0 through 5.");
  }
  return REVIEW_INTERVAL_DAYS[star];
}

export function calculateNextReviewDate(learningDate, updatedStar) {
  return addCalendarDays(learningDate, getReviewIntervalDays(updatedStar));
}

export function addCalendarDays(dateOnly, days) {
  const { year, month, day } = parseDateOnly(dateOnly);
  if (!Number.isInteger(days)) {
    throw new TypeError("Calendar day offset must be an integer.");
  }

  const date = new Date(Date.UTC(year, month - 1, day + days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

export function toLearningDate(value) {
  const date = normalizeDate(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function assertDateOnly(value, fieldName = "date") {
  parseDateOnly(value, fieldName);
  return value;
}

function parseDateOnly(value, fieldName = "date") {
  const match = typeof value === "string" ? DATE_ONLY_PATTERN.exec(value) : null;
  if (!match) {
    throw new TypeError(`${fieldName} must use YYYY-MM-DD format.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
  ) {
    throw new RangeError(`${fieldName} is not a valid calendar date.`);
  }
  return { year, month, day };
}

function normalizeDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("A valid date or timestamp is required.");
  }
  return date;
}
