/**
 * graph.ts —— 建图 + 持久化 + 检索 + 跨文件解析(仅 MCP)
 *
 * 参考 CodeGraph "解析"阶段 + Aider 精简签名思路。
 *
 * 流程:
 *   indexCode(handle) —— 取 orig-N 原文 → parseCode → extractSymbols
 *                         → 存 symbols / refs 表(幂等)。import 路径尝试解析到已读文件。
 *   retrieveSymbol    —— 取符号定义(完整 body)+ 同文件调用关系。
 *   retrieveRefs      —— callers/callees,跨文件:to_handle 已解析则递归取该符号(深度≤3),
 *                         未读则提示 Read。
 *
 * 查询前 ensureIndexed:查 symbols 表有无记录,无则触发 indexCode。
 */

import { store } from "../store/db";
import type { SymbolRecord, RefRecord } from "../store/db";
import { parseCode } from "./parser";
import { extractSymbols } from "./extract";
import { langForExt, resolveImportPath } from "./languages";
import type { CodeLang } from "./languages";

/** 取回结果:text 给模型看;retrieved 表示是否实际取回了内容(供 incrementRetrieved) */
export interface GraphResult {
  text: string;
  retrieved: boolean;
}

// ─── 语言判定 ────────────────────────────────────────────────────────────────

