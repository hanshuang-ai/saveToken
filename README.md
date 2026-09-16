# frugal

为 Claude Code 的部分 Bash 文本输出提供保守的精简视图,采用视图时保存原文供 MCP 按需取回。不是通用无损压缩器,也不会压缩所有工具读取。

## Conservative v2

以下是当前 v2 管道。已用本地回归测试验证边界行为,真实场景收益仍未验证。

```text
Bash 文本 -> 10,000 字符早期筛选 -> 纯候选生成 -> 含标记的净收益检查
                                                   -> 同步提交原文 + FTS + 度量
                                                   -> 返回精简视图 + handle 标记
其他输入 / 无合格候选 / 提交失败 -> 原样放行
```

- **输入边界**:hook 只处理 Bash 返回的文本字符串,或对象中字符串类型的 `stdout` / `stderr`。不遍历任意字段,不处理任意二进制字段。`Read` 输出保持不变。
- **早期筛选**:10,000 字符只是避免小输出进入候选管道的门槛。超过门槛不强制压缩,这个数值也不是已证明的最优点。
- **纯候选**:候选生成不写数据库。`format-strip` 仅移除 SGR ANSI 颜色/样式码,不删除或折叠空格、制表符,不移除光标控制命令或其他终端控制序列。
- **严格识别**:`structured-digest` 只处理三类已识别机器输出: Jest 成功套件、带时间戳的日志信号行、重复的 CPU/内存快照表。不能仅凭 `PASS`、`error` 等子串判定为可摘要内容。
- **诊断保留**:日志摘要只保留结构化错误/告警/失败/堆栈信号并标出原始行号;高密度诊断不摘要。快照摘要保留每个时间片的汇总和前几条高排名进程,并明确提示省略行可从原文取回。SGR 清理是独立且仅限上述范围的转换,不是改写诊断文本的许可。不对未知 build、grep、lint、JSON 或代码输出做泛化摘要。
- **没有盲截断**:默认管道不使用头尾保留、中间丢弃的 `snip`。没有安全候选就放行。
- **采用条件**:最终视图连同完整 handle 标记,相对原文必须同时净减少至少 **512 字符**和 **10%**。未达标就原样放行。
- **先提交再返回**:采用的视图必须在返回前,将原文、FTS 索引和度量同步提交到同一事务。提交失败不能返回带有不可用 handle 的精简视图。
- **放行不留痕**:原样放行不备份原文,不添加 handle 标记。不是每次工具调用都有持久化 handle。

## MCP Tools

| 工具 | 用途 |
|---|---|
| `tok_retrieve` | 指定已存 `handle`,用 `query` 检索或 `startLine` + `count` 按行取回;只传 handle 可取全文,上限 60,000 字符 |
| `tok_stats` | 已存字符度量、分类型/会话明细、取回次数及记录取回率 |
| `tok_code_symbol` | 查询已有持久化 TS/JS 代码 handle 的符号定义与实现 |
| `tok_code_refs` | 查询已有持久化 TS/JS 代码 handle 的调用关系 |

保留 codegraph 工具是为了已有持久化代码句柄,并不意味着 v2 会压缩 `Read` 或为新读取自动生成代码句柄。

没有 `tok_compact`。普通 MCP 工具只能返回工具结果,不能驱逐、替换或修改宿主已有的对话历史。v2 不做历史变更,也不根据取回率自动降级或调整策略。打开存储不再自动删除历史记录;保留期清理仅是显式维护操作,与服务商缓存 TTL 无关。

## Metrics

大小使用 JavaScript `string.length` 统计,即 UTF-16 代码单元,本文简称“字符”。这不是 tokenizer 测得的 token 数,也不是账单、缓存命中或端到端成本节省。

`tok_stats` 的取回次数是已记录的取回计数总和;取回率是至少被取回一次的压缩记录数除以压缩记录总数,排除旧 dedup 记录。它们只是使用事实,不是压缩质量判决。没有任意的 15%/30% 告警线,高取回率不能证明压缩失败。

目前不宣称 v2 已在真实场景中建立节省收益。真实场景测试必须先获得用户批准;合成用例或字符减少量不能替代真实工作流验证。

## Configuration

hook 与 MCP 使用同一数据库路径约定:

```ts
join(process.env.FRUGAL_DATA_DIR ?? join(homedir(), 'Desktop', 'frugal'), 'frugal.db')
```

- `FRUGAL_DATA_DIR`:覆盖数据目录。测试应设置为独立的临时目录,不要连接桌面的实际数据库;需要共享 handle 的 hook/MCP 进程必须使用相同目录。
- `FRUGAL_TIMING_LOG`:可选的 JSONL 计时日志路径,仅显式设置时启用。记录分类、策略、数据库打开、原文写入、FTS 索引、度量写入及总耗时,不记录文本或路径。`moduleReadyMs` 是进程时间原点到模块加载后的时间,不是单独测得的 npx 启动耗时。日志失败不影响输出。

## Installation

需要 Node.js/npm 和 Claude Code,并安装仓库依赖。不要假设缺少存储或解析依赖时仍能安全提供完整功能。

```bash
git clone https://github.com/hanshuang-ai/saveToken.git
cd saveToken
npm install
```

在 Claude Code 中按需安装本地插件:

```text
/plugin marketplace add /absolute/path/saveToken
/plugin install frugal@lcy-tools
```

本地目录方式需要先安装依赖。修改 `hooks/`、`commands/` 或源码后，在已有 Claude 会话中运行 `/reload-plugins`，或者重新启动会话；若通过 marketplace 安装，插件版本变更后再重新安装，避免继续使用旧缓存。调试 hook 是否真的运行时，可在启动 Claude 前设置 `FRUGAL_TIMING_LOG`，它会记录每次 Bash 输出的 `reason`、输入/输出大小和耗时，不记录原文。

## Testing

仓库测试入口是 `npm test`。执行前检查测试是否使用内存数据库或隔离的 `FRUGAL_DATA_DIR`,并确认不会调用 Claude、访问桌面数据库或删除已有数据。仅设置 `FRUGAL_MCP_TEST` 不足以隔离数据库:它禁止 stdio 连接,不禁止模块加载时打开 store。

## Inspirations

以下三篇文章仅作为设计启发,不是本项目已经验证的数字保证,也不证明本项目获得了文中可能报告的收益:

- https://juejin.cn/post/7673855455463800847
- https://juejin.cn/post/7667495083470471177
- https://juejin.cn/post/7647412292435689515

## License

MIT
