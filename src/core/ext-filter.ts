/**
 * ext-filter.ts —— 扩展名/文件名快筛层
 *
 * 数据来源:13167 条真实决策库(BLOG 全量 + 车载日志包)反推。
 * 原则:有路径时扩展名/文件名比内容启发式准且快,优先用;无路径(Bash stdout)才退回内容判断。
 *
 * 三档:
 *   第一档 STRUCTURED_EXT:几乎100%结构化 → 直接判 structured,不读内容
 *   第二档 AMBIGUOUS_EXT:模糊(可能是散文)→ 给提示,内容细判
 *   无扩展名 NAME_KEYWORDS:文件名带类型线索 → structured;无线索 → 内容判断
 *
 * 关键教训(决策库数据):
 *   - .yml 111个 → 内容判 101/111 散文(配置文件内容松散),必须扩展名兜底
 *   - .md 827个 → 567/827 散文,绝不能放第一档
 *   - .html 637个 → 全是结构化/混合,无散文,可放第一档
 *   - 无扩展名 main_log_x / kernel_log_x → 文件名 log 关键词 163/182 结构化
 */

import type { ContentType } from "./types";

/** 第一档:明确结构化。命中即判 structured(覆盖代码/数据/配置/日志/二进制) */
const STRUCTURED_EXT = new Set([
  // 编程语言
  "js", "ts", "jsx", "tsx", "cjs", "mjs", "cts", "mts",
  "py", "rb", "go", "rs", "java", "c", "cpp", "cc", "h", "hpp", "cs",
  "swift", "kt", "kts", "scala", "lua", "php", "pl", "sh", "bash", "zsh",
  // 标记/样式/模板
  "css", "scss", "less", "html", "htm", "xml", "ejs", "jst", "hbs",
  "vue", "svelte", "astro",
  // 数据/配置(内容判断不可靠,必须扩展名兜底——.yml 实测 91% 被内容误判散文;
  //   .csv 同理:无 {} 强符号、行结构相似度未触发,实测判 prose → 必须扩展名兜底)
  "json", "yaml", "yml", "toml", "ini", "conf", "properties", "env",
  "csv", "tsv",
  "map", "wasm", "lock",
  // 日志/二进制/资源(命中即结构化)
  "log", "gz", "gzip", "zip", "tar", "tmp", "temp", "cache", "bak",
  "bin", "dat", "db", "sqlite", "node", "pack", "idx", "snap", "def",
  // 图片/字体/媒体(二进制,isBinary 会兜底,但扩展名先判)
  "png", "jpg", "jpeg", "gif", "ico", "webp", "mp4", "svg",
  "woff", "woff2", "ttf", "otf", "eot",
]);

/** 第二档:模糊。可能是散文也可能是结构化,交内容判断。仅记录扩展名供决策日志。 */
const AMBIGUOUS_EXT = new Set([
  "txt", "md", "markdown", "mdown", "mdwn",
  "rst", "tex", "org", "adoc", "asciidoc",
  "pug", "jade", "styl",
  "text",
]);

/**
 * 文件名类型关键词(无扩展名时的线索)。
 * 命中即判 structured——这些名字来自车载日志包,几乎100%结构化。
 */
const NAME_STRUCTURED_KEYWORDS = [
  "log", "logs",
  "kernel_log", "radio_log", "main_log", "sys_log", "events_log",
  "crash_log", "scp_log", "adsp", "atf",
  "cpuinfo", "diskinfo", "meminfo", "bootprof", "last_kmsg", "pl_lk",
  "bootup", "current_log",
];

/**
 * 扩展名快筛:有路径时,返回确定的类型提示。
 * @returns
 *   - { type: "structured" } 第一档命中,直接判结构化
 *   - { ambiguous: true, ext } 第二档,需内容细判(返回扩展名供日志)
 *   - { nameHint: "structured" } 无扩展名但文件名命中关键词
 *   - null 无任何线索,纯内容判断
 */
export interface ExtFilterResult {
  /** 第一档/关键词命中 → 直接 structured;否则不设定,内容判断 */
  type?: ContentType;
  /** 是否第二档模糊扩展名 */
  ambiguous?: boolean;
  /** 扩展名(含点,供决策日志记录) */
  ext: string;
  /** 文件名命中的关键词(供决策日志记录) */
  nameKeywords: string[];
}

export function extFilter(path: string | undefined): ExtFilterResult {
  if (!path) {
    return { ext: "", nameKeywords: [] }; // 无路径,Bash stdout,纯内容判断
  }

  // 取扩展名(最后一个点之后)
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const ext = dot > slash ? path.slice(dot + 1).toLowerCase() : "";

  // 取文件名
  const filename = path.slice(slash + 1).toLowerCase();

  // 第一档:明确结构化
  if (ext && STRUCTURED_EXT.has(ext)) {
    return { type: "structured", ext, nameKeywords: [] };
  }

  // 文件名关键词(无扩展名或模糊扩展名时,看文件名)
  const nameKeywords: string[] = [];
  for (const kw of NAME_STRUCTURED_KEYWORDS) {
    // 词边界:前后非字母数字
    const idx = filename.indexOf(kw);
    if (idx < 0) continue;
    const before = idx > 0 ? filename[idx - 1] : " ";
    const after = idx + kw.length < filename.length ? filename[idx + kw.length] : " ";
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
      nameKeywords.push(kw);
    }
  }
  if (nameKeywords.length > 0) {
    return { type: "structured", ext, nameKeywords };
  }

  // 第二档:模糊扩展名
  if (ext && AMBIGUOUS_EXT.has(ext)) {
    return { ambiguous: true, ext, nameKeywords: [] };
  }

  // 无线索
  return { ext, nameKeywords: [] };
}
