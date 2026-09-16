/** Candidate primitives. The hook owns provenance, net-savings and persistence gates. */
export { snipCompress, snipDecompress, retrieveSnippet } from "./snip";
export { formatStripCompress, formatStripDecompress, normalizeForCompare } from "./format-strip";
export { structuredDigestCompress, structuredDigestDecompress } from "./structured-digest";
export { genericPreviewCompress, genericPreviewDecompress } from "./generic-preview";

import type { Compressed } from "../core/types";
import { snipCompress, snipDecompress } from "./snip";
import { formatStripCompress, formatStripDecompress } from "./format-strip";
import { structuredDigestCompress, structuredDigestDecompress } from "./structured-digest";
import { genericPreviewDecompress } from "./generic-preview";

export interface CompressOptions {
  minChars?: number;
  snip?: Parameters<typeof snipCompress>[1];
  formatStrip?: Parameters<typeof formatStripCompress>[1];
  structuredDigest?: Parameters<typeof structuredDigestCompress>[1];
  /** Legacy explicit utility only; the production hook never enables blind snip. */
  enableSnip?: boolean;
  enableFormatStrip?: boolean;
  enableStructuredDigest?: boolean;
}

export function compress(input: string, opts: CompressOptions = {}) {
  const steps: Compressed[] = [];
  let text = input;
  if (input.length >= (opts.minChars ?? 512)) {
    if (opts.enableFormatStrip !== false) {
      const result = formatStripCompress(text, opts.formatStrip);
      steps.push(result);
      text = result.text;
    }
    if (opts.enableStructuredDigest !== false) {
      const result = structuredDigestCompress(text, opts.structuredDigest);
      steps.push(result);
      text = result.text;
    }
    if (opts.enableSnip === true) {
      const result = snipCompress(text, opts.snip);
      steps.push(result);
      text = result.text;
    }
  }
  return { text, steps, compressed: text !== input, originalSize: input.length, compressedSize: text.length };
}

/** Exact in-process restoration, not a claim that the reduced view retains all semantics. */
export function roundTripEqual(original: string, opts?: CompressOptions): boolean {
  const result = compress(original, opts);
  let text = result.text;
  for (const step of [...result.steps].reverse()) {
    if (step.method.startsWith("snip")) text = snipDecompress({ ...step, text });
    else if (step.method.startsWith("structured-digest")) text = structuredDigestDecompress({ ...step, text });
    else if (step.method.startsWith("generic-preview")) text = genericPreviewDecompress({ ...step, text });
    else if (step.method.startsWith("format-strip")) text = formatStripDecompress({ ...step, text });
  }
  return text === original;
}
