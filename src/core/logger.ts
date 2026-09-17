/**
 * 统一日志 —— 所有 frugal 组件(hooks / MCP / core)共用一个 trace 文件。
 *
 * 路径优先级:
 *   1. FRUGAL_TRACE_LOG 环境变量(绝对路径)
 *   2. FRUGAL_DATA_DIR/frugal-trace.log
 *   3. ~/Desktop/frugal/frugal-trace.log
 *
 * 未设 FRUGAL_DATA_DIR 且无 FRUGAL_TRACE_LOG 时仍写默认路径,
 * 方便开发调试;生产可设 FRUGAL_TRACE_LOG=/dev/null 关闭。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const TRACE_LOG =
  process.env.FRUGAL_TRACE_LOG ??
  join(process.env.FRUGAL_DATA_DIR ?? join(homedir(), "Desktop", "frugal"), "frugal-trace.log");

let _seq = 0;

/** 写一条 trace 日志。tag 标识组件, msg 是消息, data 可选附加对象(JSON 内联)。 */
export function trace(tag: string, msg: string, data?: Record<string, unknown>): void {
  try {
    const seq = ++_seq;
    const ts = new Date().toISOString();
    const pid = process.pid;
    const dataStr = data ? " " + JSON.stringify(data) : "";
    mkdirSync(dirname(TRACE_LOG), { recursive: true });
    appendFileSync(TRACE_LOG, `${ts} #${seq} [pid ${pid}] [${tag}] ${msg}${dataStr}\n`);
  } catch {
    // 日志绝不抛
  }
}

/** 返回当前 trace 日志文件路径,供各组件启动时记录。 */
export function getTraceLogPath(): string {
  return TRACE_LOG;
}
