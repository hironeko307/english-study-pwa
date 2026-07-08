export function normalizeVocabularyItems(items = []) {
  return items
    .map(normalizeVocabularyItem)
    .filter((item) => item.questionId && item.word && item.japanese);
}

export function getSections(words) {
  return [...new Set(words.map((word) => word.section))]
    .sort((a, b) => Number(a) - Number(b));
}

export function wordsForSection(words, section) {
  return words.filter((word) => word.section === section);
}

function normalizeVocabularyItem(item) {
  const wordId = String(item.wordId ?? item.vocabularyId ?? item.questionId ?? "").trim();
  const questionId = String(item.questionId ?? item.vocabularyId ?? (wordId ? `VG2500-${wordId}` : "")).trim();
  const pos = String(item.pos ?? item.partOfSpeech ?? "").trim();
  const posTags = Array.isArray(item.posTags)
    ? item.posTags.map(String)
    : splitPosTags(pos);

  return {
    ...item,
    source: item.source ?? "Vocabulary Grid 2500",
    wordId,
    questionId,
    stage: String(item.stage ?? ""),
    section: String(item.section ?? ""),
    word: String(item.word ?? "").trim(),
    pos,
    posTags,
    japanese: String(item.japanese ?? item.meaningJa ?? "").trim(),
    tags: Array.isArray(item.tags) ? item.tags : parseJsonArray(item.tagsJson)
  };
}

function splitPosTags(pos) {
  if (!pos) return [];
  return pos
    .split(/[\/,、\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
