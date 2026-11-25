export const STOP_WORDS = new Set([
  "what", "when", "where", "which", "who",
  "have", "has", "had", "did", "does",
  "about", "with", "from", "that", "this",
  "were", "was", "are", "the", "and",
  "for", "you", "your", "our", "previously",
  "discuss", "discussed", "talk", "talked",
  "remember", "recall", "tell", "me"
]);

export function extractKeywords(text, extraStopWords = []) {
  const extra = new Set(extraStopWords);

  return [
    ...new Set(
      String(text ?? "").toLowerCase().match(/[a-z0-9]{3,}/g) || []
    )
  ].filter((word) => !STOP_WORDS.has(word) && !extra.has(word));
}
