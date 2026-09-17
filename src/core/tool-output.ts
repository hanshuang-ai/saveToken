import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { classify } from "./classifier";
import { formatStripCompress } from "../compress/format-strip";
import { structuredDigestCompress } from "../compress/structured-digest";
import { CODE_LANGS } from "../codegraph/languages";
import { trace } from "./logger";

export const MIN_CHARS = 5000;
export const MIN_SAVED_CHARS = 512;
export const MIN_SAVED_RATIO = 0.1;
/** Read code files below this line count pass through unchanged. */
export const MIN_CODE_LINES = 60;
const SUPPORTED_TOOLS = new Set(["Bash", "Read"]);

export interface OutputMeta {
  tool: string;
  source?: string;
  sessionId?: string;
  field?: string;
}

/** Pure candidate generation: no storage, no handles emitted on pass-through. */
export async function planOutput(input: string, meta: OutputMeta) {
  const started = performance.now();
  const timings = { classifyMs: 0, strategyMs: 0 };
  const tag = `planOutput[${meta.tool}${meta.field ? ":" + meta.field : ""}]`;
  trace(tag, `input ${input.length} chars`, { source: meta.source?.slice(0, 80) });
  if (input.includes("\x00")) {
    trace(tag, `→ ineligible (null bytes)`);
    return { candidate: null, timings, reason: "ineligible" };
  }
  if (meta.tool === "Read") {
    trace(tag, `→ Read path (planCodeOutline)`);
    return await planCodeOutline(input, meta, started, timings);
  }
  if (!SUPPORTED_TOOLS.has(meta.tool) || input.length < MIN_CHARS) {
    trace(tag, `→ ineligible (tool=${meta.tool}, len=${input.length} < ${MIN_CHARS})`);
    return { candidate: null, timings, reason: "ineligible" };
  }
  const classification = classify({
    text: input,
    tool: meta.tool,
  });
  timings.classifyMs = performance.now() - started;
  trace(tag, `classified`, { type: classification.type });
  if (classification.type === "empty") {
    trace(tag, `→ empty`);
    return { candidate: null, timings, reason: "empty" };
  }

  const handle = deriveHandle(meta, input);

  const strategyStart = performance.now();
  const stripped = formatStripCompress(input);
  trace(tag, `formatStrip`, { compressed: stripped.compressed, method: stripped.method, outLen: stripped.text.length });
  const digest = classification.type === "structured"
    ? structuredDigestCompress(stripped.text)
    : { text: stripped.text, compressed: false, method: "structured-digest:skipped" };
  trace(tag, `structuredDigest`, { compressed: digest.compressed, method: digest.method, outLen: digest.text.length });
  timings.strategyMs = performance.now() - strategyStart;
  if (!stripped.compressed && !digest.compressed) {
    trace(tag, `→ no-policy (neither stripper nor digest compressed)`);
    return { candidate: null, timings, reason: "no-policy" };
  }

  const text = digest.compressed
    ? `${digest.text}\n[frugal: original via tok_retrieve(handle="${handle}")]`
    : `${stripped.text}\n[frugal: original via tok_retrieve(handle="${handle}")]`;
  const saved = input.length - text.length;
  trace(tag, `net savings`, { saved, ratio: saved / input.length, threshold_chars: MIN_SAVED_CHARS, threshold_ratio: MIN_SAVED_RATIO });
  if (saved < MIN_SAVED_CHARS || saved / input.length < MIN_SAVED_RATIO) {
    trace(tag, `→ insufficient-net-savings`);
    return { candidate: null, timings, reason: "insufficient-net-savings" };
  }
  const methods = [stripped, digest]
    .flatMap((r) => r?.compressed ? [r.method] : []);
  trace(tag, `→ CANDIDATE`, { handle, method: methods.join(","), outLen: text.length });
  return {
    candidate: {
      handle, text, contentType: classification.type,
      method: methods.join(","),
    },
    timings, reason: "candidate",
  };
}

/**
 * Read code block: hard-intercept large code files. The original is persisted
 * under a handle; the model sees only a block message directing it to
 * tok_code_map / tok_code_symbol / tok_code_refs / tok_retrieve. Non-code and
 * small files fall through unchanged.
 */
async function planCodeOutline(
  input: string,
  meta: OutputMeta,
  started: number,
  timings: { classifyMs: number; strategyMs: number }
) {
  const tag = `planCodeBlock[${meta.source?.slice(0, 60) ?? "?"}]`;
  const ext = meta.source ? extOf(meta.source) : "";
  if (!ext || !CODE_LANGS.has(ext)) {
    trace(tag, `→ non-code (ext=${ext || "(none)"})`);
    return { candidate: null, timings, reason: "non-code" };
  }
  const lineCount = input.split("\n").length;
  if (lineCount < MIN_CODE_LINES) {
    trace(tag, `→ too-few-lines (${lineCount} < ${MIN_CODE_LINES}), passthrough`);
    return { candidate: null, timings, reason: "too-few-lines" };
  }
  timings.classifyMs = performance.now() - started;
  const handle = deriveHandle(meta, input);
  const text =
    `[frugal: 代码文件已拦截 (${lineCount} 行, ${input.length} 字符)。原文已存储,禁止再次 Read 此文件。\n\n` +
    `必须使用以下 MCP 工具之一:\n` +
    `  tok_code_map(handle="${handle}") → 文件结构图(符号/调用/Vue SFC 分区)\n` +
    `  tok_code_symbol(handle="${handle}", symbol="函数名") → 查符号定义\n` +
    `  tok_code_refs(handle="${handle}", symbol="函数名", direction="callees") → 查调用关系\n` +
    `  tok_retrieve(handle="${handle}", startLine=N, count=M) → 按行取精确源码(Edit 时用这个)]`;
  trace(tag, `→ BLOCKED`, { handle, lineCount, origChars: input.length, blockChars: text.length });
  return {
    candidate: {
      handle, text, contentType: "structured" as const,
      method: "code-block",
    },
    timings, reason: "candidate",
  };
}

function deriveHandle(meta: OutputMeta, input: string): string {
  return "h-" + createHash("sha256")
    .update(JSON.stringify([meta.sessionId ?? "", meta.tool, meta.source ?? "", meta.field ?? "", input]))
    .digest("hex").slice(0, 24);
}

function extOf(source: string): string {
  const dot = source.lastIndexOf(".");
  return dot >= 0 ? source.slice(dot + 1).toLowerCase() : "";
}
