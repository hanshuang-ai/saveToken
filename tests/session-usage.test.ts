import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { compareUsage, loadScenarioArm, parseSessionUsage, type SessionFiles } from "./analyze-sessions.ts";

const usage = (input = 10, read = 20, creation = 30, output = 4) => ({
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: creation,
  output_tokens: output,
});
const assistant = (id: string, tokens: unknown = usage(), extra: Record<string, unknown> = {}) => ({
  type: "assistant", sessionId: "session-a",
  message: { id, role: "assistant", usage: tokens, stop_reason: "end_turn" },
  ...extra,
});
const jsonl = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
const parse = (content: string, sessionId = "session-a") => parseSessionUsage([{ sessionId, content }]);

test("deduplicates streamed blocks using final usage, not sums or maxima", () => {
  const result = parse(jsonl(
    assistant("m1", usage(99, 99, 99, 1)),
    assistant("m1", usage(2, 3, 4, 5)),
    assistant("m2", usage(7, 8, 9, 10)),
  ));
  assert.deepEqual(result.tokens, {
    uncachedInputTokens: 9, cacheReadTokens: 11, cacheCreationTokens: 13, outputTokens: 15,
  });
  assert.equal(result.uniqueMessages, 2);
  assert.equal(result.complete, true);
});

test("only typed assistant message usage counts; cache TTL breakdown is not additive", () => {
  const result = parse(jsonl(
    { type: "user", usage: usage(100), message: { usage: usage(100) } },
    { type: "system", usage: usage(100) },
    { type: "result", usage: usage(100) },
    { type: "progress", data: { message: assistant("nested") }, usage: usage(100) },
    assistant("m1", { ...usage(), cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } },
      { usage: usage(100) }),
  ));
  assert.equal(result.uniqueMessages, 1);
  assert.deepEqual(result.tokens, {
    uncachedInputTokens: 10, cacheReadTokens: 20, cacheCreationTokens: 30, outputTokens: 4,
  });
  assert.equal(result.complete, true);
});

test("message IDs are scoped to sessions, but parent/subagent copies share identity", () => {
  const result = parseSessionUsage([
    { sessionId: "session-a", content: jsonl(assistant("shared")) },
    { sessionId: "session-a", label: "subagent", content: jsonl(assistant("shared"), assistant("child")) },
    { sessionId: "session-b", content: jsonl(assistant("shared", usage(), { sessionId: "session-b" })) },
  ]);
  assert.equal(result.uniqueMessages, 3);
  assert.equal(result.tokens.uncachedInputTokens, 30);
  assert.equal(result.complete, true);
});

test("older cross-file copies cannot replace newer final usage", () => {
  const result = parseSessionUsage([
    { sessionId: "session-a", content: jsonl(assistant("m", usage(2), { timestamp: "2026-09-14T12:01:00Z" })) },
    { sessionId: "session-a", content: jsonl(assistant("m", usage(9), { timestamp: "2026-09-14T12:00:00Z" })) },
  ]);
  assert.equal(result.tokens.uncachedInputTokens, 2);
});

test("line order determines final usage within a file even if the clock moves backward", () => {
  const result = parse(jsonl(
    assistant("m", usage(99), { timestamp: "2026-09-14T12:01:00Z" }),
    assistant("m", usage(2), { timestamp: "2026-09-14T12:00:00Z" }),
  ));
  assert.equal(result.tokens.uncachedInputTokens, 2);
  assert.equal(result.complete, true);
});

test("missing/invalid counters are unknown, including absent top-level cache creation", () => {
  for (const tokens of [
    undefined, null, {},
    { ...usage(), input_tokens: -1 },
    { ...usage(), output_tokens: "4" },
    { ...usage(), output_tokens: 1.5 },
    { ...usage(), output_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3,
      cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 6 } },
  ]) {
    const row = assistant("m");
    row.message.usage = tokens;
    const result = parse(jsonl(row));
    assert.equal(result.complete, false);
    assert.equal(result.unknownUsageMessages, 1);
    assert.ok(Object.values(result.tokens).includes(null));
  }
});

