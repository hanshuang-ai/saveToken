/**
 * dashboard/server.ts — Frugal 压缩统计面板(网页)
 *
 * 启动: npx tsx src/dashboard/server.ts
 * 访问: http://localhost:3721
 * API:  http://localhost:3721/api/data
 */

import { createServer } from "node:http";
import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = 3721;
const DATA = join(homedir(), "Desktop", "frugal");
const DB_PATH = join(DATA, "frugal.db");
const LOG_PATH = join(DATA, "hook-decisions.jsonl");

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

function queryData() {
  const metrics = readMetrics();
  const decisions = readDecisions();

  const totalOriginal = metrics.reduce((s, m: any) => s + m.original_size, 0);
  const totalCompressed = metrics.reduce((s, m: any) => s + m.compressed_size, 0);
  const savedBytes = totalOriginal - totalCompressed;
  const ratio = totalOriginal > 0 ? ((savedBytes / totalOriginal) * 100).toFixed(1) : "0";

  // 按内容类型
  const byType: Record<string, { count: number; saved: number }> = {};
  for (const m of metrics) {
    const t = (m as any).content_type || "unknown";
    if (!byType[t]) byType[t] = { count: 0, saved: 0 };
    byType[t].count++;
    byType[t].saved += (m as any).original_size - (m as any).compressed_size;
  }

  // 按工具
  const byTool: Record<string, number> = {};
  for (const m of metrics) {
    const t = (m as any).tool || "unknown";
    byTool[t] = (byTool[t] || 0) + 1;
  }

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

  // 决策日志按类型
  const decisionByType: Record<string, number> = {};
  for (const d of decisions) {
    decisionByType[d.type] = (decisionByType[d.type] || 0) + 1;
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
    bySession,
    decisionByType,
    metrics: metrics.slice(0, 100),
    decisions: decisions.slice(-30).reverse(),
  };
}

