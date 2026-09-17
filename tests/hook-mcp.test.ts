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
    assert.equal(run("Read", { type: "text", file: { filePath: "src/small.ts", content: "const x = 'a  b';\n".repeat(10), numLines: 10, startLine: 1, totalLines: 10 } }), "");
    assert.equal(run("Bash", { stdout: "INFO memory=173MB\n".repeat(10), stderr: "", interrupted: false, isImage: false, noOutputExpected: false }), "");
    assert.equal(existsSync(join(data, "frugal.db")), false);
    const readRaw = Array.from({ length: 1000 }, (_, i) => `export const value${i} = ${i};`).join("\n");
    const readResponseText = run("Read", {
      type: "text",
      file: { filePath: "src/large.ts", content: readRaw, numLines: 1000, startLine: 1, totalLines: 1000 },
    });
    const readParsed = JSON.parse(readResponseText);
    const readView = readParsed.hookSpecificOutput.updatedToolOutput.file.content;
    const readHandle = /handle="([^"]+)"/.exec(readView)![1];
    assert.ok(readView.includes("code outline"));
    assert.ok(readView.includes("tok_code_map"));
    assert.ok(readView.length < readRaw.length);
    // sibling file metadata is never rewritten; only file.content carries the placeholder.
    assert.equal(readParsed.hookSpecificOutput.updatedToolOutput.file.filePath, "src/large.ts");
    assert.equal(readParsed.hookSpecificOutput.updatedToolOutput.file.numLines, 1000);
    assert.ok(existsSync(join(data, "frugal.db")));

    const raw = Array.from({ length: 500 }, (_, i) => `PASS src/feature-${i}.test.ts`).join("\n") +
      '\nFAIL src/broken.test.ts\n  expected: "a  b"\n    at fail (test.ts:1:1)\nTest Suites: 1 failed, 500 passed, 501 total\nTests: 1 failed, 500 passed, 501 total';
    const response = JSON.parse(run("Bash", { stdout: raw, stderr: "", interrupted: false, isImage: false, noOutputExpected: false }));
    const view = response.hookSpecificOutput.updatedToolOutput.stdout;
    const handle = /handle="([^"]+)"/.exec(view)![1];
    assert.ok(view.includes('expected: "a  b"'));
    // non-text fields pass through untouched alongside the rewritten stdout.
    assert.equal(response.hookSpecificOutput.updatedToolOutput.isImage, false);
    assert.equal(response.hookSpecificOutput.updatedToolOutput.stderr, "");
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
    const longLine = "a".repeat(11999) + "😀" + "b".repeat(13000) + "最后";
    store.saveOriginalWithHandle("long-line", longLine, {}, 1);
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
    assert.ok(tools.tools.some((t) => t.name === "tok_code_map"));
    const retrieved = await client.callTool({ name: "tok_retrieve", arguments: { handle } });
    assert.ok(JSON.stringify(retrieved).includes("PASS src/feature-0.test.ts"));
    const lines = await client.callTool({ name: "tok_retrieve", arguments: { handle, startLine: 501, count: 3 } });
    assert.ok(JSON.stringify(lines).includes("FAIL src/broken.test.ts"));
    const search = await client.callTool({ name: "tok_retrieve", arguments: { handle, query: "expected" } });
    assert.ok(JSON.stringify(search).includes("expected"));
    const old = await client.callTool({ name: "tok_retrieve", arguments: { handle: "old-record" } });
    assert.ok(JSON.stringify(old).includes("old original"));

    // Exercise the public MCP cursor, not just the pure page helper.
    let restored = "";
    let offsetChars = 0;
    for (let page = 0; page < 10; page++) {
      const result = await client.callTool({ name: "tok_retrieve", arguments: {
        handle: "long-line", startLine: 1, count: 1, offsetChars,
      } });
      assert.ok(!result.isError);
      const text = (result.content as { type: string; text: string }[])[0].text;
      const body = text.slice(text.indexOf("\n\n") + 2);
      assert.ok(body.length <= 12000);
      restored += body;
      const cursor = /"offsetChars":(\d+)/.exec(text.split("\n\n")[0]);
      if (!cursor) break;
      assert.ok(Number(cursor[1]) > offsetChars);
      offsetChars = Number(cursor[1]);
    }
    assert.equal(restored, longLine);

    // Codegraph runs against the original the Read hook persisted under its
    // derived handle; the long-running MCP process runs ts-morph / Vue compiler.
    const tsRaw = `import { audit } from "./audit";
export function loadStation(id: string) {
  return audit(id);
}
export const saveStation = (id: string) => {
  return loadStation(id);
};
class StationService {
  refresh(id: string) {
    return this.reload(id);
  }
  reload(id: string) {
    return saveStation(id);
  }
}
` + "\nexport const filler = 1;".repeat(600);
    const tsResponse = JSON.parse(run("Read", { type: "text", file: { filePath: "src/station.ts", content: tsRaw, numLines: tsRaw.split("\n").length, startLine: 1, totalLines: tsRaw.split("\n").length } }));
    const tsView = tsResponse.hookSpecificOutput.updatedToolOutput.file.content;
    const tsHandle = /handle="([^"]+)"/.exec(tsView)![1];
    assert.ok(tsView.includes("code outline"));
    const tsMap = await client.callTool({ name: "tok_code_map", arguments: { handle: tsHandle } });
    const tsMapText = JSON.stringify(tsMap);
    assert.ok(tsMapText.includes("loadStation"));
    assert.ok(tsMapText.includes("saveStation"));
    assert.ok(tsMapText.includes("StationService"));
    assert.ok(tsMapText.includes("refresh"));
    assert.ok(tsMapText.includes("reload"));
    const tsSymbol = await client.callTool({ name: "tok_code_symbol", arguments: { handle: tsHandle, symbol: "saveStation" } });
    assert.ok(JSON.stringify(tsSymbol).includes("loadStation"));
    assert.ok(JSON.stringify(tsSymbol).includes("实现未内联"));
    assert.ok(!JSON.stringify(tsSymbol).includes("return loadStation(id);"));
    const tsSymbolBody = await client.callTool({ name: "tok_code_symbol", arguments: { handle: tsHandle, symbol: "saveStation", includeBody: true } });
    assert.ok(JSON.stringify(tsSymbolBody).includes("return loadStation(id);"));

    const vueRaw = `<template>
  <FuelCard :station="station" :price="price" @select="selectFuel" />
  <PartnerPanel v-model:visible="partnerVisible" @confirm="confirmPartner" />
</template>
<script lang="ts">
import FuelCard from "./FuelCard.vue";
import PartnerPanel from "./PartnerPanel.vue";
const station = "demo";
const price = 7.42;
let partnerVisible = false;
function fromOptionsScript() {
  return "classic";
}
</script>
<script setup lang="ts">
function selectFuel(id: string) {
  return confirmPartner(id);
}
function confirmPartner(id: string) {
  partnerVisible = true;
  return id;
}
</script>
<style scoped>
.page { color: #333; }
</style>
` + "\n<!-- filler -->".repeat(900);
    const vueResponse = JSON.parse(run("Read", { type: "text", file: { filePath: "src/pages/detail/detail.vue", content: vueRaw, numLines: vueRaw.split("\n").length, startLine: 1, totalLines: vueRaw.split("\n").length } }));
    const vueView = vueResponse.hookSpecificOutput.updatedToolOutput.file.content;
    const vueHandle = /handle="([^"]+)"/.exec(vueView)![1];
    assert.ok(vueView.includes("code outline"));
    const codeMap = await client.callTool({ name: "tok_code_map", arguments: { handle: vueHandle } });
    const codeMapText = JSON.stringify(codeMap);
    assert.ok(codeMapText.includes("Vue SFC"));
    assert.ok(codeMapText.includes("FuelCard"));
    assert.ok(codeMapText.includes("PartnerPanel"));
    assert.ok(codeMapText.includes("select"));
    assert.ok(codeMapText.includes("confirm"));
    assert.ok(codeMapText.includes("visible"));
    assert.ok(codeMapText.includes("selectFuel"));
    assert.ok(codeMapText.includes("fromOptionsScript"));
    const symbol = await client.callTool({ name: "tok_code_symbol", arguments: { handle: vueHandle, symbol: "selectFuel" } });
    assert.ok(JSON.stringify(symbol).includes("confirmPartner"));
  } finally {
    store.close();
    await client?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
