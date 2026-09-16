/** Conservative PostToolUse adapter. No host-history mutation or blind snipping. */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { planOutput, type OutputMeta } from "../src/core/tool-output";
import type { MetricInput } from "../src/store/db";

type Persist = (original: string, metric: MetricInput & { handle: string }) =>
  Promise<Record<string, number>> | Record<string, number>;

interface TextField {
  field: string;
  text: string;
  source?: string;
  replace(value: unknown, next: string): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function readSourceFrom(response: unknown, fallback?: string): string | undefined {
  if (!isRecord(response)) return fallback;
  const file = isRecord(response.file) ? response.file : undefined;
  return firstString(
    response.file_path,
    response.filePath,
    response.path,
    file?.file_path,
    file?.filePath,
    file?.path,
    fallback
  );
}

function extractTextFields(response: unknown, tool: string, fallbackSource?: string): TextField[] {
  if (typeof response === "string") {
    return [{
      field: "text",
      text: response,
      source: fallbackSource,
      replace: (_value, next) => next,
    }];
  }
  if (!isRecord(response)) return [];

  if (tool === "Bash") {
    return Object.entries(response)
      .filter((entry): entry is [string, string] =>
        ["stdout", "stderr"].includes(entry[0]) && typeof entry[1] === "string")
      .map(([field, text]) => ({
        field,
        text,
        source: fallbackSource,
        replace: (value: unknown, next: string) => ({ ...(value as object), [field]: next }),
      }));
  }

  if (tool !== "Read") return [];

  const fields: TextField[] = [];
  const source = readSourceFrom(response, fallbackSource);
  for (const field of ["content", "text"] as const) {
    if (typeof response[field] === "string") {
      fields.push({
        field,
        text: response[field],
        source,
        replace: (value: unknown, next: string) => ({ ...(value as object), [field]: next }),
      });
    }
  }
  if (isRecord(response.file) && typeof response.file.content === "string") {
    fields.push({
      field: "file.content",
      text: response.file.content,
      source,
      replace: (value: unknown, next: string) => {
        const current = isRecord(value) ? value : {};
        const file = isRecord(current.file) ? current.file : {};
        return { ...current, file: { ...file, content: next } };
      },
    });
  }
  return fields;
}

/** Bash and Read text fields are eligible. Images and metadata stay intact. */
export async function rewriteToolResponse(response: unknown, meta: OutputMeta, persist: Persist) {
  let value = response;
  let changed = false;
  const measurements: Record<string, unknown>[] = [];
  const fields = extractTextFields(response, meta.tool, meta.source);

  for (const candidateField of fields) {
    const { field, text: original } = candidateField;
    const start = performance.now();
    const measurement: Record<string, unknown> = { field, originalSize: original.length };
    try {
      const fieldMeta = { ...meta, source: candidateField.source ?? meta.source, field };
      const plan = planOutput(original, fieldMeta);
      Object.assign(measurement, plan.timings, { reason: plan.reason, emittedSize: original.length });
      if (!plan.candidate) continue;
      const candidate = plan.candidate;
      const storeStart = performance.now();
      const phases = await persist(original, {
        handle: candidate.handle, source: fieldMeta.source, tool: meta.tool,
        sessionId: meta.sessionId, contentType: candidate.contentType,
        originalSize: original.length, compressedSize: candidate.text.length,
        method: candidate.method, createdAt: Date.now(),
      });
      Object.assign(measurement, phases, {
        persistenceMs: performance.now() - storeStart,
        reason: "adopted", emittedSize: candidate.text.length,
      });
      // No candidate is exposed until its backup/index/metric transaction commits.
      value = candidateField.replace(value, candidate.text);
      changed = true;
    } catch {
      measurement.reason = "failed-open";
      measurement.emittedSize = original.length;
    } finally {
      measurement.totalMs = performance.now() - start;
      measurements.push(measurement);
    }
  }
  return { value, changed, measurements };
}

async function main() {
  const moduleReadyMs = performance.now();
  const started = performance.now();
  let opened: typeof import("../src/store/db").store | undefined;
  try {
    const data = JSON.parse(readFileSync(0, "utf8"));
    const tool = data.tool_name ?? data.toolName;
    if (tool !== "Bash" && tool !== "Read") return;
    const response = data.tool_response ?? data.toolResponse;
    if (response == null) return;
    const toolInput = data.tool_input ?? data.toolInput;
    const readSource = tool === "Read"
      ? firstString(
        isRecord(toolInput) ? toolInput.file_path : undefined,
        isRecord(toolInput) ? toolInput.filePath : undefined,
        readSourceFrom(response)
      )
      : undefined;
    const meta: OutputMeta = {
      tool,
      source: readSource ?? (typeof data.cwd === "string" ? data.cwd : undefined),
      sessionId: typeof data.session_id === "string" ? data.session_id : undefined,
    };
    const rewritten = await rewriteToolResponse(response, meta, async (original, metric) => {
      const openStart = performance.now();
      if (!opened) {
        const { store } = await import("../src/store/db");
        store.open(join(process.env.FRUGAL_DATA_DIR ?? join(homedir(), "Desktop", "frugal"), "frugal.db"));
        opened = store;
      }
      const openMs = performance.now() - openStart;
      return { openMs, ...opened.saveOutput(original, metric) };
    });
    if (rewritten.changed) {
      console.log(JSON.stringify({ hookSpecificOutput: {
        hookEventName: "PostToolUse", updatedToolOutput: rewritten.value,
      } }));
    }
    // Explicit opt-in; never log source content or let telemetry affect results.
    const timingLog = process.env.FRUGAL_TIMING_LOG;
    if (timingLog) {
      try {
        mkdirSync(dirname(timingLog), { recursive: true });
        appendFileSync(timingLog, JSON.stringify({
          sessionId: meta.sessionId, tool, moduleReadyMs,
          totalMs: performance.now() - started, fields: rewritten.measurements,
        }) + "\n", "utf8");
      } catch { /* telemetry is best effort */ }
    }
  } catch {
    // Malformed input, parser errors and storage failures leave host output intact.
  } finally {
    opened?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
