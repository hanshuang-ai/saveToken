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
  method          TEXT,                    -- 所用压缩原语(snip/dedup/format-strip/none)
  retrieved_count INTEGER NOT NULL DEFAULT 0, -- 模型取回次数(成功率信号)
  created_at      INTEGER NOT NULL         -- 时间(epoch ms)
);

-- 常用查询索引
CREATE INDEX IF NOT EXISTS idx_metrics_type ON metrics(content_type);
CREATE INDEX IF NOT EXISTS idx_metrics_time ON metrics(created_at);
