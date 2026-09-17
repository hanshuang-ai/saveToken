/**
 * graph.ts —— 建图 + 持久化 + 检索 + 跨文件解析(仅 MCP)
 *
 * 参考 CodeGraph "解析"阶段 + Aider 精简签名思路。
 *
 * 流程:
 *   indexCode(handle) —— 取 orig-N 原文 → extractSymbols(ts-morph)
 *                         → 存 symbols / refs 表(幂等)。import 路径尝试解析到已读文件。
 *   retrieveSymbol    —— 取符号定义(完整 body)+ 同文件调用关系。
 *   retrieveRefs      —— callers/callees,跨文件:to_handle 已解析则递归取该符号(深度≤3),
 *                         未读则提示 Read。
 *
 * 查询前 ensureIndexed:查 symbols 表有无记录,无则触发 indexCode。
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { store } from "../store/db";
import type { SymbolRecord, RefRecord } from "../store/db";
import { extractSymbols } from "./extract";
import { langForExt, resolveImportPath } from "./languages";
import type { CodeLang } from "./languages";
import { parse as parseVueSfc } from "@vue/compiler-sfc";

/** 取回结果:text 给模型看;retrieved 表示是否实际取回了内容(供 incrementRetrieved) */
export interface GraphResult {
  text: string;
  retrieved: boolean;
}

interface HandleCodeInfo {
  rec: NonNullable<ReturnType<typeof store.getOriginal>>;
  lang?: CodeLang;
  sourceLang?: string;
  code: string;
  lineOffset: number;
  codeBlocks?: CodeBlock[];
  vue?: VueInfo;
}

interface VueInfo {
  scripts: VueBlock[];
  template?: VueBlock;
  styleCount: number;
  components: string[];
  events: string[];
  bindings: string[];
  parseErrors: string[];
}

interface VueBlock {
  attrs: Record<string, string | true>;
  content: string;
  startLine: number;
  lang?: string;
  setup?: boolean;
}

interface CodeBlock {
  code: string;
  lang: CodeLang;
  lineOffset: number;
}

interface SymbolViewOptions {
  includeBody?: boolean;
  maxBodyChars?: number;
}

const MAX_MAP_SYMBOLS = 80;
const MAX_MAP_CALL_ROWS = 40;
const MAX_FUZZY_SYMBOLS = 20;
const DEFAULT_SYMBOL_BODY_CHARS = 8000;
const MAX_SYMBOL_BODY_CHARS = 16000;
const MAX_REFS_PER_SYMBOL = 20;
const MAX_REF_LINES = 80;

// ─── 语言判定 ────────────────────────────────────────────────────────────────

/** 从 handle 的原文 source 路径推断代码语言。非代码/无 source 返回 undefined。 */
function langForHandle(handle: string): CodeLang | undefined {
  const rec = store.getOriginal(handle);
  if (!rec?.source) return undefined;
  const dot = rec.source.lastIndexOf(".");
  const ext = dot >= 0 ? rec.source.slice(dot + 1).toLowerCase() : "";
  return langForExt(ext);
}

function extForSource(source?: string): string {
  if (!source) return "";
  const dot = source.lastIndexOf(".");
  return dot >= 0 ? source.slice(dot + 1).toLowerCase() : "";
}

