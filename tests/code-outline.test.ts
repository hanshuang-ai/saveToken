import { test } from "node:test";
import assert from "node:assert/strict";
import { planOutput, MIN_CODE_LINES } from "../src/core/tool-output";
import { rewriteToolResponse } from "../hooks/post-tool-compress";
import { store } from "../src/store/db";

const sessionId = "test-session";
const codeMeta = { tool: "Read" as const, sessionId, source: "/work/src/station.ts" };

const bigTs = `import { audit } from "./audit";
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
` + "\nexport const filler = 1;".repeat(MIN_CODE_LINES + 40);

test("Read code file yields an outline placeholder pointing at tok_code_map", async () => {
  const a = (await planOutput(bigTs, codeMeta)).candidate!;
  assert.ok(a);
  assert.ok(a.text.includes(`tok_code_map(handle="${a.handle}")`));
  assert.ok(a.text.includes("code outline"));
  assert.ok(a.text.includes("fn loadStation"), "outline inlines function anchor");
  assert.ok(a.text.includes("tok_retrieve(handle="), "outline points at tok_retrieve ranges");
  assert.ok(a.text.length < bigTs.length);
  assert.equal(a.method, "code-outline");
  // Same input+provenance is stable; different source is not.
  assert.deepEqual((await planOutput(bigTs, codeMeta)).candidate, a);
  assert.notEqual((await planOutput(bigTs, { ...codeMeta, source: "/work/src/other.ts" })).candidate!.handle, a.handle);
  assert.notEqual((await planOutput(bigTs, { ...codeMeta, sessionId: "other" })).candidate!.handle, a.handle);
});

test("non-code, short, and no-extension Read inputs pass through", async () => {
  assert.equal((await planOutput(bigTs, { ...codeMeta, source: "/work/notes.md" })).candidate, null);
  assert.equal((await planOutput(bigTs, { ...codeMeta, source: "/work/data.json" })).candidate, null);
  assert.equal((await planOutput(bigTs, { ...codeMeta, source: undefined })).candidate, null);
  const small = "export const x = 1;\n";
  assert.equal((await planOutput(small, codeMeta)).candidate, null);
  // Below the line threshold even with a code extension.
  const underThreshold = "export const y = 2;\n".repeat(MIN_CODE_LINES - 5);
  assert.equal((await planOutput(underThreshold, codeMeta)).candidate, null);
});

test("Bash path is unaffected by the Read outline branch", async () => {
  // Bash never hits planCodeOutline even with a .ts source.
  const bashResult = await planOutput(bigTs, { tool: "Bash", sessionId, source: "/work/src/station.ts" });
  assert.equal(bashResult.candidate, null);
});

test("hook stores Read code original and rewrites file.content, preserves file metadata", async () => {
  const persisted: { original: string; handle: string; source?: string }[] = [];
  const persist = async (original: string, metric: any) => {
    persisted.push({ original, handle: metric.handle, source: metric.source });
    return {};
  };
  // Real Claude Code Read tool_result (the toolUseResult the hook receives).
  const numLines = bigTs.split("\n").length;
  const response = {
    type: "text",
    file: { filePath: "/work/src/station.ts", content: bigTs, numLines, startLine: 1, totalLines: numLines },
  };
  const result = await rewriteToolResponse(response, codeMeta, persist);
  assert.equal(result.changed, true);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].original, bigTs);
  assert.equal(persisted[0].source, "/work/src/station.ts");
  // placeholder lands in file.content (the field the hook extracted); sibling
  // file metadata and the top-level type are untouched.
  assert.ok((result.value as any).file.content.includes("code outline"));
  assert.equal((result.value as any).file.filePath, "/work/src/station.ts");
  assert.equal((result.value as any).file.numLines, numLines);
  assert.equal((result.value as any).type, "text");
});

test("stored Read original is retrievable by handle for MCP code indexing", async () => {
  const candidate = (await planOutput(bigTs, codeMeta)).candidate!;
  store.open();
  try {
    const metric = {
      ...codeMeta, handle: candidate.handle, contentType: "structured" as const,
      originalSize: bigTs.length, compressedSize: candidate.text.length,
      method: candidate.method, createdAt: 1,
    };
    store.saveOutput(bigTs, metric);
    assert.equal(store.getOriginalText(candidate.handle), bigTs);
    // source path recorded so MCP langForHandle can dispatch by extension
    assert.equal(store.getOriginal(candidate.handle)?.source, "/work/src/station.ts");
  } finally {
    store.close();
  }
});
