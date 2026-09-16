import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { classify } from "./classifier";
import { formatStripCompress } from "../compress/format-strip";
import { structuredDigestCompress } from "../compress/structured-digest";
import { genericPreviewCompress } from "../compress/generic-preview";

export const MIN_CHARS = 10000;
export const MIN_SAVED_CHARS = 512;
export const MIN_SAVED_RATIO = 0.1;
const SUPPORTED_TOOLS = new Set(["Bash", "Read"]);

export interface OutputMeta {
  tool: string;
  source?: string;
  sessionId?: string;
  field?: string;
}

/** Pure candidate generation: no storage, no handles emitted on pass-through. */
export function planOutput(input: string, meta: OutputMeta) {
  const started = performance.now();
  const timings = { classifyMs: 0, strategyMs: 0 };
  if (!SUPPORTED_TOOLS.has(meta.tool) || input.length < MIN_CHARS || input.includes("\x00")) {
    return { candidate: null, timings, reason: "ineligible" };
  }
  const classification = classify({
    text: input,
    tool: meta.tool,
    path: meta.tool === "Read" ? meta.source : undefined,
  });
  timings.classifyMs = performance.now() - started;
  if (classification.type === "empty") return { candidate: null, timings, reason: "empty" };

  // Scope by provenance as well as content. Same text from another session or
  // source must not overwrite metadata or retrieval counts for this occurrence.
  const handle = "h-" + createHash("sha256")
    .update(JSON.stringify([meta.sessionId ?? "", meta.tool, meta.source ?? "", meta.field ?? "", input]))
    .digest("hex").slice(0, 24);

  const strategyStart = performance.now();
  const stripped = formatStripCompress(input);
  const digest = classification.type === "structured"
    ? structuredDigestCompress(stripped.text)
    : { text: stripped.text, compressed: false, method: "structured-digest:skipped" };
  const preview = digest.compressed
    ? null
    : genericPreviewCompress(stripped.text, handle);
  timings.strategyMs = performance.now() - strategyStart;
  if (!stripped.compressed && !digest.compressed && !preview?.compressed) {
    return { candidate: null, timings, reason: "no-policy" };
  }

  const text = digest.compressed
    ? `${digest.text}\n[frugal: original via tok_retrieve(handle="${handle}")]`
    : preview?.compressed
      ? preview.text
      : `${stripped.text}\n[frugal: original via tok_retrieve(handle="${handle}")]`;
  const saved = input.length - text.length;
  if (saved < MIN_SAVED_CHARS || saved / input.length < MIN_SAVED_RATIO) {
    return { candidate: null, timings, reason: "insufficient-net-savings" };
  }
  const methods = [stripped, digest, preview]
    .flatMap((r) => r?.compressed ? [r.method] : []);
  return {
    candidate: {
      handle, text, contentType: classification.type,
      method: methods.join(","),
    },
    timings, reason: "candidate",
  };
}
