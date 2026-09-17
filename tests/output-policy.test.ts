import { test } from "node:test";
import assert from "node:assert/strict";
import { planOutput } from "../src/core/tool-output";
import { formatStripCompress } from "../src/compress/format-strip";
import { structuredDigestCompress } from "../src/compress/structured-digest";
import { compress, roundTripEqual } from "../src/compress";
import { classify } from "../src/core/classifier";
import { rewriteToolResponse } from "../hooks/post-tool-compress";
import { store } from "../src/store/db";

const meta = { tool: "Bash", sessionId: "test-session", source: "/work" };
const passes = Array.from({ length: 500 }, (_, i) => `PASS src/feature-${i}.test.ts`).join("\n");
const diagnostic = 'FAIL src/broken.test.ts\n  expected: "a  b"\n  received: "a b"\n    at fail (broken.test.ts:12:3)\n    memory 173MB -> 1221MB';
const summary = "Test Suites: 1 failed, 500 passed, 501 total\nTests: 1 failed, 500 passed, 501 total";
const jest = `${passes}\n${diagnostic}\n${summary}\n`;

test("SGR stripping never edits whitespace, string contents or cursor commands", () => {
  const raw = '\x1b[31mconst x = "a  b";\x1b[0m\r\n\t  return x;  \r\n\x1b[2J';
  assert.equal(formatStripCompress(raw, { minChars: 0 }).text,
    'const x = "a  b";\r\n\t  return x;  \r\n\x1b[2J');
  assert.equal(formatStripCompress("abc\tdef", { minChars: 0 }).compressed, false);
});

test("complete diagnostic blocks and summary survive without signal-line cap", () => {
  const extra = Array.from({ length: 100 }, (_, i) => `    assertion detail ${i}`).join("\n");
  const raw = jest + extra;
  const result = structuredDigestCompress(raw);
  assert.equal(result.compressed, true);
  assert.ok(result.text.includes(diagnostic));
  assert.ok(result.text.includes(summary));
  assert.ok(result.text.includes(extra));
  assert.ok(result.text.includes("[original lines 501-"));
  assert.equal(roundTripEqual(raw), true);
  assert.equal(roundTripEqual(`\x1b[31m${raw}\x1b[0m`), true);
});

test("timestamped vehicle logs and repeated CPU snapshots produce useful views", () => {
  const log = Array.from({ length: 80 }, (_, i) =>
    i === 37
      ? `2026-08-18 19:43:${String(i).padStart(2, "0")} E system_server: low memory killer killed pid=${i}`
      : i === 62
        ? `2026-08-18 19:43:${String(i).padStart(2, "0")} W ActivityManager: reclaiming cached process`
        : `2026-08-18 19:43:${String(i).padStart(2, "0")} I system_server: sampled process count=${i}`
  ).join("\n");
  const logResult = structuredDigestCompress(log);
  assert.equal(logResult.compressed, true);
  assert.ok(logResult.text.includes("low memory killer"));
  assert.ok(logResult.text.includes("reclaiming cached process"));
  assert.ok(!logResult.text.includes("sampled process count=0"));

  const section = (time: string) => [
    `--- cpuinfo_${time} ---`,
    "Tasks: 620 total, 1 running, 619 sleeping, 0 stopped",
    "Mem: 11888M total, 11500M used, 388M free",
    "Swap: 8916M total, 100M used, 8816M free",
    "500%cpu 20%user 10%sys 470%idle",
    "PID USER PR NI VIRT RES SHR S[%CPU] %MEM TIME+ ARGS",
    "100 app 20 0 10G 900M 200M S 90.0 7.0 1:00.00 important.app",
    "101 app 20 0 10G 800M 200M S 50.0 6.0 1:00.00 second.app",
    "102 app 20 0 10G 700M 200M S 30.0 5.0 1:00.00 third.app",
    "103 app 20 0 10G 600M 200M S 20.0 4.0 1:00.00 fourth.app",
    "104 app 20 0 10G 500M 200M S 10.0 3.0 1:00.00 fifth.app",
    "105 app 20 0 10G 400M 200M S 5.0 2.0 1:00.00 sixth.app",
    "106 app 20 0 10G 300M 200M S 4.0 1.0 1:00.00 seventh.app",
    "107 app 20 0 10G 200M 200M S 3.0 0.8 1:00.00 eighth.app",
    "108 app 20 0 10G 100M 200M S 2.0 0.5 1:00.00 ninth.app",
  ].join("\n");
  const snapshot = [
    "=== CPU SNAPSHOT ANALYSIS ===",
    section("19_15_54"),
    section("19_20_57"),
    section("19_25_59"),
  ].join("\n");
  const snapshotResult = structuredDigestCompress(snapshot);
  assert.equal(snapshotResult.compressed, true);
  assert.ok(snapshotResult.text.includes("important.app"));
  assert.ok(!snapshotResult.text.includes("sixth.app"));
  assert.equal(roundTripEqual(snapshot), true);
  assert.equal(classify({ text: snapshot, tool: "Bash" }).type, "structured");
});

