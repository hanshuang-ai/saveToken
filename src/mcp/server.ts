/**
 * server.ts —— frugal MCP server
 *
 * 暴露两个工具,让模型能取回被压缩的工具输出原文、查节省度量:
 *   1. tok_retrieve —— 取回原文 / 关键词检索 / 按行号取片段
 *   2. tok_stats    —— 度量汇总(节省比、分类型、取回率)
 *
 * 配合 PostToolUse hook:hook 把工具输出压成压缩版 + 存原文(handle),
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
import { tmpdir } from "node:os";
import { store } from "../store/db";

// ─── 数据目录与 store 初始化 ──────────────────────────────────────────────────
// 与 hook 脚本用同一份数据库,故路径逻辑保持一致。
function dataDir(): string {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) return pluginData;
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (root) return join(root, ".data");
  return join(tmpdir(), "frugal");
}
const DATA = dataDir();
const DB_PATH = join(DATA, "frugal.db");

try {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
  store.open(DB_PATH);
} catch {
  // store 打不开时,工具调用会返回错误提示,但不崩进程
}

/** 全文取回的安全上限:超过此字符数提示模型用 query/startLine 精确取,而非倾倒全文 */
const MAX_FULL_TEXT = 60000;

// ─── 工具实现 ──────────────────────────────────────────────────────────────────

interface RetrieveArgs {
  handle: string;
  query?: string;
  startLine?: number;
  count?: number;
}

/** 取回结果:text 为给模型看的内容;retrieved 表示是否实际取回了原文内容(命中/按行/全文) */
interface RetrieveResult {
  text: string;
  retrieved: boolean;
}

function tokRetrieve(args: RetrieveArgs): RetrieveResult {
  const { handle, query, startLine, count } = args;
  if (!handle) return { text: "❌ 缺少 handle 参数", retrieved: false };

  const exists = store.getOriginal(handle);
  if (!exists) {
    return { text: `❌ handle=${handle} 不存在(可能已过期或从未存储)。可用 tok_stats 查看已有记录。`, retrieved: false };
  }

  // 模式1:关键词检索 —— 返回匹配片段(带行号),不全量倾倒
  if (query && query.trim()) {
    const hits = store.search(handle, query, 10);
    if (hits.length === 0) {
      // 未命中不算"取回"——空查询不是"压缩太激进"的信号,不应累加取回计数
      return { text: `handle=${handle} 中未找到关键词「${query}」的匹配。原文 ${exists.size} 字符,可换关键词或用 startLine 按行取。`, retrieved: false };
    }
    const lines = hits.map(
      (h) => `[行 ${h.lineNo}] ${h.snippet}`
    );
    return { text: `handle=${handle} 检索「${query}」命中 ${hits.length} 条(按相关性排序):\n\n${lines.join("\n\n")}`, retrieved: true };
  }

  // 模式2:按行号取片段 —— startLine + count
  if (startLine != null && count != null) {
    const chunk = store.getLines(handle, startLine, count);
    if (!chunk) return { text: `❌ handle=${handle} 取行失败`, retrieved: false };
    return { text: `handle=${handle} 第 ${startLine}~${startLine + count - 1} 行:\n\n${chunk}`, retrieved: true };
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
    return "尚无压缩记录。运行产生工具输出后(Bash/Read 被 hook 拦截压缩),这里会显示节省统计。";
  }
  const pct = (s.savedRatio * 100).toFixed(1);
  const byType = Object.entries(s.byType)
    .map(([t, v]) => `  ${t}: ${v.count} 条,省 ${v.saved} 字符`)
    .join("\n");
  return [
    `frugal 度量汇总:`,
    `  总记录: ${s.total} 条(其中压缩 ${s.compressed} 条)`,
    `  原始: ${s.totalOriginal} 字符 → 压缩后: ${s.totalCompressed} 字符`,
    `  节省: ${s.saved} 字符(${pct}%)`,
    `  被取回: ${s.retrievedCount} 次(取回多=压缩可能太激进,该调阈值)`,
    `分类型:`,
    byType,
  ].join("\n");
}

// ─── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "frugal", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "tok_retrieve",
      description:
        "取回被 frugal 压缩的工具输出原文。当你在工具结果里看到「frugal:原文已存,handle=xxx」标记时,用本工具取回完整内容。三种用法:(1) 只传 handle 取完整原文;(2) 传 handle + query 按关键词检索相关片段(推荐,省 token);(3) 传 handle + startLine + count 按行号取片段。优先用检索/按行,避免取回超大全文。",
      inputSchema: {
        type: "object",
        properties: {
          handle: {
            type: "string",
            description: "原文句柄,如 orig-1(在压缩结果的「handle=」标记里)",
          },
          query: {
            type: "string",
            description: "可选:关键词,做全文检索返回匹配片段(带行号)。比取全文省 token",
          },
          startLine: {
            type: "number",
            description: "可选:起始行号(1-based),配合 count 按行取片段",
          },
          count: {
            type: "number",
            description: "可选:取的行数,配合 startLine 使用",
          },
        },
        required: ["handle"],
      },
    },
    {
      name: "tok_stats",
      description:
        "查看 frugal 的 token 节省度量汇总:总压缩次数、节省字符数与比例、分内容类型统计、被取回次数(取回率是压缩是否太激进的信号)。无参数。",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    let text: string;
    if (name === "tok_retrieve") {
      const r = tokRetrieve({
        handle: String(args.handle ?? ""),
        query: args.query != null ? String(args.query) : undefined,
        startLine: args.startLine != null ? Number(args.startLine) : undefined,
        count: args.count != null ? Number(args.count) : undefined,
      });
      text = r.text;
      // 仅当模型实际取回原文内容(命中/按行取到/全文)才累加取回计数。
      // 未命中、超大提示、错误不计——空查询不是"压缩太激进"的信号。
      if (r.retrieved && args.handle) {
        try {
          store.incrementRetrieved(String(args.handle));
        } catch {
          // ignore
        }
      }
    } else if (name === "tok_stats") {
      text = tokStats();
    } else {
      throw new Error(`未知工具: ${name}`);
    }
    return { content: [{ type: "text", text }] };
  } catch (e) {
    return {
      content: [{ type: "text", text: `❌ 工具调用失败 (${name}): ${(e as Error).message}` }],
      isError: true,
    };
  }
});

// 直接运行 → 启动 stdio server;被 import 测试时不启动(避免抢占 stdin)
if (!process.env.FRUGAL_MCP_TEST) {
  await server.connect(new StdioServerTransport());
}
