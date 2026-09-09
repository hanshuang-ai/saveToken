/**
 * parser.ts —— tree-sitter WASM 加载与解析(仅 MCP server 加载)
 *
 * 为什么放这里、不放 hook:hook 每次调用都是新 Bun 进式,WASM init(~数十 ms)+ 语法包
 * 加载开销大,且要背 wasm 部署。MCP server 长驻,init 一次复用,首次查某 handle 才解析。
 * hook 只 import languages.ts(纯数据),绝不碰 web-tree-sitter。
 *
 * WASM 加载(已验证,Bun 端到端通过,scripts/verify-wasm.ts):
 *   1. Parser.init({locateFile}) —— 加载 tree-sitter 运行时 wasm(web-tree-sitter.wasm)
 *   2. Language.load(grammarWasm) —— 加载某语言的语法 wasm
 *   3. new Parser() + parser.setLanguage(lang) + parser.parse(code) → Tree → rootNode
 * wasm 定位用 require.resolve("pkg/package.json") 取包目录,保证从插件缓存任意位置都能找到。
 */

import { Parser, Language } from "web-tree-sitter";
import { join, dirname } from "node:path";
import type { CodeLang } from "./languages";

/** 语法 wasm 文件位置:语言 → {包名, wasm 文件名} */
const GRAMMAR: Record<CodeLang, { pkg: string; file: string }> = {
  typescript: { pkg: "tree-sitter-typescript", file: "tree-sitter-typescript.wasm" },
  tsx: { pkg: "tree-sitter-typescript", file: "tree-sitter-tsx.wasm" },
  javascript: { pkg: "tree-sitter-javascript", file: "tree-sitter-javascript.wasm" },
};

/** 取包根目录(require.resolve 定位真实 node_modules 位置,缓存部署也能找到) */
function pkgDir(pkg: string): string {
  return dirname(require.resolve(`${pkg}/package.json`));
}

function wasmPath(pkg: string, file: string): string {
  return join(pkgDir(pkg), file);
}

// ─── 单例 ────────────────────────────────────────────────────────────────────

/** Parser.init 只调一次(加载运行时 wasm)。重复调用可能报错,用 promise 去重。 */
let initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init({
      locateFile: (f: string) => wasmPath("web-tree-sitter", f),
    }).then(() => undefined);
  }
  return initPromise;
}

/** 每语言一个 Parser(已 setLanguage),避免共享 parser 并发 setLanguage 竞态。 */
const parserCache = new Map<CodeLang, Parser>();
const langCache = new Map<CodeLang, Language>();

/**
 * 取某语言的 {parser, language}(懒加载 + 缓存)。
 * 首次:ensureInit → Language.load → new Parser + setLanguage。后续直接查缓存。
 */
export async function getParserForLang(
  lang: CodeLang
): Promise<{ parser: Parser; language: Language }> {
  const cachedParser = parserCache.get(lang);
  if (cachedParser) {
    return { parser: cachedParser, language: langCache.get(lang)! };
  }
  await ensureInit();
  const g = GRAMMAR[lang];
  const language = await Language.load(wasmPath(g.pkg, g.file));
  const parser = new Parser();
  parser.setLanguage(language);
  parserCache.set(lang, parser);
  langCache.set(lang, language);
  return { parser, language };
}

/** 取语言对象(extract.ts 建 Query 用) */
export async function getLanguage(lang: CodeLang): Promise<Language> {
  const { language } = await getParserForLang(lang);
  return language;
}

/** AST 节点(tree-sitter Node;类型按 web-tree-sitter 运行时形态用,字段: type/namedChildren/startPosition/endPosition/text/childForFieldName) */
export type AstNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildren: AstNode[];
  childForFieldName(name: string): AstNode | null;
  children: AstNode[];
};

/** 解析代码 → AST 根节点。code 为空或语法错返回 null(不抛)。 */
export async function parseCode(code: string, lang: CodeLang): Promise<AstNode | null> {
  const { parser } = await getParserForLang(lang);
  const tree = parser.parse(code);
  return (tree?.rootNode as unknown as AstNode) ?? null;
}
