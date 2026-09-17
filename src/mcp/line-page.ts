/** Limits count UTF-16 code units, matching storage and output-policy metrics. */
export const MAX_RETRIEVE_LINE_COUNT = 160;
export const MAX_RETRIEVE_CHARS = 12000;

/** A cursor is relative to the same requested line range, not to the last page. */
export function linePage(content: string, startLine: number, count: number, offsetChars = 0) {
  if (!Number.isSafeInteger(startLine) || startLine < 1 ||
      !Number.isSafeInteger(count) || count < 1 ||
      !Number.isSafeInteger(offsetChars) || offsetChars < 0) {
    throw new Error("startLine/count must be positive integers; offsetChars must be a nonnegative integer");
  }
  const lines = content.split("\n");
  const start = startLine - 1;
  if (start >= lines.length) return null;
  const end = Math.min(lines.length, start + Math.min(count, MAX_RETRIEVE_LINE_COUNT));
  const range = lines.slice(start, end).join("\n");
  if (offsetChars > range.length || (offsetChars === range.length && range.length > 0)) return null;
  // Explicit user offsets must also respect Unicode surrogate boundaries.
  const splitsPair = (at: number) => at > 0 && at < range.length &&
    /[\uD800-\uDBFF]/.test(range[at - 1]) && /[\uDC00-\uDFFF]/.test(range[at]);
  if (splitsPair(offsetChars)) throw new Error("offsetChars splits a Unicode character; use the returned continuation offset");
  let pageEnd = Math.min(range.length, offsetChars + MAX_RETRIEVE_CHARS);
  if (splitsPair(pageEnd)) pageEnd--;
  return {
    text: range.slice(offsetChars, pageEnd),
    startLine,
    endLine: end,
    offsetChars,
    nextOffsetChars: pageEnd < range.length ? pageEnd : null,
    nextStartLine: end < lines.length ? end + 1 : null,
  };
}
