# Token 节省项目策略分类

> 从 GitHub 搜索整理，共 100+ 个项目，2026-08-28

---

## 策略分类总览

| 策略分类 | 核心思路 | 代表项目 |
|----------|---------|---------|
| **CLI 输出压缩** | 拦截命令输出，去噪后再送入 LLM | rtk, headroom, context-mode, lowfat, distill, boost, chop, opentoken, snip |
| **MCP 层压缩** | 压缩工具描述/Schema，批量合并调用 | mcp-compressor, clean-mcp, sourcerer-mcp, mcp-batchit, Contextcore, ncp |
| **代理/网关压缩** | 中间层透明压缩，零代码变更 | rtk, headroom, paritok-4b, tamp, claw-compactor, pxpipe, OmniRoute |
| **格式优化** | 用紧凑格式替代 JSON | TONL, TOON, LEAN |
| **代码图索引** | 用图/索引查找替代全文件读取 | codegraph, graphify, ProjectAtlas, sdl-mcp, codemap, claude-ctags, lean-ctx, IGraph |
| **无损压缩** | 文本级压缩（反向引用/模式替换/格式剥离） | foveance, steno, tokenslim, Deblank, prompt_compressor, caveman-compression |
| **AI 模型压缩** | 用小模型/规则压缩文本 | context-compressor, bu-ketao, eridani-speak |
| **行为技能注入**（输出） | 教 Agent 更简洁地输出 | caveman, ponytail, token-diet, benjamin-plus, claude-token-optimizer, paleo, caveman-micro, genshijin, scalpel |
| **多工具组合栈** | 集成多种策略，叠加效果 | tokenwar, espresso, claude-code-tips, token-stack, toksave, token-saviour |
| **模型路由** | 简单任务用小模型，复杂任务用大模型 | locode, cc_token_saver_mcp, senior-fable, fable-orchestrator, agentwise, voly, Token-Saving-Skill |
| **上下文管理/记忆** | 渐进式披露、交接系统、分层记忆 | claude-mem, Continuous-Claude-v3, claude-modular, three-man-team, bonsai-memory, Grov, cheasee-pi, claude-memory-compiler |
| **Token 监控** | 先测量再优化，可视化 token 消耗 | tokenjam, claude-devtools, abtop, tokentap, context-lens, retok, contextspy, ctxcraft, tokbench |
| **语义缓存** | 缓存 LLM 响应，避免重复调用 | semcache |
| **补丁/代码策略** | 只传 diff/摘要，tree-sitter 语义搜索 | llm-patcher, jskim, vs-token-safer, orvix, AI-grep, tokensift, small-opencode-orchestrator, CodeGraphContext |
| **资源合集** | 手册/论文/策略列表 | Context-Engineering, awesome-llm-token-optimization, tokenjam |

---

## 第一类：CLI 输出压缩

在工具输出进入 LLM 前拦截和压缩

