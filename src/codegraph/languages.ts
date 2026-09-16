/**
 * languages.ts —— 代码语言元数据(纯数据,无依赖)
 *
 * 这是 src/codegraph/ 里唯一可以被 hook 安全 import 的模块:
 *   hook 每次调用都是新 Node 进程,不能背代码解析器依赖与初始化开销。
 *   hook 只需用 langForExt() 判定 Read 的文件是不是代码,据此选不同的 note 文案。
 *   extract.ts/graph.ts 才 import ts-morph / Vue compiler,且只被 MCP server(长驻)加载。
 *
 * TS/JS 优先(MVP 范围):覆盖常见 TS/JS 扩展名,用 ts-morph 提取符号。
 * .vue 由 graph.ts 先抽取 <script>/<script setup> 后再按 TS/JS 解析,
 * SFC/template 结构由 @vue/compiler-sfc 提取。
 */

import { dirname, resolve, join } from "node:path";

/** frugal 支持的代码扩展名(命中即走 AST 检索路径) */
export const CODE_LANGS = new Set([
  "ts", "tsx", "js", "jsx", "cjs", "mjs", "cts", "mts", "vue",
]);

/** 代码解析语言标识。 */
export type CodeLang = "typescript" | "tsx" | "javascript" | "jsx";

/**
 * 扩展名 → 语法包。返回 undefined 表示非代码(走原 tok_retrieve 扁平检索)。
 *
 * 分配依据(ts-morph / TypeScript ScriptKind):
 *   - typescript:TS 语法(.cts/.mts 是 TS 的 ESM/CJS 变体)
 *   - tsx:TS + JSX
 *   - javascript:JS 语法(.cjs/.mjs 是 JS 的 ESM/CJS 变体)
 *   - jsx:JS + JSX
 */
export function langForExt(ext: string): CodeLang | undefined {
  switch (ext) {
    case "ts":
    case "cts":
    case "mts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "jsx":
      return "jsx";
    case "js":
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

  const EXTS = [".ts", ".tsx", ".js", ".jsx", ".cts", ".mts", ".cjs", ".mjs", ".vue"];
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
