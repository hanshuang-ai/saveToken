#!/usr/bin/env bun
/**
 * post-tool-compress.ts —— PostToolUse hook(核心接线)
 *
 * 链路:工具输出 → 白名单 → 阈值 → 分类 → 无损压缩 → 原文存 SQLite →
 *       updatedToolOutput 返回压缩版 → 记度量
 *
 * 契约(官方文档 code.claude.com/docs/en/hooks,已实测确认):
 *   输入 stdin JSON: { tool_name, tool_input, tool_response, cwd, session_id, ... }
 *   输出 stdout JSON: {
 *     hookSpecificOutput: {
 *       hookEventName: "PostToolUse",
 *       updatedToolOutput: <形状同原 tool_response,仅字符串字段被压缩>
 *     }
 *   }
 *   updatedToolOutput 在工具输出发送给模型之前替换它(工具副作用已发生,只改模型看到的)。
 *
 * 适配策略:递归遍历 tool_response,只压缩"长字符串"字段,结构原样保留 →
 *          形状自动匹配任何工具(Bash{stdout,stderr,...} / Read{...} / ...),无需逐工具硬编码。
 *
 * 安全(绝不破坏工具输出):
 *   - 散文一律放行(分类器安全侧)
 *   - 小于阈值不碰
 *   - 任何异常 → exit 0 原样放行,不输出 JSON
 *   - 原文永远备份在 SQLite,handle 可经 tok_retrieve 取回(安全模型第三道闸门)
 */

import { classify } from "../src/core/classifier";
import { compress } from "../src/compress";
import { store } from "../src/store/db";
import { decisionLog } from "../src/core/decision-log";
import { langForExt } from "../src/codegraph/languages";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── 配置 ──────────────────────────────────────────────────────────────────

/** 拦截的工具白名单(覆盖 80%+ 浪费,见设计文档五·甲) */
const WHITELIST = new Set(["Bash", "Read"]);

/** 触发压缩的最小字符数(单字段)。小于此不碰,避免开销 */
const MIN_CHARS = 2048;

/** 数据库与决策日志路径:优先插件数据目录,回退插件根下 .data,再回退临时目录 */
function dataDir(): string {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) return pluginData;
  if (root) return join(root, ".data");
  return join(tmpdir(), "frugal");
}
const DATA = dataDir();
const DB_PATH = join(DATA, "frugal.db");
const DECISION_LOG = join(DATA, "hook-decisions.jsonl");

// ─── 初始化(每次 hook 调用都是新进程,需重新打开) ──────────────────────────

let storeOpened = false;
function ensureStore(): void {
  if (storeOpened) return;
  try {
    if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
    store.open(DB_PATH);
    storeOpened = true;
  } catch {
    // store 打不开不阻塞压缩(压缩仍可走内存回退,只是失去持久备份/检索)
  }
}

function ensureDecisionLog(): void {
  if (decisionLog.isEnabled()) return;
  try {
    if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
    decisionLog.enable(DECISION_LOG);
  } catch {
    // 日志开不了不影响主流程
  }
}

// ─── 核心:压缩单个字符串字段 ────────────────────────────────────────────────

/**
 * 对一个字符串字段做 分类→压缩→存备份→记度量。
 * @returns { changed, value } changed=true 时 value 为压缩版(末尾附原文 handle)
 */
