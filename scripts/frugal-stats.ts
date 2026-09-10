/**
 * scripts/frugal-stats.ts — frugal 压缩统计脚本
 *
 * 查询 DB + 决策日志,输出格式化统计(token 为主)。
 * 供 /frugal:stats slash command 调用。
 */

import Database from "better-sqlite3";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const DATA = join(homedir(), "Desktop", "frugal");
const DB_PATH = join(DATA, "frugal.db");
const LOG_PATH = join(DATA, "hook-decisions.jsonl");

/** 字符数 → 估算 token 数(英文~4字符/token,JSON/代码~3.5,中文~1.5;取保守值 3.5) */
function estTokens(chars: number): number {
  return Math.ceil(chars / 3.5);
}

function fmtTok(n: number): string {
  if (n < 1000) return `${n} tok`;
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${(n / 1000000).toFixed(2)}M tok`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function time(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

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

// ─── JSONL token 统计 ──────────────────────────────────────────────────────
interface ConvTokens {
  file: string;
  input: number;
  output: number;
  cacheRead: number;
  turns: number;
  mtime: number;
}

function scanJsonl(): ConvTokens[] {
  const claudeDir = join(homedir(), ".claude", "projects");
  if (!existsSync(claudeDir)) return [];
  const results: ConvTokens[] = [];
  function walk(dir: string) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".jsonl")) continue;
        try {
          const st = statSync(full);
          if (Date.now() - st.mtimeMs > 7 * 24 * 3600 * 1000) continue;
          let input = 0, output = 0, cacheRead = 0, turns = 0;
          for (const line of readFileSync(full, "utf-8").split("\n")) {
            if (!line.trim()) continue;
            try {
              const d = JSON.parse(line);
              if (d.type === "assistant") {
                const u = d.message?.usage;
                if (u?.input_tokens > 0) {
                  turns++;
                  input += u.input_tokens;
                  output += u.output_tokens || 0;
                  cacheRead += u.cache_read_input_tokens || 0;
                }
              }
            } catch {}
          }
          if (turns > 0) results.push({ file: full, input, output, cacheRead, turns, mtime: st.mtimeMs });
        } catch {}
      }
    } catch {}
  }
  walk(claudeDir);
  return results.sort((a, b) => b.mtime - a.mtime);
}

const metrics = readMetrics();
const decisions = readDecisions();
const convs = scanJsonl();
const lines: string[] = [];

// ─── 压缩统计(DB) ─────────────────────────────────────────────────────────
if (metrics.length === 0) {
  lines.push("## 压缩记录");
  lines.push("尚无压缩记录。hook 触发后数据自动写入 DB。");
} else {
  const totalOrig = metrics.reduce((s: number, m: any) => s + m.original_size, 0);
  const totalComp = metrics.reduce((s: number, m: any) => s + m.compressed_size, 0);
  const savedBytes = totalOrig - totalComp;
  const ratio = totalOrig > 0 ? ((savedBytes / totalOrig) * 100).toFixed(1) : "0";

  const tokOrig = estTokens(totalOrig);
  const tokComp = estTokens(totalComp);
  const tokSaved = tokOrig - tokComp;

  lines.push("## frugal 压缩统计");
  lines.push("");
  lines.push(`压缩次数: ${metrics.length}`);
  lines.push(`节省 token: ${fmtTok(tokSaved)} (估算,压缩率 ${ratio}%)`);
  lines.push(`  原始: ${fmtTok(tokOrig)} → 压缩后: ${fmtTok(tokComp)}`);
  lines.push(`  原始字节: ${fmtBytes(totalOrig)} → ${fmtBytes(totalComp)}`);
  lines.push("");

  // 按类型
  const byType: Record<string, { count: number; origBytes: number; compBytes: number }> = {};
  for (const m of metrics) {
    const r = m as any;
    const t = r.content_type || "unknown";
    if (!byType[t]) byType[t] = { count: 0, origBytes: 0, compBytes: 0 };
    byType[t].count++;
    byType[t].origBytes += r.original_size;
    byType[t].compBytes += r.compressed_size;
  }
  lines.push("### 按内容类型");
  for (const [t, v] of Object.entries(byType).sort((a, b) => (b[1].origBytes - b[1].compBytes) - (a[1].origBytes - a[1].compBytes))) {
    const saved = v.origBytes - v.compBytes;
    const p = v.origBytes > 0 ? ((saved / v.origBytes) * 100).toFixed(0) : "0";
    lines.push(`  ${t}: ${v.count} 条, 省 ${fmtTok(estTokens(saved))} (${p}%)`);
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

  // 按会话
  const bySession: Record<string, { count: number; orig: number; comp: number; latest: number }> = {};
  for (const m of metrics) {
    const r = m as any;
    const sid = r.session_id || "(无会话)";
    if (!bySession[sid]) bySession[sid] = { count: 0, orig: 0, comp: 0, latest: 0 };
    bySession[sid].count++;
    bySession[sid].orig += r.original_size;
    bySession[sid].comp += r.compressed_size;
    if (r.created_at > bySession[sid].latest) bySession[sid].latest = r.created_at;
  }
  const sessions = Object.entries(bySession).sort((a, b) => b[1].latest - a[1].latest);
  if (sessions.length > 0) {
    lines.push("### 按会话");
    for (let i = 0; i < sessions.length; i++) {
      const [sid, v] = sessions[i];
      const tag = sid.length > 16 ? sid.slice(0, 16) + "…" : sid;
      const saved = v.orig - v.comp;
      const p = v.orig > 0 ? ((saved / v.orig) * 100).toFixed(0) : "0";
      const mark = i === 0 ? " ← 最近会话" : "";
      lines.push(`  ${tag}: ${v.count} 条, 省 ${fmtTok(estTokens(saved))} (${p}%)${mark}`);
    }
    lines.push("");
  }

  // 逐条明细
  lines.push("### 压缩记录 (最近 30 条)");
  for (const m of metrics.slice(0, 30)) {
    const r = m as any;
    const tokO = estTokens(r.original_size);
    const tokC = estTokens(r.compressed_size);
    const tokS = tokO - tokC;
    const p = r.original_size > 0 ? ((1 - r.compressed_size / r.original_size) * 100).toFixed(0) : "0";
    const ret = r.retrieved_count > 0 ? ` [取回${r.retrieved_count}]` : "";
    lines.push(`  ${time(r.created_at)} ${r.tool} ${r.content_type} 省${fmtTok(tokS)} (${p}%)${ret}`);
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
    lines.push(`  ${time(d.ts)} ${d.tool} ${d.type} conf=${d.confidence} ${fmtBytes(d.size)}`);
  }
}

// ─── JSONL 对话级 token 统计(精确值) ───────────────────────────────────────
if (convs.length > 0) {
  lines.push("");
  lines.push("## 对话 token 统计 (JSONL 精确值, 最近 7 天)");
  lines.push("");

  const totalInput = convs.reduce((s, c) => s + c.input, 0);
  const totalOutput = convs.reduce((s, c) => s + c.output, 0);
  const totalCache = convs.reduce((s, c) => s + c.cacheRead, 0);

  lines.push(`对话数: ${convs.length}`);
  lines.push(`input(新): ${fmtTok(totalInput)}  output: ${fmtTok(totalOutput)}  cache_read: ${fmtTok(totalCache)}`);
  lines.push("");

  // 最近 10 个对话明细
  lines.push("### 对话明细 (最近 10 个)");
  for (const c of convs.slice(0, 10)) {
    const name = basename(c.file).replace(".jsonl", "").slice(0, 16);
    // input = 新 token(全价), cache_read = 缓存命中(1/10 价), 两者独立不相加
    lines.push(`  ${name}  ${c.turns}轮  新token:${fmtTok(c.input)}  缓存:${fmtTok(c.cacheRead)}  输出:${fmtTok(c.output)}`);
  }
}

console.log(lines.join("\n"));
