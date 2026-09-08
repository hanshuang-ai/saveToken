/**
 * db.ts —— SQLite 存储层
 *
 * 三个职责:
 *   1. 原文备份:存压缩前原文,handle 取回(安全模型第三道闸门)
 *   2. 全文检索:FTS5 索引,tok_retrieve 按关键词查相关片段
 *   3. 度量记录:每次压缩记大小/类型/策略,统计节省与取回率
 *
 * 第一阶段:只服务无引用的结构化内容(日志/JSON/表格)。代码只压缩不检索(设计文档 TODO-1)。
 *
 * 用法:
 *   import { store } from "./db";
 *   store.open("/path/to/frugal.db");
 *   const handle = store.saveOriginal(text, { source, tool }, now);
 *   const text = store.getOriginal(handle);
 *   const hits = store.search(handle, "报错 ERROR");
 *   store.recordMetric({ ... });
 */

import { Database } from "bun:sqlite";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const SCHEMA_PATH = join(import.meta.dir, "schema.sql");

/** 原文备份:返回的句柄用于取回 */
export interface OriginalRecord {
  handle: string;
  content: string;
  size: number;
  source?: string;
  tool?: string;
  createdAt: number;
}

/** 检索命中:原文的一个片段 */
export interface SearchHit {
  handle: string;
  lineNo: number;
  /** 命中片段原文 */
  snippet: string;
  /** FTS5 bm25 排序分数(越小越相关) */
  rank: number;
}

/** 度量记录入参 */
export interface MetricInput {
  handle?: string;
  source?: string;
  tool?: string;
  contentType: "structured" | "prose" | "mixed" | "empty";
  originalSize: number;
  compressedSize: number;
  method: string;
  createdAt: number;
}

/** 度量汇总 */
export interface MetricSummary {
  total: number;
  compressed: number;
  totalOriginal: number;
  totalCompressed: number;
  /** 总节省字符数 */
  saved: number;
  /** 平均节省比 0-1 */
  savedRatio: number;
  byType: Record<string, { count: number; saved: number }>;
  /** 被取回的记录数(成功率信号:取回多=压缩太激进) */
  retrievedCount: number;
}

class Store {
  private db: Database | null = null;
  private dbPath = "";

