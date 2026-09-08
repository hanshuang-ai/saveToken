/**
 * dedup-side-effect.ts —— 量化关掉 dedup 对各类结构化内容的副作用
 * 隔离脚本,直接调 compress 对比,不碰真实数据库。用完即删。
 *
 * 对每类内容比较:
 *   A = compress(text)             全开(format-strip+dedup+snip)
 *   B = compress(text, 关dedup)     format-strip+snip
 *   dedup 净贡献 = |A - B|
 * 并打印 dedup 实际压了哪些串,判断是否路径。
 */
import { compress } from "./src/compress";
import { readFileSync, existsSync } from "node:fs";

const fmt = (n: number) => n.toLocaleString();
const pct = (n: number, base: number) => base > 0 ? (n / base * 100).toFixed(1) + "%" : "-";

interface Sample { name: string; text: string; }
const samples: Sample[] = [];

// 1. 真实 JSON 锁文件(bun.lock)
if (existsSync("bun.lock")) {
  samples.push({ name: "JSON锁文件(bun.lock)", text: readFileSync("bun.lock", "utf-8") });
}

// 2. 构造日志样本:重复模板前缀 + 变化内容(典型构建日志/git log)
const logLines: string[] = [];
for (let i = 0; i < 200; i++) {
  logLines.push(
    `2024-01-15T10:23:${String(i % 60).padStart(2, "0")}.123Z [INFO] [app.module.subsystem] processing request batch #${i} from client-${i % 7} payload=${Math.random().toString(36).slice(2)}`
  );
}
samples.push({ name: "日志(重复模板前缀×200)", text: logLines.join("\n") });

// 3. 构造 JSON API 响应:重复 key 和 URL 前缀
const jsonObj: Record<string, unknown>[] = [];
for (let i = 0; i < 80; i++) {
  jsonObj.push({
    id: i,
    resolved: `https://registry.npmjs.org/@scope/package-name/-/package-name-${i}.0.0.tgz`,
    dependencies: { "some-long-dependency-name": `^${i}.0.0`, "another-dep": "^1.2.3" },
    integrity: `sha512-${Math.random().toString(36).slice(2).repeat(4)}`,
  });
}
samples.push({ name: "JSON API响应(重复key/URL×80)", text: JSON.stringify(jsonObj, null, 2) });

// 4. 表格/CSV:重复分隔与值
const csv: string[] = ["id,name,status,createdAt,updatedAt,owner,path"];
for (let i = 0; i < 150; i++) {
  csv.push(`${i},item-${i % 20},active,2024-01-15T10:00:00Z,2024-01-15T11:00:00Z,team-${i % 5},src/modules/group-${i % 8}/file-${i}.ts`);
}
samples.push({ name: "CSV表格(重复值×150)", text: csv.join("\n") });

console.log("样本 | 原文 | 全开压缩 | 关dedup压缩 | dedup净贡献 | 占原文% | dedup压的串(是否路径)\n" + "-".repeat(110));

for (const s of samples) {
  const A = compress(s.text);                          // 全开
  const B = compress(s.text, { enableDedup: false }); // 关 dedup
  const dedupGain = B.compressedSize - A.compressedSize; // 关了之后大了多少 = dedup 省的

  // 提取 dedup 登记表里的串,判断是否路径
  const tableMatch = A.text.match(/「dedup-table\n([\s\S]*?)\n」/);
  let dedupStrs = "无(未触发dedup)";
  let pathFlag = "";
  if (tableMatch) {
    const strs = tableMatch[1].split("\n").map(l => l.replace(/^@\d+=/, ""));
    dedupStrs = strs.map(x => x.length > 50 ? x.slice(0, 50) + "…" : x).join(" | ");
    pathFlag = strs.some(x => /node_modules|\/|\.(js|ts|json|md)/.test(x)) ? " ⚠️含路径" : " 非路径";
  }

  console.log(
    `${s.name} | ${fmt(s.text.length)} | ${fmt(A.compressedSize)} | ${fmt(B.compressedSize)} | ${fmt(dedupGain)} | ${pct(dedupGain, s.text.length)} | ${dedupStrs}${pathFlag}`
  );
}

// 5. 关键验证:snip 截断后,dedup 对中间部分是不是"白压了"?
// 对超过 snip 阈值的内容,看 dedup 登记表里有多少串出现在被 snip 省略的中间区
console.log("\n--- snip 与 dedup 重叠分析(日志样本)---");
const bigLog = logLines.concat(logLines).concat(logLines).join("\n"); // 600 行,超 snip minLines
const fullOpen = compress(bigLog);
const tableM = fullOpen.text.match(/「dedup-table\n([\s\S]*?)\n」/);
if (tableM) {
  const strs = tableM[1].split("\n").map(l => l.replace(/^@\d+=/, ""));
  console.log(`600行日志:全开压到 ${fmt(fullOpen.compressedSize)},dedup 登记了 ${strs.length} 个串`);
  console.log(`→ dedup 对全文做反向引用,但 snip 随后截掉中间 ~540 行`);
  console.log(`→ 落在头尾 60 行保留区的 dedup 标记才有用,中间的标记被截掉=白压`);
}
