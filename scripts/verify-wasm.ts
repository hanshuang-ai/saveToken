// 验证 web-tree-sitter WASM 在 Bun 端到端加载 + parse TS/JS/TSX 出 AST
// 这是 Task #18 最大风险点。失败则需降级方案。
import { Parser, Language } from "web-tree-sitter";
import { join, dirname } from "node:path";

// 用 require.resolve 定位包真实位置(parser.ts 也将用这个机制,
// 保证从插件缓存任意位置运行都能找到 wasm)
const pkgDir = (pkg: string) => dirname(require.resolve(`${pkg}/package.json`));
const nm = (p: string) => {
  const [pkg, ...rest] = p.split("/");
  return join(pkgDir(pkg), ...rest);
};

console.log("1) Parser.init...");
await Parser.init({
  locateFile: (f: string) => nm(`web-tree-sitter/${f}`),
});
console.log("   ✓ init ok");

const TS = await Language.load(nm("tree-sitter-typescript/tree-sitter-typescript.wasm"));
const TSX = await Language.load(nm("tree-sitter-typescript/tree-sitter-tsx.wasm"));
const JS = await Language.load(nm("tree-sitter-javascript/tree-sitter-javascript.wasm"));
console.log("2) Language.load ok (ts/tsx/js)");

const code = `import { foo } from "./fileB";
export function bar(n: number): string {
  return foo(n) + "!";
}
class C {
  method() { return bar(1); }
}
const arrow = (x: number) => x * 2;
`;

const parser = new Parser();
parser.setLanguage(TS);
const tree = parser.parse(code);
console.log("3) parse ok");
console.log("   root type:", tree.rootNode.type);
console.log("   child count:", tree.rootNode.childCount);

// 遍历顶层节点,看是否提取到 import/function/class
const tops = tree.rootNode.namedChildren;
console.log("4) 顶层命名节点:");
for (const n of tops) {
  console.log(`   - ${n.type} [${n.startPosition.row + 1}-${n.endPosition.row + 1}]`);
}

// 测试 query:提取函数定义
const q = TS.query(`
  (function_declaration name: (identifier) @fn.name) @fn.def
  (class_declaration name: (type_identifier) @cls.name) @cls.def
  (import_statement) @import
  (call_expression function: (identifier) @call.name) @call.expr
`);
console.log("5) query ok");
const matches = q.matches(tree.rootNode);
console.log("   matches:", matches.length);
for (const m of matches) {
  const cap = m.captures[0];
  console.log(`   - pattern ${m.patternIndex}: ${cap.name} = ${cap.node.text.slice(0, 40)}`);
}

// 测试 JS + TSX 也行
parser.setLanguage(JS);
const jsTree = parser.parse("const f = (a) => a + 1; f(2);");
console.log("6) JS parse ok, root:", jsTree.rootNode.type);

parser.setLanguage(TSX);
const tsxTree = parser.parse("const App = () => <div>hi</div>;");
console.log("7) TSX parse ok, root:", tsxTree.rootNode.type);

console.log("\n✅ WASM 全部验证通过");
