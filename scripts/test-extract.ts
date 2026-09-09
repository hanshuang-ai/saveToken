import { parseCode } from "../src/codegraph/parser";
import { extractSymbols } from "../src/codegraph/extract";

const code = `import { foo, bar } from "./fileB";
import defThing from "../util";
import "./side-effect";

export function doWork(n: number): string {
  return foo(n) + bar(n);
}

class Worker {
  private name: string;
  constructor(name: string) { this.name = name; }
  run() { return doWork(1); }
}

const handler = (x: number) => {
  return foo(x);
};

function internal() { return 42; }
`;

const root = await parseCode(code, "typescript");
const r = extractSymbols(root);
console.log("=== 定义 ===");
for (const d of r.definitions) console.log(`  [${d.kind}] ${d.name} 行${d.startLine}-${d.endLine} export=${d.exported} | sig: ${d.signature}`);
console.log("=== imports ===");
for (const i of r.imports) console.log(`  行${i.line} src=${i.source} names=[${i.importedNames.join(",")}]`);
console.log("=== calls ===");
for (const c of r.calls) console.log(`  行${c.line} ${c.calleeName}  (in ${c.callerSymbol ?? "顶层"})`);
