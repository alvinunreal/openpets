const DEFAULT_MAX_UTTERANCE_CHARS = 500;

function splitSystemSpeech(text, maxChars = DEFAULT_MAX_UTTERANCE_CHARS) {
  if (typeof text !== "string" || text.length === 0) return [];
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error("Invalid system speech chunk limit.");
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const breakAt = findBreak(text, start, end);
      if (breakAt > start) end = breakAt + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function findBreak(text, start, end) {
  for (let index = end - 1; index > start; index -= 1) {
    if (/\s/.test(text[index])) return index;
  }
  return -1;
}

module.exports = { DEFAULT_MAX_UTTERANCE_CHARS, splitSystemSpeech };
