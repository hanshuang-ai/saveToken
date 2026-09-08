/**
 * decision-log.ts —— 分类决策日志
 *
 * 每次 classify 判定记一行 JSONL,积累"决策库",让分类规则可回溯、可统计、
 * 用数据反推扩展名表该怎么分档(而非拍脑袋硬编码)。
 *
 * 设计:
 *   - 独立于 classify 主流程,通过 enable/disable 开关,不影响默认性能
 *   - JSONL 格式(一行一条,好追加好分析)
 *   - 同步追加写(分类是热路径,但日志默认关闭;开启时用 appendFileSync)
 *   - 字段:路径、扩展名、文件名关键词、大小、判定、置信度、命中信号、来源(tool)
 *
 * 用法:
 *   import { decisionLog } from "./decision-log";
 *   decisionLog.enable("/path/to/decisions.jsonl");
 *   // classify 内部调用 decisionLog.record(...)
 *   decisionLog.summary();  // 汇总统计
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname, basename } from "node:path";
import type { ContentType } from "./types";

export interface DecisionRecord {
  /** 来源文件路径(无路径时为空,如 Bash stdout) */
  path?: string;
  /** 扩展名(含点,小写;无扩展名为空串) */
  ext: string;
  /** 文件名(不含路径) */
  filename: string;
  /** 文件名关键词(从文件名提取的类型线索,如 log/info/conf) */
  nameKeywords: string[];
  /** 内容大小(字符数) */
  size: number;
  /** 判定类型 */
  type: ContentType;
  /** 置信度 0-1 */
  confidence: number;
  /** 命中的分类信号 */
  signals: string[];
  /** 来源工具名(如 Bash/Read) */
  tool?: string;
  /** 时间戳(epoch ms)。注意:运行时由调用方传入,不在模块内取 Date.now */
  ts: number;
}

/** 文件名里的类型线索关键词(命中即提示结构化) */
const NAME_KEYWORDS = [
  "log", "logs", "info", "stat", "stats", "conf", "config",
  "prop", "properties", "history", "tree", "ver", "version",
  "cache", "dump", "trace", "prof", "mem", "cpu", "disk",
  "boot", "kernel", "radio", "event", "crash",
];

function extractNameKeywords(filename: string): string[] {
  const lower = filename.toLowerCase();
  const hits: string[] = [];
  for (const kw of NAME_KEYWORDS) {
    // 词边界匹配:前后是非字母数字 或 字符串边界
    // 避免把 "catalog" 里的 "log" 误匹配——要求前后是边界
    const idx = lower.indexOf(kw);
    if (idx < 0) continue;
    const before = idx > 0 ? lower[idx - 1] : " ";
    const after = idx + kw.length < lower.length ? lower[idx + kw.length] : " ";
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
      hits.push(kw);
    }
  }
  return hits;
}

class DecisionLogger {
  private enabled = false;
  private filePath = "";
  private count = 0;

  /** 开启决策日志,写入指定文件 */
  enable(path: string): void {
    this.filePath = path;
    this.enabled = true;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // 清空旧文件,开始新一轮记录
    appendFileSync(path, "");
    this.count = 0;
  }

  /** 关闭 */
  disable(): void {
    this.enabled = false;
  }

  /** 是否已开启 */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** 记一条决策 */
  record(
    text: string,
    result: { type: ContentType; confidence: number; signals: string[] },
    meta: { path?: string; tool?: string },
    now: number
  ): void {
    if (!this.enabled) return;
    const filename = meta.path ? basename(meta.path) : "";
    const ext = meta.path ? extname(meta.path).toLowerCase() : "";
    const rec: DecisionRecord = {
      path: meta.path,
      ext,
      filename,
      nameKeywords: extractNameKeywords(filename),
      size: text.length,
      type: result.type,
      confidence: result.confidence,
      signals: result.signals,
      tool: meta.tool,
      ts: now,
    };
    appendFileSync(this.filePath, JSON.stringify(rec) + "\n", "utf-8");
    this.count++;
  }

  getRecordedCount(): number {
    return this.count;
  }

  /** 读回日志,做汇总统计(按扩展名/文件名关键词的判定分布) */
  summary(): {
    total: number;
    byExt: Record<string, Record<string, number>>;
    byKeyword: Record<string, Record<string, number>>;
    byType: Record<string, number>;
    lowConfidence: DecisionRecord[];
  } {
    if (!this.filePath || !existsSync(this.filePath)) {
      return { total: 0, byExt: {}, byKeyword: {}, byType: {}, lowConfidence: [] };
    }
    const lines = readFileSync(this.filePath, "utf-8").split("\n").filter(Boolean);
    const byExt: Record<string, Record<string, number>> = {};
    const byKeyword: Record<string, Record<string, number>> = {};
    const byType: Record<string, number> = {};
    const lowConfidence: DecisionRecord[] = [];

    for (const line of lines) {
      let rec: DecisionRecord;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      // 按扩展名分布(无扩展名记作 "(none)")
      const extKey = rec.ext || "(none)";
      (byExt[extKey] ||= {})[rec.type] = (byExt[extKey][rec.type] || 0) + 1;
      // 按文件名关键词分布
      if (rec.nameKeywords.length > 0) {
        const kwKey = rec.nameKeywords.join(",");
        (byKeyword[kwKey] ||= {})[rec.type] = (byKeyword[kwKey][rec.type] || 0) + 1;
      }
      // 总类型分布
      byType[rec.type] = (byType[rec.type] || 0) + 1;
      // 低置信度样本(< 0.6),前 30 个
      if (rec.confidence < 0.6 && lowConfidence.length < 30) {
        lowConfidence.push(rec);
      }
    }

    return { total: lines.length, byExt, byKeyword, byType, lowConfidence };
  }
}

/** 单例 */
export const decisionLog = new DecisionLogger();
