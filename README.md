# frugal

通用 token 节省插件 —— 内容感知核心 + 可插拔适配器。

给 Claude Code 的工具输出做**无损压缩**:对 Bash/Read 的大输出,按内容分类(prose/structured/mixed),只压缩 structured(代码/日志/JSON),**散文永不动**。压缩后用 `tok_retrieve` 按需取回全文,信息零丢失。

## 压缩管道

```
工具输出 → classify(分类) → prose/mixed? 放行不压
                            → structured? → format-strip(去噪) → structured-digest(抽信号行) → snip(头尾截断)
                                                              → 全文存盘(tok_retrieve 取回)
```

- **format-strip**:剥离 ANSI 码等纯噪声,语义不变。
- **structured-digest**:针对噪声主导的行式输出(测试/build/grep/lint 日志),抽取失败/错误/警告/堆栈信号行,省略 PASS 噪声。结构性信号检测(行首级别/错误类型/堆栈/时间戳+级别 token),不靠子串匹配——避免散文/HTML/二进制里的 "fail"/"error" 假阳性。
- **snip**:超长内容头尾保留、中间段存盘。
- **散文红线**:prose/mixed/empty 永不压缩(hook 分类层放行),结构性检测是第二道防线。

## 安装(Claude Code 插件)

### 前置
- [Bun](https://bun.sh)(运行时,内置 `bun:sqlite`):`curl -fsSL https://bun.sh/install | bash`
- Claude Code

### 步骤
```bash
git clone https://github.com/hanshuang-ai/saveToken.git
cd saveToken
bun install          # 装 codegraph MCP 工具的依赖(核心压缩不装也能跑)
```
在 Claude Code 里:
```
/plugin marketplace add /绝对路径/saveToken
/plugin install frugal@lcy-tools
```
重启会话即生效。

> 用目录 marketplace 是因为:插件 MCP server 依赖 `@modelcontextprotocol/sdk`,Claude Code 的 git marketplace 不会自动 `bun install`(plugin.json 无 postinstall 字段——官方规范尚未支持)。目录源直接跑源码仓库,依赖从仓库 `node_modules` 解析;改代码后 `git pull` 即生效,无需同步缓存。

### 降级
即使跳过 `bun install`,核心 token 节省(hook 压缩 + digest)照常工作——核心压缩链路零外部依赖(仅 `bun:sqlite` 内置)。只有 codegraph 的 `tok_code_symbol`/`tok_code_refs` 需要 tree-sitter 依赖。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `tok_retrieve` | 取回被压缩的全文片段(按关键词检索/按行取) |
| `tok_code_symbol` | 取代码符号定义(跨文件解析) |
| `tok_code_refs` | 取符号调用/被调用关系 |

## 测试
```bash
bun test          # 55 pass(bunfig root=tests,排除 corpus 自带测试)
```

## 语料与测量
`corpus/`(gitignored)放真实测试语料(车载日志/SDK 源码/博客/文档)。`scripts/measure-corpus.ts` 镜像 hook 流程测量压缩表现与散文守卫泄漏风险。详见 [memory/corpus-baseline](.claude/projects/)。

## License
MIT
