/**
 * structured-digest.ts —— 结构化信号提取原语
 *
 * 借鉴 CCE 的 summarizeStructured 思路(只借鉴算法,不引其源码;CCE 为 AGPL-3.0)。
 *
 * 针对"噪声主导的行式工具输出"(测试/grep/build/lint):大量 PASS/成功行是噪声,
 * 真正有用的是埋在中间的少数 FAIL/error/warn/异常行。盲截 head+tail 可能头部全是
 * PASS、尾部是 summary,中间的失败看不到。本原语抽取信号行 + 计数,省略噪声行,
 * 全文存盘供 tok_retrieve 取回。
 *
 * 与 snip 的关系:snip 盲截头尾(中间存盘);digest 抽信号行(全文存盘)。
 * digest 命中时输出已短,snip 自然 noop。未命中(compressed=false)则回退 snip。
 *
 * 可逆性:digest 存的是全文(非中间段),decompress 取回全文即严格相等原文。
 * 行号对齐:存全文 → tok_retrieve(handle, startLine) 行号正确(避免 snip- 中间段错配)。
 *
 * 安全:仅对 structured 内容生效(hook 已在分类层放行 prose/mixed)。代码/JSON 高符号
 * 密度 → 不启用(让 snip+codegraph/retrieve 处理)。二进制 → 不启用。
 *
 * 信号检测用"结构性锚定"而非子串匹配:真信号行带结构化严重度标记(行首级别/错误类型/
 * 堆栈/摘要,或日志型行首时间戳+内嵌级别),而非 prose/HTML/JSON 串值/二进制里
 * 对 "fail"/"error" 的偶然提及。后者是假阳性,会误把散文/教程当日志压缩。
 */

import type { Compressed, Snippet } from "../core/types";
import { store } from "../store/db";

/** 内存回退库:store 未打开时用(snip 同模式) */
const memStore = new Map<string, Snippet>();

function storeReady(): boolean {
  return store.isOpen;
}

/** 存全文片段:优先 store,回退内存 */
function putSnippet(snippet: Snippet): void {
  memStore.set(snippet.handle, snippet);
  if (storeReady()) {
    try {
      store.saveOriginalWithHandle(snippet.handle, snippet.content, {}, Date.now());
    } catch {
      // store 异常不阻塞压缩
    }
  }
}

/** 取回片段 */
function getSnippet(handle: string): Snippet | undefined {
  return memStore.get(handle);
}

/** 跨进程唯一句柄(hook 每次新进程,需时间戳+随机) */
function makeHandle(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `digest-${ts}${rand}`;
}

export interface DigestOptions {
  /** 触发摘要的最小非空行数(短于此不启用,snip 够用) */
  minLines?: number;
  /** 信号行提取上限(超出截断,避免全信号输出撑爆) */
  maxSignalLines?: number;
}

const DEFAULTS: Required<DigestOptions> = {
  minLines: 40,
  maxSignalLines: 50,
};

// ─── 信号模式(结构性检测)─────────────────────────────────────────────────
// 原理:真信号行带"结构化严重度标记"(行首级别/错误类型/堆栈/摘要计数,或日志型
// 行首时间戳+内嵌级别 token),而非 prose/HTML/JSON 串值/二进制里的 "fail"/"error"
// 提及。子串匹配会在散文"the operation fails"、HTML <p>、二进制字节里误命中——
// 结构性锚定才能泛化(详见 corpus-baseline 假阳性记录)。
//
// 纯 PASS/成功行不算信号(那是要省略的噪声)。
const STRUCTURAL_SIGNAL_PATTERNS: {
  re: RegExp;
  kind: "fail" | "warn" | "err" | "summary" | "stack";
}[] = [
  // (A1) 行首错误类型(\w*Error 泛化所有 Error 子类:AssertionError/TypeError/...)
  //   + Exception/Traceback/Panic/FATAL 等;可带 markdown 强调前缀 *
  { re: /^\s*\*?\s*(?:\w*Error|Exception|Traceback|Panic|FATAL|PANIC|CRIT(?:ICAL)?|EMERG|SEGFAULT|ABORT|ASSERTION)\b/i, kind: "err" },
  // (A2) 行首 FAIL/ERROR/WARN(含 [ERROR] 包裹、npm ERR! 等,允许前置短工具名)
  { re: /^\s*(?:\w+\s)?\]?\s*(?:FAIL(?:ED|URES?)?|ERROR|ERR|WARNING?S?|WARN(?:ING)?)\b!?/i, kind: "fail" },
  // (A3) 行首失败符号(✗/✘/⚠;不含 ✓/✔——那是 PASS 噪声)
  { re: /^\s*[✗✘⚠]/, kind: "fail" },
  // (A4) TAP 失败("not ok")
  { re: /^not ok\b/i, kind: "fail" },
  // (A5) 堆栈帧(JS at / Caused by / gdb #N)
  { re: /^\s*at\s+\S/, kind: "stack" },
  { re: /^Caused by/, kind: "stack" },
  { re: /^\s*#\d+\s/, kind: "stack" },
  // (A6) 位置前缀诊断(tsc/eslint/rustc/gcc: path:line:col: error:)
  { re: /^\S+:\d+:\d+:\s*(?:error|warning|note)\b/i, kind: "err" },
  // (A7) 摘要计数行
  { re: /^\s*\d+\s*(?:passed|failed|tests?|cases?|suites?|skipped)\b/i, kind: "summary" },
  { re: /^Tests?\s*:\s*\d/i, kind: "summary" },
  { re: /^Tests?\s+\d+\s*(?:failed|passed|skipped)/i, kind: "summary" },
  { re: /^\s*\d+\s*(?:failing|passing)\b/i, kind: "summary" },
];

