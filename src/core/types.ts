/**
 * 类型定义 —— 压缩原语共享
 *
 * 核心契约:所有原语必须可逆,即 decompress(compress(x)) === x(严格相等)。
 */

/** 内容类型(分类器输出) */
export type ContentType = "structured" | "prose" | "mixed" | "empty";

/** 压缩结果 */
export interface Compressed {
  /** 压缩后的文本,送进上下文 */
  text: string;
  /** 该次压缩是否实际发生(未达阈值时 text===原文,compressed=false) */
  compressed: boolean;
  /** 原始字节/字符数(度量用) */
  originalSize: number;
  /** 压缩后字节/字符数(度量用) */
  compressedSize: number;
  /** 使用的原语名(度量用) */
  method: string;
  /** 延迟加载的片段句柄(snip 用,其余为 undefined) */
  handle?: string;
}

/** 单条备份记录(snip 的省略片段) */
export interface Snippet {
  /** 唯一句柄,用于取回 */
  handle: string;
  /** 原文片段 */
  content: string;
  /** 该片段在原文中的起始行 */
  startLine: number;
  /** 该片段在原文中的结束行 */
  endLine: number;
}
