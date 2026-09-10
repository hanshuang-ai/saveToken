/**
 * dashboard/server.ts — Frugal 压缩统计面板
 *
 * 启动: npx tsx src/dashboard/server.ts
 * 访问: http://localhost:3721
 */

import { createServer } from "node:http";
import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = 3721;
const DATA = join(homedir(), "Desktop", "frugal");
const DB_PATH = join(DATA, "frugal.db");

function readDecisionLog(): any[] {
  const logPath = join(DATA, "hook-decisions.jsonl");
  if (!existsSync(logPath)) return [];
  try {
    return readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function queryData() {
  // 读 DB
  let metrics: any[] = [];
  let dbError = "";
  try {
    if (existsSync(DB_PATH)) {
      const db = new Database(DB_PATH, { readonly: true });
      metrics = db
        .prepare(
          `SELECT id, handle, source, tool, content_type, original_size,
                  compressed_size, method, retrieved_count, session_id, created_at
           FROM metrics ORDER BY created_at DESC`
        )
        .all();
      db.close();
    }
  } catch (e: any) {
    dbError = e.message;
  }

  // 读决策日志
  const decisions = readDecisionLog();

  // 汇总
  const totalOriginal = metrics.reduce((s, m) => s + m.original_size, 0);
  const totalCompressed = metrics.reduce((s, m) => s + m.compressed_size, 0);
  const savedBytes = totalOriginal - totalCompressed;
  const ratio = totalOriginal > 0 ? ((savedBytes / totalOriginal) * 100).toFixed(1) : "0";

  // 按内容类型分组
  const byType: Record<string, { count: number; saved: number }> = {};
  for (const m of metrics) {
    const t = m.content_type || "unknown";
    if (!byType[t]) byType[t] = { count: 0, saved: 0 };
    byType[t].count++;
    byType[t].saved += m.original_size - m.compressed_size;
  }

  // 按工具分组
  const byTool: Record<string, number> = {};
  for (const m of metrics) {
    const t = m.tool || "unknown";
    byTool[t] = (byTool[t] || 0) + 1;
  }

  // 决策日志按类型分组
  const decisionByType: Record<string, number> = {};
  for (const d of decisions) {
    const t = d.type || "unknown";
    decisionByType[t] = (decisionByType[t] || 0) + 1;
  }

  return {
    summary: {
      totalCompressions: metrics.length,
      totalOriginalBytes: totalOriginal,
      totalCompressedBytes: totalCompressed,
      savedBytes,
      ratio: parseFloat(ratio),
      totalDecisions: decisions.length,
    },
    byType,
    byTool,
    decisionByType,
    metrics: metrics.slice(0, 50), // 最近50条
    decisions: decisions.slice(-20).reverse(), // 最近20条决策
    dbError,
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function renderHTML(data: ReturnType<typeof queryData>): string {
  const { summary, byType, byTool, decisionByType, metrics, decisions, dbError } = data;

  const typeRows = Object.entries(byType)
    .sort((a, b) => b[1].saved - a[1].saved)
    .map(
      ([t, v]) =>
        `<tr><td>${t}</td><td>${v.count}</td><td>${formatBytes(v.saved)}</td></tr>`
    )
    .join("");

  const toolRows = Object.entries(byTool)
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `<tr><td>${t}</td><td>${c}</td></tr>`)
    .join("");

  const metricRows = metrics
    .map(
      (m) =>
        `<tr>
          <td>${formatTime(m.created_at)}</td>
          <td>${m.tool}</td>
          <td>${m.content_type}</td>
          <td>${formatBytes(m.original_size)}</td>
          <td>${formatBytes(m.compressed_size)}</td>
          <td>${((1 - m.compressed_size / m.original_size) * 100).toFixed(1)}%</td>
          <td>${m.method || "-"}</td>
          <td>${m.retrieved_count}</td>
        </tr>`
    )
    .join("");

  const decisionRows = decisions
    .map(
      (d) =>
        `<tr>
          <td>${formatTime(d.ts)}</td>
          <td>${d.tool}</td>
          <td>${d.type}</td>
          <td>${d.confidence}</td>
          <td>${d.size}</td>
          <td>${(d.signals || []).join(", ")}</td>
        </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Frugal 面板</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         background: #0d1117; color: #c9d1d9; padding: 24px; }
  h1 { font-size: 24px; margin-bottom: 24px; color: #58a6ff; }
  h2 { font-size: 16px; margin: 24px 0 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 1px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .card .label { font-size: 12px; color: #8b949e; margin-bottom: 4px; }
  .card .value { font-size: 28px; font-weight: 700; color: #58a6ff; }
  .card .sub { font-size: 12px; color: #8b949e; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  tr:hover { background: #161b22; }
  .section { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .empty { color: #484f58; font-style: italic; padding: 24px; text-align: center; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; background: #1f6feb22; color: #58a6ff; }
  .error { color: #f85149; font-size: 12px; margin: 8px 0; }
  .bar { height: 8px; border-radius: 4px; background: #238636; margin-top: 4px; }
</style>
</head>
<body>
<h1>⚡ Frugal 压缩面板</h1>

${dbError ? `<div class="error">DB 错误: ${dbError}</div>` : ""}

<div class="cards">
  <div class="card">
    <div class="label">压缩次数</div>
    <div class="value">${summary.totalCompressions}</div>
    <div class="sub">决策日志 ${summary.totalDecisions} 条</div>
  </div>
  <div class="card">
    <div class="label">节省空间</div>
    <div class="value">${formatBytes(summary.savedBytes)}</div>
    <div class="sub">压缩率 ${summary.ratio}%</div>
    <div class="bar" style="width:${Math.min(summary.ratio, 100)}%"></div>
  </div>
  <div class="card">
    <div class="label">原始总量</div>
    <div class="value">${formatBytes(summary.totalOriginalBytes)}</div>
  </div>
  <div class="card">
    <div class="label">压缩后总量</div>
    <div class="value">${formatBytes(summary.totalCompressedBytes)}</div>
  </div>
</div>

<div class="section">
  <h2>按内容类型</h2>
  ${typeRows
    ? `<table><thead><tr><th>类型</th><th>次数</th><th>节省</th></tr></thead><tbody>${typeRows}</tbody></table>`
    : '<div class="empty">暂无数据</div>'}
</div>

<div class="section">
  <h2>按工具</h2>
  ${toolRows
    ? `<table><thead><tr><th>工具</th><th>触发次数</th></tr></thead><tbody>${toolRows}</tbody></table>`
    : '<div class="empty">暂无数据</div>'}
</div>

<div class="section">
  <h2>压缩记录 (最近50条)</h2>
  ${
    metricRows
      ? `<table><thead><tr><th>时间</th><th>工具</th><th>类型</th><th>原始</th><th>压缩后</th><th>压缩率</th><th>方法</th><th>取回次数</th></tr></thead><tbody>${metricRows}</tbody></table>`
      : '<div class="empty">暂无压缩记录 — 等待 hook 触发</div>'
  }
</div>

<div class="section">
  <h2>分类决策 (最近20条)</h2>
  ${
    decisionRows
      ? `<table><thead><tr><th>时间</th><th>工具</th><th>分类</th><th>置信度</th><th>大小</th><th>信号</th></tr></thead><tbody>${decisionRows}</tbody></table>`
      : '<div class="empty">暂无决策记录</div>'
  }
</div>

<div style="text-align:center;color:#484f58;font-size:11px;margin-top:24px">
  Frugal v0.0.1 · 面板自动刷新需手动刷新页面
</div>
</body>
</html>`;
}

const server = createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    const data = queryData();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderHTML(data));
  } else if (req.url === "/api/data") {
    const data = queryData();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`Frugal 面板已启动: http://localhost:${PORT}`);
  console.log(`数据源: ${DB_PATH}`);
});
