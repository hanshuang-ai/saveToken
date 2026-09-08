# Token 节省思路全景报告

> 基于 100+ 个 GitHub 开源项目的调研，2026-08-28

---

## 核心问题

所有方案本质上都在解决一个问题：**LLM 的上下文窗口有限，且按 token 计费。** 围绕这个问题，业界从六个维度切入。

---

## 全景图

```
Token 节省思路全景
│
├── 1. 输入端瘦身
│   ├── CLI 输出去噪（rtk, headroom, ...）
│   ├── 代理透明压缩（paritok-4b, claw-compactor, pxpipe, ...）
│   ├── 文本算法压缩（foveance, steno, ...）
│   ├── AI 模型压缩（context-compressor, ...）
│   └── 格式优化（TONL, TOON, LEAN）
│
├── 2. 精准检索（不读全量）
│   ├── 代码知识图谱（graphify, codegraph, ...）
│   ├── 上下文智能路由（lean-ctx）
│   └── 补丁/Diff 策略（llm-patcher, ...）
│
├── 3. 减少调用
│   ├── 语义缓存（semcache）
│   └── 模型路由（senior-fable, voly, ...）
│
├── 4. 输出端约束
│   ├── 行为技能（caveman, ponytail, ...）
│   └── 格式压缩（bu-ketao, eridani-speak, ...）
│
├── 5. 跨会话记忆
│   ├── 持久记忆（claude-mem, Continuous-Claude-v3, ...）
│   ├── 分层披露（bonsai-memory, ...）
│   └── 多代理交接（three-man-team, ...）
│
└── 6. 测量监控
    └── tokenjam, claude-devtools, abtop, ...
```

---

## 一、输入端瘦身

**核心逻辑：送进去的东西先瘦身，垃圾不进上下文。**

### 1.1 CLI 输出压缩

拦截 shell 命令的输出，在进入 LLM 之前剥离噪声。

```
git diff（5000 行）→ 去噪 → 只保留关键变更（500 行）
```

| 代表项目 | Stars | 核心机制 |
|----------|-------|---------|
| rtk-ai/rtk | 77,677 | 单一 Rust 二进制，拦截 shell 输出，省 60-90% |
| headroomlabs-ai/headroom | 67,865 | 库+代理+MCP 三位一体，省 20-95% |
| mksglu/context-mode | 20,203 | MCP 沙箱子进程，SQLite FTS5+BM25，最高省 98% |
| zdk/lowfat | 570 | 可插拔 CLI 过滤器，剥离 ANSI 码 |
| samuelfaj/distill | 669 | npm 包，过滤浓缩步骤，宣称省 99% |
| jfrog/boost | 461 | Go CLI 包装 shell 命令，省 80% |
| AgusRdz/chop | 44 | PreToolUse hook 拦截 52+ 命令，省 50-90% |
| MrGray17/opentoken | 159 | 42 层压缩，拦截工具输出 |
| edouard-claude/snip | 428 | Go+YAML 声明式过滤器，多 CLI 通用 |

**适用场景**：大量 CLI 操作的场景（调试、构建、日志分析）

### 1.2 代理/网关层透明压缩

在 Agent 和 LLM API 之间架一个中间层，透明地对请求/响应做压缩。**零代码变更。**

```
Agent → [压缩代理] → LLM API
```

| 代表项目 | Stars | 核心机制 |
|----------|-------|---------|
| rtk-ai/rtk | 77,677 | 拦截 shell 输出，省 60-90% |
| headroomlabs-ai/headroom | 67,865 | 压缩工具输出/日志/JSON |
| diegosouzapw/OmniRoute | 57,156 | 350+ 提供商 AI 网关，RTK+Caveman，省 15-95% |
| teamchong/pxpipe | 7,292 | 文本→图片，利用视觉模型 token 效率优势 |
| open-compress/claw-compactor | 2,032 | 14 阶段融合管道，AST 感知，零推理成本 |
| Paritok-official/paritok-4b-v1 | 1,445 | 4B 参数压缩模型，压缩至原始 25.7%，保留 86.5% 解决率 |
| sliday/tamp | 90 | 可配置压缩级别，平衡模式省 60-70% |

