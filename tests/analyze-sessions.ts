/** Read-only session accounting. Usage: node --import tsx tests/analyze-sessions.ts [manifest] */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface SessionRecord {
  sessionId: string;
  jsonlPath: string;
  round?: number;
  jsonlSize?: number;
  startedAt?: string;
}

export interface JsonlSource {
  sessionId: string;
  content: string;
  label?: string;
}

const counters = {
  uncachedInputTokens: "input_tokens",
  cacheReadTokens: "cache_read_input_tokens",
  cacheCreationTokens: "cache_creation_input_tokens",
  outputTokens: "output_tokens",
} as const;

type TokenCounts = { [K in keyof typeof counters]: number | null };

export interface SessionUsage {
  tokens: TokenCounts;
  uniqueMessages: number;
  unknownUsageMessages: number;
  sessionIds: string[];
  complete: boolean;
  issues: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pure parser. Only typed assistant message snapshots are usage evidence.
 * The last snapshot of each (session, message.id) wins, not the sum or maximum.
 * Timestamps disambiguate copies across sources; absent/equal timestamps use source order.
 */
export function parseSessionUsage(sources: readonly JsonlSource[]): SessionUsage {
  const issues: string[] = [];
  const messages = new Map<string, { usage: unknown; timestamp: number; stopReason: unknown; sourceIndex: number }>();
  const sessionIds = [...new Set(sources.map((source) => source.sessionId))];
  if (!sources.length) issues.push("No session sources; usage is unknown.");

  for (const [sourceIndex, source] of sources.entries()) {
    const label = source.label ?? source.sessionId;
    if (!source.sessionId) {
      issues.push(`${label}: missing session identity.`);
      continue;
    }
    let lastStopReason: unknown;
    let assistantRecords = 0;
    for (const [index, line] of source.content.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        issues.push(`${label}:${index + 1}: invalid/truncated JSON; coverage is incomplete.`);
        continue;
      }
      if (!isObject(record) || typeof record.type !== "string") {
        issues.push(`${label}:${index + 1}: untyped record; usage cannot be attributed.`);
        continue;
      }
      if (record.type === "user") lastStopReason = undefined;
      if (record.type !== "assistant") continue;
      assistantRecords++;
      lastStopReason = undefined;
      if (record.sessionId !== undefined && record.sessionId !== source.sessionId) {
        issues.push(`${label}:${index + 1}: session identity does not match the manifest.`);
        continue;
      }
      const message = record.message;
      if (!isObject(message) || (message.role !== undefined && message.role !== "assistant") ||
          typeof message.id !== "string" || !message.id.trim()) {
        issues.push(`${label}:${index + 1}: assistant message has no usable identity/type.`);
        continue;
      }
      lastStopReason = message.stop_reason;
      const key = JSON.stringify([source.sessionId, message.id]);
      const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
      const previous = messages.get(key);
      if (previous && previous.sourceIndex !== sourceIndex &&
          Number.isFinite(timestamp) && Number.isFinite(previous.timestamp) &&
          timestamp < previous.timestamp) continue;
      messages.set(key, { usage: message.usage, timestamp, stopReason: message.stop_reason, sourceIndex });
    }
    if (!assistantRecords) {
      issues.push(`${label}: no assistant records; usage is unknown.`);
    } else if (!["end_turn", "stop_sequence", "refusal"].includes(String(lastStopReason))) {
      issues.push(`${label}: no terminal assistant turn; session may be incomplete.`);
    }
  }

  const tokens: TokenCounts = {
    uncachedInputTokens: messages.size ? 0 : null,
    cacheReadTokens: messages.size ? 0 : null,
    cacheCreationTokens: messages.size ? 0 : null,
    outputTokens: messages.size ? 0 : null,
  };
  let unknownUsageMessages = 0;
  for (const [key, message] of messages) {
    let unknown = false;
    for (const name of Object.keys(counters) as (keyof TokenCounts)[]) {
      const value = isObject(message.usage) ? message.usage[counters[name]] : undefined;
      // Cache creation's nested TTL breakdown is NOT additional input usage.
      // Missing top-level counters are unknown, even when a breakdown is present.
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        tokens[name] = null;
        unknown = true;
      } else if (tokens[name] !== null) {
        const sum = tokens[name] + value;
        tokens[name] = Number.isSafeInteger(sum) ? sum : null;
        if (tokens[name] === null) issues.push(`${key}: ${name} exceeds safe integer precision.`);
      }
    }
    if (unknown) unknownUsageMessages++;
    if (typeof message.stopReason !== "string" || !message.stopReason) {
      issues.push(`${key}: final message snapshot has no stop_reason; final usage is unconfirmed.`);
    }
  }
  if (unknownUsageMessages) issues.push(`${unknownUsageMessages} unique message(s) have unknown usage counters.`);
  return { tokens, uniqueMessages: messages.size, unknownUsageMessages, sessionIds,
    complete: messages.size > 0 && issues.length === 0, issues };
}

export interface SessionFiles {
  read(path: string): string;
  subagentFiles(directory: string): string[];
}

const sessionFiles: SessionFiles = {
  read: (path) => readFileSync(path, "utf8"),
  subagentFiles(directory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sessionFiles.subagentFiles(path);
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
    });
  },
};

