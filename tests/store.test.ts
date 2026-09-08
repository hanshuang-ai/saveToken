/**
 * store.test.ts —— 存储层测试
 *
 * 验证四个闭环:
 *   1. 存原文 → 取回严格一致(安全模型第三道闸门)
 *   2. 全文检索:关键词命中相关片段,带行号
 *   3. 度量汇总:节省比、分类型统计正确
 *   4. 取回计数:incrementRetrieved 累加(成功率信号)
 *
 * 运行:bun test
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { store } from "../src/store/db";

beforeEach(() => {
  store.open(":memory:"); // 每个测试用内存库,隔离
});

afterEach(() => {
  store.close();
});

// ─── 存原文 / 取回一致 ──────────────────────────────────────────────────────

test("存原文后取回严格相等", () => {
  const text = "第1行\n第2行\n第3行\n报错 ERROR here\n第5行";
  const handle = store.saveOriginal(text, { source: "/tmp/test.log", tool: "Read" }, 1000);
  expect(handle).toBeTruthy();

  const rec = store.getOriginal(handle);
  expect(rec).toBeDefined();
  expect(rec!.content).toBe(text); // 严格相等
  expect(rec!.size).toBe(text.length);
  expect(rec!.source).toBe("/tmp/test.log");
  expect(rec!.tool).toBe("Read");
  expect(rec!.createdAt).toBe(1000);
});

test("getOriginalText 快捷取回", () => {
  const text = "hello world";
  const handle = store.saveOriginal(text, {}, 0);
  expect(store.getOriginalText(handle)).toBe(text);
});

test("不存在的 handle 返回 undefined", () => {
  expect(store.getOriginal("nope")).toBeUndefined();
  expect(store.getOriginalText("nope")).toBeUndefined();
});

test("大文本存取一致(10000 行日志)", () => {
  const lines = Array.from({ length: 10000 }, (_, i) => `2026-09-08 line ${i} data`);
  const text = lines.join("\n");
  const handle = store.saveOriginal(text, {}, 0);
  expect(store.getOriginalText(handle)).toBe(text);
});

// ─── 全文检索 ──────────────────────────────────────────────────────────────

test("检索:关键词命中相关片段", () => {
  const text = Array.from({ length: 100 }, (_, i) =>
    i === 50 ? "2026-09-08 报错 ERROR something failed" : `line ${i} normal`
  ).join("\n");
  const handle = store.saveOriginal(text, {}, 0);

  const hits = store.search(handle, "报错", 5);
  expect(hits.length).toBeGreaterThan(0);
  // 命中片段应包含查询词
  expect(hits[0].snippet).toContain("报错");
  expect(hits[0].handle).toBe(handle);
});

test("检索:英文关键词命中", () => {
  const text = "normal line\nERROR: connection refused\nnormal again";
  const handle = store.saveOriginal(text, {}, 0);
  const hits = store.search(handle, "ERROR", 5);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].snippet).toContain("ERROR");
});

test("检索:无匹配返回空", () => {
  const handle = store.saveOriginal("hello world foo bar", {}, 0);
  expect(store.search(handle, "不存在的词xyz", 5)).toEqual([]);
});

test("getLines 按行号取片段", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
  const handle = store.saveOriginal(lines.join("\n"), {}, 0);
  const chunk = store.getLines(handle, 10, 5); // 从第10行取5行
  expect(chunk).toBe("line9\nline10\nline11\nline12\nline13");
});

test("检索:限定在指定 handle 内(不跨文档)", () => {
  const h1 = store.saveOriginal("报错 ERROR in doc1", {}, 0);
  const h2 = store.saveOriginal("报错 ERROR in doc2", {}, 0);
  const hits1 = store.search(h1, "报错", 5);
  expect(hits1.length).toBeGreaterThan(0);
  expect(hits1.every((h) => h.handle === h1)).toBe(true);
});

// ─── 度量记录 ──────────────────────────────────────────────────────────────

test("度量汇总:节省比与分类型统计", () => {
  // structured: 1000 → 300 (省 700)
  store.recordMetric({
    contentType: "structured", originalSize: 1000, compressedSize: 300,
    method: "snip", createdAt: 1000,
  });
  // structured: 2000 → 800 (省 1200)
  store.recordMetric({
    contentType: "structured", originalSize: 2000, compressedSize: 800,
    method: "snip", createdAt: 1000,
  });
  // prose: 500 → 500 (没压,省 0)
  store.recordMetric({
    contentType: "prose", originalSize: 500, compressedSize: 500,
    method: "none", createdAt: 1000,
  });

  const s = store.getMetricSummary();
  expect(s.total).toBe(3);
  expect(s.compressed).toBe(2); // 两条 structured 压缩了
  expect(s.totalOriginal).toBe(3500);
  expect(s.totalCompressed).toBe(1600);
  expect(s.saved).toBe(1900);
  expect(s.savedRatio).toBeCloseTo(1900 / 3500, 2);
  expect(s.byType.structured.count).toBe(2);
  expect(s.byType.structured.saved).toBe(1900);
  expect(s.byType.prose.count).toBe(1);
  expect(s.byType.prose.saved).toBe(0);
});

test("取回计数累加(成功率信号)", () => {
  const handle = store.saveOriginal("some content", {}, 0);
  store.recordMetric({
    handle, contentType: "structured", originalSize: 100, compressedSize: 30,
    method: "snip", createdAt: 0,
  });
  expect(store.getMetricSummary().retrievedCount).toBe(0);

  store.incrementRetrieved(handle);
  store.incrementRetrieved(handle);
  expect(store.getMetricSummary().retrievedCount).toBe(2);
});

// ─── 边界 ──────────────────────────────────────────────────────────────────

test("空文本不崩", () => {
  const handle = store.saveOriginal("", {}, 0);
  expect(store.getOriginalText(handle)).toBe("");
});

test("未打开 store 抛错", () => {
  store.close();
  expect(() => store.getOriginal("x")).toThrow(/未打开/);
});
