/**
 * evaluate.ts —— 分类器基线评估脚本
 *
 * 用途:全量扫描 BLOG 项目,按文件类型映射 ground truth,
 *      跑分类器出混淆矩阵 + 散文误判率(安全侧硬指标)。
 *
 * 原则:测量先行。先拿数据看现在偏在哪,再动手改信号。
 *      不手造假数据,只用真实文件。
 *
 * 用法:bun run tests/evaluate.ts [扫描根目录] [输出json路径]
 *      默认扫描 /Users/lcy/Documents/个人资料/BLOG
 */

import { classify } from "../src/core/classifier";
import type { ContentType } from "../src/core/types";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

// ─── ground truth:扩展名 → 期望类型 ──────────────────────────────────────────
// 映射依据:BLOG 真实内容
//   .json/.log → 结构化(机器产出,规整)
//   .md/.html 正文 → 散文为主(但 html/md 含模板/代码块会偏混合,见下"松散桶")
//   .pug/.styl/.css/.js → 结构化(代码/模板/样式)
//   .yml/.xml → 结构化
//
// 注意:html/md 是"松散桶"——有的是纯散文文章,有的是含代码的混合。
//       全量扫描时它们会同时出现 prose 和 mixed,正好测分类器能否区分。
//       所以 html/md 不预设单一期望,单独归到"观察桶",只看分布不判对错。
//       真正的硬断言桶:.json/.log(structured)、纯散文样本(prose)。

const STRUCTURED_EXT = new Set(["json", "log", "js", "css", "styl", "pug", "yml", "xml"]);
const PROSE_EXT = new Set([]); // 见下:散文用内容启发式抽纯正文,而非按扩展名
const OBSERVE_EXT = new Set(["md", "html"]); // 松散桶,看分布不判对错
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "ico", "svg", "webp", "mp4",
  "woff", "woff2", "ttf", "eot", "otf", "db", "lock",
]);

// ─── 文件收集 ────────────────────────────────────────────────────────────────

interface FileSample {
  path: string;
  ext: string;
  bucket: "structured" | "prose-candidate" | "observe" | "binary" | "skip";
  content: string;
  size: number;
}

/** 递归收集文件,排除 node_modules/.git/dist 等 */
function collectFiles(root: string): FileSample[] {
  const out: FileSample[] = [];
  const EXCLUDE = new Set(["node_modules", ".git", "dist", "build", ".next", ".history"]);

  function walk(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      // 跳过隐藏目录(但保留单个文件如 .gitignore 不在这层)
      if (EXCLUDE.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        const ext = extname(name).slice(1).toLowerCase();
        if (BINARY_EXT.has(ext) || ext === "") {
          out.push({ path: full, ext, bucket: "binary", content: "", size: st.size });
          continue;
        }
        // 太小的文件分类没意义(< 50 字符)
        if (st.size < 50) {
          out.push({ path: full, ext, bucket: "skip", content: "", size: st.size });
          continue;
        }
        let content = "";
        try {
          content = readFileSync(full, "utf-8");
        } catch {
          out.push({ path: full, ext, bucket: "skip", content: "", size: st.size });
          continue;
        }
        // 二进制伪检测:含大量不可打印字符
        if (looksBinary(content)) {
          out.push({ path: full, ext, bucket: "binary", content: "", size: st.size });
          continue;
        }
        const bucket: FileSample["bucket"] = STRUCTURED_EXT.has(ext)
          ? "structured"
          : OBSERVE_EXT.has(ext)
            ? "observe"
            : "prose-candidate";
        out.push({ path: full, ext, bucket, content, size: st.size });
      }
    }
  }

  walk(root);
  return out;
}

function looksBinary(s: string): boolean {
  // 前 1024 字符里不可打印控制字符(除 \n\r\t)占比 > 10% → 二进制
  const head = s.slice(0, 1024);
  let bad = 0;
  for (const ch of head) {
    const c = ch.charCodeAt(0);
    if (c < 32 && c !== 10 && c !== 13 && c !== 9) bad++;
  }
  return bad / Math.max(1, head.length) > 0.1;
}

// ─── 散文样本抽取 ────────────────────────────────────────────────────────────
// html/md 含模板/代码块,不能整文件当散文。
// 纯散文 ground truth 从 md 文件里抽"纯段落块"(去掉 frontmatter/代码块/标题行)。
// 这样得到的是确定性的纯散文样本,可做硬断言。