test("a final snapshot with absent usage does not silently retain an earlier estimate", () => {
  const result = parse(jsonl(assistant("m"), {
    type: "assistant", sessionId: "session-a", message: { id: "m", stop_reason: "end_turn" },
  }));
  assert.equal(result.uniqueMessages, 1);
  assert.equal(result.tokens.outputTokens, null);
  assert.equal(result.complete, false);
});

test("zero counters are known, but a zero baseline has no percentage", () => {
  const control = parse(jsonl(assistant("m", usage(0, 0, 0, 0))));
  const experiment = parse(jsonl(assistant("m", usage(0, 0, 0, 0), { sessionId: "session-b" })), "session-b");
  assert.equal(control.complete, true);
  assert.deepEqual(compareUsage(control, experiment), {
    available: true, inputSaved: 0, totalSaved: 0, inputPct: null, totalPct: null,
  });
});

test("malformed, empty, untyped, unidentified, mismatched and unfinished records block savings", () => {
  for (const content of [
    "", jsonl({ type: "user" }), "{\"type\":\"assistant\"", jsonl(assistant("m")) + "{",
    jsonl({ usage: usage() }), jsonl(assistant("")),
    jsonl(assistant("m", usage(), { sessionId: "wrong-session" })),
    jsonl({ type: "assistant", message: { id: "m", role: "user", usage: usage() } }),
    jsonl({ type: "assistant", message: { id: "m", usage: usage(), stop_reason: null } }),
    jsonl({ type: "assistant", message: { id: "m", usage: usage(), stop_reason: "tool_use" } }),
  ]) {
    const result = parse(content);
    assert.equal(result.complete, false, content);
    assert.ok(result.issues.length > 0);
    assert.equal(compareUsage(result, parse(jsonl(assistant("other")))).totalSaved, null);
  }
  assert.equal(parse("").tokens.uncachedInputTokens, null);
});

test("CRLF and blank lines work, and explicit source identity covers records without sessionId", () => {
  const result = parse("\r\n" + JSON.stringify({
    type: "assistant", message: { id: "m", usage: usage(), stop_reason: "end_turn" },
  }) + "\r\n\r\n");
  assert.equal(result.complete, true);
});

test("a resumed user turn or tool result after a completed turn makes the session incomplete", () => {
  for (const content of ["next question", [{ type: "tool_result", tool_use_id: "t1", content: "result" }]]) {
    const result = parse(jsonl(assistant("m"), {
      type: "user", sessionId: "session-a", message: { role: "user", content },
    }));
    assert.equal(result.complete, false);
    assert.match(result.issues.join("\n"), /no terminal assistant turn/);
  }
});

test("safe integer overflow blocks comparison rather than reporting rounded savings", () => {
  const result = parse(jsonl(assistant("m", usage(Number.MAX_SAFE_INTEGER)), assistant("n", usage(1))));
  assert.equal(result.tokens.uncachedInputTokens, null);
  assert.equal(result.complete, false);
  const crossCategory = parse(jsonl(assistant("m", usage(Number.MAX_SAFE_INTEGER))));
  const experiment = parse(jsonl(assistant("n", usage(), { sessionId: "session-b" })), "session-b");
  assert.equal(compareUsage(crossCategory, experiment).available, false);
});

test("resume records read once; only session-local subagents load and parent copies deduplicate", () => {
  const base = resolve("tests");
  const parent = join(base, "session-a.jsonl");
  const child = join(base, "session-a", "subagents", "agent-child.jsonl");
  const contents = new Map([
    [parent, jsonl(assistant("parent"), assistant("child"))],
    [child, jsonl(assistant("child"), assistant("child-2"))],
  ]);
  const reads: string[] = [];
  const directories: string[] = [];
  const files: SessionFiles = {
    read(path) { reads.push(path); return contents.get(path)!; },
    subagentFiles(directory) { directories.push(directory); return [child]; },
  };
  const record = { sessionId: "session-a", jsonlPath: "session-a.jsonl" };
  const result = loadScenarioArm([{ ...record, round: 1 }, { ...record, round: 2 }], base, files);
  assert.deepEqual(reads, [parent, child]);
  assert.deepEqual(directories, [join(base, "session-a", "subagents")]);
  assert.equal(result.uniqueMessages, 3);
  assert.equal(result.tokens.uncachedInputTokens, 30);
  assert.equal(result.complete, true);
});

