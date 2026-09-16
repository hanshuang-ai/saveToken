import type { Compressed } from "../core/types";

export interface GenericPreviewOptions {
  maxChars?: number;
  headLines?: number;
  tailLines?: number;
  anchorLines?: number;
  maxLineChars?: number;
}

const DEFAULTS: Required<GenericPreviewOptions> = {
  maxChars: 6000,
  headLines: 32,
  tailLines: 24,
  anchorLines: 24,
  maxLineChars: 180,
};

function truncateLine(line: string, max: number): string {
  if (line.length <= max) return line;
  const head = Math.max(20, Math.floor(max * 0.65));
  const tail = Math.max(10, max - head - 24);
  return `${line.slice(0, head)} ... ${line.slice(line.length - tail)}`;
}

function evenlySpacedIndexes(start: number, end: number, count: number): number[] {
  if (count <= 0 || end < start) return [];
  const span = end - start + 1;
  if (span <= count) return Array.from({ length: span }, (_, i) => start + i);
  const indexes = new Set<number>();
  for (let i = 1; i <= count; i++) {
    indexes.add(start + Math.floor((i * span) / (count + 1)));
  }
  return [...indexes].sort((a, b) => a - b);
}

function buildLinePreview(
  input: string,
  handle: string,
  opts: Required<GenericPreviewOptions>
): string {
  const lines = input.split("\n");
  const total = lines.length;
  const headCount = Math.min(opts.headLines, total);
  const tailStart = Math.max(headCount, total - opts.tailLines);
  const middleStart = headCount;
  const middleEnd = tailStart - 1;
  const anchorIndexes = evenlySpacedIndexes(middleStart, middleEnd, opts.anchorLines)
    .filter((index) => lines[index]?.trim().length > 0);

  const out: string[] = [
    `[frugal: large output stored; ${input.length} chars, ${total} lines]`,
    `[frugal: retrieve original with tok_retrieve(handle="${handle}"), search with tok_retrieve(handle="${handle}", query="..."), or fetch lines with tok_retrieve(handle="${handle}", startLine=N, count=M)]`,
    `[frugal: generic preview; first ${headCount} lines, ${anchorIndexes.length} sampled middle lines, last ${total - tailStart} lines]`,
    `--- first lines 1-${headCount} ---`,
    ...lines.slice(0, headCount).map((line) => truncateLine(line, opts.maxLineChars)),
  ];

  if (anchorIndexes.length > 0) {
    out.push(`--- sampled middle lines ---`);
    for (const index of anchorIndexes) {
      out.push(`[L${index + 1}] ${truncateLine(lines[index], opts.maxLineChars)}`);
    }
  }

  if (tailStart < total) {
    out.push(`--- last lines ${tailStart + 1}-${total} ---`);
    out.push(...lines.slice(tailStart).map((line) => truncateLine(line, opts.maxLineChars)));
  }

  return out.join("\n");
}

function buildCharPreview(
  input: string,
  handle: string,
  opts: Required<GenericPreviewOptions>
): string {
  const budget = Math.max(1000, opts.maxChars);
  const bodyBudget = Math.max(400, budget - 500);
  const headChars = Math.floor(bodyBudget * 0.6);
  const tailChars = bodyBudget - headChars;
  return [
    `[frugal: large output stored; ${input.length} chars, 1 line]`,
    `[frugal: retrieve original with tok_retrieve(handle="${handle}"), search with tok_retrieve(handle="${handle}", query="...")]`,
    `[frugal: generic preview; first ${headChars} chars and last ${tailChars} chars]`,
    `--- first chars ---`,
    input.slice(0, headChars),
    `--- last chars ---`,
    input.slice(input.length - tailChars),
  ].join("\n");
}

/**
 * Generic deferred view for long tool outputs.
 *
 * This does not infer semantics. It only keeps a navigable preview while the
 * hook persists the exact original under the same handle before emission.
 */
export function genericPreviewCompress(
  input: string,
  handle: string,
  opts: GenericPreviewOptions = {}
): Compressed {
  const options = { ...DEFAULTS, ...opts };
  const lineCount = input.split("\n").length;
  let text = lineCount <= 2
    ? buildCharPreview(input, handle, options)
    : buildLinePreview(input, handle, options);

  if (text.length > options.maxChars) {
    const overflow = text.length - options.maxChars;
    text = text.slice(0, options.maxChars) +
      `\n[frugal: preview clipped by ${overflow} chars; original remains available via tok_retrieve(handle="${handle}")]`;
  }

  if (text.length >= input.length) {
    return {
      text: input,
      compressed: false,
      originalSize: input.length,
      compressedSize: input.length,
      method: "generic-preview:noop",
      restoreText: input,
    };
  }

  return {
    text,
    compressed: true,
    originalSize: input.length,
    compressedSize: text.length,
    method: "generic-preview",
    handle,
    restoreText: input,
  };
}

export function genericPreviewDecompress(result: Compressed): string {
  return result.restoreText ?? result.text;
}
