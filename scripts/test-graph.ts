// 集成测试 graph.ts:跨文件解析 + 未读降级(验证计划 #4 #5)
import { store } from "../src/store/db";
import { indexCode, retrieveSymbol, retrieveRefs } from "../src/codegraph/graph";

store.open(); // 内存库

const now = 1700000000000;
const fileA = `import { foo } from "./fileB";
import { log } from "./unread";

export function bar(n: number): number {
  log("bar", n);
  return foo(n) + 1;
}

export function helper() {
  return bar(2);
}
`;
const fileB = `export function foo(x: number): number {
  return x * 2;
}
`;

const ha = store.saveOriginal(fileA, { source: "/proj/fileA.ts", tool: "Read" }, now);
const hb = store.saveOriginal(fileB, { source: "/proj/fileB.ts", tool: "Read" }, now + 1);
console.log("fileA handle:", ha, "| fileB handle:", hb);

console.log("\n=== indexCode fileA ===");
const ia = await indexCode(ha);
console.log("indexed:", ia);
console.log("\n=== indexCode fileB ===");
const ib = await indexCode(hb);
console.log("indexed:", ib);

console.log("\n=== retrieveSymbol(bar) 完整定义+同文件关系 ===");
const sym = await retrieveSymbol(ha, "bar");
console.log(sym.text);

console.log("\n=== retrieveRefs(bar, callees, depth=2) 跨文件解析 foo ===");
const refs = await retrieveRefs(ha, "bar", "callees", 2);
console.log(refs.text);

console.log("\n=== retrieveRefs(bar, callers) 同文件 helper 调 bar ===");
const callers = await retrieveRefs(ha, "bar", "callers");
console.log(callers.text);

console.log("\n=== 校验 ===");
const okFoo = refs.text.includes("foo") && refs.text.includes("fileB");
const okUnread = refs.text.includes("log") && refs.text.includes("未读");
const okCaller = callers.text.includes("helper");
console.log("  foo 跨文件解析到 fileB:", okFoo ? "✓" : "✗");
console.log("  log 未读降级提示:", okUnread ? "✓" : "✗");
console.log("  helper 是 bar 的 caller:", okCaller ? "✓" : "✗");
