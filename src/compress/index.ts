/**
 * compress/index.ts —— 无损原语聚合
 *
 * 对外暴露统一入口:压缩、解压、往返校验。
 * 各原语独立可逆,聚合层按顺序串联。
 *
 * 注:dedup(反向引用)原语已移除。在"存原文 + store 取回"架构下,
 * dedup 的可逆性是死路径——模型取回走 store(tok_retrieve),从不调
 * decompress;它退化成有损缩写(对模型不可还原),且把路径压成 @n 伤可读性。
 * 实测收益仅 ~8% 且 74% 集中在单条日志,代码/路径/JSON 类贡献为 0。
 * 省 token 大头是 snip 头尾截断。详见设计文档与实测记录。
 */

export { snipCompress, snipDecompress, retrieveSnippet } from "./snip";
export {
 formatStripCompress,
 formatStripDecompress,
 normalizeForCompare,
} from "./format-strip";

import type { Compressed } from "../core/types";
import { snipCompress, snipDecompress } from "./snip";
import {
 formatStripCompress,
 formatStripDecompress,
 normalizeForCompare,
} from "./format-strip";

export interface CompressOptions {
 /** 触发压缩的最小字符数(总入口阈值) */
 minChars?: number;
 snip?: Parameters<typeof snipCompress>[1];
 formatStrip?: Parameters<typeof formatStripCompress>[1];
 /** 各原语开关 */
 enableSnip?: boolean;
 enableFormatStrip?: boolean;
}

const DEFAULTS: Required<CompressOptions> = {
 minChars: 512,
 snip: {},
 formatStrip: {},
 enableSnip: true,
 enableFormatStrip: true,
};

/**
 * 聚合压缩管道。顺序:format-strip → snip。
 * 先去噪(让后续步骤更干净),最后截断超长。
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

 // 逆序解压:snip → format-strip(与压缩顺序相反)
 let text = r.text;
 const reversed = [...r.steps].reverse();
 for (const step of reversed) {
 if (step.method.startsWith("snip")) text = snipDecompress({ ...step, text });
 else if (step.method.startsWith("format-strip")) text = formatStripDecompress({ ...step, text });
 }

 // format-strip 是语义等价,用规范化比较;snip 是严格相等。
 // 统一用规范化比较(format-strip 删的是纯噪声,规范化后应相等)。
 return normalizeForCompare(text) === normalizeForCompare(original);
}
