/**
 * dispatcher.ts —— 策略派发
 *
 * 内容分类路由器的下游:按分类结果决定压不压、怎么压。
 * 这是安全模型第零道闸门的代码实现:
 *   structured → 压(可逆无损原语)
 *   prose      → 放行(原样返回,不碰叙事)
 *   mixed      → 仅压缩可识别的结构化段(MVP 简化:整体按 structured 处理但降低激进度)
 */

import type { ContentType } from "./types";
import { classify, type ClassifyInput } from "./classifier";
import { compress, type CompressOptions } from "../compress";

export interface DispatchResult {
  /** 最终送进上下文的文本 */
  text: string;
  /** 是否实际压缩 */
  compressed: boolean;
  /** 分类结果 */
  contentType: ContentType;
  /** 压缩步骤明细(度量用) */
  steps: ReturnType<typeof compress>["steps"];
  originalSize: number;
  compressedSize: number;
}

export function dispatch(
  input: string,
  meta: Pick<ClassifyInput, "tool" | "mime"> = {},
  compressOpts?: CompressOptions
): DispatchResult {
  const classification = classify({ text: input, ...meta });
  const originalSize = input.length;

  // 安全侧倾斜:prose 一律放行,哪怕看起来很长
  if (classification.type === "prose") {
    return {
      text: input,
      compressed: false,
      contentType: "prose",
      steps: [],
      originalSize,
      compressedSize: input.length,
    };
  }

  // structured:进入完整压缩管道
  // mixed:保守策略,只用 format-strip(去 ANSI/空白,对散文无害),
  //        不用 snip/dedup(可能伤叙事部分)
  if (classification.type === "mixed") {
    const result = compress(input, {
      ...compressOpts,
      enableSnip: false,
      enableDedup: false,
      // format-strip 保持开启
    });
    return {
      text: result.text,
      compressed: result.compressed,
      contentType: "mixed",
      steps: result.steps,
      originalSize: result.originalSize,
      compressedSize: result.compressedSize,
    };
  }

  // structured:完整管道
  const result = compress(input, compressOpts);
  return {
    text: result.text,
    compressed: result.compressed,
    contentType: classification.type,
    steps: result.steps,
    originalSize: result.originalSize,
    compressedSize: result.compressedSize,
  };
}
