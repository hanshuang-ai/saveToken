/** SessionStart hook: inject routing guidance for code-graph MCP tools. */
import { trace } from "../src/core/logger";

const GUIDANCE = `# ⚠ frugal 代码理解工具(强制规则)

遇到 .ts/.js/.vue/.tsx/.jsx 代码文件时,禁止直接 Read 整个文件。必须先使用以下 MCP 工具之一:

1. tok_code_map(filePath="绝对路径") → 文件结构图(符号/调用/Vue SFC 分区)。第一次看某个代码文件时用这个。
2. tok_code_symbol(filePath="绝对路径", symbol="函数名") → 查特定符号定义。
3. tok_code_refs(filePath="绝对路径", symbol="函数名", direction="callees") → 查调用关系。

三个工具都接受 filePath,自动读取+索引,无需预先压缩。

Read 仅允许用于:配置文件(.json/.yaml/.toml)、<200行的小文件、非代码文本、Edit 前取精确文本片段。`;

trace("SessionStart", "hook invoked");
const output = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: GUIDANCE,
  },
});
trace("SessionStart", "guidance prepared", { chars: GUIDANCE.length, outputLen: output.length });
trace("SessionStart", "emitting JSON to stdout");
console.log(output);
trace("SessionStart", "done");
