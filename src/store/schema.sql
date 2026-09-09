-- schema.sql —— 存储层表结构
--
-- 三个职责:
--   1. originals:原文备份(snip 截断的中间段、被压缩的全文),handle 取回
--   2. docs_fts:全文索引(FTS5),tok_retrieve 关键词检索
--   3. metrics:度量记录(token 节省、内容类型、成功率信号)
--
-- 第一阶段:只服务无引用的结构化内容(日志/JSON/表格)。代码只压缩不检索(见设计文档 TODO-1)。

-- ─── 原文备份 ──────────────────────────────────────────────────────────────
-- 每条是一次压缩操作的原文。handle 全局唯一,decompress/tok_retrieve 凭它取回。
-- content 可选用 fflate 压缩存储(大日志原文压完省磁盘),取回时解压——但这是存储压缩,
-- 与"进上下文的无损压缩"无关,不影响可逆性。
CREATE TABLE IF NOT EXISTS originals (
  handle     TEXT PRIMARY KEY,           -- 全局唯一句柄
  content    TEXT NOT NULL,              -- 原文(未压缩 或 fflate 压缩后)
  compressed INTEGER NOT NULL DEFAULT 0, -- content 是否经 fflate 压缩(0/1)
  size       INTEGER NOT NULL,           -- 原文字符数
  source     TEXT,                       -- 来源路径(可选,日志文件路径)
  tool       TEXT,                       -- 来源工具(可选,Bash/Read)
  created_at INTEGER NOT NULL            -- 创建时间(epoch ms,调用方传入)
);

-- ─── 全文索引(FTS5)──────────────────────────────────────────────────────
-- 用于 tok_retrieve(handle, query):按关键词查相关片段,返回原文切片。
-- contentless=1? 不用——我们要高亮片段位置,需要存原文以切片。
-- 但为省空间,FTS 只存可搜索文本,原文在 originals 里取。
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  handle UNINDEXED,    -- 关联原文句柄(不索引,只存储用于回查)
  line_no UNINDEXED,   -- 该片段在原文的起始行号(用于切片定位)
  content,             -- 可搜索的文本片段
  tokenize = 'unicode61'  -- unicode 分词,支持中文(按字切)
);

-- ─── 度量记录 ──────────────────────────────────────────────────────────────
-- 每次压缩操作记一条:原始/压缩后大小、内容类型、所用策略。
-- 成功率信号(retrieved_count)后续 hook 接入后更新——模型频繁取回=压缩太激进。
CREATE TABLE IF NOT EXISTS metrics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  handle          TEXT,                    -- 关联原文(可空,未压缩时无 handle)
  source          TEXT,                    -- 来源路径
  tool            TEXT,                    -- 来源工具
  content_type    TEXT NOT NULL,           -- structured/prose/mixed
  original_size   INTEGER NOT NULL,        -- 原始字符数
  compressed_size INTEGER NOT NULL,        -- 压缩后字符数
  method          TEXT,                    -- 所用压缩原语(snip/format-strip/none)
  retrieved_count INTEGER NOT NULL DEFAULT 0, -- 模型取回次数(成功率信号)
  session_id      TEXT,                    -- Claude Code 会话 ID(会话级统计)
  created_at      INTEGER NOT NULL         -- 时间(epoch ms)
);

-- 常用查询索引
CREATE INDEX IF NOT EXISTS idx_metrics_type ON metrics(content_type);
CREATE INDEX IF NOT EXISTS idx_metrics_time ON metrics(created_at);
-- 注意:idx_metrics_session 不在此处建,而在 db.ts 迁移加列之后建——
-- 旧库 exec(schema) 时 session_id 列尚不存在(由迁移 ALTER 补),此时建索引会报
-- "no such column" 导致整个 initSchema 失败。

-- ─── 代码符号图谱(Task #18:代码 AST 图检索)──────────────────────────────
-- 参考 CodeGraph:symbols + edges 持久化到 SQLite,跨会话/重启不丢,可 SQL 查跨文件。
-- hook 存 orig-N(原文);MCP server 首次查某 handle 时懒解析 AST → 填这两表,后续查表。
-- WAL 跨进程:hook 写 orig-N,MCP 读写 symbols/references。

-- 符号定义(函数/类/方法/命名箭头函数)。一个 handle(原文)对应多条符号。
CREATE TABLE IF NOT EXISTS symbols (
  handle     TEXT NOT NULL,             -- 关联原文句柄(orig-N)
  name       TEXT NOT NULL,             -- 符号名
  kind       TEXT NOT NULL,             -- function/class/method/variable
  start_line INTEGER NOT NULL,          -- 起始行(1-based,对齐原文行号)
  end_line   INTEGER NOT NULL,          -- 结束行
  body_text  TEXT,                      -- 符号完整实现(主符号取回用)
  signature  TEXT,                      -- 精简签名(引用符号取回用,控 token)
  exported   INTEGER NOT NULL DEFAULT 0,-- 是否 export(1/0)
  lang       TEXT,                      -- 语言(typescript/tsx/javascript)
  created_at INTEGER NOT NULL           -- 时间(epoch ms)
);
CREATE INDEX IF NOT EXISTS idx_symbols_handle ON symbols(handle);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(handle, name);

-- 引用边(调用/导入)。from→to 的有向边,跨文件解析的核心。
-- 表名用 refs 而非 references——后者是 SQL 关键字,SQLite 虽多能容忍但易踩坑,直接避开。
CREATE TABLE IF NOT EXISTS refs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_handle TEXT NOT NULL,            -- 调用方所在原文句柄
  from_symbol TEXT,                     -- 调用方符号名(哪个函数里调的)
  to_handle   TEXT,                     -- 被调用方所在句柄(已读则解析、未读为 NULL)
  to_symbol   TEXT NOT NULL,            -- 被调用符号名
  ref_type    TEXT NOT NULL,            -- call/import/inherit
  line        INTEGER NOT NULL,         -- 引用所在行(1-based)
  resolved    INTEGER NOT NULL DEFAULT 0,-- 是否已解析到 to_handle(1/0)
  import_src  TEXT,                     -- import 原始字符串(未解析时供提示)
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refs_from ON refs(from_handle);
CREATE INDEX IF NOT EXISTS idx_refs_to ON refs(to_handle, to_symbol);
CREATE INDEX IF NOT EXISTS idx_refs_from_sym ON refs(from_handle, from_symbol);