/** Only explicit manifest paths and their own <session>/subagents tree are read. */
export function loadScenarioArm(
  records: readonly SessionRecord[] | undefined,
  baseDirectory: string,
  files: SessionFiles = sessionFiles,
): SessionUsage {
  const sources: JsonlSource[] = [];
  const issues: string[] = [];
  const loaded = new Map<string, string>();
  const discovered = new Set<string>();
  if (!Array.isArray(records) || !records.length) issues.push("Scenario arm has no session records.");
  for (const record of records ?? []) {
    if (!record || typeof record.sessionId !== "string" || !record.sessionId.trim() ||
        typeof record.jsonlPath !== "string" || !record.jsonlPath.trim() ||
        !record.jsonlPath.endsWith(".jsonl")) {
      issues.push("Session record has a missing/invalid identity or JSONL path.");
      continue;
    }
    const path = resolve(baseDirectory, record.jsonlPath);
    // Repeated --resume manifest records describe the same growing file, not new sessions.
    const subagentDirectory = join(path.slice(0, -".jsonl".length), "subagents");
    const paths = [path];
    if (!discovered.has(subagentDirectory)) {
      discovered.add(subagentDirectory);
      try {
        paths.push(...files.subagentFiles(subagentDirectory));
      } catch (error) {
        issues.push(`${subagentDirectory}: cannot enumerate subagents (${String(error)}).`);
      }
    }
    for (const sourcePath of paths) {
      const canonicalPath = resolve(baseDirectory, sourcePath);
      const pathKey = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
      if (loaded.has(pathKey)) {
        if (loaded.get(pathKey) !== record.sessionId) issues.push(`${canonicalPath}: conflicting session identities.`);
        continue;
      }
      loaded.set(pathKey, record.sessionId);
      try {
        sources.push({ sessionId: record.sessionId, label: canonicalPath, content: files.read(canonicalPath) });
      } catch (error) {
        issues.push(`${canonicalPath}: missing/unreadable session (${String(error)}).`);
      }
    }
  }
  const usage = parseSessionUsage(sources);
  usage.issues.push(...issues);
  usage.complete = usage.complete && issues.length === 0;
  return usage;
}

function totalInput(tokens: TokenCounts): number | null {
  const values = [tokens.uncachedInputTokens, tokens.cacheReadTokens, tokens.cacheCreationTokens];
  if (values.some((value) => value === null)) return null;
  const sum = (values as number[]).reduce((a, b) => a + b, 0);
  return Number.isSafeInteger(sum) ? sum : null;
}

function totalTokens(tokens: TokenCounts): number | null {
  const input = totalInput(tokens);
  if (input === null || tokens.outputTokens === null) return null;
  const sum = input + tokens.outputTokens;
  return Number.isSafeInteger(sum) ? sum : null;
}

/** Raw token deltas, not billing savings or evidence of equivalent task quality. */
export function compareUsage(control: SessionUsage, experiment: SessionUsage) {
  const ctrlInput = totalInput(control.tokens);
  const exprInput = totalInput(experiment.tokens);
  const ctrlTotal = totalTokens(control.tokens);
  const exprTotal = totalTokens(experiment.tokens);
  if (!control.complete || !experiment.complete ||
      control.sessionIds.some((id) => experiment.sessionIds.includes(id)) ||
      ctrlInput === null || exprInput === null || ctrlTotal === null || exprTotal === null) {
    return { available: false as const, inputSaved: null, totalSaved: null, inputPct: null, totalPct: null };
  }
  return {
    available: true as const,
    inputSaved: ctrlInput - exprInput,
    totalSaved: ctrlTotal - exprTotal,
    inputPct: ctrlInput > 0 ? (ctrlInput - exprInput) / ctrlInput * 100 : null,
    totalPct: ctrlTotal > 0 ? (ctrlTotal - exprTotal) / ctrlTotal * 100 : null,
  };
}

function main() {
  const manifest = resolve(process.argv[2] ?? fileURLToPath(new URL("session-results.json", import.meta.url)));
  const results: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  if (!isObject(results) || !Object.keys(results).length) throw new Error("Manifest has no scenarios.");
  console.log("Session usage accounting (observed unique messages, NOT measured API calls).");
  console.log("Manifest attribution and successful task completion require independent verification.");
  console.log("Raw token totals include all cache categories; they are not monetary cost estimates.");
  const display = (value: number | null) => value === null ? "unknown" : String(value);
  for (const [name, result] of Object.entries(results)) {
    if (!isObject(result) || !Array.isArray(result.control) || !Array.isArray(result.experiment)) {
      console.log(`\n${name}: invalid/missing arms; savings unavailable.`);
      process.exitCode = 1;
      continue;
    }
    console.log(`\n${name}`);
    const control = loadScenarioArm(result.control, dirname(manifest));
    const experiment = loadScenarioArm(result.experiment, dirname(manifest));
    for (const [arm, usage] of [["control", control], ["experiment", experiment]] as const) {
      console.log(`  ${arm}: ${usage.complete ? "recorded usage complete" : "INCOMPLETE / UNKNOWN (observed subset only)"}`);
      console.log(`    Unique assistant messages: ${usage.uniqueMessages}; unknown usage: ${usage.unknownUsageMessages}`);
      for (const [counter, value] of Object.entries(usage.tokens)) console.log(`    ${counter}: ${display(value)}`);
      console.log(`    All input: ${display(totalInput(usage.tokens))}; all tokens: ${display(totalTokens(usage.tokens))}`);
      for (const issue of usage.issues) console.log(`    WARNING: ${issue}`);
    }
    const comparison = compareUsage(control, experiment);
    if (!comparison.available) {
      console.log("  Savings unavailable: incomplete/unknown usage, overlapping arms, or unsafe totals.");
      process.exitCode = 1;
      continue;
    }
    const pct = (value: number | null) => value === null ? "n/a (zero baseline)" : `${value.toFixed(1)}%`;
    console.log(`  All-input delta (control - experiment): ${comparison.inputSaved} (${pct(comparison.inputPct)})`);
    console.log(`  All-token delta (control - experiment): ${comparison.totalSaved} (${pct(comparison.totalPct)})`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`Analysis unavailable: ${String(error)}`);
    process.exitCode = 1;
  }
}