test("unknown large outputs pass through without generic sampling, with or without source", async () => {
  const samples = [
    Array.from({ length: 1000 }, (_, i) => `2026-09-15 12:00 INFO memory=${i}MB cpu=${i % 100}`).join("\n"),
    JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: i, value: "a  b" })), null, 2),
    '    const text = "a  b";\n'.repeat(1000),
    "The system is running. This is the explanation and it should remain complete.\n".repeat(1000),
    `${passes}\nERROR a general log is not a Jest report`,
  ];
  for (const text of samples) {
    assert.equal((await planOutput(text, meta)).candidate, null);
    assert.equal((await planOutput(text, { tool: "Bash" })).candidate, null);
    assert.equal((await planOutput(text, { ...meta, tool: "Read" })).candidate, null);
    assert.equal(compress(text).text, text);
  }
});

test("Jest candidate includes marker in savings, uses scoped stable handles", async () => {
  const a = (await planOutput(jest, meta)).candidate!;
  assert.ok(a);
  assert.ok(a.text.length <= jest.length * 0.9);
  assert.ok(a.text.includes(`tok_retrieve(handle="${a.handle}")`));
  assert.deepEqual((await planOutput(jest, meta)).candidate, a);
  assert.notEqual((await planOutput(jest, { ...meta, sessionId: "other" })).candidate!.handle, a.handle);
  assert.notEqual((await planOutput(jest, { ...meta, source: "/other" })).candidate!.handle, a.handle);
  assert.equal((await planOutput(jest, { ...meta, tool: "Read", source: "/work/result.log" })).candidate, null);
});

test("threshold and binary gates still prevent unsafe compression", async () => {
  const report = Array.from({ length: 140 }, (_, i) => `PASS src/f${i}.test.ts`).join("\n") + "\n" + summary;
  assert.ok(report.length < 4999);
  assert.equal((await planOutput(report.padEnd(4999), meta)).candidate, null);
  assert.ok((await planOutput(report.padEnd(5000), meta)).candidate?.method.includes("jest-pass"));
  const tinySaving = "\x1b[31m" + "value=123;\n".repeat(2000) + "\x1b[0m";
  assert.equal((await planOutput(tinySaving, meta)).candidate, null);
  assert.equal((await planOutput(jest + "\x00", meta)).candidate, null);
});

