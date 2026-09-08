/**
 * compress/index.ts —— 无损原语聚合
 *
 * 对外暴露统一入口:压缩、解压、往返校验。
 * 各原语独立可逆,聚合层按顺序串联。
 */

export { snipCompress, snipDecompress, retrieveSnippet } from "./snip";
export {
  formatStripCompress,
  formatStripDecompress,
  normalizeForCompare,
} from "./format-strip";
export { dedupCompress, dedupDecompress } from "./dedup";

import type { Compressed } from "../core/types";
import { snipCompress, snipDecompress } from "./snip";
import {
  formatStripCompress,
  formatStripDecompress,
  normalizeForCompare,
} from "./format-strip";
import { dedupCompress, dedupDecompress } from "./dedup";

export interface CompressOptions {
  /** 触发压缩的最小字符数(总入口阈值) */
  minChars?: number;
  snip?: Parameters<typeof snipCompress>[1];
  formatStrip?: Parameters<typeof formatStripCompress>[1];
  dedup?: Parameters<typeof dedupCompress>[1];
  /** 各原语开关 */
  enableSnip?: boolean;
  enableFormatStrip?: boolean;
  enableDedup?: boolean;
}

const DEFAULTS: Required<CompressOptions> = {
  minChars: 512,
  snip: {},
  formatStrip: {},
  dedup: {},
  enableSnip: true,
  enableFormatStrip: true,
  enableDedup: true,
};

/**
 * 聚合压缩管道。顺序:format-strip → dedup → snip。
 * 先去噪(让后续步骤更干净),再去重,最后截断超长。
 * 每步只在自己有效时改文本。
 */
export function compress(input: string, opts: CompressOptions = {}): {
  text: string;
  steps: Compressed[];
  compressed: boolean;
  originalSize: number;
  compressedSize: number;
} {
  const o = { ...DEFAULTS, ...opts };
  const steps: Compressed[] = [];
  let text = input;
  let anyCompressed = false;

  if (input.length < o.minChars) {
    return {
      text: input,
      steps: [],
      compressed: false,
      originalSize: input.length,
      compressedSize: input.length,
    };
  }

  if (o.enableFormatStrip) {
    const r = formatStripCompress(text, o.formatStrip);
    steps.push(r);
    text = r.text;
    if (r.compressed) anyCompressed = true;
  }
  if (o.enableDedup) {
    const r = dedupCompress(text, o.dedup);
    steps.push(r);
    text = r.text;
    if (r.compressed) anyCompressed = true;
  }
  if (o.enableSnip) {
    const r = snipCompress(text, o.snip);
    steps.push(r);
    text = r.text;
    if (r.compressed) anyCompressed = true;
  }

  return {
    text,
    steps,
    compressed: anyCompressed,
    originalSize: input.length,
    compressedSize: text.length,
  };
}

/** 往返校验:解压(压缩(x)) 是否与 x 语义等价 */
export function roundTripEqual(original: string, opts?: CompressOptions): boolean {
  const r = compress(original, opts);
  if (!r.compressed) return true;

  // 逆序解压:snip → dedup → format-strip(与压缩顺序相反)
  let text = r.text;
  const reversed = [...r.steps].reverse();
  for (const step of reversed) {
    if (step.method.startsWith("snip")) text = snipDecompress({ ...step, text });
    else if (step.method.startsWith("dedup")) text = dedupDecompress({ ...step, text });
    else if (step.method.startsWith("format-strip")) text = formatStripDecompress({ ...step, text });
  }

  // format-strip 是语义等价,用规范化比较;snip/dedup 是严格相等。
  // 统一用规范化比较(format-strip 删的是纯噪声,规范化后应相等)。
  return normalizeForCompare(text) === normalizeForCompare(original);
}
