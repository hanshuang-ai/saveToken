/**
 * measure-corpus.ts —— 真实语料上测量插件表现(镜像真实 hook 流程)
 *
 * 流程与 hooks/post-tool-compress.ts 一致:
 *   classify() → 若 prose/mixed/empty 则放行(不压缩) → 仅对 structured 跑 compress()+digest
 *
 * 安全硬指标:
 *   - 散文被压缩数:镜像守卫后应 = 0(构造上保证)
 *   - 守卫泄漏风险:prose/mixed 文件里 digest *本会* engage 的数量
 *     (即分类器一旦误判为 structured,digest 会吃掉多少散文——承重墙风险)
 *
 * 用法:bun run scripts/measure-corpus.ts [子目录] (默认 tests/corpus)
 * 大文件(>2MB)只读前 2MB 采样,避免 OOM。
 */

import { classify } from "../src/core/classifier";
import { compress } from "../src/compress";
import { structuredDigestCompress } from "../src/compress/structured-digest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";

const ROOT = process.argv[2] || "corpus";
const SAMPLE_LIMIT = 2 * 1024 * 1024;

interface Row {
  path: string;
  ext: string;
  cls: string;
  guarded: boolean;          // 被 prose/mixed/empty 守卫放行(不压缩)
  compressed: boolean;       // structured 且 compress() 实际压缩
  digestEngaged: boolean;   // structured 且 digest 命中
  digestRisk: boolean;      // prose/mixed 文件,digest *本会* engage(守卫泄漏风险)
  origSize: number;
  compSize: number;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    let st; try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
}

const files = walk(ROOT);
console.log(`扫描根: ${ROOT}`);
console.log(`文件总数: ${files.length}`);
console.log("═".repeat(70));

const rows: Row[] = [];

for (const f of files) {
  const ext = extname(f).toLowerCase().slice(1) || "(none)";
  let raw: Buffer;
  try { raw = readFileSync(f); } catch { continue; }
  let text: string;
  try { text = raw.subarray(0, SAMPLE_LIMIT).toString("utf8"); } catch { continue; }
  if (!text.trim()) continue;

  const cls = classify({ text, path: f });
  const type = cls.type;

  // ── 镜像 hook 守卫 ──
  if (type === "prose" || type === "mixed" || type === "empty") {
    // 守卫放行:不压缩。但探测 digest 风险(若守卫泄漏,digest 会否 engage)
    const d = structuredDigestCompress(text);
    rows.push({
      path: relative(ROOT, f), ext, cls: type,
      guarded: true, compressed: false, digestEngaged: false,
      digestRisk: d.compressed,
      origSize: d.originalSize, compSize: d.originalSize,
    });
    continue;
  }

  // ── structured:跑真实 compress(含 digest) ──
  const r = compress(text);
  rows.push({
    path: relative(ROOT, f), ext, cls: type,
    guarded: false,
    compressed: r.compressed,
    digestEngaged: r.compressed && r.steps.some((s) => s.method.startsWith("structured-digest") && s.compressed),
    digestRisk: false,
    origSize: r.originalSize, compSize: r.compressedSize,
  });
}

// ─── 汇总 ──────────────────────────────────────────────────────────────────
const byType: Record<string, number> = {};
const byExt: Record<string, number> = {};
let digestHits = 0, compressedCount = 0, totalOrig = 0, totalComp = 0;
let proseDigestRisk = 0, proseTotal = 0, mixedTotal = 0;

for (const r of rows) {
  byType[r.cls] = (byType[r.cls] || 0) + 1;
  byExt[r.ext] = (byExt[r.ext] || 0) + 1;
  if (r.cls === "prose") proseTotal++;
  if (r.cls === "mixed") mixedTotal++;
  if (r.digestEngaged) digestHits++;
  if (r.compressed) { compressedCount++; totalOrig += r.origSize; totalComp += r.compSize; }
  if (r.digestRisk) proseDigestRisk++;
}

console.log("── 分类分布 ──");
for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1]))
  console.log(` ${t.padEnd(12)} ${n}`);
console.log();
console.log("── 扩展名分布(top 15) ──");
for (const [e, n] of Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 15))
  console.log(` .${e.padEnd(8)} ${n}`);
console.log();
console.log("── 压缩表现(仅 structured) ──");
console.log(` 被压缩: ${compressedCount}/${rows.length}`);
console.log(` digest 命中(structured): ${digestHits}/${rows.length} (${rows.length ? ((digestHits / rows.length) * 100).toFixed(1) : 0}%)`);
console.log(` 总压缩率: ${totalOrig} -> ${totalComp} chars (${totalOrig ? ((1 - totalComp / totalOrig) * 100).toFixed(1) : 0}% 省)`);
console.log();
console.log("── 安全侧 ──");
console.log(` 散文/混合被压缩(守卫后应 = 0): ${rows.filter((r) => r.guarded && r.compressed).length}`);
console.log(` 守卫放行: prose ${proseTotal} + mixed ${mixedTotal} = ${proseTotal + mixedTotal}`);
console.log(` 守卫泄漏风险(digest 本会在 prose/mixed 上 engage): ${proseDigestRisk}`);
console.log(`   ↳ 这些文件若被分类器误判为 structured,digest 会吃掉散文。占比: ${proseTotal + mixedTotal ? ((proseDigestRisk / (proseTotal + mixedTotal)) * 100).toFixed(1) : 0}%`);
console.log();

console.log("── digest 命中样本(structured,前 15) ──");
for (const r of rows.filter((x) => x.digestEngaged).slice(0, 15))
  console.log(` ${r.path} [${r.cls}] ${r.origSize}->${r.compSize}`);
console.log();

console.log("── 守卫泄漏风险样本(prose/mixed 上 digest 本会 engage,前 15) ──");
for (const r of rows.filter((x) => x.digestRisk).slice(0, 15))
  console.log(` ${r.path} [${r.cls}] ${r.origSize} chars`);