**适用场景**：不想改代码，需要透明集成的场景

### 1.3 无损文本压缩算法

对文本本身做算法级压缩——反向引用、模式替换、格式剥离。

```
"Artificial Intelligence is a field. Artificial Intelligence has applications..."
→ "AI is a field. @1 has applications..."（@1 = 反向引用）
```

| 代表项目 | Stars | 核心机制 |
|----------|-------|---------|
| wilpel/caveman-compression | 1,094 | 语义压缩：移除可预测语法，保留不可预测的事实内容 |
| Aimaghsoodi/foveance | 21 | 短反向引用替换已出现文本，省 82%，零信息丢失 |
| deemuk123/steno | 11 | Rust 三层压缩：结构剥离→通用字典→领域缩写，完全可逆 |
| nuoyazhizhou/tokenslim | 25 | Rust 插件引擎，模式匹配结构化重复，省 50-95% |
| anpl-code/Deblank | 21 | 剥离空白/缩进，C 族省 30%，Python 省 9% |
| metawake/prompt_compressor | 12 | 模块化规则压缩，safe/quality 配置 |

**适用场景**：文本中有大量重复内容的场景

### 1.4 AI 模型驱动压缩

用小模型或规则来压缩文本，不是纯算法。**需要语义理解才能压缩。**

```
BERT/BART/T5 理解原文 → 生成压缩版
```

| 代表项目 | Stars | 核心机制 |
|----------|-------|---------|
| Huzaifa785/context-compressor | 89 | 四种策略（提取/摘要/语义/混合），Query-Aware 压缩，省 80% |
| notoriouslab/bu-ketao | 56 | 繁体中文输出压缩规则集，剥离客套冗余，约 72% |
| SijuEC/eridani-speak | 102 | 极简输出语法，最高省 83% 输出 token |

**适用场景**：需要语义理解才能压缩的场景（叙事文本、文档）

### 1.5 序列化格式优化

用更紧凑的格式替代 JSON。

```
{"name": "John", "age": 30}  →  name:John|age:30
```

| 代表项目 | Stars | 核心机制 |
|----------|-------|---------|
| tonl-dev/tonl | 837 | TONL 紧凑列式记法，省 5-15% |
| HelgeSverre/toon-php | 130 | TOON：YAML 嵌套+CSV 表格，省 30-60% |
| fiialkod/lean-format | 22 | LEAN：自适应记法，省 28% vs JSON，总体省 47% |

**适用场景**：大量结构化数据交换的场景

---

## 二、精准检索（不读全量）

**核心逻辑：不让模型读全量，只读它需要的那部分。**

### 2.1 代码知识图谱

把代码库预索引为图结构，AI 按需查询而非全文件读取。

```
"找到所有调用 login() 的地方"
→ 图查询 → 返回 3 个文件和调用关系
→ 而不是 grep 全仓库 + 读取所有匹配文件
```

| 代表项目 | Stars | 核心机制 |
|----------|-------|---------|
| Graphify-Labs/graphify | 111,720 | 代码库/文档/SQL/PDF→知识图谱，AST 解析，无向量存储 |
| colbymchenry/codegraph | 68,441 | 预索引代码知识图谱，自动同步变更，100% 本地 |
| CodeGraphContext/CodeGraphContext | 4,131 | MCP 服务器+CLI，代码索引到图数据库 |
| styler-ai/ProjectAtlas | 356 | 预构建代码图+目的元数据，省 90%+ |
| GlitterKill/sdl-mcp | 468 | 符号 Delta 账本，4-20 倍 token 减少 |
| AZidan/codemap | 72 | 目标行范围读取替代全文件，省 60-80% |
| DevonMorris/claude-ctags | 15 | ctags 索引，高效代码导航，省约 80% |
| Ychangqing/IGraph | 52 | 符号节点+调用关系图，双通道 RRF 融合检索 |
| Jakedismo/codegraph-rust | 869 | 100% Rust 实现，AST+FastML，SurrealDB 后端 |

