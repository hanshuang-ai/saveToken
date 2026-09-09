import { execSync } from "node:child_process";
import { writeFileSync as wf, readFileSync as rf } from "node:fs";

// 造一段 >2048 字符的 TS 代码(含函数/import/调用)
const tsCode = `import { foo } from "./fileB";
export class Worker {
  process(items: number[]): number {
    return items.map(i => foo(i)).reduce((a, b) => a + b, 0);
  }
}
` + Array.from({ length: 200 }, (_, i) =>
  `export function fn${i}(x: number): number { return x + ${i}; }`
).join("\n");

function runHook(tool: string, path: string | undefined, content: string): string {
  const payload = JSON.stringify({
    tool_name: tool,
    tool_input: path ? { file_path: path } : {},
    tool_response: { content },
    session_id: "test-cg",
  });
  wf("/tmp/pl.json", payload);
  try {
    execSync("bun run /Users/lcy/Documents/个人资料/saveToken/hooks/post-tool-compress.ts < /tmp/pl.json > /tmp/out.json 2>/tmp/err.txt", {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: "/tmp/frugal-cg-test" },
    });
  } catch (e) { console.log("hook err:", (e as Error).message); }
  const err = rf("/tmp/err.txt", "utf-8");
  if (err) console.log("stderr:", err.slice(0, 200));
  const out = rf("/tmp/out.json", "utf-8");
  if (!out) return "(无输出=放行)";
  return JSON.parse(out).hookSpecificOutput.updatedToolOutput.content;
}

console.log("=== .ts 代码 note ===");
const tsOut = runHook("Read", "/proj/src/worker.ts", tsCode);
console.log("长度:", tsOut.length);
console.log("末尾 note:");
console.log(tsOut.slice(-500));
console.log("\n关键词检查:");
for (const kw of ["代码", "tok_code_symbol", "tok_code_refs", "orig-", "symbol=", "direction="]) {
  console.log(`  ${tsOut.includes(kw) ? "✓" : "✗"} ${kw}`);
}
for (const kw of ["统计/聚合", "awk"]) {
  console.log(`  ${tsOut.includes(kw) ? "✗(代码不该有statHint)" : "✓(无statHint)"} ${kw}`);
}

console.log("\n=== .csv 数据 note(应保持 Task#36 不变)===");
const csv = "id,name\n" + Array.from({ length: 500 }, (_, i) => `${i},item-${i}`).join("\n");
const csvOut = runHook("Read", "/proj/data.csv", csv);
console.log("关键词检查:");
for (const kw of ["tok_retrieve", "统计/聚合", "awk"]) {
  console.log(`  ${csvOut.includes(kw) ? "✓" : "✗"} ${kw}`);
}
for (const kw of ["tok_code_symbol", "tok_code_refs"]) {
  console.log(`  ${csvOut.includes(kw) ? "✗(csv不该有code工具)" : "✓(无code工具)"} ${kw}`);
}
