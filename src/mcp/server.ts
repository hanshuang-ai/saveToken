/**
 * server.ts —— frugal MCP server
 *
 * 提供已存原文取回、字符度量及已有代码句柄的图谱工具:
 *   1. tok_retrieve —— 取回原文 / 关键词检索 / 按行号取片段
 *   2. tok_stats    —— 度量汇总(节省比、分类型、取回率)
 *
 * 配合 PostToolUse hook:仅在采用精简视图时存原文(handle),
 * 模型在压缩版里看到 `handle=orig-1`,调用 tok_retrieve 取回完整原文或检索片段。
 * 这是安全模型第三道闸门的"取回"侧。
 *
 * stdio MCP server:长期运行进程,store 在启动时打开一次,保持打开。
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { store } from "../store/db";
import { retrieveCodeMap, retrieveSymbol, retrieveRefs, ensureFileIndexed } from "../codegraph/graph";
import { linePage, MAX_RETRIEVE_CHARS, MAX_RETRIEVE_LINE_COUNT } from "./line-page";
import { trace, getTraceLogPath } from "../core/logger";

// ─── 数据目录与 store 初始化 ──────────────────────────────────────────────────
const DATA = process.env.FRUGAL_DATA_DIR ?? join(homedir(), "Desktop", "frugal");
const DB_PATH = join(DATA, "frugal.db");

// ─── 统一日志:所有组件写到同一 trace 文件 ────────────────────────────────────
function log(msg: string, data?: Record<string, unknown>): void {
  trace("MCP", msg, data);
}
log(`server module loaded`, { DATA, DB_PATH, traceLog: getTraceLogPath() });

try {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
  store.open(DB_PATH);
  log(`store opened OK`, { DB_PATH });
} catch (e) {
  log(`store.open FAILED: ${String((e as Error).message)}`);
}

/** 全文取回的安全上限:超过此字符数提示模型用 query/startLine 精确取,而非倾倒全文 */
const MAX_FULL_TEXT = 60000;
const QUERY_HIT_LIMIT = 5;
const MAX_SEARCH_SNIPPET_CHARS = 700;

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n[frugal: snippet truncated; use tok_retrieve(startLine,count) for more context]`;
}

// ─── 工具实现 ──────────────────────────────────────────────────────────────────

interface RetrieveArgs {
  handle: string;
  query?: string;
  startLine?: number;
  count?: number;
  offsetChars?: number;
}

/** 取回结果:text 为给模型看的内容;retrieved 表示是否实际取回了原文内容(命中/按行/全文) */
interface RetrieveResult {
  text: string;
  retrieved: boolean;
}

function tokRetrieve(args: RetrieveArgs): RetrieveResult {
  const { handle, query, startLine, count, offsetChars } = args;
  if (!handle) return { text: "❌ 缺少 handle 参数", retrieved: false };

  const exists = store.getOriginal(handle);
  if (!exists) {
    return { text: `❌ handle=${handle} 不存在(可能已过期或从未存储)。可用 tok_stats 查看已有记录。`, retrieved: false };
  }

  // 模式1:关键词检索 —— 返回匹配片段(带行号),不全量倾倒
  if (query && query.trim()) {
    const hits = store.search(handle, query, QUERY_HIT_LIMIT);
    if (hits.length === 0) {
      // 未命中不算实际取回,不累加计数。
      return { text: `handle=${handle} 中未找到关键词「${query}」的匹配。原文 ${exists.size} 字符,可换关键词或用 startLine 按行取。`, retrieved: false };
    }
    const lines = hits.map(
      (h) => `[行 ${h.lineNo}] ${clampText(h.snippet, MAX_SEARCH_SNIPPET_CHARS)}`
    );
    return { text: `handle=${handle} 检索「${query}」命中 ${hits.length} 条(按相关性排序):\n\n${lines.join("\n\n")}`, retrieved: true };
  }

  // 模式2:按行号取片段 —— startLine + count
  if (startLine != null || count != null || offsetChars != null) {
    if (startLine == null || count == null) throw new Error("startLine and count must be provided together");
    const page = linePage(exists.content, startLine, count, offsetChars);
    if (!page) return { text: `❌ handle=${handle} 行号或字符偏移超出范围`, retrieved: false };
    const next = page.nextOffsetChars != null
      ? `\n[frugal: range continues; tok_retrieve(${JSON.stringify({ handle, startLine, count, offsetChars: page.nextOffsetChars })})]`
      : count > MAX_RETRIEVE_LINE_COUNT && page.nextStartLine != null
        ? `\n[frugal: line limit reached; tok_retrieve(${JSON.stringify({ handle, startLine: page.nextStartLine, count: count - MAX_RETRIEVE_LINE_COUNT })})]`
        : "";
    return {
      text: `handle=${handle} 原文第 ${page.startLine}~${page.endLine} 行的片段(UTF-16 字符偏移 ${page.offsetChars},本次 ${page.text.length} 字符):${next}\n\n${page.text}`,
      retrieved: page.text.length > 0,
    };
  }

  // 模式3:取完整原文 —— 超大时提示改用检索/按行,避免又把巨量内容塞回上下文(违背省 token 初衷)
  if (exists.size > MAX_FULL_TEXT) {
    return { text: `handle=${handle} 原文 ${exists.size} 字符(超过 ${MAX_FULL_TEXT} 安全上限)。为避免大量内容重回上下文,请:\n  - tok_retrieve(handle, query="关键词") 检索相关片段,或\n  - tok_retrieve(handle, startLine=N, count=M) 按行取片段\n原文来源:${exists.source ?? "(未知)"},工具:${exists.tool ?? "(未知)"}`, retrieved: false };
  }

  return { text: `handle=${handle} 完整原文(${exists.size} 字符):\n\n${exists.content}`, retrieved: true };
}

function tokStats(): string {
  const s = store.getMetricSummary();
  if (s.total === 0) {
    return "尚无度量记录。采用精简视图并提交原文与度量后,这里会显示字符统计,不是实测 token 数。Read 保持不变。";
  }
  const pct = (s.savedRatio * 100).toFixed(1);
  const byType = Object.entries(s.byType)
    .map(([t, v]) => `  ${t}: ${v.count} 条,省 ${v.saved} 字符`)
    .join("\n");
  const sessions = store.getSessionBreakdown(5);
  const sessionLines = sessions.length
    ? sessions
        .map((ss, i) => {
          const tag = ss.sessionId ? ss.sessionId.slice(0, 8) : "(未知)";
          const sp = ss.original > 0 ? ((ss.saved / ss.original) * 100).toFixed(0) : "0";
          const mark = i === 0 ? "  ← 最近会话" : "";
          return `  ${tag}: ${ss.count} 条,省 ${ss.saved} 字符(${sp}%)${mark}`;
        })
        .join("\n")
    : "  (无会话信息)";
  const records = store.getRecentMetrics(30);
  const recLines = records.length
    ? records
        .map((r) => {
          const tool = (r.tool ?? "?").slice(0, 5).padStart(5);
          const type = r.contentType.slice(0, 10).padEnd(10);
          const orig = String(r.originalSize).padStart(6);
          const comp = String(r.compressedSize).padStart(5);
          const pct2 = (r.savedPct + "%").padStart(4);
          const ret = r.retrievedCount > 0 ? `取回${r.retrievedCount}` : "";
          return `  ${tool} ${type} ${orig}→${comp} 省${pct2} ${ret}`;
        })
        .join("\n")
    : "  (无记录)";

  const retrieveRate = store.getRetrieveRate();
  const rRate = (retrieveRate.rate * 100).toFixed(1);

  return [
    `frugal 度量汇总:`,
    `  大小按字符统计(JavaScript string.length),不是实测 token 数。`,
    `  总记录: ${s.total} 条(其中压缩 ${s.compressed} 条)`,
    `  原始: ${s.totalOriginal} 字符 → 压缩后: ${s.totalCompressed} 字符`,
    `  节省: ${s.saved} 字符(${pct}%)`,
    `  被取回: ${s.retrievedCount} 次`,
    `  取回率: ${rRate}%(${retrieveRate.retrieved}/${retrieveRate.compressed} 条压缩记录曾被取回,不含 dedup 记录)`,
    `逐条明细(最近 ${records.length} 条):`,
    recLines,
    `分类型:`,
    byType,
    `分会话(最近 5 个):`,
    sessionLines,
  ].join("\n");
}

/** Resolve handle from args: use provided handle, or read + index via filePath. */
async function resolveHandle(args: Record<string, unknown>): Promise<string> {
  const handle = args.handle != null ? String(args.handle) : "";
  const filePath = args.filePath != null ? String(args.filePath) : "";
  if (!handle && !filePath) throw new Error("需要 handle 或 filePath 参数");
  if (handle) return handle;
  log(`ensureFileIndexed BEFORE path=${filePath}`);
  const h = await ensureFileIndexed(filePath);
  log(`ensureFileIndexed AFTER handle=${h}`);
  return h;
}

const server = new Server(
  { name: "frugal", version: "0.0.5" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "tok_retrieve",
      description:
        `按指定 handle 取回已存原文。query 检索,或 startLine + count 按行取(最多 ${MAX_RETRIEVE_LINE_COUNT} 行、${MAX_RETRIEVE_CHARS} 字符);超长行按返回的 offsetChars 续读同一行范围。仅传 handle 取全文(上限 ${MAX_FULL_TEXT} 字符)。`,
      inputSchema: {
        type: "object",
        properties: {
          handle: {
            type: "string",
            description: "原文句柄,如 orig-1(在压缩结果的「handle=」标记里)",
          },
          query: {
            type: "string",
            description: "可选:关键词,做全文检索返回匹配片段(带行号)",
          },
          startLine: {
            type: "number",
            description: "可选:起始行号(1-based),配合 count 按行取片段",
          },
          count: {
            type: "number",
            description: "可选:取的行数,配合 startLine 使用",
          },
          offsetChars: {
            type: "integer",
            minimum: 0,
            description: "可选:所请求行范围内的 UTF-16 字符偏移(从 0 开始)。续读时保持 startLine/count 不变,使用上次返回的偏移。",
          },
        },
        required: ["handle"],
      },
    },
    {
      name: "tok_stats",
      description:
        "查看已存字符度量(非实测 token):记录数、字符减少量与比例、类型/会话明细、取回次数及记录取回率。无参数。",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "tok_code_map",
      description:
        "【优先于 Read】代码文件(.ts/.js/.vue/.tsx/.jsx)结构图。传 filePath(绝对路径)即可,自动读取+索引。返回符号列表、调用概览;Vue SFC 返回 template/script/style 分区、组件引用、事件绑定。理解代码时必须先用此工具,而非直接 Read 整个文件——Read 大文件浪费大量 token。Edit 前需精确文本时再用 Read 或 tok_retrieve 按行取。",
      inputSchema: {
        type: "object",
        properties: {
          handle: {
            type: "string",
            description: "代码原文句柄(压缩结果里的 handle=orig-N 或 h-...)",
          },
          filePath: {
            type: "string",
            description: "代码文件绝对路径。与 handle 二选一;传此参数会自动读取文件、索引并返回结构图。",
          },
        },
      },
    },
    {
      name: "tok_code_symbol",
      description:
        "【优先于 Read】查询代码文件的符号定义及实现。传 filePath(绝对路径)即可,自动读取+索引。精确查 symbol 或模糊 query 匹配。支持 TS/JS,Vue SFC 解析 script/setup。理解函数/类/方法时用此工具,而非 Read 整个文件。includeBody=true 可内联实现(有字符上限)。",
      inputSchema: {
        type: "object",
        properties: {
          handle: {
            type: "string",
            description: "代码原文句柄(压缩结果里的 handle=orig-N)",
          },
          filePath: {
            type: "string",
            description: "代码文件绝对路径。与 handle 二选一;自动读取文件并索引。",
          },
          symbol: {
            type: "string",
            description: "可选:精确符号名(函数/类/方法名)",
          },
          query: {
            type: "string",
            description: "可选:模糊查询词,匹配符号名",
          },
          includeBody: {
            type: "boolean",
            description: "可选:是否内联符号完整实现。设为 true 可直接获取方法/函数的完整代码,无需再用 tok_retrieve 按行取。默认 false(仅看签名和调用关系时用)。",
          },
          maxBodyChars: {
            type: "number",
            description: "可选:includeBody=true 时的实现字符上限,默认 8000,最大 16000。绝大多数方法/函数在 8000 字符内可完整返回。",
          },
        },
      },
    },
    {
      name: "tok_code_refs",
      description:
        "【优先于 Read】查询代码文件的调用关系。传 filePath(绝对路径)即可,自动读取+索引。callers=谁调用了本符号,callees=本符号调用了谁。支持 TS/JS/Vue SFC script。分析依赖关系时用此工具,而非 Read 整个文件去人工找调用。",
      inputSchema: {
        type: "object",
        properties: {
          handle: {
            type: "string",
            description: "代码原文句柄(orig-N)",
          },
          filePath: {
            type: "string",
            description: "代码文件绝对路径。与 handle 二选一;自动读取文件并索引。",
          },
          symbol: {
            type: "string",
            description: "符号名(函数/方法名)",
          },
          direction: {
            type: "string",
            enum: ["callers", "callees"],
            description: "callers=谁调用本符号;callees=本符号调用了谁",
          },
          depth: {
            type: "number",
            description: "可选:callees 递归深度(默认1,最大3)",
          },
        },
        required: ["symbol", "direction"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const argSummary = JSON.stringify({
    handle: args.handle,
    filePath: args.filePath,
    query: args.query,
    startLine: args.startLine,
    count: args.count,
    offsetChars: args.offsetChars,
    symbol: args.symbol,
    direction: args.direction,
    depth: args.depth,
  });
  log(`ENTER ${name} ${argSummary}`);
  try {
    let text: string;
    if (name === "tok_retrieve") {
      log(`tokRetrieve BEFORE`);
      const r = tokRetrieve({
        handle: String(args.handle ?? ""),
        query: args.query != null ? String(args.query) : undefined,
        startLine: args.startLine != null ? Number(args.startLine) : undefined,
        count: args.count != null ? Number(args.count) : undefined,
        offsetChars: args.offsetChars != null ? Number(args.offsetChars) : undefined,
      });
      log(`tokRetrieve AFTER retrieved=${r.retrieved} textLen=${r.text.length}`);
      text = r.text;
      // 仅当模型实际取回原文内容(命中/按行取到/全文)才累加取回计数。
      // 未命中、超大提示、错误不计。
      if (r.retrieved && args.handle) {
        log(`incrementRetrieved BEFORE`);
        try {
          store.incrementRetrieved(String(args.handle));
          log(`incrementRetrieved AFTER`);
        } catch (e) {
          log(`incrementRetrieved THREW ${String((e as Error).message)}`);
        }
      }
    } else if (name === "tok_code_map") {
      log(`tok_code_map BEFORE`);
      const handle = await resolveHandle(args);
      log(`retrieveCodeMap BEFORE handle=${handle}`);
      const r = await retrieveCodeMap(handle);
      log(`retrieveCodeMap AFTER retrieved=${r.retrieved} textLen=${r.text.length}`);
      text = r.text;
      if (r.retrieved) {
        try { store.incrementRetrieved(handle); } catch {}
      }
    } else if (name === "tok_code_symbol") {
      log(`tok_code_symbol BEFORE`);
      const handle = await resolveHandle(args);
      const r = await retrieveSymbol(
        handle,
        args.symbol != null ? String(args.symbol) : undefined,
        args.query != null ? String(args.query) : undefined,
        {
          includeBody: args.includeBody === true,
          maxBodyChars: args.maxBodyChars != null ? Number(args.maxBodyChars) : undefined,
        }
      );
      log(`retrieveSymbol AFTER retrieved=${r.retrieved} textLen=${r.text.length}`);
      text = r.text;
      if (r.retrieved) {
        try { store.incrementRetrieved(handle); } catch {}
      }
    } else if (name === "tok_code_refs") {
      log(`tok_code_refs BEFORE`);
      const handle = await resolveHandle(args);
      const direction = String(args.direction ?? "callees") as "callers" | "callees";
      const depth = args.depth != null ? Number(args.depth) : 1;
      log(`retrieveRefs BEFORE`);
      const r = await retrieveRefs(
        handle,
        String(args.symbol ?? ""),
        direction,
        depth
      );
      log(`retrieveRefs AFTER retrieved=${r.retrieved} textLen=${r.text.length}`);
      text = r.text;
      if (r.retrieved) {
        try { store.incrementRetrieved(handle); } catch {}
      }
    } else if (name === "tok_stats") {
      text = tokStats();
      log(`tokStats textLen=${text.length}`);
    } else {
      throw new Error(`未知工具: ${name}`);
    }
    log(`EXIT ${name} respLen=${text.length}`);
    return { content: [{ type: "text", text }] };
  } catch (e) {
    log(`HANDLER THREW ${name} ${String((e as Error).message)}`);
    return {
      content: [{ type: "text", text: `❌ 工具调用失败 (${name}): ${(e as Error).message}` }],
      isError: true,
    };
  }
});

// 直接运行 → 启动 stdio server;被 import 测试时不启动(避免抢占 stdin)
if (!process.env.FRUGAL_MCP_TEST) {
  log(`connecting StdioServerTransport`);
  await server.connect(new StdioServerTransport());
  log(`connected; idle, awaiting tool calls`);
}