**适用场景**：大型代码库的理解和导航

### 2.2 上下文智能层

一个中间决策层，决定 Agent 该读什么、记住什么、忽略什么。

```
Agent 请求："帮我理解这个项目的认证流程"
→ 智能层拦截 → 只返回 auth 相关文件，过滤掉其他 90% 的代码
```

| 代表项目 | Stars | 核心机制 |
|----------|-------|---------|
| yvgude/lean-ctx | 3,666 | Rust 二进制，上下文智能层，省 60-90% |

### 2.3 补丁/差异策略

只传变更（diff），不传完整文件。

```
改了一个 1000 行的文件 → 只传 10 行 diff → LLM 只需要理解这 10 行
```

| 代表项目 | Stars | 核心机制 |
|----------|-------|---------|
| theluk/llm-patcher | 31 | 流式传输 diff，客户端重建最终结果 |
| garvit-joshi/jskim | 4 | tree-sitter 解析 Java 为紧凑结构摘要，省 70-80% |
| JSungMin/vs-token-safer | 11 | language-server/tree-sitter 索引替代 grep，30+ 语言 |
| lightningpixel/orvix | 6 | 查询符号和调用图，省 90% 代码搜索 token |
| seqis/AI-grep | 88 | Go 便携式搜索工具，索引目录，无需读取整个文件 |

**适用场景**：代码修改和审查场景

---

## 三、减少 LLM 调用次数

**核心逻辑：能不问就不问，能便宜问就便宜问。**

### 3.1 语义缓存

不是精确匹配缓存，而是**语义相似**匹配。命中时完全绕过 LLM。

```
用户问："法国的首都是什么？" → LLM 回答 "巴黎"
用户问："告诉我法国的首都" → 语义匹配命中 → 直接返回 "巴黎"（绕过 LLM）
```

| 代表项目 | Stars | 核心机制 |
|----------|-------|---------|
| sensoris/semcache | 96 | Rust 实现，Docker 部署，内存存储，LRU 淘汰，Prometheus 监控 |

**适用场景**：重复性高的查询场景

### 3.2 模型路由/分层

简单任务用便宜模型，复杂任务才用旗舰模型。

```
"格式化这个 JSON" → Haiku（便宜）
"设计这个系统的架构" → Opus/Fable（贵）
```

| 代表项目 | Stars | 核心机制 |
|----------|-------|---------|
| chocks/locode | 23 | 本地优先 CLI，简单任务→Ollama，复杂任务→Claude |
| csabakecskemeti/cc_token_saver_mcp | 19 | 允许 Claude Code 使用本地 LLM 处理较小任务 |
| AndyShaman/senior-fable | 23 | Fable 只做决策/分解，实现委托给 Opus/Sonnet/Haiku |
| 100yenadmin/fable-orchestrator | 101 | Fable 仅规划/仲裁，重活委托给廉价子代理 |
| VibeCodingWithPhil/agentwise | 46 | 多代理编排，并行执行+自动验证，15-30% 优化 |
| voly-codes/voly | 16 | 控制平面：智能路由+硬支出限制+多代理分解 |
| liutingzhang/Token-Saving-Skill | 4 | 分级 LLM 调度：免费 LLM 做检索，旗舰仅做关键生成 |
| tempont/small-opencode-orchestrator | 33 | 中央协调器（贵）规划，专业子代理（便宜）执行 |

**适用场景**：任务复杂度差异大的场景

---

## 四、输出端约束

**核心逻辑：让 LLM 闭嘴，别废话。**

### 4.1 行为技能注入

通过系统提示/skill 教 Agent 更简洁地输出。

```
不要说："好的，我理解了你的需求，让我来帮你分析一下..."
直接说："分析结果：..."
```

