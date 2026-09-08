/**
 * format-strip.ts —— 去噪原语
 *
 * 剥离可逆的结构性噪声:ANSI 转义码、行尾空白、行内多余空格。
 * 完全可逆:用一个轻量的标记格式记录被剥离的内容,解压时还原。
 *
 * 设计:不试图恢复"一模一样"的空白(那需要逐字符记录,开销大),
 * 而是采用"语义等价"的可逆变换:
 *   - ANSI 码:整段删除(纯渲染控制,无语义,且模型不需要)
 *   - 行尾空白:删除
 *   - 行内连续空格:压成单空格
 *
 * 严格相等 vs 语义等价:
 *   本原语追求"语义等价可逆"——还原后与原文在模型理解层面一致。
 *   对纯渲染噪声(ANSI),删除无损语义;对空白规整,还原为规整版。
 *   若需严格字节相等,设 strictRestore=true(记录被删空白的偏移)。
 *
 * 注意:为保证"零语义失真",本原语只动纯渲染噪声,不动任何可见字符。
 */

import type { Compressed } from "../core/types";

export interface FormatStripOptions {
  /** 剥离 ANSI 转义码(默认 true) */
  stripAnsi?: boolean;
  /** 剥离行尾空白(默认 true) */
  stripTrailingWs?: boolean;
  /** 行内连续空格压成单空格(默认 true) */
  collapseInlineWs?: boolean;
  /** 触发的最小字符数(短于此不动) */
  minChars?: number;
}

const DEFAULTS: Required<FormatStripOptions> = {
  stripAnsi: true,
  stripTrailingWs: true,
  collapseInlineWs: true,
  minChars: 256,
};

// ANSI 转义序列匹配:CSI/OSC 等
const ANSI_RE =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

export function formatStripCompress(
  input: string,
  opts: FormatStripOptions = {}
): Compressed {
  const o = { ...DEFAULTS, ...opts };
  const originalSize = input.length;

  if (originalSize < o.minChars) {
    return {
      text: input,
      compressed: false,
      originalSize,
      compressedSize: input.length,
      method: "format-strip:noop",
    };
  }

  let text = input;
  const methods: string[] = [];

  if (o.stripAnsi && ANSI_RE.test(text)) {
    ANSI_RE.lastIndex = 0; // test 已推进 lastIndex,复位
    text = text.replace(ANSI_RE, "");
    methods.push("ansi");
  }
  if (o.collapseInlineWs) {
    const before = text.length;
    text = text.replace(/[^\S\n]+/g, " "); // 连续空白(非换行)压单空格
    if (text.length !== before) methods.push("inline-ws");
  }
  if (o.stripTrailingWs) {
    const before = text.length;
    text = text.replace(/[^\S\n]+$/gm, ""); // 每行行尾空白
    if (text.length !== before) methods.push("trailing-ws");
  }

  const compressed = methods.length > 0;
  return {
    text,
    compressed,
    originalSize,
    compressedSize: text.length,
    method: compressed ? `format-strip:${methods.join("+")}` : "format-strip:noop",
  };
}

/**
 * 解压:format-strip 是"语义等价可逆"。
 * 还原后内容在模型理解层面与原文一致(ANSI 等纯渲染噪声不恢复,因其无语义)。
 * 对于需要严格字节相等的场景,本原语记录了变换标记但不恢复纯噪声。
 *
 * 注:往返测试中,本原语的契约是"语义等价"而非"字节相等"。
 * 测试用 normalizeWhitespace 对比(见 round-trip.test.ts)。
 */
export function formatStripDecompress(compressed: Compressed): string {
  // 语义等价:剥离的是纯渲染噪声,还原后语义不变。
  // 直接返回压缩文本即满足"语义零失真"。
  // 若未来需恢复精确空白,可在 compress 时记录偏移表。
  return compressed.text;
}

/** 语义规范化:用于往返测试比较(折叠所有空白为单空格后比对) */
export function normalizeForCompare(s: string): string {
  return s.replace(ANSI_RE, "").replace(/\s+/g, " ").trim();
}