  /** 打开/创建数据库。path 为空则用内存库(测试用)。 */
  open(path?: string): void {
    if (path) {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.db = new Database(path, { create: true });
      this.dbPath = path;
    } else {
      this.db = new Database(":memory:");
      this.dbPath = ":memory:";
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initSchema();
  }

  /** 初始化表结构 */
  private initSchema(): void {
    const schema = readFileSync(SCHEMA_PATH, "utf-8");
    this.db!.exec(schema);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  get path(): string {
    return this.dbPath;
  }

  private ensureOpen(): Database {
    if (!this.db) throw new Error("Store 未打开,请先调用 store.open()");
    return this.db;
  }

  // ─── 原文备份 ────────────────────────────────────────────────────────────

  /**
   * 存原文,返回 handle。
   * 同时按行建 FTS5 索引(供检索用)。大文本分行索引,查询时能定位行号。
   */
  saveOriginal(
    content: string,
    meta: { source?: string; tool?: string },
    now: number
  ): string {
    return this.saveOriginalWithHandle(this.makeHandle(), content, meta, now);
  }

  /**
   * 存原文,用指定的 handle(snip 等需要固定 handle 的场景)。
   * handle 已存在则覆盖(同 handle 重复存视为更新)。
   */
  saveOriginalWithHandle(
    handle: string,
    content: string,
    meta: { source?: string; tool?: string },
    now: number
  ): string {
    const db = this.ensureOpen();
    const size = content.length;

    // 已存在则先删旧记录(含 FTS 索引),再插新的
    db.prepare("DELETE FROM originals WHERE handle = ?").run(handle);
    db.prepare("DELETE FROM docs_fts WHERE handle = ?").run(handle);

    db.prepare(
      "INSERT INTO originals(handle, content, compressed, size, source, tool, created_at) VALUES (?, ?, 0, ?, ?, ?, ?)"
    ).run(handle, content, size, meta.source ?? null, meta.tool ?? null, now);

    this.indexLines(handle, content);
    return handle;
  }

  /** 取回原文(handle 不存在返回 undefined) */
  getOriginal(handle: string): OriginalRecord | undefined {
    const db = this.ensureOpen();
    const row = db
      .prepare(
        "SELECT handle, content, size, source, tool, created_at FROM originals WHERE handle = ?"
      )
      .get(handle) as
      | { handle: string; content: string; size: number; source: string | null; tool: string | null; created_at: number }
      | null;
    if (!row) return undefined;
    return {
      handle: row.handle,
      content: row.content,
      size: row.size,
      source: row.source ?? undefined,
      tool: row.tool ?? undefined,
      createdAt: row.created_at,
    };
  }

  /** 按 handle 取回原文纯文本(快捷方式) */
  getOriginalText(handle: string): string | undefined {
    const rec = this.getOriginal(handle);
    return rec?.content;
  }

  // ─── 全文检索 ────────────────────────────────────────────────────────────

  /**
   * 关键词检索:在指定原文内查匹配片段。
   * @param handle 原文句柄(限定在该原文内查)
   * @param query  查询词(FTS5 语法,如 "报错 ERROR")
   * @param limit  最多返回数
   * @returns 命中片段列表(按相关性排序),带行号和上下文
   */
  search(handle: string, query: string, limit = 5): SearchHit[] {
    const db = this.ensureOpen();
    // FTS5 MATCH 查询,按 bm25 排序
    // 注意:query 需做 FTS5 安全处理(避免注入/语法错误),用引号包裹当短语查询
    const safeQuery = this.sanitizeFtsQuery(query);
    if (!safeQuery) return [];
    try {
      const rows = db
        .prepare(
          `SELECT handle, line_no, content, rank
           FROM docs_fts
           WHERE handle = ? AND docs_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(handle, safeQuery, limit) as
        | { handle: string; line_no: number; content: string; rank: number }[];
      return rows.map((r) => ({
        handle: r.handle,
        lineNo: r.line_no,
        snippet: r.content,
        rank: r.rank,
      }));
    } catch {
      // FTS 查询语法错误等,返回空
      return [];
    }
  }

  /**
   * 取指定行号附近的片段(带上下文)。
   * 检索命中后,模型可能要更多上下文,凭行号取邻近行。
   */
  getLines(handle: string, startLine: number, count: number): string {
    const db = this.ensureOpen();
    const row = db
      .prepare("SELECT content FROM originals WHERE handle = ?")
      .get(handle) as { content: string } | null;
    if (!row) return "";
    const lines = row.content.split("\n");
    const start = Math.max(0, startLine - 1); // 转为 0-based
    const end = Math.min(lines.length, start + count);
    return lines.slice(start, end).join("\n");
  }

  // ─── 度量记录 ────────────────────────────────────────────────────────────

  /** 记一条度量 */
  recordMetric(m: MetricInput): void {
    const db = this.ensureOpen();
    db.prepare(
      `INSERT INTO metrics(handle, source, tool, content_type, original_size, compressed_size, method, retrieved_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(
      m.handle ?? null,
      m.source ?? null,
      m.tool ?? null,
      m.contentType,
      m.originalSize,
      m.compressedSize,
      m.method,
      m.createdAt
    );
  }

  /** 标记某 handle 被取回一次(成功率信号) */
  incrementRetrieved(handle: string): void {
    const db = this.ensureOpen();
    db.prepare("UPDATE metrics SET retrieved_count = retrieved_count + 1 WHERE handle = ?").run(
      handle
    );
  }

  /** 度量汇总(供 tok_stats) */
  getMetricSummary(): MetricSummary {
    const db = this.ensureOpen();
    const overall = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN compressed_size < original_size THEN 1 ELSE 0 END) AS compressed,
           SUM(original_size) AS total_original,
           SUM(compressed_size) AS total_compressed,
           SUM(retrieved_count) AS retrieved
         FROM metrics`
      )
      .get() as {
      total: number;
      compressed: number;
      total_original: number;
      total_compressed: number;
      retrieved: number;
    };

    const byTypeRows = db
      .prepare(
        `SELECT content_type, COUNT(*) AS count, SUM(original_size - compressed_size) AS saved
         FROM metrics GROUP BY content_type`
      )
      .all() as { content_type: string; count: number; saved: number }[];
    const byType: Record<string, { count: number; saved: number }> = {};
    for (const r of byTypeRows) {
      byType[r.content_type] = { count: r.count, saved: r.saved ?? 0 };
    }

    const totalOriginal = overall.total_original ?? 0;
    const totalCompressed = overall.total_compressed ?? 0;
    return {
      total: overall.total ?? 0,
      compressed: overall.compressed ?? 0,
      totalOriginal,
      totalCompressed,
      saved: Math.max(0, totalOriginal - totalCompressed),
      savedRatio: totalOriginal > 0 ? Math.max(0, totalOriginal - totalCompressed) / totalOriginal : 0,
      byType,
      retrievedCount: overall.retrieved ?? 0,
    };
  }

  // ─── 内部 ────────────────────────────────────────────────────────────────

  /** 按行建 FTS5 索引。大文本按块切(每块 N 行),避免单行太碎或整篇太大 */
  private indexLines(handle: string, content: string): void {
    const db = this.ensureOpen();
    const lines = content.split("\n");
    const CHUNK = 20; // 每 20 行一块,平衡索引粒度与条数
    const ins = db.prepare(
      "INSERT INTO docs_fts(handle, line_no, content) VALUES (?, ?, ?)"
    );
    // 用事务批量插入,提速
    db.exec("BEGIN");
    try {
      for (let i = 0; i < lines.length; i += CHUNK) {
        const lineNo = i + 1; // 1-based
        const chunk = lines.slice(i, i + CHUNK).join("\n");
        if (chunk.trim()) {
          ins.run(handle, lineNo, chunk);
        }
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  /** FTS5 查询安全化:包裹引号做短语查询,转义内部双引号 */
  private sanitizeFtsQuery(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) return "";
    // 按空白拆词,每词单独短语查询,空格连接 = FTS5 隐式 AND。
    // 这样 "classify function" 命中文中既含 classify 又含 function 的块,
    // 而非要求多词相邻(旧实现把整个 query 当一个短语,多词几乎必踩空)。
    // 引号包裹使每 token 成为字面量短语,FTS5 操作符(AND/OR/NOT/NEAR)不被误解析。
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return "";
    return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
  }

  /**
   * 生成跨进程唯一句柄。
   *
   * hook 每次调用都是新进程,进程内 counter 永远从 0 开始 → 永远生成 orig-1,
   * 后存的原文会覆盖前面的(saveOriginalWithHandle 先删后插)。
   * 用 SQLite 自增序列保证跨进程递增且不冲突。
   */
  private makeHandle(): string {
    const db = this.ensureOpen();
    // 用序列表保证跨进程原子递增;表不存在则建
    db.exec(
      "CREATE TABLE IF NOT EXISTS handle_seq (id INTEGER PRIMARY KEY)"
    );
    db.exec("INSERT INTO handle_seq (id) VALUES (NULL)");
    const row = db.prepare("SELECT last_insert_rowid() AS n").get() as {
      n: number;
    };
    return `orig-${row.n.toString(36)}`;
  }
}

/** 单例 */
export const store = new Store();
