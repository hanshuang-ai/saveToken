/**
 * extract.ts —— 从 AST 提取符号定义/导入/调用(仅 MCP)
 *
 * 用手动遍历而非 tree-sitter query:query 的字段名(type_identifier vs identifier)、
 * 包裹节点(export_statement)、跨语言差异(TS/JS/TSX)需逐案调 S 表达式,
 * 手动递归遍历 namedChildren + childForFieldName 更可控、跨语言一致。
 *
 * 参考 CodeGraph "提取"阶段 + Aider 符号签名思路:
 *   - 定义提取完整 body(主符号取回用)+ 精简 signature(引用符号取回用,控 token)
 *   - 调用记录 callerSymbol(栈顶)便于建 callers/callees 边
 *   - import 记 source + importedNames,供 graph.ts 跨文件解析
 */

import type { AstNode } from "./parser";

/** 符号定义 */
export interface Definition {
  name: string;
  kind: "function" | "class" | "method" | "variable";
  startLine: number; // 1-based,对齐原文行号
  endLine: number;
  bodyText: string; // 完整实现(主符号取回用)
  signature: string; // 精简签名(引用符号取回用)
  exported: boolean;
}

/** import 信息 */
export interface ImportInfo {
  importedNames: string[]; // 命名/默认导入名;空=副作用 import
  source: string; // 源字符串原始值(如 ./fileB,已去引号)
  line: number;
}

/** 调用信息 */
export interface CallInfo {
  calleeName: string; // foo / obj.method(含 . 的只对裸名解析)
  callerSymbol: string | null; // 所在函数/方法名(顶层为 null)
  line: number;
}

export interface ExtractResult {
  definitions: Definition[];
  imports: ImportInfo[];
  calls: CallInfo[];
}

// ─── 辅助 ────────────────────────────────────────────────────────────────────

const DEF_TYPES = new Set([
  "function_declaration",
  "class_declaration",
  "method_definition",
]);

/** 取节点名字段(兼容 identifier / type_identifier) */
function nodeName(node: AstNode): string {
  return node.childForFieldName("name")?.text ?? "";
}

/** 取节点起始行(1-based) */
function startLine(node: AstNode): number {
  return node.startPosition.row + 1;
}

/**
 * 构造精简签名:取 body 之前的声明头。
 * - function/method/class:第一个 `{` 之前
 * - 箭头/变量:第一个 `=>` 之前
 * 文本切分法,不依赖字段名,跨 TS/JS/TSX 一致。
 */
function makeSignature(text: string): string {
  const brace = text.indexOf("{");
  const arrow = text.indexOf("=>");
  let cut = -1;
  if (brace >= 0 && (arrow < 0 || brace < arrow)) cut = brace;
  else if (arrow >= 0) cut = arrow;
  if (cut > 0) return text.slice(0, cut).trim().replace(/[\s;]+$/, "");
  // 单行无 body(罕见):取首行
  return text.split("\n")[0].trim();
}

/** 去字符串字面量的引号 */
function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const f = s[0];
    const l = s[s.length - 1];
    if ((f === '"' && l === '"') || (f === "'" && l === "'") || (f === "`" && l === "`")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

// ─── 提取 ────────────────────────────────────────────────────────────────────

/**
 * 从 AST 根节点提取定义/导入/调用。
 * @param rootNode parseCode 返回的根节点
 */
export function extractSymbols(rootNode: AstNode | null): ExtractResult {
  const definitions: Definition[] = [];
  const imports: ImportInfo[] = [];
  const calls: CallInfo[] = [];
  if (!rootNode) return { definitions, imports, calls };

  // 调用方符号栈:进入函数/方法/箭头时压名,退出弹;记录调用时取栈顶
  const stack: string[] = [];

  function walk(node: AstNode): void {
    // ── 定义:函数/类/方法 ──
    if (DEF_TYPES.has(node.type)) {
      const name = nodeName(node);
      if (name) {
        const kind =
          node.type === "function_declaration"
            ? "function"
            : node.type === "class_declaration"
              ? "class"
              : "method";
        definitions.push({
          name,
          kind,
          startLine: startLine(node),
          endLine: node.endPosition.row + 1,
          bodyText: node.text,
          signature: makeSignature(node.text),
          exported: node.parent?.type === "export_statement",
        });
        stack.push(name);
        for (const c of node.namedChildren) walk(c);
        stack.pop();
        return;
      }
    }

    // ── 定义:命名箭头函数 / const f = function ...
    //  lexical_declaration → variable_declarator(name, value=arrow_function/function)
    if (node.type === "variable_declarator") {
      const value = node.childForFieldName("value");
      if (value && (value.type === "arrow_function" || value.type === "function_expression")) {
        const name = nodeName(node); // variable_declarator 的 name 字段
        if (name) {
          definitions.push({
            name,
            kind: "variable",
            startLine: startLine(node),
            endLine: node.endPosition.row + 1,
            bodyText: node.text,
            signature: makeSignature(node.text),
            exported: node.parent?.parent?.type === "export_statement",
          });
          stack.push(name);
          for (const c of node.namedChildren) walk(c);
          stack.pop();
          return;
        }
      }
    }

    // ── import ──
    if (node.type === "import_statement") {
      const info = parseImport(node);
      if (info) imports.push(info);
      // import 内部无定义/调用,不递归
      return;
    }

    // ── 调用 ──
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn) {
        let calleeName = fn.text;
        // this.X() / super.X() → 裸名 X。同类方法调用是最常见模式,
        // 存成 "this.X" 全名会让 callers 按裸名查不到;改存裸名 X 可解析到本文件定义。
        // 其它成员调用(obj.X / store.getOriginal)仍存全名,标成员调用未解析(需类型信息才能跨文件)。
        if (fn.type === "member_expression") {
          const obj = fn.childForFieldName("object");
          const prop = fn.childForFieldName("property");
          if (obj && prop && (obj.text === "this" || obj.text === "super")) {
            calleeName = prop.text;
          }
        }
        calls.push({
          calleeName,
          callerSymbol: stack.length > 0 ? stack[stack.length - 1] : null,
          line: startLine(node),
        });
      }
      // 调用参数里可能还有调用 f(g(x)),递归进去
    }

    // 递归子节点
    for (const c of node.namedChildren) walk(c);
  }

  walk(rootNode);
  return { definitions, imports, calls };
}

/** 解析 import_statement → {importedNames, source, line} */
function parseImport(node: AstNode): ImportInfo | null {
  let source = "";
  const names: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === "string") {
      source = stripQuotes(child.text);
    } else {
      // import_clause 的子树:收集所有 identifier(导入名)
      collectIdentifiers(child, names);
    }
  }
  if (!source) return null;
  return { importedNames: names, source, line: startLine(node) };
}

/** 递归收集 identifier 节点的文本(跳过 string/keyword) */
function collectIdentifiers(node: AstNode, out: string[]): void {
  if (node.type === "identifier") {
    out.push(node.text);
    return;
  }
  // namespace_import (* as ns) 里的 ns 是 identifier;named_imports 里 import_specifier.name
  for (const c of node.namedChildren) collectIdentifiers(c, out);
}
