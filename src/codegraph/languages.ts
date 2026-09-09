/**
 * languages.ts —— 代码语言元数据(纯数据,无依赖)
 *
 * 这是 src/codegraph/ 里唯一可以被 hook 安全 import 的模块:
 *   hook 每次调用都是新 Bun 进式,绝不能背 tree-sitter(WASM init 开销大、部署重)。
 *   hook 只需用 langForExt() 判定 Read 的文件是不是代码,据此选不同的 note 文案。
 *   parser.ts/extract.ts/graph.ts 才 import web-tree-sitter,且只被 MCP server(长驻)加载。
 *
 * TS/JS 优先(MVP 范围):覆盖 8 个扩展名,对应 3 个 tree-sitter 语法包。
 */

import { dirname, resolve, join } from "node:path";

/** frugal 支持的代码扩展名(命中即走 AST 检索路径) */
export const CODE_LANGS = new Set([
  "ts", "tsx", "js", "jsx", "cjs", "mjs", "cts", "mts",
]);

/** tree-sitter 语法包标识。对应 wasm 文件名前缀。 */
export type CodeLang = "typescript" | "tsx" | "javascript";

/**
 * 扩展名 → 语法包。返回 undefined 表示非代码(走原 tok_retrieve 扁平检索)。
 *
 * 分配依据(tree-sitter 语法包能力):
 *   - typescript:tree-sitter-typescript.wasm,TS 语法(.cts/.mts 是 TS 的 ESM/CJS 变体)
 *   - tsx:tree-sitter-tsx.wasm,TS + JSX
 *   - javascript:tree-sitter-javascript.wasm,JS + JSX(.cjs/.mjs 是 JS 的 ESM/CJS 变体)
 */
export function langForExt(ext: string): CodeLang | undefined {
  switch (ext) {
    case "ts":
    case "cts":
    case "mts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "js":
    case "jsx":
    case "cjs":
    case "mjs":
      return "javascript";
    default:
      return undefined;
  }
}

/**
 * 解析 import 的相对路径 → 候选绝对路径列表。
 *
 * frugal 跨文件解析只覆盖"已 Read 的文件"(orig-N 里存了 source 路径)。
 * 这里返回所有可能的绝对路径变体,graph.ts 逐个去 store.getOriginalBySource 比对,
 * 命中即说明该文件已被读、可跨文件解析;全部不命中 → 未读,提示模型 Read。
 *
 * 只处理相对路径(./ ../)。裸模块名(npm 包、bare specifier)无法解析 → 返回空。
 * 不做 barrel/re-export/动态 import/路径别名(@/)——这些降级为"未自动解析"。
 *
 * @param importerPath 正在解析的文件绝对路径(Read 时的 file_path)
 * @param importSrc    import 语句里的源字符串,如 "./fileB"、"../util"、"./idx"
 * @returns 候选绝对路径(去重),graph.ts 逐个比对 store
 */
export function resolveImportPath(importerPath: string, importSrc: string): string[] {
  // 只处理相对路径;bare specifier(npm 包等)不解析
  if (!importSrc.startsWith(".")) return [];

  const importerDir = dirname(importerPath);
  const base = resolve(importerDir, importSrc); // 绝对路径,可能无扩展名或带部分名

  const EXTS = [".ts", ".tsx", ".js", ".jsx", ".cts", ".mts", ".cjs", ".mjs"];
  const seen = new Set<string>();
  const candidates: string[] = [];

  const push = (p: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      candidates.push(p);
    }
  };

  // 1. 路径本身(importSrc 已带扩展名时,如 "./fileB.ts")
  push(base);
  // 2. 逐个追加扩展名(importSrc 无扩展名时,如 "./fileB")
  for (const ext of EXTS) push(base + ext);
  // 3. 目录入口(importSrc 指向目录,如 "./utils" → ./utils/index.ts)
  for (const ext of EXTS) push(join(base, "index" + ext));

  return candidates;
}
