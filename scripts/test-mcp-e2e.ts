// 端到端:启动 MCP server 子进程,JSON-RPC 验证 tok_code_symbol/tok_code_refs
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { store } from "../src/store/db";

const DATA = "/tmp/frugal-mcp-e2e";
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

// 预存一段代码原文到 DB(server 会读同一 DB)
store.open(join(DATA, "frugal.db"));
const code = `import { foo } from "./fileB";
export function bar(n: number): number {
  return foo(n) + 1;
}
`;
const handle = store.saveOriginal(code, { source: "/proj/fileA.ts", tool: "Read" }, 1700000000000);
store.close();
console.log("预存 handle:", handle);

// 启动 server 子进程
const proc = spawn("bun", ["run", "src/mcp/server.ts"], {
  cwd: "/Users/lcy/Documents/个人资料/saveToken",
  env: { ...process.env, CLAUDE_PLUGIN_DATA: DATA },
});
let buf = "";
const send = (obj: unknown) => proc.stdin.write(JSON.stringify(obj) + "\n");
const results: Record<number, unknown> = {};

proc.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) results[msg.id] = msg;
    } catch {}
  }
});

proc.stderr.on("data", (d) => process.stderr.write("[server stderr] " + d));

await new Promise((r) => setTimeout(r, 500));

// MCP 握手
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } });
await new Promise((r) => setTimeout(r, 300));
send({ jsonrpc: "2.0", method: "notifications/initialized" });
await new Promise((r) => setTimeout(r, 100));

// tools/list
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
await new Promise((r) => setTimeout(r, 300));
const list = results[2] as any;
const toolNames = list?.result?.tools?.map((t: any) => t.name) ?? [];
console.log("\n=== tools/list ===");
console.log("工具:", toolNames.join(", "));
const hasSymbol = toolNames.includes("tok_code_symbol");
const hasRefs = toolNames.includes("tok_code_refs");
console.log("  tok_code_symbol:", hasSymbol ? "✓" : "✗");
console.log("  tok_code_refs:", hasRefs ? "✓" : "✗");

// tools/call tok_code_symbol
send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tok_code_symbol", arguments: { handle, symbol: "bar" } } });
await new Promise((r) => setTimeout(r, 1500)); // 首次查触发 WASM init + parse,留足时间
const symRes = results[3] as any;
const symText = symRes?.result?.content?.[0]?.text ?? "(无结果)";
console.log("\n=== tools/call tok_code_symbol(bar) ===");
console.log(symText.slice(0, 400));
const symOk = symText.includes("bar") && symText.includes("return foo(n)");
console.log("  返回 bar 完整实现:", symOk ? "✓" : "✗");

// tools/call tok_code_refs
send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "tok_code_refs", arguments: { handle, symbol: "bar", direction: "callees" } } });
await new Promise((r) => setTimeout(r, 1000));
const refsRes = results[4] as any;
const refsText = refsRes?.result?.content?.[0]?.text ?? "(无结果)";
console.log("\n=== tools/call tok_code_refs(bar, callees) ===");
console.log(refsText.slice(0, 300));
const refsOk = refsText.includes("foo") && refsText.includes("未读");
console.log("  返回 foo 未读提示:", refsOk ? "✓" : "✗");

proc.kill();
console.log("\n=== 总结 ===");
console.log(hasSymbol && hasRefs && symOk && refsOk ? "✅ 端到端全部通过" : "❌ 有失败项");