function fmt(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function renderHTML(data: ReturnType<typeof queryData>): string {
  const { summary, byType, byTool, bySession, decisionByType, metrics, decisions } = data;

  const maxSaved = Math.max(...Object.values(byType).map(v => v.saved), 1);
  const typeRows = Object.entries(byType)
    .sort((a, b) => b[1].saved - a[1].saved)
    .map(([t, v]) => {
      const pct = (v.saved / maxSaved * 100).toFixed(0);
      return `<tr><td><span class="tag">${t}</span></td><td>${v.count}</td>
        <td>${fmt(v.saved)}</td><td><div class="bar-wrap"><div class="bar" style="width:${pct}%"></div></div></td></tr>`;
    }).join("");

  const maxTool = Math.max(...Object.values(byTool), 1);
  const toolRows = Object.entries(byTool)
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `<tr><td>${t}</td><td>${c}</td>
      <td><div class="bar-wrap"><div class="bar" style="width:${(c/maxTool*100).toFixed(0)}%"></div></div></td></tr>`)
    .join("");

  const sessionRows = Object.entries(bySession)
    .sort((a, b) => b[1].latest - a[1].latest)
    .map(([sid, v], i) => {
      const tag = sid.length > 16 ? sid.slice(0, 16) + "…" : sid;
      const saved = v.orig - v.comp;
      const pct = v.orig > 0 ? ((saved / v.orig) * 100).toFixed(0) : "0";
      const mark = i === 0 ? " ← 当前" : "";
      return `<tr><td><code>${tag}</code></td><td>${v.count}</td>
        <td>${fmt(saved)} (${pct}%)</td><td>${fmtTime(v.latest)}</td>
        <td style="color:#3fb950">${mark}</td></tr>`;
    }).join("");

  const metricRows = metrics.map((m: any) => {
    const pct = m.original_size > 0 ? ((1 - m.compressed_size / m.original_size) * 100).toFixed(0) : "0";
    const ret = m.retrieved_count > 0 ? `<span class="tag-warn">取回${m.retrieved_count}</span>` : "-";
    return `<tr><td>${fmtTime(m.created_at)}</td><td>${m.tool}</td>
      <td><span class="tag">${m.content_type}</span></td>
      <td>${fmt(m.original_size)}</td><td>${fmt(m.compressed_size)}</td>
      <td><strong>${pct}%</strong></td><td>${m.method || "-"}</td><td>${ret}</td></tr>`;
  }).join("");

  const decisionRows = decisions.map((d: any) =>
    `<tr><td>${fmtTime(d.ts)}</td><td>${d.tool}</td>
      <td><span class="tag">${d.type}</span></td><td>${d.confidence}</td>
      <td>${fmt(d.size)}</td><td>${(d.signals || []).join(", ")}</td></tr>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Frugal 面板</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
       background:#0d1117;color:#c9d1d9;padding:24px;max-width:1200px;margin:0 auto}
  h1{font-size:24px;margin-bottom:8px;color:#58a6ff;display:flex;align-items:center;gap:8px}
  h1 .ver{font-size:12px;color:#484f58;font-weight:400}
  .sub{color:#8b949e;font-size:13px;margin-bottom:24px}
  h2{font-size:14px;margin:24px 0 12px;color:#8b949e;text-transform:uppercase;letter-spacing:1px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}
  .card .label{font-size:11px;color:#8b949e;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px}
  .card .value{font-size:26px;font-weight:700;color:#58a6ff}
  .card .sub{font-size:11px;color:#8b949e;margin-top:2px}
  .card .bar-pct{height:4px;border-radius:2px;background:#238636;margin-top:6px;transition:width .3s}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{padding:7px 10px;text-align:left;border-bottom:1px solid #21262d}
  th{color:#8b949e;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;
     background:#161b22;position:sticky;top:0}
  tr:hover{background:#161b2255}
  .section{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:14px;margin-bottom:12px}
  .empty{color:#484f58;font-style:italic;padding:20px;text-align:center}
  .tag{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;
       background:#1f6feb22;color:#58a6ff}
  .tag-warn{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;
            background:#d2992222;color:#d29922}
  code{font-family:"SF Mono",Menlo,monospace;font-size:11px;color:#8b949e}
  .bar-wrap{width:100%;height:6px;background:#21262d;border-radius:3px;overflow:hidden}
  .bar{height:100%;border-radius:3px;background:linear-gradient(90deg,#238636,#3fb950)}
  .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:768px){.grid-2{grid-template-columns:1fr}}
  .footer{text-align:center;color:#30363d;font-size:11px;margin-top:32px;padding-top:16px;
          border-top:1px solid #21262d}
  .refresh{float:right;font-size:11px;color:#58a6ff;cursor:pointer;
           text-decoration:none;padding:4px 10px;border:1px solid #30363d;border-radius:6px}
  .refresh:hover{background:#161b22}
</style>
</head>
<body>

<h1>⚡ Frugal <span class="ver">v0.0.1</span> <a class="refresh" href="/">↻ 刷新</a></h1>
<p class="sub">压缩统计面板 · 数据实时从 ~/Desktop/frugal/frugal.db 读取</p>

<div class="cards">
  <div class="card">
    <div class="label">压缩次数</div>
    <div class="value">${summary.totalCompressions}</div>
    <div class="sub">决策日志 ${summary.totalDecisions} 条</div>
  </div>
  <div class="card">
    <div class="label">节省空间</div>
    <div class="value">${fmt(summary.savedBytes)}</div>
    <div class="sub">压缩率 ${summary.ratio}%</div>
    <div class="bar-pct" style="width:${Math.min(summary.ratio, 100)}%"></div>
  </div>
  <div class="card">
    <div class="label">原始总量</div>
    <div class="value">${fmt(summary.totalOriginalBytes)}</div>
  </div>
  <div class="card">
    <div class="label">压缩后</div>
    <div class="value">${fmt(summary.totalCompressedBytes)}</div>
  </div>
</div>

<div class="grid-2">
  <div class="section">
    <h2>按内容类型</h2>
    ${typeRows ? `<table><thead><tr><th>类型</th><th>次数</th><th>节省</th><th></th></tr></thead><tbody>${typeRows}</tbody></table>` : '<div class="empty">暂无数据</div>'}
  </div>
  <div class="section">
    <h2>按工具</h2>
    ${toolRows ? `<table><thead><tr><th>工具</th><th>次数</th><th></th></tr></thead><tbody>${toolRows}</tbody></table>` : '<div class="empty">暂无数据</div>'}
  </div>
</div>

<div class="section">
  <h2>按会话</h2>
  ${sessionRows ? `<table><thead><tr><th>会话 ID</th><th>压缩次数</th><th>节省</th><th>最近时间</th><th></th></tr></thead><tbody>${sessionRows}</tbody></table>` : '<div class="empty">暂无数据</div>'}
</div>

<div class="section">
  <h2>压缩记录 (最近 ${Math.min(metrics.length, 100)} 条)</h2>
  ${metricRows ? `<table><thead><tr><th>时间</th><th>工具</th><th>类型</th><th>原始</th><th>压缩后</th><th>压缩率</th><th>方法</th><th>取回</th></tr></thead><tbody>${metricRows}</tbody></table>` : '<div class="empty">暂无记录</div>'}
</div>

<div class="section">
  <h2>分类决策 (最近 ${Math.min(decisions.length, 30)} 条)</h2>
  ${decisionRows ? `<table><thead><tr><th>时间</th><th>工具</th><th>分类</th><th>置信度</th><th>大小</th><th>信号</th></tr></thead><tbody>${decisionRows}</tbody></table>` : '<div class="empty">暂无记录</div>'}
</div>

<div class="footer">Frugal v0.0.1 · ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</div>
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
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(data, null, 2));
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`✅ Frugal 面板已启动: http://localhost:${PORT}`);
  console.log(`   数据源: ${DB_PATH}`);
  console.log(`   按 Ctrl+C 停止`);
});
