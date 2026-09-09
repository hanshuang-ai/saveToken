/**
 * dispatcher.ts —— 策略派发
 *
 * 内容分类路由器的下游:按分类结果决定压不压、怎么压。
 * 这是安全模型第零道闸门的代码实现:
 *   structured → 压(可逆无损原语)
 *   prose      → 放行(原样返回,不碰叙事)
 *   mixed      → 放行(含散文部分,format-strip ROI 仅 3-11%,不值得冒险)
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

  // 安全侧倾斜:prose 与 mixed 一律放行,哪怕看起来很长。
  // mixed 含散文部分,实测 format-strip ROI 仅 3-11%(见度量),
  // 却照常走分类/存原文/记 metrics 产生噪音,不值得为这点收益冒险触碰叙事部分。
  if (classification.type === "prose" || classification.type === "mixed") {
    return {
      text: input,
      compressed: false,
      contentType: classification.type,
      steps: [],
      originalSize,
      compressedSize: input.length,
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
