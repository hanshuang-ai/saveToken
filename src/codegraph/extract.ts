/**
 * extract.ts —— 用 ts-morph 提取 TS/JS 符号、导入、调用(仅 MCP)
 *
 * 原则:语法/语义基础能力优先交给成熟开源库。这里使用 ts-morph
 * 包装 TypeScript Compiler API,本文件只负责把结果裁剪成插件的轻量图谱模型。
 */

import {
  Node,
  Project,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type CallExpression,
  type ClassDeclaration,
  type FunctionDeclaration,
  type ImportDeclaration,
  type MethodDeclaration,
  type Node as MorphNode,
  type SourceFile,
  type VariableDeclaration,
} from "ts-morph";
import type { CodeLang } from "./languages";

/** 符号定义 */
export interface Definition {
  name: string;
  kind: "function" | "class" | "method" | "variable";
  startLine: number; // 1-based,对齐当前代码片段行号
  endLine: number;
  bodyText: string; // 完整实现(主符号取回用)
  signature: string; // 精简签名(引用符号取回用)
  exported: boolean;
}

/** import 信息 */
export interface ImportInfo {
  importedNames: string[]; // 命名/默认/namespace 导入名;空=副作用 import
  source: string; // 源字符串原始值(如 ./fileB)
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

let sourceSeq = 0;

function scriptKindForLang(lang: CodeLang): ScriptKind {
  if (lang === "tsx") return ScriptKind.TSX;
  if (lang === "jsx") return ScriptKind.JSX;
  if (lang === "javascript") return ScriptKind.JS;
  return ScriptKind.TS;
}

function createSourceFile(code: string, lang: CodeLang, sourcePath?: string): SourceFile {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      jsx: lang === "tsx" ? 4 : undefined,
      target: ScriptTarget.Latest,
    },
  });
  const ext = lang === "tsx" ? "tsx" : lang === "jsx" ? "jsx" : lang === "javascript" ? "js" : "ts";
  const path = sourcePath && /\.[cm]?[jt]sx?$/.test(sourcePath)
    ? sourcePath
    : `/virtual/frugal-${++sourceSeq}.${ext}`;
  return project.createSourceFile(path, code, {
    overwrite: true,
    scriptKind: scriptKindForLang(lang),
  });
}

function startLine(node: MorphNode): number {
  return node.getSourceFile().getLineAndColumnAtPos(node.getStart()).line;
}

function endLine(node: MorphNode): number {
  return node.getSourceFile().getLineAndColumnAtPos(node.getEnd()).line;
}

function makeSignature(text: string): string {
  const brace = text.indexOf("{");
  const arrow = text.indexOf("=>");
  let cut = -1;
  if (brace >= 0 && (arrow < 0 || brace < arrow)) cut = brace;
  else if (arrow >= 0) cut = arrow;
  if (cut > 0) return text.slice(0, cut).trim().replace(/[\s;]+$/, "");
  return text.split("\n")[0].trim();
}

function hasExportModifier(node: MorphNode): boolean {
  return Node.isModifierable(node) &&
    node.getModifiers().some((modifier) => modifier.getKind() === SyntaxKind.ExportKeyword);
}

function definitionFromFunction(node: FunctionDeclaration): Definition | undefined {
  const name = node.getName();
  if (!name) return undefined;
  const text = node.getText();
  return {
    name,
    kind: "function",
    startLine: startLine(node),
    endLine: endLine(node),
    bodyText: text,
    signature: makeSignature(text),
    exported: hasExportModifier(node),
  };
}

function definitionFromClass(node: ClassDeclaration): Definition | undefined {
  const name = node.getName();
  if (!name) return undefined;
  const text = node.getText();
  return {
    name,
    kind: "class",
    startLine: startLine(node),
    endLine: endLine(node),
    bodyText: text,
    signature: makeSignature(text),
    exported: hasExportModifier(node),
  };
}

function definitionFromMethod(node: MethodDeclaration): Definition | undefined {
  const name = node.getName();
  if (!name) return undefined;
  const text = node.getText();
  return {
    name,
    kind: "method",
    startLine: startLine(node),
    endLine: endLine(node),
    bodyText: text,
    signature: makeSignature(text),
    exported: hasExportModifier(node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration) ?? node),
  };
}

function definitionFromVariable(node: VariableDeclaration): Definition | undefined {
  const initializer = node.getInitializer();
  if (!initializer || (!Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer))) {
    return undefined;
  }
  const name = node.getName();
  const text = node.getText();
  return {
    name,
    kind: "variable",
    startLine: startLine(node),
    endLine: endLine(node),
    bodyText: text,
    signature: makeSignature(text),
    exported: Boolean(node.getVariableStatement()?.hasExportKeyword()),
  };
}

function importInfoFromDeclaration(node: ImportDeclaration): ImportInfo {
  const clause = node.getImportClause();
  const importedNames: string[] = [];
  const defaultImport = clause?.getDefaultImport()?.getText();
  if (defaultImport) importedNames.push(defaultImport);
  const namespaceImport = clause?.getNamespaceImport()?.getText();
  if (namespaceImport) importedNames.push(namespaceImport);
  for (const named of clause?.getNamedImports() ?? []) {
    const alias = named.getAliasNode()?.getText();
    importedNames.push(alias ?? named.getName());
  }
  return {
    importedNames,
    source: node.getModuleSpecifierValue(),
    line: startLine(node),
  };
}

function callerNameFor(node: MorphNode): string | null {
  let current: MorphNode | undefined = node;
  while ((current = current.getParent())) {
    if (Node.isFunctionDeclaration(current)) return current.getName() ?? null;
    if (Node.isMethodDeclaration(current)) return current.getName();
    if (Node.isVariableDeclaration(current)) {
      const initializer = current.getInitializer();
      if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
        return current.getName();
      }
    }
  }
  return null;
}

function calleeNameFor(node: CallExpression): string {
  const expression = node.getExpression();
  if (Node.isPropertyAccessExpression(expression)) {
    const objectText = expression.getExpression().getText();
    const prop = expression.getName();
    if (objectText === "this" || objectText === "super") return prop;
    return `${objectText}.${prop}`;
  }
  return expression.getText();
}

export function extractSymbols(code: string, lang: CodeLang, sourcePath?: string): ExtractResult {
  const sourceFile = createSourceFile(code, lang, sourcePath);
  const definitions: Definition[] = [];
  const imports = sourceFile.getImportDeclarations().map(importInfoFromDeclaration);
  const calls: CallInfo[] = [];

  sourceFile.forEachDescendant((node) => {
    if (Node.isFunctionDeclaration(node)) {
      const def = definitionFromFunction(node);
      if (def) definitions.push(def);
    } else if (Node.isClassDeclaration(node)) {
      const def = definitionFromClass(node);
      if (def) definitions.push(def);
    } else if (Node.isMethodDeclaration(node)) {
      const def = definitionFromMethod(node);
      if (def) definitions.push(def);
    } else if (Node.isVariableDeclaration(node)) {
      const def = definitionFromVariable(node);
      if (def) definitions.push(def);
    } else if (Node.isCallExpression(node)) {
      calls.push({
        calleeName: calleeNameFor(node),
        callerSymbol: callerNameFor(node),
        line: startLine(node),
      });
    }
  });

  return { definitions, imports, calls };
}