| 项目 | Stars | 核心机制 |
|------|-------|---------|
| [rtk-ai/rtk](https://github.com/rtk-ai/rtk) | 77,677 | 单一 Rust 二进制，拦截 shell 命令输出，在到达 LLM 前压缩 60-90% token。零依赖 |
| [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom) | 67,865 | 库 + 代理 + MCP 三位一体，压缩工具输出/日志/文件/RAG chunks，编码代理省 20%，JSON 省 60-95% |
| [mksglu/context-mode](https://github.com/mksglu/context-mode) | 20,203 | MCP 服务器沙箱子进程过滤 CLI 噪声，SQLite FTS5 + BM25 会话记忆检索，输出压缩剥离 JSON/日志噪声，最高减少 98% 上下文 |
| [zdk/lowfat](https://github.com/zdk/lowfat) | 570 | 可插拔 CLI 过滤器，针对特定命令剥离 ANSI 码、截断冗长日志、仅提取相关行 |
| [samuelfaj/distill](https://github.com/samuelfaj/distill) | 669 | npm 包，将大型 CLI 输出通过过滤/浓缩步骤，仅提取 LLM 需要的信号，宣称节省 99% |
| [jfrog/boost](https://github.com/jfrog/boost) | 461 | Go CLI 工具包装 shell 命令，将嘈杂日志转换为紧凑结构化输出，保留错误和时间戳，省 80% |
| [AgusRdz/chop](https://github.com/AgusRdz/chop) | 44 | PreToolUse hook 拦截并压缩 CLI 输出（docker ps、git status 等），支持 52+ 命令，省 50-90% |
| [MrGray17/opentoken](https://github.com/MrGray17/opentoken) | 159 | OpenCode 配套，42 层压缩，在工具输出到达 LLM 前拦截并剥离噪声 |
| [edouard-claude/snip](https://github.com/edouard-claude/snip) | 428 | Go 实现，声明式 YAML 过滤器，rtk 替代品，Claude Code/Cursor/Copilot/Gemini 通用 |

---

## 第二类：MCP 协议层压缩

压缩工具描述、输出和上下文

| 项目 | Stars | 核心机制 |
|------|-------|---------|
| [atlassian-labs/mcp-compressor](https://github.com/atlassian-labs/mcp-compressor) | 115 | Atlassian 出品，MCP 代理包装器（TS/Python/Rust），压缩工具描述 70-97% |
| [cleanmcp/clean-mcp](https://github.com/cleanmcp/clean-mcp) | 46 | tree-sitter 语义代码搜索 + 调用图 + 本地嵌入（LanceDB），agent 通过描述精确找到函数 |
| [st3v3nmw/sourcerer-mcp](https://github.com/st3v3nmw/sourcerer-mcp) | 119 | 语义代码搜索和导航 MCP，减少 token 浪费 |
| [ryanjoachim/mcp-batchit](https://github.com/ryanjoachim/mcp-batchit) | 59 | 将多次 MCP 工具调用批量合并为单个请求，减少开销 |
| [lucifer-ux/Contextcore](https://github.com/lucifer-ux/Contextcore) | 23 | 混合搜索（BM25 + 语义检索），仅检索最相关 chunks 而非加载整个文件 |
| [portel-dev/ncp](https://github.com/portel-dev/ncp) | 97 | MCP 编排器，按需加载工具而非启动时全部加载，省 47-97% token |

---

## 第三类：代理/网关压缩

在 Agent 和 LLM API 之间进行透明压缩

| 项目 | Stars | 核心机制 |
|------|-------|---------|
| [rtk-ai/rtk](https://github.com/rtk-ai/rtk) | 77,677 | 单一 Rust 二进制，拦截 shell 输出，省 60-90% |
| [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom) | 67,865 | 库+代理+MCP 三位一体，压缩工具输出/日志/JSON |
| [teamchong/pxpipe](https://github.com/teamchong/pxpipe) | 7,292 | 把文本上下文渲染为图片，利用视觉模型 token 效率优势 |
| [Paritok-official/paritok-4b-v1](https://github.com/Paritok-official/paritok-4b-v1) | 1,445 | 4B 参数压缩网关模型，无损压缩至原始大小约 25.7%，保留 86.5% 解决率 |
| [sliday/tamp](https://github.com/sliday/tamp) | 90 | Token 压缩代理，可配置压缩级别，平衡模式省 60-70% |
| [open-compress/claw-compactor](https://github.com/open-compress/claw-compactor) | 2,032 | 14 阶段融合管道，AST 感知代码分析 + 可逆压缩 + 智能内容路由，零推理成本 |
| [diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute) | 57,156 | 350+ 提供商 AI 网关，RTK+Caveman 压缩省 15-95% token |

---

## 第四类：序列化格式优化

用更紧凑的格式替代 JSON

| 项目 | Stars | 核心机制 |
|------|-------|---------|
| [tonl-dev/tonl](https://github.com/tonl-dev/tonl) | 837 | TONL（Token-Optimized Notation Language），紧凑列式记法替代 JSON，省 5-15% |
| [HelgeSverre/toon-php](https://github.com/HelgeSverre/toon-php) | 130 | TOON（Token-Oriented Object Notation），YAML 嵌套 + CSV 表格风格，省 30-60% |
| [fiialkod/lean-format](https://github.com/fiialkod/lean-format) | 22 | LEAN（LLM-Efficient Adaptive Notation），省 28% vs JSON，总体省 47% |

---

## 第五类：代码图/元数据索引

用图/索引查找替代全文件读取

| 项目 | Stars | 核心机制 |
|------|-------|---------|
| [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) | 111,720 | 将代码库、文档、SQL schema、PDF 转为可查询知识图谱，AST 解析，无向量存储 |
| [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) | 68,441 | 预索引代码知识图谱，自动同步代码变更，100% 本地，减少 token 和工具调用 |
| [yvgude/lean-ctx](https://github.com/yvgude/lean-ctx) | 3,666 | 上下文智能层，Rust 二进制，决定 Agent 读什么/记住什么/保护什么，省 60-90% |
| [CodeGraphContext/CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) | 4,131 | MCP 服务器 + CLI，将本地代码索引到图数据库，为 AI 提供上下文 |
| [styler-ai/ProjectAtlas](https://github.com/styler-ai/ProjectAtlas) | 356 | 预构建代码图 + 目的元数据，图查找替代文件探索，省 90%+ |
| [GlitterKill/sdl-mcp](https://github.com/GlitterKill/sdl-mcp) | 468 | 符号 Delta 账本，索引代码库为可搜索符号图，4-20 倍 token 减少 |
| [AZidan/codemap](https://github.com/AZidan/codemap) | 72 | LLM 友好代码索引器，目标行范围读取替代全文件读取，省 60-80% |
| [DevonMorris/claude-ctags](https://github.com/DevonMorris/claude-ctags) | 15 | 自动生成 ctags 索引，高效代码导航，省约 80% |
| [Ychangqing/IGraph](https://github.com/Ychangqing/IGraph) | 52 | 符号节点 + 调用关系知识图谱，双通道 RRF 融合检索，MCP Server 接入 |
| [Jakedismo/codegraph-rust](https://github.com/Jakedismo/codegraph-rust) | 869 | 100% Rust 实现，AST+FastML 解析，SurrealDB 后端，MCP 工具 |

---

## 第六类：无损压缩算法

文本级压缩（反向引用/模式替换/格式剥离）

| 项目 | Stars | 核心机制 |
|------|-------|---------|
| [wilpel/caveman-compression](https://github.com/wilpel/caveman-compression) | 1,094 | 语义压缩方法：移除可预测的语法，保留不可预测的事实内容 |
| [Aimaghsoodi/foveance](https://github.com/Aimaghsoodi/foveance) | 21 | 无损编解码器，用短反向引用替换已出现的文本，省 82% 输入 token，零信息丢失 |
| [deemuk123/steno](https://github.com/deemuk123/steno) | 11 | Rust 三层压缩：结构剥离 → 通用字典替换 → 领域缩写，完全可逆，MCP 集成 |
| [nuoyazhizhou/tokenslim](https://github.com/nuoyazhizhou/tokenslim) | 25 | Rust 插件压缩引擎，模式匹配结构化重复输入，省 50-95% |
| [anpl-code/Deblank](https://github.com/anpl-code/Deblank) | 21 | 双向代码格式编解码器，剥离空白/缩进，C 族省 30%，Python 省 9%，AST 保留 |
| [metawake/prompt_compressor](https://github.com/metawake/prompt_compressor) | 12 | 模块化规则压缩，可配置 safe/quality 配置文件，带 token 计数分析 |

---

## 第七类：AI 模型驱动压缩

使用小模型/规则压缩文本

| 项目 | Stars | 核心机制 |
|------|-------|---------|
| [Huzaifa785/context-compressor](https://github.com/Huzaifa785/context-compressor) | 89 | 四种 AI 策略（提取/抽象/语义/混合），基于 BERT/BART/T5，查询感知，省 80% |
| [notoriouslab/bu-ketao](https://github.com/notoriouslab/bu-ketao) | 56 | 繁体中文 LLM 输出压缩规则集，剥离客套冗余，约 72% 压缩 |
| [SijuEC/eridani-speak](https://github.com/SijuEC/eridani-speak) | 102 | 受《Project Hail Mary》中 Rocky 语言启发的极简输出语法，最高省 83% 输出 token |

---

## 第八类：行为/技能注入（输出端）

教 Agent 更省 token 的编码和输出习惯

| 项目 | Stars | 核心机制 |
|------|-------|---------|
| [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) | 101,510 | 极简输出风格，"why use many token when few token do trick"，省 65% token |
| [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | 114,550 | 最懒 senior dev 风格——最好的代码是你没写过的代码，YAGNI 原则 |
| [Kulaxyz/token-diet](https://github.com/Kulaxyz/token-diet) | 479 | 始终在线的 token 效率技能，提示工程 + 输出过滤启发式，平均省 31% |
| [JetBrains/benjamin-plus-skill](https://github.com/JetBrains/benjamin-plus-skill) | 279 | JetBrains 出品，五种高效习惯（单次侦察/钥匙孔读取/一次性探测/任务完成检查/合理轮询），成本中位数 -17.9% |
| [Shawnchee/caveman-skill](https://github.com/Shawnchee/caveman-skill) | 71 | 极简输出风格，极度精简语言，减少输出 token |
| [KINGSTAR-OMEGA/claude-token-optimizer](https://github.com/KINGSTAR-OMEGA/claude-token-optimizer) | 108 | Antigravity 协议（结构化规划） + Ultimate 协议（纯 JSON 编译器模式） |
| [undefdev/token-efficiency](https://github.com/undefdev/token-efficiency) | 25 | 教授代理在工具使用和数据处理中最小化 token 浪费 |
| [ravinperera/ai-token-efficiency-playbook](https://github.com/ravinperera/ai-token-efficiency-playbook) | 9 | 即用型指令/提示/工作流集合，跨 Codex/Claude/Copilot/Cursor |
| [mocasus/paleo](https://github.com/mocasus/paleo) | 20 | 即用型 SKILL.md 文件，指示代理压缩输出：修剪填充内容、跳过寒暄、浓缩上下文 |
| [ritenv/tokensift](https://github.com/ritenv/tokensift) | 7 | 类似 ESLint 但用于 token 效率，18+ lint 规则在 prompt 发送前检测 token 浪费模式 |
| [kuba-guzik/caveman-micro](https://github.com/kuba-guzik/caveman-micro) | 162 | 6 行 caveman 微提示（85 token），在 benchmark 上超越原版 552 token 技能 |
| [InterfaceX-co-jp/genshijin](https://github.com/InterfaceX-co-jp/genshijin) | 314 | 日文版 caveman，针对日语特有冗余表达优化 |
| [anshaneja5/scalpel](https://github.com/anshaneja5/scalpel) | 12 | 最小切口治愈——在 ponytail 自己的 benchmark 上每个维度都超越之 |

---

## 第九类：多工具组合栈

集成多种策略，叠加效果

| 项目 | Stars | 核心机制 |
|------|-------|---------|
| [oratelecom/tokenwar](https://github.com/oratelecom/tokenwar) | 52 | 六工具栈（caveman/RTK/context-mode/claude-mem/pxpipe/Ponytail），节省叠加累积 |
| [mirkobozzetto/espresso](https://github.com/mirkobozzetto/espresso) | 19 | 一键安装栈：输出规则 + RTK + Caveman + Ponytail + 模型阶梯，省 70-85% |
| [sgaabdu4/claude-code-tips](https://github.com/sgaabdu4/claude-code-tips) | 64 | CBM + context-mode + RTK + Headroom + Caveman，hook 强制，90%+ 减少 |
| [palpal2312/token-stack](https://github.com/palpal2312/token-stack) | 5 | 四层栈（ponytail + caveman + RTK + headroom），多 CLI 支持 |
| [agungprasastia/toksave](https://github.com/agungprasastia/toksave) | 5 | 零配置 CLI，一键将 token 节省工具接入多个 AI 编码代理 |
| [vagkaratzas/token-saviour](https://github.com/vagkaratzas/token-saviour) | 10 | 每层路由到最省 token 的工具：serena 读代码、rtk 处理命令输出、caveman 写文、Ponytail 生成代码，省 70% |

---

## 第十类：模型路由/分层

简单任务用小模型，复杂任务用大模型

| 项目 | Stars | 核心机制 |
|------|-------|---------|
| [chocks/locode](https://github.com/chocks/locode) | 23 | 本地优先 CLI，简单任务路由到 Ollama，复杂任务路由到 Claude |
| [csabakecskemeti/cc_token_saver_mcp](https://github.com/csabakecskemeti/cc_token_saver_mcp) | 19 | 允许 Claude Code 使用本地 LLM 处理较小任务，决策基于任务复杂度 |
| [AndyShaman/senior-fable](https://github.com/AndyShaman/senior-fable) | 23 | Fable 5 只处理分解/架构/争议决策，所有实现劳动委托给廉价子代理（Opus/Sonnet/Haiku） |
| [100yenadmin/fable-token-saving-skills-orchestrator](https://github.com/100yenadmin/fable-token-saving-skills-orchestrator) | 101 | Fable 仅用于规划/仲裁/最终决策，重活委托给廉价子代理，缓存保持通道路由 |
| [VibeCodingWithPhil/agentwise](https://github.com/VibeCodingWithPhil/agentwise) | 46 | 多代理编排，并行执行 + 自动验证 + 自我改进，15-30% token 优化 |
| [voly-codes/voly](https://github.com/voly-codes/voly) | 16 | 控制平面：智能代理路由（每个任务最便宜的合格模型）、硬支出限制、多代理分解 |
| [liutingzhang/Token-Saving-Skill](https://github.com/liutingzhang/Token-Saving-Skill) | 4 | 分级 LLM 调度：免费/低成本 LLM 做检索/提取/验证，旗舰 LLM 仅做关键代码生成 |
| [tempont/small-opencode-orchestrator](https://github.com/tempont/small-opencode-orchestrator) | 33 | 分层模型编排：中央协调器（昂贵模型）规划，专业子代理（便宜模型）执行，只传过滤后的上下文 |

---

## 第十一类：上下文管理/记忆

| 项目 | Stars | 核心机制 |
|------|-------|---------|
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | 92,408 | 跨会话持久记忆，捕获会话内容、AI 压缩、注入相关上下文到未来会话 |
| [parcadei/Continuous-Claude-v3](https://github.com/parcadei/Continuous-Claude-v3) | 3,931 | YAML 交接 + TLDR 多层代码分析，语义索引替代全文件读取，学习成果跨会话累积 |
| [coleam00/claude-memory-compiler](https://github.com/coleam00/claude-memory-compiler) | 1,283 | Claude Agent SDK 提取关键决策，LLM 编译器组织为结构化交叉引用知识文章 |
| [oxygen-fragment/claude-modular](https://github.com/oxygen-fragment/claude-modular) | 284 | 渐进式披露，模块化斜杠命令按需加载，仅必要指令进入上下文 |
| [russelleNVy/three-man-team](https://github.com/russelleNVy/three-man-team) | 946 | 三代理架构（Architect/Builder/Reviewer），严格交接防止全代码库读取和功能漂移 |
| [felixsim/bonsai-memory](https://github.com/felixsim/bonsai-memory) | 26 | 分层记忆，盆景形域树替代扁平 MEMORY.md，渐进式披露，省 70-95% |
| [TonyStef/Grov](https://github.com/TonyStef/Grov) | 193 | 自动捕获会话上下文并同步到共享团队记忆，自动注入相关记忆，消除重复解释 |
| [sanqianzilanyue/claude-p-save-tokens](https://github.com/sanqianzilanyue/claude-p-save-tokens) | 80 | 剥离所有工具定义 + 替换为最小系统提示，请求开销从约 2.7 万 token 降至一两百 |
| [SchneiderDaniel/cheasee-pi](https://github.com/SchneiderDaniel/cheasee-pi) | 59 | 看板风格 git 导向子代理工作流，将工作结构化为离散任务，防止主代理加载过多上下文 |
| [warrenth/ctxcraft](https://github.com/warrenth/ctxcraft) | 13 | Claude Code 插件，审计 `.claude/` 目录结构，标记臃肿 CLAUDE.md 和低效配置，省 45% 上下文 |

---

## 第十二类：Token 监控/可视化

先测量再优化，可视化 token 消耗

| 项目 | Stars | 核心机制 |
|------|-------|---------|
| [Metabuilder-Labs/tokenjam](https://github.com/Metabuilder-Labs/tokenjam) | 106 | 12 分析器诊断 token 浪费，本地 Web 仪表盘，Claude Code 插件，支持 Codex/LangChain/OTel |
| [matt1398/claude-devtools](https://github.com/matt1398/claude-devtools) | 3,874 | 读取本地会话日志（JSONL），重构每轮 token 归因（7 类别），压缩可视化 |
| [graykode/abtop](https://github.com/graykode/abtop) | 3,473 | 类似 btop 的 TUI 仪表盘，从本地进程状态发现运行中代理会话，实时显示上下文窗口 % |
| [jmuncor/tokentap](https://github.com/jmuncor/tokentap) | 813 | 代理拦截 LLM API 流量，实时终端仪表盘，自动保存每个提示为 markdown/JSON |
| [larsderidder/context-lens](https://github.com/larsderidder/context-lens) | 388 | 本地代理捕获 API 调用，显示上下文窗口组成分解（系统提示/工具定义/历史/思考块） |
| [d-date/retok](https://github.com/d-date/retok) | 33 | 事后分析器：解析 JSONL 日志提取缓存命中率/峰值上下文大小/每模型 token 数，给出具体建议 |
| [RimantasZ/contextspy](https://github.com/RimantasZ/contextspy) | 32 | 上下文分析器，提供每个请求各类 token 的实时分解（输入/输出/缓存命中/缓存写入） |
| [Entelligentsia/tokbench](https://github.com/Entelligentsia/tokbench) | 10 | 独立基准测试，可复现测量 token 节省中间件在真实代理 SDLC 工作负载上的效果 |

---

## 第十三类：语义缓存

| 项目 | Stars | 核心机制 |
|------|-------|---------|
| [sensoris/semcache](https://github.com/sensoris/semcache) | 96 | 语义缓存层，拦截 LLM 请求，对语义相似的查询返回缓存响应（不仅精确匹配），完全绕过 LLM |

---

## 第十四类：补丁/代码策略

| 项目 | Stars | 核心机制 |
|------|-------|---------|
| [theluk/llm-patcher](https://github.com/theluk/llm-patcher) | 31 | 生成和流式传输变更补丁，只传 diff 不做完整文件重写，客户端重建最终结果 |
| [garvit-joshi/jskim](https://github.com/garvit-joshi/jskim) | 4 | tree-sitter 解析 Java 文件为紧凑结构摘要，用轻量符号/调用图替代全文件内容，省 70-80% |
| [JSungMin/vs-token-safer](https://github.com/JSungMin/vs-token-safer) | 11 | language-server/tree-sitter 索引替代 grep，clangd/Roslyn 语义查询，30+ 语言 |
| [lightningpixel/orvix](https://github.com/lightningpixel/orvix) | 6 | 查询符号和调用图，而非 grep 和读取文件，省 90% 代码搜索 token |
| [seqis/AI-grep](https://github.com/seqis/AI-grep) | 88 | Go 便携式搜索工具，索引目录，专为 AI/LLM 工作流设计，找到内容无需读取整个文件 |

---

## 第十五类：资源合集/手册

| 项目 | Stars | 核心机制 |
|------|-------|---------|
| [jasontang-ai/Context-Engineering](https://github.com/jasontang-ai/Context-Engineering) | 9,230 | Karpathy 启发的研究支持上下文优化技术手册（上下文修剪/token 预算/记忆系统/检索增强） |
| [pleasedodisturb/awesome-llm-token-optimization](https://github.com/pleasedodisturb/awesome-llm-token-optimization) | 63 | LLM token 优化策略、工具、论文精选列表 |

---

## 策略分类拓扑图

```
Token 节省策略
├── 1. 减少进入 LLM 的数据量
│   ├── CLI 输出压缩（rtk, headroom, context-mode, lowfat, distill, boost, chop, opentoken, snip）
│   ├── MCP 层压缩（mcp-compressor, clean-mcp, sourcerer-mcp, mcp-batchit, Contextcore, ncp）
│   ├── 代理/网关压缩（rtk, headroom, paritok-4b, tamp, claw-compactor, pxpipe, OmniRoute）
│   ├── 无损压缩算法（caveman-compression, foveance, steno, tokenslim, Deblank, prompt_compressor）
│   ├── AI 模型压缩（context-compressor, bu-ketao, eridani-speak）
│   └── 格式优化（TONL, TOON, LEAN）
├── 2. 减少 LLM 需要读取的内容
│   ├── 代码图索引（graphify, codegraph, lean-ctx, CodeGraphContext, ProjectAtlas, sdl-mcp, codemap, claude-ctags, IGraph, codegraph-rust）
│   ├── 上下文管理（claude-mem, Continuous-Claude-v3, claude-modular, bonsai-memory, Grov, cheasee-pi, ctxcraft, claude-memory-compiler）
│   └── 补丁/代码策略（llm-patcher, jskim, vs-token-safer, orvix, AI-grep）
├── 3. 减少 LLM 调用次数
│   ├── 语义缓存（semcache）
│   └── 模型路由（locode, cc_token_saver_mcp, senior-fable, fable-orchestrator, agentwise, voly, Token-Saving-Skill, small-opencode-orchestrator）
├── 4. 减少 LLM 输出浪费
│   ├── 行为技能注入（caveman, ponytail, token-diet, benjamin-plus, caveman-micro, genshijin, scalpel, paleo, token-efficiency, claude-token-optimizer）
│   ├── 输出格式压缩（bu-ketao, eridani-speak, tokensift）
│   └── 多工具组合栈（tokenwar, espresso, claude-code-tips, token-stack, toksave, token-saviour）
└── 5. 测量与优化
    └── Token 监控（tokenjam, claude-devtools, abtop, tokentap, context-lens, retok, contextspy, tokbench）
```

---

## 核心项目速查表（按 Stars 排序）

| 排名 | 项目 | Stars | 类型 | 一句话 |
|------|------|-------|------|--------|
| 1 | [ponytail](https://github.com/DietrichGebert/ponytail) | 114,550 | Skill | 最懒 senior dev，YAGNI 原则 |
| 2 | [graphify](https://github.com/Graphify-Labs/graphify) | 111,720 | Skill | 代码库→知识图谱 |
| 3 | [caveman](https://github.com/JuliusBrussee/caveman) | 101,510 | Skill | 极简输出，省 65% |
| 4 | [claude-mem](https://github.com/thedotmack/claude-mem) | 92,408 | 记忆系统 | 跨会话持久记忆 |
| 5 | [rtk](https://github.com/rtk-ai/rtk) | 77,677 | CLI 代理 | 压缩 shell 输出 60-90% |
| 6 | [codegraph](https://github.com/colbymchenry/codegraph) | 68,441 | 代码图 | 预索引代码知识图谱 |
| 7 | [headroom](https://github.com/headroomlabs-ai/headroom) | 67,865 | 代理+MCP | 压缩工具输出/日志/JSON |
| 8 | [OmniRoute](https://github.com/diegosouzapw/OmniRoute) | 57,156 | 网关 | 350+ 提供商，RTK+Caveman |
| 9 | [context-mode](https://github.com/mksglu/context-mode) | 20,203 | MCP | 沙箱执行，上下文减 98% |
| 10 | [Context-Engineering](https://github.com/jasontang-ai/Context-Engineering) | 9,230 | 手册 | Karpathy 启发方法论 |
| 11 | [pxpipe](https://github.com/teamchong/pxpipe) | 7,292 | 代理 | 文本→图片，利用视觉模型 |
| 12 | [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) | 4,131 | MCP+CLI | 代码索引到图数据库 |
| 13 | [Continuous-Claude-v3](https://github.com/parcadei/Continuous-Claude-v3) | 3,931 | 上下文管理 | YAML 交接 + 语义索引 |
| 14 | [claude-devtools](https://github.com/matt1398/claude-devtools) | 3,874 | 监控 | 会话日志可视化 |
| 15 | [lean-ctx](https://github.com/yvgude/lean-ctx) | 3,666 | Rust 二进制 | 上下文智能层，省 60-90% |
| 16 | [abtop](https://github.com/graykode/abtop) | 3,473 | 监控 | btop 风格 TUI 仪表盘 |
| 17 | [claw-compactor](https://github.com/open-compress/claw-compactor) | 2,032 | 网关 | 14 阶段融合管道 |
| 18 | [paritok-4b](https://github.com/Paritok-official/paritok-4b-v1) | 1,445 | 网关 | 4B 模型压缩至 25.7% |
| 19 | [claude-memory-compiler](https://github.com/coleam00/claude-memory-compiler) | 1,283 | 记忆 | Agent SDK 提取决策 |
| 20 | [caveman-compression](https://github.com/wilpel/caveman-compression) | 1,094 | 算法 | 语义压缩：移除可预测语法 |