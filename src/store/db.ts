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

import Database from "better-sqlite3";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "schema.sql");

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

/** 代码符号定义(函数/类/方法)——Task #18 代码 AST 图检索 */
export interface SymbolRecord {
  handle: string;
  name: string;
  kind: string; // function/class/method/variable
  startLine: number; // 1-based,对齐原文行号
  endLine: number;
  bodyText?: string; // 完整实现(主符号取回用)
  signature?: string; // 精简签名(引用符号取回用,控 token)
  exported: boolean;
  lang?: string; // typescript/tsx/javascript
  createdAt: number;
}

/** 代码引用边(调用/导入)——跨文件解析核心 */
export interface RefRecord {
  id?: number;
  fromHandle: string;
  fromSymbol?: string; // 调用方符号名
  toHandle?: string; // 被调用方句柄(已读解析、未读 undefined)
  toSymbol: string; // 被调用符号名
  refType: string; // call/import/inherit
  line: number; // 1-based
  resolved: boolean;
  importSrc?: string; // import 原始字符串(未解析时供提示)
  createdAt: number;
}

/** symbols 表原始行(SQL 列名带下划线,内部用) */
interface SymbolRow {
  handle: string;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  body_text: string | null;
  signature: string | null;
  exported: number;
  lang: string | null;
  created_at: number;
}

/** refs 表原始行(SQL 列名带下划线,内部用) */
interface RefRow {
  id: number;
  from_handle: string;
  from_symbol: string | null;
  to_handle: string | null;
  to_symbol: string;
  ref_type: string;
  line: number;
  resolved: number;
  import_src: string | null;
  created_at: number;
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
  sessionId?: string;
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

/** 单个会话的度量汇总(会话级统计) */
export interface SessionStat {
  sessionId: string | null;
  count: number;
  original: number;
  compressed: number;
  saved: number;
  lastAt: number;
}

/** 单条度量明细(逐条分析用) */
export interface MetricRecord {
  id: number;
  tool: string | null;
  contentType: string;
  originalSize: number;
  compressedSize: number;
  saved: number;
  /** 节省百分比 0-100 */
  savedPct: number;
  method: string | null;
  retrievedCount: number;
  sessionId: string | null;
  createdAt: number;
}

class Store {
  private db: Database | null = null;
  private dbPath = "";