| 代表项目 | Stars | 核心机制 |
|----------|-------|---------|
| DietrichGebert/ponytail | 114,550 | 最懒 senior dev 风格，YAGNI 原则 |
| JuliusBrussee/caveman | 101,510 | 极简输出，"why use many token when few token do trick"，省 65% |
| Kulaxyz/token-diet | 479 | 始终在线效率技能，提示工程+输出过滤，平均省 31% |
| JetBrains/benjamin-plus-skill | 279 | 五种高效习惯，成本中位数 -17.9% |
| kuba-guzik/caveman-micro | 162 | 6 行微提示（85 token），benchmark 超越原版 552 token 技能 |
| InterfaceX-co-jp/genshijin | 314 | 日文版 caveman，针对日语冗余表达优化 |
| anshaneja5/scalpel | 12 | 在 ponytail 自己的 benchmark 上每个维度都超越之 |
| Shawnchee/caveman-skill | 71 | 极简输出风格 |
| KINGSTAR-OMEGA/claude-token-optimizer | 108 | Antigravity 协议+Ultimate 协议 |
| mocasus/paleo | 20 | 即用型 SKILL.md，修剪填充、跳过寒暄 |
| undefdev/token-efficiency | 25 | 教授代理最小化 token 浪费 |
| ravinperera/ai-token-efficiency-playbook | 9 | 即用型指令/提示/工作流集合 |

**适用场景**：所有场景，成本最低，可叠加使用

### 4.2 输出格式压缩

对 LLM 输出做后处理，去掉冗余格式。

| 代表项目 | Stars | 核心机制 |
|----------|-------|---------|
| notoriouslab/bu-ketao | 56 | 繁体中文客套剥离，约 72% |
| SijuEC/eridani-speak | 102 | 极简语法，最高省 83% 输出 |
| ritenv/tokensift | 7 | 类似 ESLint 但用于 token 效率，18+ lint 规则 |

---

## 五、跨会话记忆

**核心逻辑：跨会话积累知识，避免重复解释。**

### 5.1 持久记忆

```
会话 1：花了 2 万 token 理解项目结构
会话 2：自动注入上次的记忆 → 不需要重新理解
```

| 代表项目 | Stars | 核心机制 |
|----------|-------|---------|
| thedotmack/claude-mem | 92,408 | 跨会话持久记忆，自动捕获+AI 压缩+注入，SQLite+Chroma |
| parcadei/Continuous-Claude-v3 | 3,931 | YAML 交接+守护进程提取学习，PostgreSQL+pgvector |
| coleam00/claude-memory-compiler | 1,283 | Agent SDK 提取关键决策，编译为结构化交叉引用文章 |
| TonyStef/Grov | 193 | 自动捕获上下文并同步到共享团队记忆 |

### 5.2 分层记忆（渐进式披露）

```
不加载全部记忆，而是：
  启动时 → 只加载索引（400 token）
  需要时 → 按域加载详情（150 token）
  深入时 → 加载具体文件（200 token）
```

| 代表项目 | Stars | 核心机制 |
|----------|-------|---------|
| felixsim/bonsai-memory | 26 | 盆景形域树替代扁平 MEMORY.md，省 70-95%，零依赖 |
| oxygen-fragment/claude-modular | 284 | 模块化斜杠命令按需加载，仅必要指令进入上下文 |

### 5.3 多代理交接

```
Architect（架构师）→ 交接文档 → Builder（构建者）→ 交接文档 → Reviewer（审查者）
每个角色只看到自己的上下文，不加载全量
```

| 代表项目 | Stars | 核心机制 |
|----------|-------|---------|
| russelleNVy/three-man-team | 946 | 三代理架构（Architect/Builder/Reviewer），严格交接 |
| SchneiderDaniel/cheasee-pi | 59 | 看板风格 git 导向子代理工作流，离散任务防止上下文过载 |

### 5.4 配置优化

| 代表项目 | Stars | 核心机制 |
|----------|-------|---------|
| sanqianzilanyue/claude-p-save-tokens | 80 | 剥离工具定义+替换为最小系统提示，请求开销 2.7 万→一两百 |
| warrenth/ctxcraft | 13 | 审计 .claude/ 目录，标记臃肿配置，省 45% 上下文 |