// (B) 日志型行:行首时间戳(证明是机器日志非 prose/HTML)+ 内嵌级别 token
//   匹配 MM-DD HH:MM(Android)与 YYYY-MM-DD HH:MM(log4j)等;第三段日期可选
const LOG_LINE_PREFIX = /^\s*\d{2,4}[-/]\d{2}(?:[-/]\d{2,4})?[\sT]\d{2}:\d{2}/;
// 多字母级别词(任意位置)或单字母级别(E=error/W=warn/F=fatal;I/D/V 是 info 噪声不含)
const LOG_LEVEL_TOKEN = /\b(?:ERROR|ERR|FATAL|PANIC|CRIT(?:ICAL)?|EMERG|WARN(?:ING)?|FAIL(?:ED|URES?)?)\b/i;
const SINGLE_LETTER_LEVEL = /(?:^|[\s|])[EWF](?:[\s|]|$)/;

/**
 * 行是否为信号行(结构性判定)。返回种类用于计数,或 null。
 * 先排 HTML 标签行(<p>… 内的 fail/error 是内容提及,非结构信号)。
 */
function classifySignalLine(line: string): "fail" | "warn" | "err" | "summary" | "stack" | null {
  // HTML/XML 标签行(<p>,<div>…):信号词在标签内容里,非结构信号 → 跳过
  if (/^\s*<\w[\s/>]/.test(line)) return null;
  // (A) 行首结构模式
  for (const p of STRUCTURAL_SIGNAL_PATTERNS) {
    if (p.re.test(line)) return p.kind;
  }
  // (B) 日志型行:行首时间戳 + 内嵌级别 token
  if (LOG_LINE_PREFIX.test(line) && (LOG_LEVEL_TOKEN.test(line) || SINGLE_LETTER_LEVEL.test(line))) {
    if (/\b(?:FATAL|PANIC|CRIT|EMERG|SEGFAULT|ABORT|ERROR|ERR|EXCEPTION|ASSERTION)\b/i.test(line) || /(?:^|[\s|])E(?:[\s|]|$)/.test(line)) return "err";
    if (/\bWARN(?:ING)?\b/i.test(line) || /(?:^|[\s|])W(?:[\s|]|$)/.test(line)) return "warn";
    return "fail"; // F 级 / FAIL 词
  }
  return null;
}

/** 强符号密度(代码/JSON 特征)——与 classifier 同口径 */
function strongSymbolRatio(text: string): number {
  const strongSymbols = (text.match(/[{};]/g) || []).length;
  return strongSymbols / text.length;
}

/** 二进制检测:控制字符(不含 \t\n\r)占比 > 5% → 二进制。
 *  执行文件/locale.pak 等 ~28-32%;文本日志 0%。文本文件几乎不含控制字符。
 *  二进制的 toString('utf8') 里散落的 "fail"/"error" 字节会被子串匹配误命中,需先排除。 */
function isBinary(text: string): boolean {
  const sample = text.length > 20000 ? text.slice(0, 20000) : text;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c < 9 || (c > 13 && c < 32)) bad++;
    if (i > 2000 && bad / (i + 1) > 0.05) return true; // 提前退出
  }
  return sample.length > 0 && bad / sample.length > 0.05;
}

/** 标记文档检测:HTML/XML 标签(`<tag>`/`</tag>`)计数 > 30 → 标记文档,非行式日志。
 *  HTML 文档有数千标签;日志/测试输出 0-数个。digest 针对行式工具输出日志,
 *  不是标记文档——HTML 内嵌 <script> 的 i18n 键 `error: '复制错误'` 会被子串误命中,
 *  整体排除最干净(无损:全文存盘,snip 兜底)。 */
function isMarkup(text: string): boolean {
  const sample = text.length > 100000 ? text.slice(0, 100000) : text;
  const tagCount = (sample.match(/<\/?[a-zA-Z]/g) || []).length;
  return tagCount > 30;
}