test("missing arms/files/subagent reads and directory errors never become zero savings", () => {
  const record = { sessionId: "session-a", jsonlPath: "session-a.jsonl" };
  const healthy = parse(jsonl(assistant("m", usage(), { sessionId: "session-b" })), "session-b");
  const missing: SessionFiles = {
    read() { throw new Error("ENOENT"); }, subagentFiles() { return []; },
  };
  const results = [
    loadScenarioArm([], resolve("tests"), missing),
    loadScenarioArm(undefined, resolve("tests"), missing),
    loadScenarioArm([{ ...record, jsonlPath: "" }], resolve("tests"), missing),
    loadScenarioArm([record], resolve("tests"), missing),
    loadScenarioArm([record], resolve("tests"), {
      read: () => jsonl(assistant("m")), subagentFiles() { throw new Error("EACCES"); },
    }),
    loadScenarioArm([record], resolve("tests"), {
      read(path) { if (path.includes("subagents")) throw new Error("ENOENT"); return jsonl(assistant("m")); },
      subagentFiles: (directory) => [join(directory, "agent.jsonl")],
    }),
    loadScenarioArm([record, { sessionId: "missing", jsonlPath: "missing.jsonl" }], resolve("tests"), {
      read(path) { if (path.endsWith("missing.jsonl")) throw new Error("ENOENT"); return jsonl(assistant("m")); },
      subagentFiles: () => [],
    }),
  ];
  for (const result of results) {
    assert.equal(result.complete, false);
    assert.equal(compareUsage(healthy, result).totalSaved, null);
    assert.equal(compareUsage(result, healthy).inputPct, null);
  }
});

test("conflicting identities on one path and overlapping scenario arms prohibit comparisons", () => {
  const result = loadScenarioArm([
    { sessionId: "session-a", jsonlPath: "session-a.jsonl" },
    { sessionId: "session-b", jsonlPath: "session-a.jsonl" },
  ], resolve("tests"), { read: () => jsonl(assistant("m")), subagentFiles: () => [] });
  assert.equal(result.complete, false);
  assert.match(result.issues.join("\n"), /conflicting session identities/);
  const complete = parse(jsonl(assistant("m")));
  assert.equal(compareUsage(complete, complete).available, false);
});

test("savings include uncached input, cache reads, cache creation and output", () => {
  const control = parse(jsonl(assistant("m", usage(100, 200, 300, 40))));
  const experiment = parse(jsonl(assistant("m", usage(10, 20, 30, 4), { sessionId: "session-b" })), "session-b");
  assert.deepEqual(compareUsage(control, experiment), {
    available: true, inputSaved: 540, totalSaved: 576, inputPct: 90, totalPct: 90,
  });
  const increasedCache = parse(jsonl(assistant("m", usage(1, 900, 300, 40), { sessionId: "session-b" })), "session-b");
  assert.equal(compareUsage(control, increasedCache).totalSaved, -601);
});

test("import is side-effect free and guarded CLI reports an explicit missing manifest", () => {
  const analyzer = new URL("./analyze-sessions.ts", import.meta.url);
  const cwd = dirname(fileURLToPath(import.meta.url));
  const imported = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `await import(${JSON.stringify(analyzer.href)}); console.log('import-only');`], { cwd, encoding: "utf8" });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout.trim(), "import-only");
  assert.equal(imported.stderr, "");
  // An existing source file cannot be the parent directory of a manifest. No fixture writes needed.
  const cli = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(analyzer),
    join(fileURLToPath(import.meta.url), "missing-manifest.json")], { cwd, encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /Analysis unavailable:/);
  assert.equal(cli.stdout, "");
});