  /** 打开/创建数据库。path 为空则用内存库(测试用)。 */
  open(path?: string): void {
    if (path) {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.db = new Database(path);
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
    // 迁移:旧库的 metrics 没有 session_id 列(schema.sql 用 CREATE TABLE IF NOT EXISTS,
    // 旧库不会自动加列)。检测缺失则补列,实现跨版本升级。
    const cols = this.db!.prepare("PRAGMA table_info(metrics)").all() as { name: string }[];
    if (cols.length > 0 && !cols.some((c) => c.name === "session_id")) {
      this.db!.exec("ALTER TABLE metrics ADD COLUMN session_id TEXT");
    }
    // session_id 索引在迁移加列之后建:旧库此时才有该列。若放 schema.sql,
    // 旧库 exec(schema) 时列还不存在,建索引会报 "no such column" 使 initSchema 整个失败。
    this.db!.exec("CREATE INDEX IF NOT EXISTS idx_metrics_session ON metrics(session_id)");
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

  // ─── 代码符号图谱(Task #18:代码 AST 图检索)─────────────────────────────
  // 参考 CodeGraph:symbols + refs 持久化到 SQLite。MCP server 懒解析某 handle 后填这两表,
  // 后续查表(快);跨会话/重启不丢。WAL 跨进程:hook 写 orig-N,MCP 读写这两表。

  /** 该 handle 是否已索引符号——graph.ts 据此决定是否触发 indexCode */
  hasSymbols(handle: string): boolean {
    const db = this.ensureOpen();
    const row = db
      .prepare("SELECT 1 FROM symbols WHERE handle = ? LIMIT 1")
      .get(handle);
    return !!row;
  }

  /** 按源路径查原文句柄(跨文件 import 解析:候选路径 → 命中的 orig-N) */
  getOriginalBySource(path: string): string | undefined {
    const db = this.ensureOpen();
    const row = db
      .prepare(
        "SELECT handle FROM originals WHERE source = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(path) as { handle: string } | null;
    return row?.handle;
  }

  /** 幂等写符号:先删该 handle 旧记录,再批量插 */
  saveSymbols(handle: string, symbols: SymbolRecord[]): void {
    const db = this.ensureOpen();
    const del = db.prepare("DELETE FROM symbols WHERE handle = ?");
    const ins = db.prepare(
      `INSERT INTO symbols(handle, name, kind, start_line, end_line, body_text, signature, exported, lang, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.exec("BEGIN");
    try {
      del.run(handle);
      for (const s of symbols) {
        ins.run(
          handle,
          s.name,
          s.kind,
          s.startLine,
          s.endLine,
          s.bodyText ?? null,
          s.signature ?? null,
          s.exported ? 1 : 0,
          s.lang ?? null,
          s.createdAt
        );
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 幂等写引用边:先删该 handle 旧记录,再批量插 */
  saveReferences(handle: string, refs: RefRecord[]): void {
    const db = this.ensureOpen();
    const del = db.prepare("DELETE FROM refs WHERE from_handle = ?");
    const ins = db.prepare(
      `INSERT INTO refs(from_handle, from_symbol, to_handle, to_symbol, ref_type, line, resolved, import_src, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.exec("BEGIN");
    try {
      del.run(handle);
      for (const r of refs) {
        ins.run(
          handle,
          r.fromSymbol ?? null,
          r.toHandle ?? null,
          r.toSymbol,
          r.refType,
          r.line,
          r.resolved ? 1 : 0,
          r.importSrc ?? null,
          r.createdAt
        );
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 取某 handle 的所有符号(按行号序) */
  getSymbols(handle: string): SymbolRecord[] {
    const db = this.ensureOpen();
    const rows = db
      .prepare("SELECT * FROM symbols WHERE handle = ? ORDER BY start_line")
      .all(handle) as SymbolRow[];
    return rows.map((r) => this.symbolFromRow(r));
  }

  /** 按名查符号(精确) */
  findSymbolByName(handle: string, name: string): SymbolRecord | undefined {
    const db = this.ensureOpen();
    const row = db
      .prepare("SELECT * FROM symbols WHERE handle = ? AND name = ? LIMIT 1")
      .get(handle, name) as SymbolRow | null;
    return row ? this.symbolFromRow(row) : undefined;
  }

  /** 模糊查符号(LIKE)——symbol 参数不精确时用 */
  findSymbolFuzzy(handle: string, query: string): SymbolRecord[] {
    const db = this.ensureOpen();
    const rows = db
      .prepare(
        "SELECT * FROM symbols WHERE handle = ? AND name LIKE ? ORDER BY start_line"
      )
      .all(handle, `%${query}%`) as SymbolRow[];
    return rows.map((r) => this.symbolFromRow(r));
  }

  /**
   * 取引用边。
   *  direction="callees":symbol 调用了谁 → from_handle=handle AND from_symbol=symbol
   *  direction="callers":谁调用了 symbol → to_handle=handle AND to_symbol=symbol(跨文件)
   */
  getReferences(
    handle: string,
    direction: "callers" | "callees",
    symbol: string
  ): RefRecord[] {
    const db = this.ensureOpen();
    const rows =
      direction === "callees"
        ? (db
            .prepare(
              "SELECT * FROM refs WHERE from_handle = ? AND from_symbol = ? ORDER BY line"
            )
            .all(handle, symbol) as RefRow[])
        : (db
            .prepare(
              "SELECT * FROM refs WHERE to_handle = ? AND to_symbol = ? ORDER BY line"
            )
            .all(handle, symbol) as RefRow[]);
    return rows.map((r) => this.refFromRow(r));
  }

  private symbolFromRow(r: SymbolRow): SymbolRecord {
    return {
      handle: r.handle,
      name: r.name,
      kind: r.kind,
      startLine: r.start_line,
      endLine: r.end_line,
      bodyText: r.body_text ?? undefined,
      signature: r.signature ?? undefined,
      exported: !!r.exported,
      lang: r.lang ?? undefined,
      createdAt: r.created_at,
    };
  }

  private refFromRow(r: RefRow): RefRecord {
    return {
      id: r.id,
      fromHandle: r.from_handle,
      fromSymbol: r.from_symbol ?? undefined,
      toHandle: r.to_handle ?? undefined,
      toSymbol: r.to_symbol,
      refType: r.ref_type,
      line: r.line,
      resolved: !!r.resolved,
      importSrc: r.import_src ?? undefined,
      createdAt: r.created_at,
    };
  }

  // ─── 度量记录 ────────────────────────────────────────────────────────────

  /** 记一条度量 */
  recordMetric(m: MetricInput): void {
    const db = this.ensureOpen();
    db.prepare(
      `INSERT INTO metrics(handle, source, tool, content_type, original_size, compressed_size, method, retrieved_count, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(
      m.handle ?? null,
      m.source ?? null,
      m.tool ?? null,
      m.contentType,
      m.originalSize,
      m.compressedSize,
      m.method,
      m.sessionId ?? null,
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

  /** 度量汇总(供 tok_stats)。过滤 dedup 残留:该原语已移除(决策记录-1),
   *  旧 metrics 行的 method 含 'dedup' 无法复现且虚高节省率,统计时排除。 */
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
         FROM metrics
         WHERE method NOT LIKE '%dedup%'`
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
         FROM metrics
         WHERE method NOT LIKE '%dedup%'
         GROUP BY content_type`
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

  /** 会话级度量:按 session_id 分组,按最近活动时间降序。供 tok_stats 显示"本会话"。
   *  同样过滤 dedup 残留。旧记录无 session_id 归为 null(显示为"未知")。 */
  getSessionBreakdown(limit = 5): SessionStat[] {
    const db = this.ensureOpen();
    const rows = db
      .prepare(
        `SELECT session_id,
                COUNT(*) AS count,
                SUM(original_size) AS orig,
                SUM(compressed_size) AS comp,
                SUM(original_size - compressed_size) AS saved,
                MAX(created_at) AS last_at
         FROM metrics
         WHERE method NOT LIKE '%dedup%'
         GROUP BY session_id
         ORDER BY last_at DESC
         LIMIT ?`
      )
      .all(limit) as {
      session_id: string | null;
      count: number;
      orig: number;
      comp: number;
      saved: number;
      last_at: number;
    }[];
    return rows.map((r) => ({
      sessionId: r.session_id,
      count: r.count ?? 0,
      original: r.orig ?? 0,
      compressed: r.comp ?? 0,
      saved: Math.max(0, r.saved ?? 0),
      lastAt: r.last_at ?? 0,
    }));
  }

  /** 逐条度量明细(最近 N 条),供 tok_stats 逐条展示与质量分析。
   *  过滤 dedup 残留。按时间倒序(最近在上)。 */
  getRecentMetrics(limit = 30): MetricRecord[] {
    const db = this.ensureOpen();
    const rows = db
      .prepare(
        `SELECT id, tool, content_type, original_size, compressed_size,
                method, retrieved_count, session_id, created_at
         FROM metrics
         WHERE method NOT LIKE '%dedup%'
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as {
      id: number;
      tool: string | null;
      content_type: string;
      original_size: number;
      compressed_size: number;
      method: string | null;
      retrieved_count: number;
      session_id: string | null;
      created_at: number;
    }[];
    return rows.map((r) => {
      const orig = r.original_size ?? 0;
      const comp = r.compressed_size ?? 0;
      return {
        id: r.id,
        tool: r.tool,
        contentType: r.content_type,
        originalSize: orig,
        compressedSize: comp,
        saved: Math.max(0, orig - comp),
        savedPct: orig > 0 ? Math.round((1 - comp / orig) * 100) : 0,
        method: r.method,
        retrievedCount: r.retrieved_count ?? 0,
        sessionId: r.session_id,
        createdAt: r.created_at,
      };
    });
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
