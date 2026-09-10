/**
 * scripts/frugal-stats.ts — frugal 压缩统计脚本
 *
 * 查询 DB + 决策日志,输出格式化统计。
 * 供 /frugal:stats slash command 调用。
 */

import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DATA = join(homedir(), "Desktop", "frugal");
const DB_PATH = join(DATA, "frugal.db");
const LOG_PATH = join(DATA, "hook-decisions.jsonl");

function fmt(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function time(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

// 读决策日志
function readDecisions(): any[] {
  if (!existsSync(LOG_PATH)) return [];
  try {
    return readFileSync(LOG_PATH, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// 读 DB
function readMetrics(): any[] {
  if (!existsSync(DB_PATH)) return [];
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const rows = db
      .prepare(
        `SELECT id, handle, source, tool, content_type, original_size,
                compressed_size, method, retrieved_count, session_id, created_at
         FROM metrics ORDER BY created_at DESC`
      )
      .all();
    db.close();
    return rows;
  } catch {
    return [];
  }
}

// 主输出
const metrics = readMetrics();
const decisions = readDecisions();

const lines: string[] = [];

// 汇总
if (metrics.length === 0) {
  lines.push("尚无压缩记录。");
  lines.push("");
  lines.push("hook 触发后(Read/Bash 大输出被压缩),数据会自动写入 DB。");
} else {
  const totalOrig = metrics.reduce((s: number, m: any) => s + m.original_size, 0);
  const totalComp = metrics.reduce((s: number, m: any) => s + m.compressed_size, 0);
  const saved = totalOrig - totalComp;
  const ratio = totalOrig > 0 ? ((saved / totalOrig) * 100).toFixed(1) : "0";

  lines.push("## frugal 压缩统计");
  lines.push("");
  lines.push(`压缩次数: ${metrics.length}`);
  lines.push(`原始总量: ${fmt(totalOrig)} → 压缩后: ${fmt(totalComp)}`);
  lines.push(`节省: ${fmt(saved)} (${ratio}%)`);
  lines.push("");

  // 按类型
  const byType: Record<string, { count: number; saved: number }> = {};
  for (const m of metrics) {
    const t = (m as any).content_type || "unknown";
    if (!byType[t]) byType[t] = { count: 0, saved: 0 };
    byType[t].count++;
    byType[t].saved += (m as any).original_size - (m as any).compressed_size;
  }
  lines.push("### 按内容类型");
  for (const [t, v] of Object.entries(byType).sort((a, b) => b[1].saved - a[1].saved)) {
    lines.push(`  ${t}: ${v.count} 条, 省 ${fmt(v.saved)}`);
  }
  lines.push("");

  // 按工具
  const byTool: Record<string, number> = {};
  for (const m of metrics) {
    const t = (m as any).tool || "unknown";
    byTool[t] = (byTool[t] || 0) + 1;
  }
  lines.push("### 按工具");
  for (const [t, c] of Object.entries(byTool).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${t}: ${c} 次`);
  }
  lines.push("");

  // 逐条明细
  lines.push("### 压缩记录 (最近 30 条)");
  for (const m of metrics.slice(0, 30)) {
    const r = m as any;
    const pct = r.original_size > 0 ? ((1 - r.compressed_size / r.original_size) * 100).toFixed(0) : "0";
    const ret = r.retrieved_count > 0 ? ` [取回${r.retrieved_count}]` : "";
    lines.push(`  ${time(r.created_at)} ${r.tool} ${r.content_type} ${fmt(r.original_size)}→${fmt(r.compressed_size)} 省${pct}%${ret}`);
  }
}

// 决策日志
if (decisions.length > 0) {
  lines.push("");
  lines.push(`### 分类决策 (共 ${decisions.length} 条, 最近 10 条)`);
  const byType: Record<string, number> = {};
  for (const d of decisions) {
    byType[d.type] = (byType[d.type] || 0) + 1;
  }
  for (const [t, c] of Object.entries(byType).sort((a, b) => (b[1] as number) - (a[1] as number))) {
    lines.push(`  ${t}: ${c} 次`);
  }
  lines.push("");
  for (const d of decisions.slice(-10).reverse()) {
    lines.push(`  ${time(d.ts)} ${d.tool} ${d.type} conf=${d.confidence} ${fmt(d.size)}`);
  }
}

console.log(lines.join("\n"));
