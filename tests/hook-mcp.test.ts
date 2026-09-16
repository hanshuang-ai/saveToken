import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { store } from "../src/store/db";

test("real hook stdin and MCP retrieval use isolated storage and leave pass-through untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "frugal-local-test-"));
  const data = join(root, "data");
  const timing = join(root, "timings.jsonl");
  const env = { ...process.env, FRUGAL_DATA_DIR: data, FRUGAL_TIMING_LOG: timing };
  const run = (tool: string, response: unknown) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", resolve("hooks/post-tool-compress.ts")], {
      env, input: JSON.stringify({ tool_name: tool, tool_response: response, session_id: "isolated" }),
      encoding: "utf8", timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  let client: Client | undefined;
  try {
    assert.equal(run("Read", { content: "const x = 'a  b';\n".repeat(10) }), "");
    assert.equal(run("Bash", { stdout: "INFO memory=173MB\n".repeat(10), image: "x".repeat(20000) }), "");
    assert.equal(existsSync(join(data, "frugal.db")), false);
    const readRaw = Array.from({ length: 1000 }, (_, i) => `export const value${i} = ${i};`).join("\n");
    const readResponse = JSON.parse(run("Read", {
      filePath: "src/large.ts",
      content: readRaw,
      metadata: { content: readRaw },
    }));
    const readView = readResponse.hookSpecificOutput.updatedToolOutput.content;
    const readHandle = /handle="([^"]+)"/.exec(readView)![1];
    assert.ok(readView.includes("generic preview"));
    assert.ok(readView.length < readRaw.length);
    assert.equal(readResponse.hookSpecificOutput.updatedToolOutput.metadata.content, readRaw);

    const raw = Array.from({ length: 500 }, (_, i) => `PASS src/feature-${i}.test.ts`).join("\n") +
      '\nFAIL src/broken.test.ts\n  expected: "a  b"\n    at fail (test.ts:1:1)\nTest Suites: 1 failed, 500 passed, 501 total\nTests: 1 failed, 500 passed, 501 total';
    const response = JSON.parse(run("Bash", { stdout: raw, stderr: "", code: 1 }));
    const view = response.hookSpecificOutput.updatedToolOutput.stdout;
    const handle = /handle="([^"]+)"/.exec(view)![1];
    assert.ok(view.includes('expected: "a  b"'));
    assert.equal(response.hookSpecificOutput.updatedToolOutput.code, 1);
    const telemetry = readFileSync(timing, "utf8");
    assert.ok(!telemetry.includes("expected:"));
    const records = telemetry.trim().split("\n").map((s) => JSON.parse(s));
    assert.ok(records.some((r) => r.fields.some((f: any) => f.reason === "adopted" && f.indexMs >= 0)));

    // Reopen must not delete old originals or metrics (regression: 24h auto TTL).
    store.open(join(data, "frugal.db"));
    assert.equal(store.getOriginalText(handle), raw);
    assert.equal(store.getOriginalText(readHandle), readRaw);
    assert.equal(store.getRecentMetrics()[0].compressedSize, view.length);
    store.saveOriginalWithHandle("old-record", "old original", {}, 1);
    store.close();

    client = new Client({ name: "frugal-local-test", version: "1" });
    const transportEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) if (value !== undefined) transportEnv[key] = value;
    delete transportEnv.FRUGAL_MCP_TEST;
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", resolve("src/mcp/server.ts")], env: transportEnv,
    }));
    const tools = await client.listTools();
    assert.ok(!tools.tools.some((t) => t.name === "tok_compact"));
    assert.ok(tools.tools.some((t) => t.name === "tok_stats"));
    const retrieved = await client.callTool({ name: "tok_retrieve", arguments: { handle } });
    assert.ok(JSON.stringify(retrieved).includes("PASS src/feature-0.test.ts"));
    const readRetrieved = await client.callTool({ name: "tok_retrieve", arguments: { handle: readHandle, query: "value777" } });
    assert.ok(JSON.stringify(readRetrieved).includes("value777"));
    const lines = await client.callTool({ name: "tok_retrieve", arguments: { handle, startLine: 501, count: 3 } });
    assert.ok(JSON.stringify(lines).includes("FAIL src/broken.test.ts"));
    const search = await client.callTool({ name: "tok_retrieve", arguments: { handle, query: "expected" } });
    assert.ok(JSON.stringify(search).includes("expected"));
    const old = await client.callTool({ name: "tok_retrieve", arguments: { handle: "old-record" } });
    assert.ok(JSON.stringify(old).includes("old original"));
  } finally {
    store.close();
    await client?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
