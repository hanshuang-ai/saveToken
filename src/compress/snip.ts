/**
 * snip.ts —— head+tail 截断原语
 *
 * 超长输出截成 [头] + [省略标记+handle] + [尾]。
 * 中间部分不删除,而是存起来,handle 可取回原文。
 *
 * 存储:优先走 SQLite 存储层(持久化、可检索);store 未打开时回退内存 Map(测试/独立用)。
 *
 * 可逆性:decompress 时,根据 handle 取回中间部分,拼回原文。严格相等保证。
 *
 * 注意:本原语"延迟加载"而非"删除"——与摘要的本质区别。
 */

import type { Compressed, Snippet } from "../core/types";
import { store } from "../store/db";

/** 内存回退库:store 未打开时用。打开 store 后优先持久化。 */
const memStore = new Map<string, Snippet>();

/** store 是否可用 */
function storeReady(): boolean {
  return store.isOpen;
}

/** 存片段:优先 store,回退内存 */
function putSnippet(snippet: Snippet): void {
  memStore.set(snippet.handle, snippet);
  if (storeReady()) {
    // 把中间段原文存入 store(用 snip 自己的 handle,保持一致便于检索)
    // 使 tok_retrieve 能检索到被截断的内容
    try {
      store.saveOriginalWithHandle(snippet.handle, snippet.content, {}, Date.now());
    } catch {
      // store 异常不阻塞压缩流程
    }
  }
}

/** 取回片段 */
function getSnippet(handle: string): Snippet | undefined {
  return memStore.get(handle);
}

/** 取回片段(对外,供 decompress 与 tok_retrieve 复用) */
export function retrieveSnippet(handle: string): Snippet | undefined {
  return getSnippet(handle);
}

/**
 * 生成跨进程唯一句柄。
 *
 * hook 每次是新进程,进程内 counter 永远从 0 → 永远 snip-1,跨次调用的中间段互相覆盖。
 * 用时间戳+随机后缀保证唯一(不依赖 db,snip 可能在 store 未打开时跑)。
 */
function makeHandle(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `snip-${ts}${rand}`;
}

export interface SnipOptions {
  /** 头部保留行数 */
  headLines?: number;
  /** 尾部保留行数 */
  tailLines?: number;
  /** 触发截断的最小行数(短于此不截) */
  minLines?: number;
}

const DEFAULTS: Required<SnipOptions> = {
  headLines: 30,
  tailLines: 30,
  minLines: 120,
};

/**
 * 压缩:超长文本截成 head+省略标记+tail,中间存盘。
 * 短于阈值则原样返回(compressed=false)。
 */
export function snipCompress(input: string, opts: SnipOptions = {}): Compressed {
  const o = { ...DEFAULTS, ...opts };
  const lines = input.split("\n");
  const total = lines.length;
  const originalSize = input.length;

  // 不截断的条件:行数不够,或 head+tail 已覆盖全部行(中间无内容可省略)
  if (total <= o.minLines || total <= o.headLines + o.tailLines) {
    return {
      text: input,
      compressed: false,
      originalSize,
      compressedSize: input.length,
      method: "snip:noop",
    };
  }

  const head = lines.slice(0, o.headLines);
  const tail = lines.slice(total - o.tailLines);
  const middleLines = lines.slice(o.headLines, total - o.tailLines);

  const handle = makeHandle();
  const snippet: Snippet = {
    handle,
    content: middleLines.join("\n"),
    startLine: o.headLines + 1,
    endLine: total - o.tailLines,
  };
  putSnippet(snippet);

  const omitted = middleLines.length;
  const text =
    head.join("\n") +
    `\n\n「省略 ${omitted} 行,handle=${handle}」\n\n` +
    tail.join("\n");

  return {
    text,
    compressed: true,
    originalSize,
    compressedSize: text.length,
    method: "snip",
    handle,
  };
}

/**
 * 解压:根据 handle 取回中间片段,拼回原文。
 * 用正则定位标记(不依赖精确行数),稳健。
 */
export function snipDecompress(compressed: Compressed): string {
  if (!compressed.compressed || !compressed.handle) {
    return compressed.text;
  }
  const snippet = getSnippet(compressed.handle);
  if (!snippet) {
    return compressed.text + `\n「⚠ handle=${compressed.handle} 片段丢失,无法还原」`;
  }

  // 用正则按 handle 定位标记,不依赖精确行数
  const markerRe = new RegExp(
    `\\n\\n「省略 \\d+ 行,handle=${escapeReg(compressed.handle)}」\\n\\n`
  );
  const parts = compressed.text.split(markerRe);
  if (parts.length !== 2) {
    return compressed.text; // 格式不匹配,原样返回
  }
  // 还原:head + middle + tail,用换行连接(与压缩时 split("\n") 对应)
  return parts[0] + "\n" + snippet.content + "\n" + parts[1];
}

/** 转义正则特殊字符 */
function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