function extractProseBlocks(md: string): string[] {
  const blocks: string[] = [];
  const lines = md.split("\n");
  let inCodeFence = false;
  let inFrontmatter = false;
  let cur: string[] = [];

  const flush = () => {
    if (cur.length > 0) {
      const text = cur.join("\n").trim();
      // 至少 120 字符、含足够自然语言标记才算散文样本
      if (text.length >= 120) blocks.push(text);
      cur = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line.trim() === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === "---") inFrontmatter = false;
      continue;
    }
    // 围栏代码块 ``` / ~~~
    if (/^(```|~~~)/.test(line.trim())) {
      flush();
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    // 缩进代码块:4+ 空格开头且非列表(Markdown 缩进代码)
    if (/^    \S/.test(line)) {
      flush();
      continue;
    }
    // HTML 块:行首是 <tag>(整段 HTML/badge,非散文)
    if (/^<\/?[a-zA-Z]/.test(line.trimStart())) {
      flush();
      continue;
    }
    // Markdown 表格:行首是 |(结构化数据,非散文)
    if (/^\|/.test(line.trimStart())) {
      flush();
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      flush();
      continue;
    }
    // 纯分隔线/空行保留作段落边界
    if (line.trim() === "") {
      flush();
      continue;
    }
    // 跳过图片/链接行/列表项(这些不算纯散文正文)
    if (/^!\[/.test(line) || /^\s*[-*+]\s/.test(line)) {
      flush();
      continue;
    }
    cur.push(line);
  }
  // 围栏未闭合:丢弃当前未 flush 的残留(避免把代码当散文)
  if (inCodeFence) cur = [];
  flush();
  return blocks;
}

// ─── 评估 ────────────────────────────────────────────────────────────────────

const TYPES: ContentType[] = ["structured", "prose", "mixed", "empty"];

interface EvalReport {
  scanRoot: string;
  totalFiles: number;
  buckets: Record<string, number>;
  // 硬断言桶:期望类型 × 实际类型 计数
  confusion: Record<string, Record<string, number>>;
  // 安全侧硬指标:散文样本被判 structured 的比例(必须 = 0)
  proseMisclassifiedAsStructured: { count: number; total: number; rate: number };
  // 松散桶分布(md/html 各判成什么)
  observeDistribution: Record<string, Record<string, number>>;
  // 散文误判的具体样本(前 20 个,用于诊断)
  proseMisclassSamples: { path: string; judged: ContentType; confidence: number; signals: string[]; snippet: string }[];
  // 低置信度样本(分类器自己也拿不准的,前 20)
  lowConfidenceSamples: { path: string; bucket: string; judged: ContentType; confidence: number; snippet: string }[];
}

function run(root: string): EvalReport {
  const files = collectFiles(root);
  const buckets: Record<string, number> = {};
  for (const f of files) buckets[f.bucket] = (buckets[f.bucket] || 0) + 1;

  // 混淆矩阵:期望类型(桶) × 实际类型
  const confusion: Record<string, Record<string, number>> = {};
  for (const f of files) {
    if (f.bucket !== "structured") continue; // structured 桶有明确期望
    const r = classify({ text: f.content, path: f.path });
    const row = (confusion["structured"] ||= {});
    row[r.type] = (row[r.type] || 0) + 1;
  }

  // 散文硬断言:从 md 抽纯散文块
  let proseTotal = 0;
  let proseMis = 0;
  const proseMisclassSamples: EvalReport["proseMisclassSamples"] = [];
  const lowConfidenceSamples: EvalReport["lowConfidenceSamples"] = [];

  for (const f of files) {
    if (f.ext !== "md") continue;
    for (const block of extractProseBlocks(f.content)) {
      const r = classify({ text: block, path: f.path });
      proseTotal++;
      if (r.type === "structured") {
        proseMis++;
        if (proseMisclassSamples.length < 20) {
          proseMisclassSamples.push({
            path: f.path,
            judged: r.type,
            confidence: r.confidence,
            signals: r.signals,
            snippet: block.slice(0, 80),
          });
        }
      }
      if (r.confidence < 0.6 && lowConfidenceSamples.length < 20) {
        lowConfidenceSamples.push({
          path: f.path,
          bucket: "prose-block",
          judged: r.type,
          confidence: r.confidence,
          snippet: block.slice(0, 80),
        });
      }
    }
  }

  // 松散桶分布
  const observeDistribution: Record<string, Record<string, number>> = {};
  for (const f of files) {
    if (f.bucket !== "observe") continue;
    const r = classify({ text: f.content, path: f.path });
    const row = (observeDistribution[f.ext] ||= {});
    row[r.type] = (row[r.type] || 0) + 1;
    if (r.confidence < 0.6 && lowConfidenceSamples.length < 20) {
      lowConfidenceSamples.push({
        path: f.path,
        bucket: f.ext,
        judged: r.type,
        confidence: r.confidence,
        snippet: f.content.slice(0, 80),
      });
    }
  }

  return {
    scanRoot: root,
    totalFiles: files.length,
    buckets,
    confusion,
    proseMisclassifiedAsStructured: {
      count: proseMis,
      total: proseTotal,
      rate: proseTotal > 0 ? proseMis / proseTotal : 0,
    },
    observeDistribution,
    proseMisclassSamples,
    lowConfidenceSamples,
  };
}

// ─── 输出 ────────────────────────────────────────────────────────────────────

function pct(n: number, d: number): string {
  return d > 0 ? ((n / d) * 100).toFixed(1) + "%" : "—";
}

function printReport(r: EvalReport) {
  console.log("═".repeat(64));
  console.log("  分类器基线评估 —— BLOG 全量扫描");
  console.log("═".repeat(64));
  console.log(`扫描根: ${r.scanRoot}`);
  console.log(`文件总数: ${r.totalFiles}`);
  console.log();
  console.log("── 文件分桶 ──");
  for (const [b, n] of Object.entries(r.buckets)) {
    console.log(`  ${b.padEnd(18)} ${n}`);
  }
  console.log();

  console.log("── 混淆矩阵:structured 桶(期望全判 structured) ──");
  const sc = r.confusion["structured"] || {};
  const scTotal = Object.values(sc).reduce((a, b) => a + b, 0);
  for (const t of TYPES) {
    if (sc[t]) console.log(`  期望 structured → 实判 ${t.padEnd(12)} ${sc[t]}  (${pct(sc[t], scTotal)})`);
  }
  const scWrong = scTotal - (sc["structured"] || 0);
  console.log(`  ❌ structured 桶误判率: ${scWrong}/${scTotal} = ${pct(scWrong, scTotal)}`);
  console.log();

  console.log("── 安全侧硬指标:散文误判为 structured(必须 = 0) ──");
  const pm = r.proseMisclassifiedAsStructured;
  console.log(`  纯散文样本数: ${pm.total}`);
  console.log(`  误判为 structured: ${pm.count}`);
  console.log(`  ❌ 散文误判率: ${pct(pm.count, pm.total)}`);
  if (pm.count > 0) {
    console.log();
    console.log("  误判样本(前若干):");
    for (const s of r.proseMisclassSamples) {
      console.log(`    [${s.judged} conf=${s.confidence.toFixed(2)}] ${s.snippet.replace(/\n/g, " ")}`);
      console.log(`      信号: ${s.signals.join(", ")}`);
    }
  }
  console.log();

  console.log("── 松散桶分布:md / html(看分类器能否区分散文与混合) ──");
  for (const [ext, dist] of Object.entries(r.observeDistribution)) {
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    console.log(`  .${ext} (${total} 个):`);
    for (const t of TYPES) {
      if (dist[t]) console.log(`    → ${t.padEnd(12)} ${dist[t]}  (${pct(dist[t], total)})`);
    }
  }
  console.log();

  console.log("── 低置信度样本(分类器拿不准的,< 0.6) ──");
  for (const s of r.lowConfidenceSamples) {
    console.log(`    [${s.bucket} → ${s.judged} conf=${s.confidence.toFixed(2)}] ${s.snippet.replace(/\n/g, " ")}`);
  }
  console.log();
  console.log("═".repeat(64));
}

/** 打印决策日志汇总(按扩展名/关键词的判定分布,反推扩展名表用) */
function printDecisionSummary(summary: ReturnType<typeof decisionLog.summary>) {
  console.log();
  console.log("── 决策库汇总(反推扩展名表用) ──");
  console.log(`  记录总数: ${summary.total}`);
  console.log();
  console.log("  总类型分布:");
  for (const [t, n] of Object.entries(summary.byType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${t.padEnd(12)} ${n}  (${pct(n, summary.total)})`);
  }
  console.log();
  console.log("  按扩展名(判定分布,看哪些扩展名模糊需细判):");
  const extRows = Object.entries(summary.byExt).sort((a, b) => {
    const ta = Object.values(a[1]).reduce((x, y) => x + y, 0);
    const tb = Object.values(b[1]).reduce((x, y) => x + y, 0);
    return tb - ta;
  });
  for (const [ext, dist] of extRows) {
    const total = Object.values(dist).reduce((x, y) => x + y, 0);
    const parts = ["structured", "mixed", "prose", "empty"]
      .filter((t) => dist[t])
      .map((t) => `${t}:${dist[t]}`);
    console.log(`    ${ext.padEnd(8)} (${total})  ${parts.join("  ")}`);
  }
  console.log();
  console.log("  按文件名关键词(无扩展名时的类型线索):");
  for (const [kw, dist] of Object.entries(summary.byKeyword).sort()) {
    const total = Object.values(dist).reduce((x, y) => x + y, 0);
    const parts = ["structured", "mixed", "prose", "empty"]
      .filter((t) => dist[t])
      .map((t) => `${t}:${dist[t]}`);
    console.log(`    ${kw.padEnd(16)} (${total})  ${parts.join("  ")}`);
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

import { decisionLog } from "../src/core/decision-log";

const DEFAULT_ROOT = "/Users/lcy/Documents/个人资料/BLOG";
const root = process.argv[2] || DEFAULT_ROOT;

// 开启决策日志:每次 classify 判定记一行,积累决策库
const LOG_PATH = "logs/classify-decisions.jsonl";
decisionLog.enable(LOG_PATH);

const report = run(root);
printReport(report);

// 输出决策库汇总
printDecisionSummary(decisionLog.summary());
console.log(`\n决策库已写入: ${LOG_PATH} (${decisionLog.getRecordedCount()} 条)`);

// 可选:写 JSON 报告
const outPath = process.argv[3];
if (outPath) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`JSON 报告已写入: ${outPath}`);
}