function compressStringField(
  text: string,
  tool: string,
  path: string | undefined,
  sessionId: string | undefined,
  now: number
): { changed: boolean; value: string } {
  if (text.length < MIN_CHARS) {
    return { changed: false, value: text };
  }

  const cls = classify({ text, tool, path });

  // 散文与 mixed 一律放行(安全侧:绝不压叙事)。
  // mixed 含散文部分,实测 format-strip ROI 仅 3-11%,却照常分类/存原文/记 metrics
  // 产生噪音,不值得为这点收益冒险触碰叙事部分 → 与 prose 同等放行。
  if (cls.type === "prose" || cls.type === "mixed" || cls.type === "empty") {
    return { changed: false, value: text };
  }

  // structured:format-strip + snip(头尾截断)。
  // 省 token 大头靠 snip。dedup 原语已移除:在"存原文+store 取回"架构下其可逆性
  // 是死路径(模型取回走 store 不走 decompress),退化成有损缩写且把路径压成 @n
  // 伤可读性,实测收益仅 ~8% 且 74% 集中在单条日志。详见设计文档。
  const result = compress(text);

  if (!result.compressed) {
    return { changed: false, value: text };
  }

  // 存完整原文(安全模型第三道闸门:handle 可取回原文)
  let handle = "";
  try {
    ensureStore();
    if (storeOpened) {
      handle = store.saveOriginal(text, { source: path, tool }, now);
      store.recordMetric({
        handle,
        source: path,
        tool,
        contentType: cls.type,
        originalSize: result.originalSize,
        compressedSize: result.compressedSize,
        method: result.steps.map((s) => s.method).join(","),
        sessionId,
        createdAt: now,
      });
    }
  } catch {
    // 存储失败不阻塞压缩流程
  }

  // 末尾附原文 handle + 检索引导:引导模型按需取片段/按行,而非倾倒全文。
  // orig-N 是完整原文(FTS5 按原文行号建索引,startLine 正确);snip-(省略标记里)
  // 是被截中间段,其索引按中间段内行号建,与原文行号错配 → 优先用 orig-N,
  // 避免混用 snip- 的 startLine 拿到错位行。
  // 统计型与压缩根本矛盾(全表分析需全数据在上下文)→ 引导计算下推(Bash 处理源文件)。
  // 行数用压缩前的 text 算(compress 后 result.text 行数已变,不能用来报"共X行")。
  const totalLines = text.split("\n").length;
  const sourceTag = path ? `,来源:${path}` : "";
  const statHint = path
    ? `统计/聚合全表:用 Bash 处理源文件(如 awk/python ${path}),勿取回全文(耗token)。`
    : `统计/聚合全表:重新用 Bash 跑统计命令(如 awk),勿取回全文(耗token)。`;
  // 代码(TS/JS)走 AST 检索引导:tok_code_symbol/tok_code_refs 比扁平 FTS5 检索更准
  // (能跨文件解析调用关系)。hook 只判扩展名(langForExt 纯数据,不背 tree-sitter 依赖);
  // AST 解析在 MCP server 懒做(首次查某 handle 时 parse+存表,后续查表)。
  const ext = (() => {
    if (!path) return "";
    const d = path.lastIndexOf(".");
    const s = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return d > s ? path.slice(d + 1).toLowerCase() : "";
  })();
  const isCode = !!langForExt(ext);
  const note = handle
    ? isCode
      ? `\n\n「frugal:原文已存,handle=${handle}(代码,共${totalLines}行${sourceTag})。省略标记里的 snip- 是截断中间段,查符号用 ${handle}(完整原文)。\n查函数/类完整实现:tok_code_symbol(handle="${handle}", symbol="函数名")。\n查调用关系(跨文件,谁调用/调用了谁):tok_code_refs(handle="${handle}", symbol="函数名", direction="callees")。\n查特定行:tok_retrieve(handle="${handle}", startLine=N, count=M)。\n勿取回全文(耗token)。」`
      : `\n\n「frugal:原文已存,handle=${handle}(完整原文,共${totalLines}行${sourceTag})。省略标记是压缩视图(中间段或结构化摘要),${handle} 已含全文,优先用 ${handle}。\n查特定数据:tok_retrieve(handle="${handle}", query="关键词") 检索片段(约20行上下文),或 tok_retrieve(handle="${handle}", startLine=N, count=M) 按行取。\n${statHint}」`
    : "";
  return { changed: true, value: result.text + note };
}

// ─── 递归遍历 tool_response,压缩所有长字符串字段 ────────────────────────────

function rewriteToolResponse(
  node: unknown,
  tool: string,
  path: string | undefined,
  sessionId: string | undefined,
  now: number
): { changed: boolean; value: unknown } {
  if (typeof node === "string") {
    return compressStringField(node, tool, path, sessionId, now);
  }
  if (Array.isArray(node)) {
    let changed = false;
    const value = node.map((item) => {
      const r = rewriteToolResponse(item, tool, path, sessionId, now);
      if (r.changed) changed = true;
      return r.value;
    });
    return { changed, value };
  }
  if (node && typeof node === "object") {
    let changed = false;
    const value: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const r = rewriteToolResponse(v, tool, path, sessionId, now);
      if (r.changed) changed = true;
      value[k] = r.value;
    }
    return { changed, value };
  }
  // 数字/布尔/null 原样
  return { changed: false, value: node };
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 读 stdin
  let raw: string;
  try {
    raw = await Bun.stdin.text();
  } catch {
    return; // 读不到 stdin,放行
  }
  if (!raw.trim()) return;

  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return; // 非 JSON,放行
  }

  const toolName: string = data.tool_name ?? data.toolName ?? "";
  if (!WHITELIST.has(toolName)) return; // 不在白名单,放行

  const toolResponse = data.tool_response ?? data.toolResponse;
  if (toolResponse == null) return; // 无输出,放行

  // 来源路径(Read 的 file_path;Bash 无路径,走内容启发式)
  const toolInput = data.tool_input ?? data.toolInput ?? {};
  const path: string | undefined =
    typeof toolInput.file_path === "string" ? toolInput.file_path : undefined;

  // 会话 ID(用于会话级统计;PostToolUse payload 标准字段)
  const sessionId: string | undefined =
    typeof data.session_id === "string" ? data.session_id : undefined;

  const now = Date.now();
  ensureDecisionLog();

  let rewritten: { changed: boolean; value: unknown };
  try {
    rewritten = rewriteToolResponse(toolResponse, toolName, path, sessionId, now);
  } catch {
    return; // 压缩过程异常,放行(绝不破坏工具输出)
  }

  if (!rewritten.changed) return; // 没压缩(都太小/都散文),放行

  // 用 updatedToolOutput 返回压缩版(形状自动匹配,因为是同结构改字符串)
  const output = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: rewritten.value,
    },
  };
  console.log(JSON.stringify(output));

  // 关闭 store,确保 WAL 落盘
  try {
    if (storeOpened) store.close();
  } catch {
    // ignore
  }
}

main();