test("hook persists Bash and Read code outline before emission, preserves non-text fields, fails open", async () => {
  // Real Claude Code Bash tool_result (toolUseResult).
  const response = { stdout: jest, stderr: "", interrupted: false, isImage: false, noOutputExpected: false };
  const originals: string[] = [];
  let writes = 0;
  const persisted = async (original: string, metric: any) => {
    assert.ok(metric.compressedSize < original.length);
    originals.push(original);
    writes++;
    return {};
  };
  const result = await rewriteToolResponse(response, meta, persisted);
  assert.equal(writes, 1);
  assert.equal(result.changed, true);
  // non-text fields pass through untouched alongside the rewritten stdout.
  assert.equal((result.value as any).stderr, "");
  assert.equal((result.value as any).isImage, false);
  assert.equal((result.value as any).noOutputExpected, false);
  assert.equal(response.stdout, jest);
  const failed = await rewriteToolResponse(response, meta, () => { throw new Error("disk full"); });
  assert.equal(failed.value, response);
  assert.equal(failed.changed, false);
  assert.equal(failed.measurements[0].reason, "failed-open");
  const readText = Array.from({ length: 1000 }, (_, i) => `export const value${i} = ${i};`).join("\n");
  // Real Claude Code Read tool_result (toolUseResult).
  const readResponse = {
    type: "text",
    file: { filePath: "/work/src/large.ts", content: readText, numLines: 1000, startLine: 1, totalLines: 1000 },
  };
  const readResult = await rewriteToolResponse(readResponse, { ...meta, tool: "Read" }, persisted);
  assert.equal(readResult.changed, true);
  const readView = (readResult.value as any).file.content;
  assert.ok(readView.includes("code outline"));
  assert.ok(readView.includes(`tok_code_map(handle="`));
  assert.ok(readView.length < readText.length);
  // sibling file metadata and the original response object are never mutated.
  assert.equal((readResult.value as any).file.filePath, "/work/src/large.ts");
  assert.equal((readResult.value as any).file.numLines, 1000);
  assert.equal(readResponse.file.content, readText);
  const nestedRead = {
    type: "text",
    file: { filePath: "/work/data.txt", content: readText, numLines: 1000, startLine: 1, totalLines: 1000 },
    ok: true,
  };
  const nestedResult = await rewriteToolResponse(nestedRead, { ...meta, tool: "Read" }, persisted);
  assert.equal(nestedResult.changed, false);
  assert.equal(nestedResult.value, nestedRead);
  assert.equal(nestedRead.file.content, readText);
  assert.equal((await rewriteToolResponse("small", meta, persisted)).changed, false);
  assert.equal(writes, 2);
  assert.deepEqual(originals, [jest, readText]);
});

test("log windows merge and retain complete diagnostic continuation blocks", () => {
  const lines = Array.from({ length: 180 }, (_, i) => `2026-09-16 12:00:00 INFO tick=${i}`);
  lines[40] = "2026-09-16 12:00:00 ERROR failed request";
  lines[42] = "2026-09-16 12:00:00 WARN retry pending";
  const stack = ["Traceback (most recent call last):", ...Array.from({ length: 12 }, (_, i) => `  frame-${i}: request handler`), "RuntimeError: request rejected"];
  lines.splice(43, 0, ...stack);
  const raw = lines.join("\n");
  const view = structuredDigestCompress(raw);
  assert.ok(view.compressed);
  const expected = lines.slice(37, 46 + stack.length).join("\n");
  assert.ok(view.text.includes(expected));
  assert.equal((view.text.match(/tick=39/g) ?? []).length, 1);
  assert.equal((view.text.match(/\[original lines/g) ?? []).length, 1);
  assert.ok(!view.text.includes("tick=0\n"));
});

test("too many signals and dense diagnostics are never replaced by generic preview", async () => {
  for (const interval of [10, 2]) {
    const raw = Array.from({ length: 1000 }, (_, i) =>
      `2026-09-16 12:00:00 ${i % interval === 0 ? "ERROR" : "INFO"} request=${i}`
    ).join("\n");
    assert.equal(structuredDigestCompress(raw).compressed, false);
    assert.equal((await planOutput(raw, meta)).candidate, null);
  }
});

test("backup/index/metric commit atomically, collision and failed metrics roll back", async () => {
  store.open();
  try {
    const candidate = (await planOutput(jest, meta)).candidate!;
    const metric = {
      ...meta, handle: candidate.handle, contentType: "structured" as const,
      originalSize: jest.length, compressedSize: candidate.text.length,
      method: candidate.method, createdAt: 1,
    };
    const phases = store.saveOutput(jest, metric);
    assert.ok(phases.indexMs >= 0);
    assert.equal(store.getOriginalText(candidate.handle), jest);
    assert.ok(store.search(candidate.handle, "expected").length > 0);
    assert.equal(store.getLines(candidate.handle, 501, 5), diagnostic);
    store.incrementRetrieved(candidate.handle);
    store.saveOutput(jest, metric);
    assert.equal(store.getHandleRetrieveStats(candidate.handle)?.retrievedCount, 1);
    assert.throws(() => store.saveOriginalWithHandle(candidate.handle, "changed", {}, 2), /collision/);
    assert.equal(store.getOriginalText(candidate.handle), jest);
    assert.throws(() => store.saveOutput(jest, { ...metric, handle: "rollback", contentType: null as any }));
    assert.equal(store.getOriginalText("rollback"), undefined);
    assert.equal(store.search("rollback", "expected").length, 0);
    assert.equal(store.getMetricSummary().total, 2);
  } finally { store.close(); }
});