/**
 * 摘要:抽信号行 + 计数 + 全文存盘。
 * 非匹配(短/二进制/代码/无信号/全信号)→ compressed=false 回退 snip。
 */
export function structuredDigestCompress(
  input: string,
  opts: DigestOptions = {}
): Compressed {
  const o = { ...DEFAULTS, ...opts };
  const originalSize = input.length;
  const lines = input.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);

  // 条件 1:行数不够 → 不启用
  if (nonEmpty.length < o.minLines) {
    return {
      text: input,
      compressed: false,
      originalSize,
      compressedSize: input.length,
      method: "structured-digest:noop",
    };
  }

  // 条件 2:二进制 → 不启用(留 snip;避免字节里的 "fail" 误命中)
  if (isBinary(input)) {
    return {
      text: input,
      compressed: false,
      originalSize,
      compressedSize: input.length,
      method: "structured-digest:noop",
    };
  }

  // 条件 3:高符号密度(代码/JSON)→ 不启用,留给 snip+codegraph/retrieve
  if (strongSymbolRatio(input) > 0.008) {
    return {
      text: input,
      compressed: false,
      originalSize,
      compressedSize: input.length,
      method: "structured-digest:noop",
    };
  }

  // 条件 4:标记文档(HTML/XML,标签 > 30)→ 不启用。digest 针对行式日志,
  // 非 HTML 文档——内嵌 <script> 的 i18n 键 `error:'...'` 会被子串误命中。
  if (isMarkup(input)) {
    return {
      text: input,
      compressed: false,
      originalSize,
      compressedSize: input.length,
      method: "structured-digest:noop",
    };
  }

  // 扫描信号行(保留原行号,便于 tok_retrieve 按行定位)
  const signalEntries: { line: number; text: string }[] = [];
  let failCount = 0;
  let warnCount = 0;
  let errCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const kind = classifySignalLine(l);
    if (kind) {
      if (kind === "err") {
        errCount++;
      } else if (kind === "fail") {
        failCount++;
      } else if (kind === "warn") {
        warnCount++;
      }
      signalEntries.push({ line: i + 1, text: l });
    }
  }

  const signalCount = signalEntries.length;
  const density = signalCount / nonEmpty.length;

  // 条件 5:无信号可抽 → 不启用(留 snip 展示头尾形状)
  // 注:不设密度下限——digest 价值正在"少数信号埋在大堆噪声里"(低密度是目标场景,
  // 不是拒绝条件)。只要 ≥1 条信号就抽。
  if (signalCount === 0) {
    return {
      text: input,
      compressed: false,
      originalSize,
      compressedSize: input.length,
      method: "structured-digest:noop",
    };
  }
  // 条件 6:全信号(grep 类,>35% 行是信号)→ digest 不压缩,留 snip
  if (density > 0.35) {
    return {
      text: input,
      compressed: false,
      originalSize,
      compressedSize: input.length,
      method: "structured-digest:noop",
    };
  }

  // 组装摘要文本
  const shown = signalEntries.slice(0, o.maxSignalLines);
  const omittedSignals = signalCount - shown.length;
  const digestLines = shown.map((e) => `[L${e.line}] ${e.text}`);

  const handle = makeHandle();
  const snippet: Snippet = {
    handle,
    content: input, // 全文(非中间段)→ 行号正确
    startLine: 1,
    endLine: lines.length,
  };
  putSnippet(snippet);

  const omitted = lines.length - shown.length;
  const tally = `失败 ${failCount} / 警告 ${warnCount} / 错误 ${errCount}`;
  const truncNote =
    omittedSignals > 0 ? `(另有 ${omittedSignals} 条信号未列,见全文)` : "";

  const text =
    digestLines.join("\n") +
    `\n\n「frugal:结构化摘要 — 共 ${lines.length} 行,提取 ${signalCount} 条信号(${tally})${truncNote},省略 ${omitted} 行噪声,handle=${handle}。tok_retrieve(handle="${handle}", query="关键词") 查全文片段,或 startLine 按行取。统计/聚合用 Bash 处理源输出,勿取回全文。」`;

  // size guard:摘要不比原文短就不压缩(永不劣化)
  if (text.length >= originalSize) {
    return {
      text: input,
      compressed: false,
      originalSize,
      compressedSize: input.length,
      method: "structured-digest:noop",
    };
  }

  return {
    text,
    compressed: true,
    originalSize,
    compressedSize: text.length,
    method: "structured-digest",
    handle,
  };
}

/**
 * 解压:取回全文返回。digest 存的是全文(信号行是其子集),严格相等。
 */
export function structuredDigestDecompress(compressed: Compressed): string {
  if (!compressed.compressed || !compressed.handle) {
    return compressed.text;
  }
  const snippet = getSnippet(compressed.handle);
  if (!snippet) {
    return compressed.text + `\n「⚠ handle=${compressed.handle} 片段丢失,无法还原」`;
  }
  return snippet.content;
}
