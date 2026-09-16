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

test("general large outputs get a recoverable preview while low-level compress stays conservative", () => {
  const samples = [
    Array.from({ length: 1000 }, (_, i) => `2026-09-15 12:00 INFO memory=${i}MB cpu=${i % 100}`).join("\n"),
    JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: i, value: "a  b" })), null, 2),
    '    const text = "a  b";\n'.repeat(1000),
    "The system is running. This is the explanation and it should remain complete.\n".repeat(1000),
    `${passes}\nERROR a general log is not a Jest report`,
  ];
  for (const text of samples) {
    const candidate = planOutput(text, meta).candidate;
    assert.ok(candidate);
    assert.ok(candidate.text.includes(`tok_retrieve(handle="${candidate.handle}")`));
    assert.ok(candidate.text.length < text.length);
    assert.equal(compress(text).text, text);
  }
});

test("Jest candidate includes marker in savings, uses scoped stable handles", () => {
  const a = planOutput(jest, meta).candidate!;
  assert.ok(a);
  assert.ok(a.text.length <= jest.length * 0.9);
  assert.ok(a.text.includes(`tok_retrieve(handle="${a.handle}")`));
  assert.deepEqual(planOutput(jest, meta).candidate, a);
  assert.notEqual(planOutput(jest, { ...meta, sessionId: "other" }).candidate!.handle, a.handle);
  assert.notEqual(planOutput(jest, { ...meta, source: "/other" }).candidate!.handle, a.handle);
  assert.ok(planOutput(jest, { ...meta, tool: "Read", source: "/work/result.log" }).candidate);
});

test("threshold and binary gates still prevent unsafe compression", () => {
  assert.equal(planOutput("x".repeat(9999), meta).candidate, null);
  const tinySaving = "\x1b[31m" + "value=123;\n".repeat(2000) + "\x1b[0m";
  assert.ok(planOutput(tinySaving, meta).candidate?.method.includes("generic-preview"));
  assert.equal(planOutput(jest + "\x00", meta).candidate, null);
});

test("hook persists before emission, handles Bash and Read text, ignores metadata, fails open", async () => {
  const response = { stdout: jest, stderr: "", image: jest, metadata: { text: jest }, exitCode: 1 };
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
  assert.equal((result.value as any).image, jest);
  assert.equal((result.value as any).exitCode, 1);
  assert.equal(response.stdout, jest);
  const failed = await rewriteToolResponse(response, meta, () => { throw new Error("disk full"); });
  assert.equal(failed.value, response);
  assert.equal(failed.changed, false);
  assert.equal(failed.measurements[0].reason, "failed-open");
  const readText = Array.from({ length: 1000 }, (_, i) => `export const value${i} = ${i};`).join("\n");
  const readResponse = { filePath: "/work/src/large.ts", content: readText, metadata: { content: readText } };
  const readResult = await rewriteToolResponse(readResponse, { ...meta, tool: "Read" }, persisted);
  assert.equal(readResult.changed, true);
  assert.ok((readResult.value as any).content.includes("generic preview"));
  assert.equal((readResult.value as any).metadata.content, readText);
  assert.equal(readResponse.content, readText);
  const nestedRead = { file: { filePath: "/work/data.txt", content: readText }, ok: true };
  const nestedResult = await rewriteToolResponse(nestedRead, { ...meta, tool: "Read" }, persisted);
  assert.equal(nestedResult.changed, true);
  assert.ok((nestedResult.value as any).file.content.includes("generic preview"));
  assert.equal(nestedRead.file.content, readText);
  assert.equal((await rewriteToolResponse("small", meta, persisted)).changed, false);
  assert.equal(writes, 3);
  assert.deepEqual(originals, [jest, readText, readText]);
});

test("backup/index/metric commit atomically, collision and failed metrics roll back", () => {
  store.open();
  try {
    const candidate = planOutput(jest, meta).candidate!;
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