/** 从 handle 的原文 source 路径推断代码语言。非代码/无 source 返回 undefined。 */
function langForHandle(handle: string): CodeLang | undefined {
  const rec = store.getOriginal(handle);
  if (!rec?.source) return undefined;
  const dot = rec.source.lastIndexOf(".");
  const ext = dot >= 0 ? rec.source.slice(dot + 1).toLowerCase() : "";
  return langForExt(ext);
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
  const rec = store.getOriginal(handle);
  if (!rec) return false;
  const lang = langForHandle(handle);
  if (!lang) return false; // 非代码语言,不索引

  const root = await parseCode(rec.content, lang);
  const { definitions, imports, calls } = extractSymbols(root);
  const now = rec.createdAt;
  const importerPath = rec.source ?? "";

  // ── 存符号 ──
  const symRecords: SymbolRecord[] = definitions.map((d) => ({
    handle,
    name: d.name,
    kind: d.kind,
    startLine: d.startLine,
    endLine: d.endLine,
    bodyText: d.bodyText,
    signature: d.signature,
    exported: d.exported,
    lang,
    createdAt: now,
  }));
  store.saveSymbols(handle, symRecords);

  // ── 存引用 ──
  const localNames = new Set(definitions.map((d) => d.name));
  const refRecords: RefRecord[] = [];

  // calls → call 边
  for (const c of calls) {
    const isPlain = !c.calleeName.includes(".");
    const target = isPlain
      ? resolveCallTarget(handle, c.calleeName, localNames, imports, importerPath)
      : { toHandle: undefined as string | undefined };
    refRecords.push({
      fromHandle: handle,
      fromSymbol: c.callerSymbol,
      toHandle: target.toHandle,
      toSymbol: c.calleeName,
      refType: "call",
      line: c.line,
      resolved: !!target.toHandle,
      importSrc: target.importSrc,
      createdAt: now,
    });
  }

  // imports → import 边(每个导入名一条,便于跨文件符号查找)
  for (const imp of imports) {
    const toHandle = resolveImportHandle(importerPath, imp.source);
    if (imp.importedNames.length === 0) {
      // 副作用 import(无导入名):存一条占位,to_symbol 用 source 标记
      refRecords.push({
        fromHandle: handle,
        fromSymbol: null,
        toHandle,
        toSymbol: "(side-effect)",
        refType: "import",
        line: imp.line,
        resolved: !!toHandle,
        importSrc: imp.source,
        createdAt: now,
      });
    } else {
      for (const name of imp.importedNames) {
        refRecords.push({
          fromHandle: handle,
          fromSymbol: null,
          toHandle,
          toSymbol: name,
          refType: "import",
          line: imp.line,
          resolved: !!toHandle,
          importSrc: imp.source,
          createdAt: now,
        });
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
  query?: string
): Promise<GraphResult> {
  const rec = store.getOriginal(handle);
  if (!rec) return { text: `❌ handle=${handle} 不存在`, retrieved: false };
  const lang = langForHandle(handle);
  if (!lang) {
    return {
      text: `❌ handle=${handle} 非代码文件(来源:${rec.source ?? "?"})。tok_code_symbol 仅支持 TS/JS。用 tok_retrieve 检索。`,
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
        const list = fuzzy
          .map((s) => `  [${s.kind}] ${s.name} 行${s.startLine}-${s.endLine}${s.exported ? " (exported)" : ""}`)
          .join("\n");
        return {
          text: `「${symbol}」匹配多个符号,请用精确名重查:\n${list}`,
          retrieved: true,
        };
      }
    }
    return { text: formatSymbol(handle, sym, src), retrieved: true };
  }

  // 模式2:模糊 query
  if (query) {
    const fuzzy = store.findSymbolFuzzy(handle, query);
    if (fuzzy.length === 0) {
      return { text: `handle=${handle}(${src})未找到含「${query}」的符号。`, retrieved: false };
    }
    const list = fuzzy
      .map((s) => `  [${s.kind}] ${s.name} 行${s.startLine}-${s.endLine}${s.exported ? " (exported)" : ""} — ${s.signature}`)
      .join("\n");
    return { text: `handle=${handle}(${src})含「${query}」的符号:\n${list}`, retrieved: true };
  }

  // 模式3:所有符号概览
  const all = store.getSymbols(handle);
  if (all.length === 0) {
    return { text: `handle=${handle}(${src})未提取到符号。`, retrieved: false };
  }
  const list = all
    .map((s) => `  [${s.kind}] ${s.name} 行${s.startLine}-${s.endLine}${s.exported ? " (exported)" : ""} — ${s.signature}`)
    .join("\n");
  return { text: `handle=${handle}(${src})符号列表:\n${list}`, retrieved: true };
}

/** 格式化单个符号:完整 body + 同文件 callers/callees */
function formatSymbol(handle: string, sym: SymbolRecord, src: string): string {
  const lines: string[] = [];
  lines.push(`符号 ${sym.name}(handle=${handle},来源:${src}):`);
  lines.push("");
  lines.push(`〔${sym.kind}${sym.exported ? " · exported" : ""} · 行${sym.startLine}-${sym.endLine}〕`);
  lines.push(`完整实现:`);
  lines.push(sym.bodyText ?? sym.signature);
  lines.push("");

  // 同文件调用关系
  const callees = store.getReferences(handle, "callees", sym.name);
  const callers = store.getReferences(handle, "callers", sym.name);
  if (callees.length > 0) {
    lines.push(`本符号调用(callees):`);
    for (const r of callees) {
      lines.push(`  ${r.toSymbol}(行${r.line})${r.resolved ? "" : r.importSrc ? ` — imported from ${r.importSrc}` : ""}`);
    }
  }
  if (callers.length > 0) {
    lines.push(`本文件内被调用(callers):`);
    for (const r of callers) {
      lines.push(`  ${r.fromSymbol ?? "?"}(行${r.line})`);
    }
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
  const rec = store.getOriginal(handle);
  if (!rec) return { text: `❌ handle=${handle} 不存在`, retrieved: false };
  const lang = langForHandle(handle);
  if (!lang) {
    return { text: `❌ handle=${handle} 非代码文件。tok_code_refs 仅支持 TS/JS。`, retrieved: false };
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
  for (const r of refs) {
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
}

/** 收集 callers(本文件内 + 跨文件已解析指向本 handle 的) */
function collectCallers(handle: string, symbol: string, src: string, out: string[]): void {
  const refs = store.getReferences(handle, "callers", symbol);
  for (const r of refs) {
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
}
