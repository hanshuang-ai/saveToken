/**
 * codegraph.test.ts —— 代码 AST 图检索测试(Task #18)
 *
 * 验证:
 *   1. 符号提取:definitions/imports/calls 正确(行号/签名/exported)
 *   2. 持久化:indexCode 存 symbols/refs,幂等(重复不重复)
 *   3. 符号取回:精确/模糊/概览
 *   4. 跨文件解析:callees 自动解析到已读文件,带签名
 *   5. 未读降级:import 的符号所在文件未读 → 提示 Read
 *   6. callers:本文件内 + 跨文件
 *
 * 运行:bun test
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { store } from "../src/store/db";
import { parseCode } from "../src/codegraph/parser";
import { extractSymbols } from "../src/codegraph/extract";
import { indexCode, retrieveSymbol, retrieveRefs } from "../src/codegraph/graph";

beforeEach(() => {
  store.open(":memory:");
});
afterEach(() => {
  store.close();
});

// ─── 1. 符号提取 ──────────────────────────────────────────────────────────────

test("提取函数/类/方法/箭头/导入/调用", async () => {
  const code = `import { foo } from "./fileB";
import def from "../util";

export function doWork(n: number): string {
  return foo(n);
}

class Worker {
  run() { return doWork(1); }
}

const handler = (x: number) => foo(x);
`;
  const root = await parseCode(code, "typescript");
  const r = extractSymbols(root);

  const names = r.definitions.map((d) => d.name);
  expect(names).toContain("doWork");
  expect(names).toContain("Worker");
  expect(names).toContain("run");
  expect(names).toContain("handler");

  const doWork = r.definitions.find((d) => d.name === "doWork")!;
  expect(doWork.kind).toBe("function");
  expect(doWork.exported).toBe(true);
  expect(doWork.signature).toContain("doWork(n: number): string");
  expect(doWork.startLine).toBe(4);

  const run = r.definitions.find((d) => d.name === "run")!;
  expect(run.kind).toBe("method");

  const handler = r.definitions.find((d) => d.name === "handler")!;
  expect(handler.kind).toBe("variable");

  // imports
  expect(r.imports).toHaveLength(2);
  expect(r.imports[0].source).toBe("./fileB");
  expect(r.imports[0].importedNames).toContain("foo");
  expect(r.imports[1].source).toBe("../util");
  expect(r.imports[1].importedNames).toContain("def");

  // calls
  const fooCalls = r.calls.filter((c) => c.calleeName === "foo");
  expect(fooCalls.length).toBeGreaterThanOrEqual(2);
  const callInDoWork = r.calls.find((c) => c.calleeName === "foo" && c.callerSymbol === "doWork");
  expect(callInDoWork).toBeTruthy();
});

// ─── 2. 持久化 + 幂等 ────────────────────────────────────────────────────────

test("indexCode 存符号并幂等", async () => {
  const code = `export function bar(n: number): number { return n + 1; }
const x = bar(2);
`;
  const handle = store.saveOriginal(code, { source: "/p/a.ts", tool: "Read" }, 1000);

  expect(store.hasSymbols(handle)).toBe(false);
  const ok = await indexCode(handle);
  expect(ok).toBe(true);
  expect(store.hasSymbols(handle)).toBe(true);

  const syms = store.getSymbols(handle);
  expect(syms.find((s) => s.name === "bar")).toBeTruthy();

  // 幂等:重复 index 不重复记录
  await indexCode(handle);
  const syms2 = store.getSymbols(handle);
  expect(syms2.filter((s) => s.name === "bar")).toHaveLength(1);
});

test("indexCode 非代码返回 false", async () => {
  const handle = store.saveOriginal("id,name\n1,a\n2,b\n", { source: "/p/d.csv", tool: "Read" }, 1000);
  const ok = await indexCode(handle);
  expect(ok).toBe(false);
  expect(store.hasSymbols(handle)).toBe(false);
});

// ─── 3. 符号取回 ──────────────────────────────────────────────────────────────

test("retrieveSymbol 精确返回完整 body", async () => {
  const code = `export function bar(n: number): number {\n  return n + 1;\n}\n`;
  const handle = store.saveOriginal(code, { source: "/p/a.ts", tool: "Read" }, 1000);
  await indexCode(handle);

  const r = await retrieveSymbol(handle, "bar");
  expect(r.retrieved).toBe(true);
  expect(r.text).toContain("bar");
  expect(r.text).toContain("return n + 1");
  expect(r.text).toContain("行1");
});

test("retrieveSymbol 概览模式列出所有符号", async () => {
  const code = `function a() {}\nfunction b() {}\n`;
  const handle = store.saveOriginal(code, { source: "/p/a.ts", tool: "Read" }, 1000);
  await indexCode(handle);

  const r = await retrieveSymbol(handle);
  expect(r.retrieved).toBe(true);
  expect(r.text).toContain("a");
  expect(r.text).toContain("b");
});

test("retrieveSymbol 模糊查询", async () => {
  const code = `function getUserData() {}\nfunction other() {}\n`;
  const handle = store.saveOriginal(code, { source: "/p/a.ts", tool: "Read" }, 1000);
  await indexCode(handle);

  const r = await retrieveSymbol(handle, undefined, "User");
  expect(r.retrieved).toBe(true);
  expect(r.text).toContain("getUserData");
  expect(r.text).not.toContain("other");
});

// ─── 4. 跨文件解析 ────────────────────────────────────────────────────────────

test("retrieveRefs callees 跨文件解析到已读文件", async () => {
  const fileA = `import { foo } from "./fileB";
export function bar(n: number): number {
  return foo(n);
}
`;
  const fileB = `export function foo(x: number): number {\n  return x * 2;\n}\n`;
  const ha = store.saveOriginal(fileA, { source: "/proj/fileA.ts", tool: "Read" }, 1000);
  const hb = store.saveOriginal(fileB, { source: "/proj/fileB.ts", tool: "Read" }, 1001);
  await indexCode(ha);
  await indexCode(hb);

  const r = await retrieveRefs(ha, "bar", "callees", 2);
  expect(r.retrieved).toBe(true);
  // foo 解析到 fileB,带签名
  expect(r.text).toContain("foo");
  expect(r.text).toContain("fileB");
  expect(r.text).toContain("function foo(x: number): number");
  expect(r.text).toContain("跨文件");
});

// ─── 5. 未读降级 ──────────────────────────────────────────────────────────────

test("retrieveRefs 未读 import 提示 Read", async () => {
  const fileA = `import { log } from "./unread";
export function bar(n: number): number {
  log(n);
  return n;
}
`;
  const ha = store.saveOriginal(fileA, { source: "/proj/fileA.ts", tool: "Read" }, 1000);
  await indexCode(ha);

  const r = await retrieveRefs(ha, "bar", "callees");
  expect(r.retrieved).toBe(true);
  expect(r.text).toContain("log");
  expect(r.text).toContain("未读");
  expect(r.text).toContain("./unread");
});

// ─── 6. callers ──────────────────────────────────────────────────────────────

test("retrieveRefs callers 本文件内", async () => {
  const fileA = `export function bar(n: number): number { return n; }
export function caller() { return bar(1); }
`;
  const ha = store.saveOriginal(fileA, { source: "/proj/fileA.ts", tool: "Read" }, 1000);
  await indexCode(ha);

  const r = await retrieveRefs(ha, "bar", "callers");
  expect(r.retrieved).toBe(true);
  expect(r.text).toContain("caller");
  expect(r.text).toContain("同文件");
});

test("retrieveRefs 跨文件 callers(反向解析)", async () => {
  // fileB imports bar from fileA and calls it
  const fileA = `export function bar(n: number): number { return n; }\n`;
  const fileB = `import { bar } from "./fileA";
export function useBar() { return bar(2); }
`;
  const ha = store.saveOriginal(fileA, { source: "/proj/fileA.ts", tool: "Read" }, 1000);
  const hb = store.saveOriginal(fileB, { source: "/proj/fileB.ts", tool: "Read" }, 1001);
  await indexCode(ha);
  await indexCode(hb);

  // 从 fileA 查 bar 的 callers:应找到 fileB 的 useBar
  const r = await retrieveRefs(ha, "bar", "callers");
  expect(r.retrieved).toBe(true);
  expect(r.text).toContain("useBar");
  expect(r.text).toContain("fileB");
});

test("this.X 同类方法调用解析到本文件定义", async () => {
  // process 调 this.helper → 应解析为同类方法 helper(同文件),而非"成员调用未解析"
  const code = `class Worker {
  process(n: number): number {
    return this.helper(n);
  }
  helper(x: number): number {
    return x * 2;
  }
}
`;
  const handle = store.saveOriginal(code, { source: "/p/w.ts", tool: "Read" }, 1000);
  await indexCode(handle);

  // callees of process → helper 同文件已解析
  const cal = await retrieveRefs(handle, "process", "callees");
  expect(cal.text).toContain("helper");
  expect(cal.text).toContain("同文件");

  // callers of helper → process(同类方法调用反向找到)
  const cal2 = await retrieveRefs(handle, "helper", "callers");
  expect(cal2.text).toContain("process");
});