function langFromScriptAttrs(attrs: Record<string, string | true>): CodeLang {
  const lang = String(attrs.lang ?? "").toLowerCase();
  if (lang === "ts" || lang === "typescript") return "typescript";
  if (lang === "tsx") return "tsx";
  if (lang === "jsx") return "jsx";
  return "javascript";
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function oneLine(text = "", maxChars = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trimEnd()}...`;
}

function cappedList<T>(items: T[], max: number): { shown: T[]; omitted: number } {
  return {
    shown: items.slice(0, max),
    omitted: Math.max(0, items.length - max),
  };
}

function normalizeBodyBudget(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_SYMBOL_BODY_CHARS;
  return Math.max(200, Math.min(Math.trunc(value!), MAX_SYMBOL_BODY_CHARS));
}

function normalizeAttrs(attrs: Record<string, unknown> | undefined): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (const [key, value] of Object.entries(attrs ?? {})) {
    out[key] = typeof value === "string" ? value : true;
  }
  return out;
}

function blockFromSfc(block: {
  content: string;
  attrs?: Record<string, unknown>;
  loc?: { start?: { line?: number } };
}, setup = false): VueBlock {
  const attrs = normalizeAttrs(block.attrs);
  return {
    attrs,
    content: block.content,
    startLine: block.loc?.start?.line ?? 1,
    lang: typeof attrs.lang === "string" ? attrs.lang : undefined,
    setup,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expressionContent(value: unknown): string {
  return isRecord(value) && typeof value.content === "string" ? value.content : "";
}

function isVueComponentTag(tag: string, tagType: unknown): boolean {
  return tagType === 1 || /^[A-Z]/.test(tag) || tag.includes("-");
}

function walkVueTemplateAst(
  node: unknown,
  out: { components: string[]; events: string[]; bindings: string[] }
): void {
  if (!isRecord(node)) return;
  const tag = typeof node.tag === "string" ? node.tag : "";
  if (tag && isVueComponentTag(tag, node.tagType)) out.components.push(tag);

  const props = Array.isArray(node.props) ? node.props : [];
  for (const prop of props) {
    if (!isRecord(prop) || prop.type !== 7 || typeof prop.name !== "string") continue;
    const arg = expressionContent(prop.arg);
    if (prop.name === "on" && arg) {
      out.events.push(arg);
    } else if (prop.name === "bind" && arg) {
      out.bindings.push(arg);
    } else if (prop.name === "model") {
      out.bindings.push(arg || "modelValue");
    }
  }

  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) walkVueTemplateAst(child, out);
}

function extractVueInfo(content: string, filename?: string): VueInfo {
  const parsed = parseVueSfc(content, { filename: filename ?? "anonymous.vue" });
  const descriptor = parsed.descriptor;
  const scripts = [
    ...(descriptor.script ? [blockFromSfc(descriptor.script)] : []),
    ...(descriptor.scriptSetup ? [blockFromSfc(descriptor.scriptSetup, true)] : []),
  ];
  const template = descriptor.template ? blockFromSfc(descriptor.template) : undefined;
  const templateParts = { components: [] as string[], events: [] as string[], bindings: [] as string[] };
  if (descriptor.template?.ast) walkVueTemplateAst(descriptor.template.ast, templateParts);
  return {
    scripts,
    template,
    styleCount: descriptor.styles.length,
    components: uniq(templateParts.components),
    events: uniq(templateParts.events),
    bindings: uniq(templateParts.bindings),
    parseErrors: parsed.errors.map((error) => error instanceof Error ? error.message : String(error)),
  };
}

function codeInfoForHandle(handle: string): HandleCodeInfo | undefined {
  const rec = store.getOriginal(handle);
  if (!rec) return undefined;
  const ext = extForSource(rec.source);
  if (ext === "vue") {
    const vue = extractVueInfo(rec.content, rec.source);
    const codeBlocks = vue.scripts
      .map((block) => ({
        code: block.content,
        lang: langFromScriptAttrs(block.attrs),
        lineOffset: block.startLine - 1,
      }))
      .filter((block) => block.code.trim());
    const mainScript = vue.scripts.find((block) => block.setup) ?? vue.scripts[0];
    if (!mainScript) {
      return {
        rec,
        sourceLang: "vue",
        code: "",
        lineOffset: 0,
        vue,
      };
    }
    const lang = langFromScriptAttrs(mainScript.attrs);
    return {
      rec,
      lang,
      sourceLang: "vue",
      code: mainScript.content,
      lineOffset: mainScript.startLine - 1,
      codeBlocks,
      vue,
    };
  }
  const lang = langForHandle(handle);
  if (!lang) return { rec, code: rec.content, lineOffset: 0 };
  return { rec, lang, sourceLang: lang, code: rec.content, lineOffset: 0 };
}

/** 取 handle 原文的来源路径(给提示用) */
function sourceOf(handle: string): string {
  return store.getOriginal(handle)?.source ?? "(未知)";
}

// ─── 跨文件解析 ──────────────────────────────────────────────────────────────

/** import 源字符串 → 已读文件的 orig-N handle(逐个候选路径比对 originals.source) */
function resolveImportHandle(importerPath: string, importSrc: string): string | undefined {
  const candidates = resolveImportPath(importerPath, importSrc);
  for (const p of candidates) {
    const h = store.getOriginalBySource(p);
    if (h) return h;
  }
  return undefined;
}

/** 调用目标解析:本地定义 / import / 未知。返回 toHandle + importSrc(供未读提示) */
function resolveCallTarget(
  handle: string,
  calleeName: string,
  localNames: Set<string>,
  imports: { importedNames: string[]; source: string }[],
  importerPath: string
): { toHandle: string | undefined; importSrc?: string } {
  // 1. 本文件定义 → 自引用
  if (localNames.has(calleeName)) return { toHandle: handle };
  // 2. import → 解析到已读文件
  for (const imp of imports) {
    if (imp.importedNames.includes(calleeName)) {
      return { toHandle: resolveImportHandle(importerPath, imp.source), importSrc: imp.source };
    }
  }
  // 3. 未知(内置/全局/未解析)
  return { toHandle: undefined };
}

// ─── 索引 ────────────────────────────────────────────────────────────────────

/**
 * 索引某 handle 的代码:解析 AST → 提取 → 存 symbols/refs 表(幂等)。
 * @returns true=已索引(是代码);false=非代码/找不到原文
 */
export async function indexCode(handle: string): Promise<boolean> {
  const info = codeInfoForHandle(handle);
  if (!info?.rec || !info.lang || !info.code.trim()) return false; // 非代码/无脚本,不索引

  const now = info.rec.createdAt;
  const importerPath = info.rec.source ?? "";
  const blocks = info.codeBlocks?.length ? info.codeBlocks : [{
    code: info.code,
    lang: info.lang,
    lineOffset: info.lineOffset,
  }];

  const symRecords: SymbolRecord[] = [];
  const refRecords: RefRecord[] = [];
  const blockResults: {
    definitions: ReturnType<typeof extractSymbols>["definitions"];
    imports: ReturnType<typeof extractSymbols>["imports"];
    calls: ReturnType<typeof extractSymbols>["calls"];
    lineOffset: number;
  }[] = [];

  for (const block of blocks) {
    const extracted = extractSymbols(block.code, block.lang, importerPath);
    blockResults.push({ ...extracted, lineOffset: block.lineOffset });
  }

  // ── 存符号 ──
  for (const result of blockResults) {
    for (const d of result.definitions) {
      symRecords.push({
        handle,
        name: d.name,
        kind: d.kind,
        startLine: d.startLine + result.lineOffset,
        endLine: d.endLine + result.lineOffset,
        bodyText: d.bodyText,
        signature: d.signature,
        exported: d.exported,
        lang: info.sourceLang ?? info.lang,
        createdAt: now,
      });
    }
  }
  store.saveSymbols(handle, symRecords);

  // ── 存引用 ──
  const localNames = new Set(blockResults.flatMap((result) => result.definitions.map((d) => d.name)));
  const allImports = blockResults.flatMap((result) => result.imports);

  // calls → call 边
  for (const result of blockResults) {
    for (const c of result.calls) {
      const isPlain = !c.calleeName.includes(".");
      const target = isPlain
        ? resolveCallTarget(handle, c.calleeName, localNames, allImports, importerPath)
        : { toHandle: undefined as string | undefined };
      refRecords.push({
        fromHandle: handle,
        fromSymbol: c.callerSymbol ?? undefined,
        toHandle: target.toHandle,
        toSymbol: c.calleeName,
        refType: "call",
        line: c.line + result.lineOffset,
        resolved: !!target.toHandle,
        importSrc: target.importSrc,
        createdAt: now,
      });
    }
  }

  // imports → import 边(每个导入名一条,便于跨文件符号查找)
  for (const result of blockResults) {
    for (const imp of result.imports) {
      const toHandle = resolveImportHandle(importerPath, imp.source);
      if (imp.importedNames.length === 0) {
        // 副作用 import(无导入名):存一条占位,to_symbol 用 source 标记
        refRecords.push({
          fromHandle: handle,
          fromSymbol: undefined,
          toHandle,
          toSymbol: "(side-effect)",
          refType: "import",
          line: imp.line + result.lineOffset,
          resolved: !!toHandle,
          importSrc: imp.source,
          createdAt: now,
        });
      } else {
        for (const name of imp.importedNames) {
          refRecords.push({
            fromHandle: handle,
            fromSymbol: undefined,
            toHandle,
            toSymbol: name,
            refType: "import",
            line: imp.line + result.lineOffset,
            resolved: !!toHandle,
            importSrc: imp.source,
            createdAt: now,
          });
        }
      }
    }
  }

  store.saveReferences(handle, refRecords);
  return true;
}

/** 确保 handle 已索引(查 symbols 表,无则 indexCode)。返回是否为已索引代码。 */
async function ensureIndexed(handle: string): Promise<boolean> {
  if (store.hasSymbols(handle)) return true;
  return indexCode(handle);
}

// ─── 文件路径直接索引 ──────────────────────────────────────────────────────────

/**
 * 从文件路径读取、生成 handle、存储原文、索引代码。
 * 返回 handle 供后续 tok_code_map/tok_code_symbol/tok_code_refs 使用。
 * 这是 MCP 工具的入口:模型传 filePath,无需 Read 被压缩即可用代码图工具。
 */
export async function ensureFileIndexed(filePath: string): Promise<string> {
  const abs = filePath.replace(/\\/g, "/");
  if (!existsSync(abs)) {
    throw new Error(`文件不存在: ${abs}`);
  }
  const content = readFileSync(abs, "utf8");
  const handle = "h-" + createHash("sha256").update(abs).update(content).digest("hex").slice(0, 24);

  if (store.hasSymbols(handle)) return handle;

  const now = Date.now();
  const ext = abs.slice(abs.lastIndexOf(".") + 1).toLowerCase();
  store.saveOriginalWithHandle(handle, content, { source: abs, tool: "Read" }, now);
  await indexCode(handle);
  return handle;
}

// ─── 检索:代码结构图 ──────────────────────────────────────────────────────

/**
 * 返回一个文件级结构图。对普通 TS/JS 返回符号/导入/调用概览;
 * 对 Vue SFC 额外返回 template/script/style、组件、事件、绑定。
 */
export async function retrieveCodeMap(handle: string): Promise<GraphResult> {
  const info = codeInfoForHandle(handle);
  if (!info?.rec) return { text: `❌ handle=${handle} 不存在`, retrieved: false };
  if (!info.lang && !info.vue) {
    return {
      text: `❌ handle=${handle} 非代码文件(来源:${info.rec.source ?? "?"})。可用 tok_retrieve 检索。`,
      retrieved: false,
    };
  }

  if (info.lang) await ensureIndexed(handle);
  const symbols = store.getSymbols(handle);
  const source = sourceOf(handle);
  const lines: string[] = [
    `代码结构图 handle=${handle}`,
    `来源: ${source}`,
    `类型: ${info.vue ? "Vue SFC" : info.sourceLang ?? info.lang ?? "code"}`,
    "",
  ];

  if (info.vue) {
    const vue = info.vue;
    lines.push("Vue SFC 分区:");
    lines.push(`  template: ${vue.template ? `行${vue.template.startLine}+` : "无"}`);
    lines.push(`  script: ${vue.scripts.length} 个${vue.scripts.length ? ` (${vue.scripts.map((s) => `行${s.startLine}${s.lang ? ` lang=${s.lang}` : ""}${s.setup ? " setup" : ""}`).join(", ")})` : ""}`);
    lines.push(`  style: ${vue.styleCount} 个`);
    if (vue.components.length) lines.push(`  组件引用: ${vue.components.join(", ")}`);
    if (vue.events.length) lines.push(`  事件监听: ${vue.events.join(", ")}`);
    if (vue.bindings.length) lines.push(`  属性/模型绑定: ${vue.bindings.join(", ")}`);
    if (vue.parseErrors.length) lines.push(`  解析警告: ${vue.parseErrors.slice(0, 3).join("; ")}`);
    lines.push("");
  }

  if (symbols.length > 0) {
    lines.push("符号列表:");
    const { shown, omitted } = cappedList(symbols, MAX_MAP_SYMBOLS);
    for (const s of shown) {
      lines.push(`  [${s.kind}] ${s.name} 行${s.startLine}-${s.endLine}${s.exported ? " (exported)" : ""} (${(s.bodyText ?? "").length}字符) — ${oneLine(s.signature)}`);
    }
    if (omitted) lines.push(`  ... 另有 ${omitted} 个符号省略,可用 tok_code_symbol(handle="${handle}", query="关键词") 精查`);
  } else if (info.lang) {
    lines.push("符号列表: 未提取到函数/类/命名箭头函数。");
  }

  const callLines: string[] = [];
  for (const s of symbols.slice(0, MAX_MAP_SYMBOLS)) {
    if (callLines.length >= MAX_MAP_CALL_ROWS) break;
    const refs = store.getReferences(handle, "callees", s.name);
    if (refs.length === 0) continue;
    const compact = refs.slice(0, 8).map((r) =>
      `${r.toSymbol}@${r.line}${r.resolved ? "" : r.importSrc ? `(import:${r.importSrc})` : ""}`
    ).join(", ");
    callLines.push(`  ${s.name} -> ${compact}${refs.length > 8 ? ` ... +${refs.length - 8}` : ""}`);
  }
  if (callLines.length > 0) {
    lines.push("");
    lines.push("调用概览:");
    lines.push(...callLines);
    if (callLines.length >= MAX_MAP_CALL_ROWS) {
      lines.push(`  ... 调用概览已截断,可用 tok_code_refs(handle="${handle}", symbol="方法名", direction="callees") 精查`);
    }
  }

  if (info.vue) {
    lines.push("");
    lines.push("建议用法:");
    lines.push(`  - 查结构: tok_code_map(handle="${handle}")`);
    lines.push(`  - 查符号: tok_code_symbol(handle="${handle}", symbol="方法名")`);
    lines.push(`  - 查调用: tok_code_refs(handle="${handle}", symbol="方法名", direction="callees")`);
    lines.push(`  - 查模板片段: tok_retrieve(handle="${handle}", query="组件名或事件名")`);
  }

  return { text: lines.join("\n"), retrieved: true };
}

// ─── 检索:符号定义 ──────────────────────────────────────────────────────────

/**
 * 取符号定义。
 *  - symbol 精确:返回该符号完整 body + 同文件调用关系
 *  - query 模糊:返回匹配符号的签名 + 位置(列表)
 *  - 都不给:返回所有符号概览(Aider repo-map 风格,仅签名)
 */
export async function retrieveSymbol(
  handle: string,
  symbol?: string,
  query?: string,
  options: SymbolViewOptions = {}
): Promise<GraphResult> {
  const info = codeInfoForHandle(handle);
  if (!info?.rec) return { text: `❌ handle=${handle} 不存在`, retrieved: false };
  if (!info.lang) {
    return {
      text: `❌ handle=${handle} 非代码文件或无可解析脚本(来源:${info.rec.source ?? "?"})。tok_code_symbol 支持 TS/JS/Vue SFC script。用 tok_retrieve 检索。`,
      retrieved: false,
    };
  }
  if (!(await ensureIndexed(handle))) {
    return { text: `❌ handle=${handle} 索引失败`, retrieved: false };
  }

  const src = sourceOf(handle);

  // 模式1:精确符号
  if (symbol) {
    let sym = store.findSymbolByName(handle, symbol);
    if (!sym) {
      const fuzzy = store.findSymbolFuzzy(handle, symbol);
      if (fuzzy.length === 0) {
        return {
          text: `handle=${handle}(${src})未找到符号「${symbol}」。可用 tok_code_symbol(handle="${handle}") 列出所有符号,或换名。`,
          retrieved: false,
        };
      }
      // 多个模糊匹配:列出让模型选
      if (fuzzy.length === 1) {
        sym = fuzzy[0];
      } else {
        const { shown, omitted } = cappedList(fuzzy, MAX_FUZZY_SYMBOLS);
        const list = shown
          .map((s) => `  [${s.kind}] ${s.name} 行${s.startLine}-${s.endLine}${s.exported ? " (exported)" : ""}`)
          .join("\n");
        return {
          text: `「${symbol}」匹配多个符号,请用精确名重查:\n${list}${omitted ? `\n  ... 另有 ${omitted} 个匹配省略` : ""}`,
          retrieved: true,
        };
      }
    }
    return { text: formatSymbol(handle, sym, src, options), retrieved: true };
  }

  // 模式2:模糊 query
  if (query) {
    const fuzzy = store.findSymbolFuzzy(handle, query);
    if (fuzzy.length === 0) {
      return { text: `handle=${handle}(${src})未找到含「${query}」的符号。`, retrieved: false };
    }
    const { shown, omitted } = cappedList(fuzzy, MAX_FUZZY_SYMBOLS);
    const list = shown
      .map((s) => `  [${s.kind}] ${s.name} 行${s.startLine}-${s.endLine}${s.exported ? " (exported)" : ""} — ${oneLine(s.signature)}`)
      .join("\n");
    return { text: `handle=${handle}(${src})含「${query}」的符号:\n${list}${omitted ? `\n  ... 另有 ${omitted} 个匹配省略,请缩小 query` : ""}`, retrieved: true };
  }

  // 模式3:所有符号概览
  const all = store.getSymbols(handle);
  if (all.length === 0) {
    return { text: `handle=${handle}(${src})未提取到符号。`, retrieved: false };
  }
  const { shown, omitted } = cappedList(all, MAX_MAP_SYMBOLS);
  const list = shown
    .map((s) => `  [${s.kind}] ${s.name} 行${s.startLine}-${s.endLine}${s.exported ? " (exported)" : ""} — ${oneLine(s.signature)}`)
    .join("\n");
  return { text: `handle=${handle}(${src})符号列表:\n${list}${omitted ? `\n  ... 另有 ${omitted} 个符号省略,请用 query 精查` : ""}`, retrieved: true };
}

/** 格式化单个符号:完整 body + 同文件 callers/callees */
function formatSymbol(handle: string, sym: SymbolRecord, src: string, options: SymbolViewOptions): string {
  const lines: string[] = [];
  lines.push(`符号 ${sym.name}(handle=${handle},来源:${src}):`);
  lines.push("");
  lines.push(`〔${sym.kind}${sym.exported ? " · exported" : ""} · 行${sym.startLine}-${sym.endLine}〕`);
  lines.push(`签名: ${oneLine(sym.signature ?? "")}`);
  if (options.includeBody) {
    const budget = normalizeBodyBudget(options.maxBodyChars);
    const body = sym.bodyText ?? sym.signature ?? "";
    if (body.length > budget) {
      lines.push(`实现预览(前 ${budget}/${body.length} 字符):`);
      lines.push(`${body.slice(0, budget).trimEnd()}\n[frugal: 实现被截断,可用 tok_code_symbol(handle="${handle}", symbol="${sym.name}", includeBody=true, maxBodyChars=${Math.min(MAX_SYMBOL_BODY_CHARS, body.length)}) 获取完整实现]`);
    } else {
      lines.push(`实现(完整 ${body.length} 字符):`);
      lines.push(body);
    }
  } else {
    const bodyLen = (sym.bodyText ?? "").length;
    lines.push(`实现未内联${bodyLen > 0 ? `(约 ${bodyLen} 字符)` : ""}。需要源码时用: tok_code_symbol(handle="${handle}", symbol="${sym.name}", includeBody=true)`);
  }
  lines.push("");

  // 同文件调用关系
  const callees = store.getReferences(handle, "callees", sym.name);
  const callers = store.getReferences(handle, "callers", sym.name);
  if (callees.length > 0) {
    lines.push(`本符号调用(callees):`);
    const { shown, omitted } = cappedList(callees, MAX_REFS_PER_SYMBOL);
    for (const r of shown) {
      lines.push(`  ${r.toSymbol}(行${r.line})${r.resolved ? "" : r.importSrc ? ` — imported from ${r.importSrc}` : ""}`);
    }
    if (omitted) lines.push(`  ... 另有 ${omitted} 条调用省略,可用 tok_code_refs 精查`);
  }
  if (callers.length > 0) {
    lines.push(`本文件内被调用(callers):`);
    const { shown, omitted } = cappedList(callers, MAX_REFS_PER_SYMBOL);
    for (const r of shown) {
      lines.push(`  ${r.fromSymbol ?? "?"}(行${r.line})`);
    }
    if (omitted) lines.push(`  ... 另有 ${omitted} 条调用方省略,可用 tok_code_refs 精查`);
  }
  return lines.join("\n");
}

// ─── 检索:调用关系 ──────────────────────────────────────────────────────────

/**
 * 取 callers/callees,跨文件自动解析。
 *  - callees:symbol 调用了谁(含跨文件,深度递归 ≤ depth)
 *  - callers:谁调用了 symbol(本文件 + 跨文件已解析的 import 指向)
 */
export async function retrieveRefs(
  handle: string,
  symbol: string,
  direction: "callers" | "callees",
  depth = 1
): Promise<GraphResult> {
  const info = codeInfoForHandle(handle);
  if (!info?.rec) return { text: `❌ handle=${handle} 不存在`, retrieved: false };
  if (!info.lang) {
    return { text: `❌ handle=${handle} 非代码文件或无可解析脚本。tok_code_refs 支持 TS/JS/Vue SFC script。`, retrieved: false };
  }
  if (!(await ensureIndexed(handle))) {
    return { text: `❌ handle=${handle} 索引失败`, retrieved: false };
  }

  // 确认符号存在(精确或模糊)
  let sym = store.findSymbolByName(handle, symbol);
  if (!sym) {
    const fuzzy = store.findSymbolFuzzy(handle, symbol);
    if (fuzzy.length === 1) sym = fuzzy[0];
    else if (fuzzy.length > 1) {
      const list = fuzzy.map((s) => `  [${s.kind}] ${s.name} 行${s.startLine}`).join("\n");
      return { text: `「${symbol}」匹配多个符号,请用精确名:\n${list}`, retrieved: true };
    } else {
      return { text: `handle=${handle}(${sourceOf(handle)})未找到符号「${symbol}」。`, retrieved: false };
    }
  }

  const src = sourceOf(handle);
  const lines: string[] = [];
  const visited = new Set<string>(); // 防 callee 递归成环

  if (direction === "callees") {
    lines.push(`${sym.name} 调用了(handle=${handle},来源:${src}):`);
    lines.push("");
    const before = lines.length;
    await collectCallees(handle, sym.name, src, 1, Math.min(depth, 3), visited, lines, "");
    if (lines.length === before) lines.push("  (无调用关系记录)");
  } else {
    lines.push(`谁调用了 ${sym.name}(handle=${handle},来源:${src}):`);
    lines.push("");
    const before = lines.length;
    collectCallers(handle, sym.name, src, lines);
    if (lines.length === before) lines.push("  (无被调用关系记录)");
  }
  return { text: lines.join("\n"), retrieved: true };
}

/** 递归收集 callees(跨文件,深度限制) */
async function collectCallees(
  handle: string,
  symbol: string,
  src: string,
  level: number,
  maxDepth: number,
  visited: Set<string>,
  out: string[],
  indent: string
): Promise<void> {
  const key = `${handle}:${symbol}`;
  if (visited.has(key)) {
    out.push(`${indent}▸ ${symbol}(环回,已展示)`);
    return;
  }
  visited.add(key);

  const refs = store.getReferences(handle, "callees", symbol);
  const { shown, omitted } = cappedList(refs, MAX_REFS_PER_SYMBOL);
  for (const r of shown) {
    if (out.length >= MAX_REF_LINES) {
      out.push(`${indent}... 调用关系输出达到预算上限,请缩小 symbol/depth 精查`);
      return;
    }
    if (r.toHandle) {
      // 已解析到某 handle
      if (r.toHandle === handle) {
        // 同文件
        const tgt = store.findSymbolByName(handle, r.toSymbol);
        out.push(
          `${indent}▸ ${r.toSymbol}(行${r.line}) [同文件]${tgt ? ` — ${tgt.signature}` : ""}`
        );
        if (level < maxDepth && tgt) {
          await collectCallees(handle, r.toSymbol, src, level + 1, maxDepth, visited, out, indent + "  ");
        }
      } else {
        // 跨文件:to_handle 是另一个已读文件
        await ensureIndexed(r.toHandle);
        const tgtSrc = sourceOf(r.toHandle);
        const tgt = store.findSymbolByName(r.toHandle, r.toSymbol);
        out.push(
          `${indent}▸ ${r.toSymbol}(行${r.line}) [跨文件 ← ${tgtSrc}]${tgt ? ` — ${tgt.signature}` : ""}`
        );
        if (level < maxDepth && tgt) {
          await collectCallees(r.toHandle, r.toSymbol, tgtSrc, level + 1, maxDepth, visited, out, indent + "  ");
        }
      }
    } else {
      // 未解析
      if (r.importSrc) {
        out.push(`${indent}▸ ${r.toSymbol}(行${r.line}) — imported from ${r.importSrc},未读。建议 Read 该文件后重查`);
      } else if (r.toSymbol.includes(".")) {
        out.push(`${indent}▸ ${r.toSymbol}(行${r.line}) — 成员调用(如 obj.method),未解析`);
      } else {
        out.push(`${indent}▸ ${r.toSymbol}(行${r.line}) — 未解析(内置/全局?)`);
      }
    }
  }
  if (omitted) out.push(`${indent}... 另有 ${omitted} 条调用省略,请缩小查询`);
}

/** 收集 callers(本文件内 + 跨文件已解析指向本 handle 的) */
function collectCallers(handle: string, symbol: string, src: string, out: string[]): void {
  const refs = store.getReferences(handle, "callers", symbol);
  const { shown, omitted } = cappedList(refs, MAX_REFS_PER_SYMBOL);
  for (const r of shown) {
    if (out.length >= MAX_REF_LINES) {
      out.push("  ... 调用方输出达到预算上限,请缩小查询");
      return;
    }
    if (r.fromHandle === handle) {
      // 同文件内调用方
      const caller = r.fromSymbol ? store.findSymbolByName(handle, r.fromSymbol) : undefined;
      out.push(`  ▸ ${r.fromSymbol ?? "?"}(行${r.line}) [同文件]${caller ? ` — ${caller.signature}` : ""}`);
    } else {
      // 跨文件调用方(from_handle 是另一个文件,它 import 了本符号)
      const callerSrc = sourceOf(r.fromHandle);
      const caller = r.fromSymbol ? store.findSymbolByName(r.fromHandle, r.fromSymbol) : undefined;
      out.push(`  ▸ ${r.fromSymbol ?? "?"}(行${r.line}) [跨文件 ← ${callerSrc}]${caller ? ` — ${caller.signature}` : ""}`);
    }
  }
  if (omitted) out.push(`  ... 另有 ${omitted} 条调用方省略,请缩小查询`);
}
