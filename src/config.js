export const APP_VERSION = "0.1.0";
export const DATASET_ID = "vocabulary-grid-2500";
export const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbyIMNdghNgeAVE7BsFV1WZCg-AQ-Drm-QRIZDenEl1pzRZ8Jlz_L25iZxw6I8mzTsrcbA/exec";

export const REVIEW_INTERVAL_DAYS = [1, 3, 7, 14, 30];
export const WRONG_RETRY_DELAY_MINUTES = 5;
export const EXAM_DATE = "2027-02-16";
export const DAILY_NEW_TARGET = 20;
export const CORRECT_FEEDBACK_DELAY_MS = 700;
export const INCORRECT_FEEDBACK_DELAY_MS = 2500;

export const STUDENT_DISPLAY_NAMES = {
  student001: "Learner 1",
  student002: "Learner 2",
  student003: "Learner 3"
};

export const STORAGE_KEYS = {
  endpoint: "vg2500:gasEndpoint",
  authSession: "vg2500:authSession",
  vocabularyCache: (datasetId) => `vg2500:${datasetId}:vocabularyCache`,
  history: (studentId) => `vg2500:${studentId}:answerHistory`,
  pending: (studentId) => `vg2500:${studentId}:pendingSubmissions`,
  attempts: (studentId) => `vg2500:${studentId}:attempts`,
  sessions: (studentId) => `vg2500:${studentId}:sessions`,
  studentProgress: (studentId) => `vg2500:${studentId}:studentProgress`
};
