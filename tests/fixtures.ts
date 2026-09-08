/**
 * fixtures.ts —— 真实内容样本(测试基准)
 *
 * 每类内容用真实形态构造,覆盖实际会遇到的字符分布与结构。
 * 每个样本标注 expectedType(分类器应判出的类型)和 reversible(严格相等 vs 语义等价)。
 */

export interface Fixture {
  name: string;
  content: string;
  /** 分类器期望类型 */
  expectedType: "structured" | "prose" | "mixed";
  /** 可逆性契约:strict=字节严格相等, semantic=语义等价(纯噪声剥离后) */
  reversible: "strict" | "semantic";
}

// ─── 结构化:JSON ────────────────────────────────────────────────────────────

const jsonSample = JSON.stringify(
  Array.from({ length: 60 }, (_, i) => ({
    id: i,
    name: `item-${i}`,
    status: i % 3 === 0 ? "active" : "inactive",
    value: i * 100,
    tags: ["tag-a", "tag-b", "tag-c"],
    nested: { foo: "bar", count: i, flag: true },
  })),
  null,
  2
);

// ─── 结构化:git log ──────────────────────────────────────────────────────────

const gitLog = Array.from({ length: 80 }, (_, i) => {
  const hash = `commit ${i.toString(16).padStart(8, "0")}${"a".repeat(32)}`;
  const author = `Author: dev-${i % 5} <dev${i % 5}@example.com>`;
  const date = `Date:   2026-09-${String((i % 28) + 1).padStart(2, "0")} 14:30:${String(i % 60).padStart(2, "0")} +0800`;
  const msg = `    fix: handle edge case ${i} in parser module`;
  return `${hash}\n${author}\n${date}\n\n    ${msg}\n`;
}).join("\n");

// ─── 结构化:npm install 输出(带 ANSI) ─────────────────────────────────────

const npmOutput = [
  "\x1b[32madded 247 packages\x1b[0m, and \x1b[32maudited 248 packages\x1b[0m in 12s",
  "",
  "\x1b[32m108 packages\x1b[0m are looking for funding",
  "  \x1b[32mrun\x1b[0m \x1b[32m`npm fund`\x1b[0m for details",
  "",
  "found \x1b[32m0 vulnerabilities\x1b[0m",
  "",
  ...Array.from({ length: 40 }, (_, i) =>
    `\x1b[2m│\x1b[0m ${" ".repeat(i % 5)}package-${i} \x1b[32m✓\x1b[0m  ${" ".repeat(8)}${(i * 23) % 1000}ms`
  ),
].join("\n");

// ─── 结构化:代码 ────────────────────────────────────────────────────────────

const codeSample = [
  "import { useEffect, useState } from 'react';",
  "",
  "export function useDebounce<T>(value: T, delay: number): T {",
  "  const [debounced, setDebounced] = useState<T>(value);",
  "",
  "  useEffect(() => {",
  "    const handler = setTimeout(() => setDebounced(value), delay);",
  "    return () => clearTimeout(handler);",
  "  }, [value, delay]);",
  "",
  "  return debounced;",
  "}",
  "",
  ...Array.from({ length: 50 }, (_, i) =>
    `export const handler${i} = () => { console.log('handler ${i}'); return ${i} * 2; };`
  ),
].join("\n");

// ─── 结构化:服务器日志 ──────────────────────────────────────────────────────

const logSample = Array.from({ length: 100 }, (_, i) => {
  const ts = `2026-09-08T14:30:${String(i % 60).padStart(2, "0")}.${String(i * 7 % 1000).padStart(3, "0")}Z`;
  const level = ["INFO", "WARN", "ERROR", "DEBUG"][i % 4];
  const msg = ["request completed", "cache miss", "connection timeout", "retrying"][i % 4];
  return `${ts} [${level}] req-${i} ${msg} path=/api/v1/resource/${i} status=${200 + (i % 5)}`;
}).join("\n");

// ─── 散文:文档 ──────────────────────────────────────────────────────────────

const proseSample = [
  "# 项目说明",
  "",
  "这是一个用于演示的文档段落。无损压缩的核心思想在于,",
  "我们只处理结构性的冗余内容,而不触碰任何叙事性的文字。",
  "因为散文本身没有可以剥离的冗余结构,强行压缩会破坏语义。",
  "",
  "这段文字应当被分类器识别为散文类型,并且在压缩管道中",
  "被原样保留,不做任何修改。这是安全模型的第一道闸门:",
  "对于没有可剥离结构的内容,hook 应当完全放行。",
  "",
  "文档里偶尔出现的 \"引号\" 和一些标点符号,以及中文、English 混排,",
  "都不应影响分类结果。模型需要完整理解这些叙事内容。",
].join("\n");

// ─── 混合:Markdown with code blocks ─────────────────────────────────────────

const mixedSample = [
  "# 使用说明",
  "",
  "先安装依赖:",
  "",
  "```bash",
  ...Array.from({ length: 20 }, (_, i) => `step ${i}: run command-${i}`),
  "```",
  "",
  "然后配置环境变量,具体步骤如下。注意配置文件的路径",
  "需要根据你的操作系统进行调整。Windows 和 macOS 的",
  "默认路径不同,请参考下表。",
  "",
  "```json",
  ...Array.from({ length: 30 }, (_, i) => `  "key_${i}": "value_${i}",`),
  "```",
  "",
  "以上配置完成后,重启服务即可生效。",
].join("\n");

export const FIXTURES: Fixture[] = [
  { name: "json", content: jsonSample, expectedType: "structured", reversible: "semantic" },
  { name: "git-log", content: gitLog, expectedType: "structured", reversible: "strict" },
  { name: "npm-output", content: npmOutput, expectedType: "structured", reversible: "semantic" },
  { name: "code", content: codeSample, expectedType: "structured", reversible: "strict" },
  { name: "log", content: logSample, expectedType: "structured", reversible: "strict" },
  { name: "prose", content: proseSample, expectedType: "prose", reversible: "strict" },
  { name: "mixed", content: mixedSample, expectedType: "mixed", reversible: "semantic" },
];