---

## 六、测量与监控

**先测量，再优化。看不到浪费就不知道从哪砍。**

| 代表项目 | Stars | 核心机制 |
|----------|-------|---------|
| matt1398/claude-devtools | 3,874 | 读取会话日志（JSONL），重构每轮 token 归因（7 类别），压缩可视化 |
| graykode/abtop | 3,473 | btop 风格 TUI 仪表盘，实时显示上下文窗口 % |
| jmuncor/tokentap | 813 | 拦截 LLM API 流量，实时终端仪表盘，自动保存 prompt 为 markdown/JSON |
| larsderidder/context-lens | 388 | 捕获 API 调用，显示上下文窗口组成分解 |
| Metabuilder-Labs/tokenjam | 106 | 12 分析器诊断浪费，本地 Web 仪表盘，Claude Code 插件 |
| d-date/retok | 33 | 事后分析器：解析 JSONL 日志，提取缓存命中率/峰值上下文/每模型 token 数 |
| RimantasZ/contextspy | 32 | 上下文分析器，每个请求各类 token 实时分解 |
| Entelligentsia/tokbench | 10 | 独立基准测试，可复现测量 token 节省中间件效果 |

---

## 七、多工具组合栈

集成多种策略，叠加效果。

| 代表项目 | Stars | 组合内容 | 节省效果 |
|----------|-------|---------|---------|
| oratelecom/tokenwar | 52 | caveman+RTK+context-mode+claude-mem+pxpipe+Ponytail | 叠加累积 |
| mirkobozzetto/espresso | 19 | 输出规则+RTK+Caveman+Ponytail+模型阶梯 | 省 70-85% |
| sgaabdu4/claude-code-tips | 64 | CBM+context-mode+RTK+Headroom+Caveman，hook 强制 | 90%+ |
| palpal2312/token-stack | 5 | ponytail+caveman+RTK+headroom，多 CLI 支持 | — |
| agungprasastia/toksave | 5 | 零配置 CLI，一键接入多个 AI 编码代理 | — |
| vagkaratzas/token-saviour | 10 | 每层路由到最省工具：serena 读代码、rtk 处理输出、caveman 写文、Ponytail 生成代码 | 省 70% |

---

## 八、资源合集

| 项目 | Stars | 内容 |
|------|-------|------|
| jasontang-ai/Context-Engineering | 9,230 | Karpathy 启发，上下文优化技术手册 |
| pleasedodisturb/awesome-llm-token-optimization | 63 | LLM token 优化策略、工具、论文精选列表 |

---

## 关键洞察

### 1. 所有方案都是针对代码开发场景设计的

100+ 个项目，没有一个专门为「长文本阅读/书籍分析」场景设计。token 节省的需求主要来自 AI 编码的高频、高量场景。

### 2. 输入端和输出端是两条独立战线

- **输入端**：CLI 去噪、文本压缩、代理压缩、格式优化——减少进入 LLM 的数据
- **输出端**：行为技能、格式约束——减少 LLM 产生的内容
- 两者互不冲突，可以叠加

### 3. 最有效的方案往往是组合使用

espresso 组合了 5 种策略省 70-85%，claude-code-tips 组合了 5 种策略省 90%+。单一策略有天花板，组合才能突破。

### 4. 书籍分析场景是空白领域

目前没有一个方案能在「保持叙事连贯性」的前提下压缩长文本。context-compressor 的 Query-Aware 压缩理论上最接近，但缺少 Claude Code 集成层。

### 5. 行为技能注入是 ROI 最高的方案

caveman 和 ponytail 合计 21 万+ Stars，安装简单（一个 skill 文件），零依赖，效果立竿见影。是所有场景下都应该优先考虑的基础方案。

### 6. 监控先行

在投入任何优化方案之前，先用 tokenjam、claude-devtools 或 abtop 搞清楚 token 到底花在哪里——避免优化错了方向。