import type { Compressed } from "../core/types";

export interface FormatStripOptions {
  stripAnsi?: boolean;
  minChars?: number;
}

// Only SGR styling. Cursor movement, OSC, whitespace and line endings are data.
const SGR = /\x1b\[[0-9;:]*m/g;

export function formatStripCompress(input: string, opts: FormatStripOptions = {}): Compressed {
  const text = input.length >= (opts.minChars ?? 256) && opts.stripAnsi !== false
    ? input.replace(SGR, "") : input;
  return {
    text,
    compressed: text !== input,
    originalSize: input.length,
    compressedSize: text.length,
    method: text !== input ? "format-strip:sgr" : "format-strip:noop",
    restoreText: text !== input ? input : undefined,
  };
}

export function formatStripDecompress(result: Compressed): string {
  return result.restoreText ?? result.text;
}

/** Display comparison only; do not use whitespace normalization as a safety test. */
export function normalizeForCompare(text: string): string {
  return text.replace(SGR, "");
}
