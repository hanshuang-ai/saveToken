// dogfood:对本插件自己的源码跑 tok_code_symbol/tok_code_refs,验证真实代码提取
import { readFileSync } from "node:fs";
import { store } from "../src/store/db";
import { indexCode, retrieveSymbol, retrieveRefs } from "../src/codegraph/graph";

store.open("/tmp/frugal-dogfood.db");

const files = [
  "/Users/lcy/Documents/个人资料/saveToken/src/store/db.ts",
  "/Users/lcy/Documents/个人资料/saveToken/src/mcp/server.ts",
  "/Users/lcy/Documents/个人资料/saveToken/src/codegraph/graph.ts",
];

const handles: Record<string, string> = {};
let now = 1700000000000;
for (const f of files) {
  const content = readFileSync(f, "utf-8");
  const h = store.saveOriginal(content, { source: f, tool: "Read" }, now++);
  handles[f] = h;
  const ok = await indexCode(h);
  const syms = store.getSymbols(h);
  console.log(`\n=== ${f.split("/").pop()} (handle=${h}, indexed=${ok}) ===`);
  console.log(`  符号数:${syms.length}`);
  // 列前 8 个符号
  for (const s of syms.slice(0, 8)) {
    console.log(`    [${s.kind}] ${s.name} 行${s.startLine}-${s.endLine}${s.exported ? " ★" : ""}`);
  }
  if (syms.length > 8) console.log(`    ... 还有 ${syms.length - 8} 个`);
}

// 查 db.ts 的 saveOriginal 符号
const dbH = handles[files[0]];
console.log("\n═══ tok_code_symbol(db.ts, saveOriginal) ═══");
const sym = await retrieveSymbol(dbH, "saveOriginal");
console.log(sym.text.slice(0, 600));

// 查 graph.ts indexCode 调用了什么(callees)
const graphH = handles[files[2]];
console.log("\n═══ tok_code_refs(graph.ts, indexCode, callees) ═══");
const refs = await retrieveRefs(graphH, "indexCode", "callees", 2);
console.log(refs.text);

// 跨文件:graph.ts 调用了 store.getOriginal / store.saveSymbols 等(member,不解析)
// 但也调用了 parseCode/extractSymbols/resolveImportPath(裸名,同文件 import)
console.log("\n═══ tok_code_refs(graph.ts, indexCode, callees) 跨文件解析检查 ═══");
const cross = ["parseCode", "extractSymbols", "resolveImportPath", "langForExt"];
for (const c of cross) {
  console.log(`  ${c}: ${refs.text.includes(c) ? "✓ 出现" : "✗ 未出现"}`);
}

store.close();
