import type { Compressed } from "../core/types";

export interface DigestOptions {
  /** Minimum number of non-empty lines before a digest is considered. */
  minLines?: number;
  /** Above this signal count, pass through instead of dropping diagnostics. */
  maxSignalLines?: number;
  /** Neighboring original lines retained around every diagnostic block. */
  contextLines?: number;
  /** Maximum number of table rows retained per repeated snapshot section. */
  maxRowsPerSection?: number;
}

const DEFAULTS: Required<DigestOptions> = {
  minLines: 40,
  maxSignalLines: 80,
  contextLines: 3,
  maxRowsPerSection: 5,
};

type SignalKind = "fail" | "warn" | "err" | "summary" | "stack";

const STRUCTURAL_SIGNAL_PATTERNS: { re: RegExp; kind: SignalKind }[] = [
  { re: /^\s*\*?\s*(?:\w*Error|Exception|Traceback|Panic|FATAL|PANIC|CRIT(?:ICAL)?|EMERG|SEGFAULT|ABORT|ASSERTION)\b/i, kind: "err" },
  { re: /^\s*(?:\w+\s)?\]?\s*(?:FAIL(?:ED|URES?)?|ERROR|ERR|WARNING?S?|WARN(?:ING)?)\b!?/i, kind: "fail" },
  { re: /^\s*[✗✘⚠]/, kind: "fail" },
  { re: /^not ok\b/i, kind: "fail" },
  { re: /^\s*at\s+\S/, kind: "stack" },
  { re: /^Caused by/i, kind: "stack" },
  { re: /^\s*#\d+\s/, kind: "stack" },
  { re: /^\S+:\d+:\d+:\s*(?:error|warning|note)\b/i, kind: "err" },
  { re: /^\s*\d+\s*(?:passed|failed|tests?|cases?|suites?|skipped)\b/i, kind: "summary" },
  { re: /^Tests?\s*:\s*\d/i, kind: "summary" },
  { re: /^Tests?\s+\d+\s*(?:failed|passed|skipped)/i, kind: "summary" },
  { re: /^\s*\d+\s*(?:failing|passing)\b/i, kind: "summary" },
];

const LOG_LINE_PREFIX =
  /^\s*\d{2,4}[-/]\d{2}(?:[-/]\d{2,4})?[\sT]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?/;
const LOG_LEVEL_TOKEN =
  /\b(?:ERROR|ERR|FATAL|PANIC|CRIT(?:ICAL)?|EMERG|WARN(?:ING)?|FAIL(?:ED|URES?)?)\b/i;
const SINGLE_LETTER_LEVEL =
  /(?:^|[\s|])E(?:RROR)?(?:[\s|]|$)|(?:^|[\s|])W(?:ARN)?(?:[\s|]|$)|(?:^|[\s|])F(?:[\s|]|$)/i;
const SNAPSHOT_SECTION = /^\s*---\s+.+?\s+---\s*$/;
const SNAPSHOT_SUMMARY =
  /^\s*(?:Tasks:|Mem:|Swap:|\d+%cpu\b|PID\s+USER\b|PSS\(kB\)\s+Process Name\b)/i;
const SNAPSHOT_ROW = /^\s*\d+\s+\S+(?:\s+\S+){2,}/;

function noop(input: string): Compressed {
  return {
    text: input,
    compressed: false,
    originalSize: input.length,
    compressedSize: input.length,
    method: "structured-digest:noop",
  };
}

function isBinary(text: string): boolean {
  const sample = text.slice(0, 20000);
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32)) bad++;
  }
  return sample.length > 0 && bad / sample.length > 0.05;
}

function isMarkup(text: string): boolean {
  return (text.slice(0, 100000).match(/<\/?[a-zA-Z]/g) || []).length > 30;
}

function classifySignalLine(line: string): SignalKind | null {
  if (/^\s*<\w[\s/>]/.test(line)) return null;
  for (const pattern of STRUCTURAL_SIGNAL_PATTERNS) {
    if (pattern.re.test(line)) return pattern.kind;
  }
  if (LOG_LINE_PREFIX.test(line) && (LOG_LEVEL_TOKEN.test(line) || SINGLE_LETTER_LEVEL.test(line))) {
    if (/\b(?:FATAL|PANIC|CRIT|EMERG|SEGFAULT|ABORT|ERROR|ERR|EXCEPTION|ASSERTION)\b/i.test(line) ||
        /(?:^|[\s|])E(?:RROR)?(?:[\s|]|$)/i.test(line)) return "err";
    if (/\bWARN(?:ING)?\b/i.test(line) || /(?:^|[\s|])W(?:ARN)?(?:[\s|]|$)/i.test(line)) return "warn";
    return "fail";
  }
  return null;
}

function isTimestampedLog(lines: string[]): boolean {
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length < 3) return false;
  const timestamped = nonEmpty.filter((line) => LOG_LINE_PREFIX.test(line)).length;
  return timestamped / nonEmpty.length >= 0.5;
}

function digestTimestampedLog(
  input: string,
  lines: string[],
  opts: Required<DigestOptions>
): Compressed {
  if (!isTimestampedLog(lines)) return noop(input);

  const entries: { line: number; text: string; kind: SignalKind }[] = [];
  const counts: Record<SignalKind, number> = {
    fail: 0, warn: 0, err: 0, summary: 0, stack: 0,
  };
  for (let i = 0; i < lines.length; i++) {
    const kind = classifySignalLine(lines[i]);
    if (!kind) continue;
    counts[kind]++;
    entries.push({ line: i + 1, text: lines[i], kind });
  }

  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const density = entries.length / Math.max(1, nonEmpty.length);
  // Dense diagnostics are already information-dense; keeping only signal lines
  // would not be a useful view of the failure.
  if (entries.length === 0 || density > 0.35 || entries.length > opts.maxSignalLines) return noop(input);

  // Keep complete continuation blocks (including unrecognized stack frames),
  // then merge neighboring windows in original, zero-based line coordinates.
  const context = Number.isFinite(opts.contextLines) ? Math.max(0, Math.trunc(opts.contextLines)) : DEFAULTS.contextLines;
  const ranges: { start: number; end: number }[] = [];
  for (const entry of entries) {
    const index = entry.line - 1;
    let blockEnd = index;
    while (blockEnd + 1 < lines.length && !LOG_LINE_PREFIX.test(lines[blockEnd + 1])) blockEnd++;
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length - 1, blockEnd + context);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  const tally = `errors=${counts.err}, warnings=${counts.warn}, failures=${counts.fail}, summaries=${counts.summary}, stacks=${counts.stack}`;
  const view = [
    `[frugal: log digest; all ${entries.length} signal lines and diagnostic context retained; ${tally}]`,
    ...ranges.flatMap(({ start, end }) => [
      `[original lines ${start + 1}-${end + 1}]`,
      ...lines.slice(start, end + 1),
    ]),
  ].join("\n");
  if (view.length >= input.length) return noop(input);
  return {
    text: view,
    compressed: true,
    originalSize: input.length,
    compressedSize: view.length,
    method: "structured-digest:log-signals",
    restoreText: input,
  };
}

function digestJest(input: string, lines: string[], opts: Required<DigestOptions>): Compressed {
  const summaries = lines.filter((line) =>
    /^\s*(?:Test Suites|Tests):\s+\d+.*\btotal\s*\r?$/.test(line)
  );
  if (!summaries.some((line) => /^\s*Test Suites:/.test(line)) ||
      !summaries.some((line) => /^\s*Tests:/.test(line))) {
    return noop(input);
  }

  const isPass = (line: string) =>
    /^\s*PASS\s+\S+\.(?:test|spec)\.[cm]?[jt]sx?(?:\s+\(\d+(?:\.\d+)?\s*s\))?\s*\r?$/.test(line);
  const removed = lines.filter(isPass).length;
  if (removed === 0) return noop(input);

  const view: string[] = [
    `[frugal: omitted ${removed} PASS suite headers; diagnostics and summaries retained]`,
  ];
  let start = 0;
  while (start < lines.length) {
    if (isPass(lines[start])) {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < lines.length && !isPass(lines[end])) end++;
    view.push(`[original lines ${start + 1}-${end}]`, lines.slice(start, end).join("\n"));
    start = end;
  }
  const text = view.join("\n");
  if (text.length >= input.length) return noop(input);
  return {
    text,
    compressed: true,
    originalSize: input.length,
    compressedSize: text.length,
    method: "structured-digest:jest-pass",
    restoreText: input,
  };
}

function digestRepeatedSnapshot(
  input: string,
  lines: string[],
  opts: Required<DigestOptions>
): Compressed {
  const starts = lines
    .map((line, index) => SNAPSHOT_SECTION.test(line) ? index : -1)
    .filter((index) => index >= 0);
  if (starts.length < 3) return noop(input);

  const preamble = lines.slice(0, starts[0]).filter((line) => line.trim().length > 0);
  const sections: string[] = [];
  let omittedRows = 0;
  for (let i = 0; i < starts.length; i++) {
    const section = lines.slice(starts[i], starts[i + 1] ?? lines.length);
    const body = section.slice(1).filter((line) => line.trim().length > 0);
    const rows = body.filter((line) => SNAPSHOT_ROW.test(line));
    const retained = rows.slice(0, opts.maxRowsPerSection);
    const unknown = body.filter((line) => !SNAPSHOT_SUMMARY.test(line) && !SNAPSHOT_ROW.test(line));
    // This view is only for known, repetitive command snapshots. Unknown lines
    // mean the section may carry semantics that the generic table policy misses.
    if (unknown.length > 0 || rows.length < opts.maxRowsPerSection) return noop(input);
    const dropped = rows.length - retained.length;
    omittedRows += dropped;
    sections.push([
      section[0],
      ...body.filter((line) => SNAPSHOT_SUMMARY.test(line)),
      ...retained,
      `[frugal: omitted ${dropped} lower-ranked rows from this snapshot; use the original handle for the complete table]`,
    ].join("\n"));
  }

  const view = [...preamble, ...sections].join("\n");
  if (omittedRows === 0 || view.length >= input.length) return noop(input);
  return {
    text: `[frugal: repeated snapshot digest; ${starts.length} sections, ${omittedRows} table rows omitted]\n${view}`,
    compressed: true,
    originalSize: input.length,
    compressedSize: view.length,
    method: "structured-digest:repeated-snapshot",
    restoreText: input,
  };
}

/**
 * Produce a conservative view for machine-generated, line-oriented output.
 * The original is retained by the hook before this view is exposed.
 */
export function structuredDigestCompress(input: string, opts: DigestOptions = {}): Compressed {
  const options = { ...DEFAULTS, ...opts };
  const lines = input.split("\n");
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length < options.minLines || input.includes("\x00") || isBinary(input) || isMarkup(input)) {
    return noop(input);
  }

  const candidates = [
    digestJest(input, lines, options),
    digestTimestampedLog(input, lines, options),
    digestRepeatedSnapshot(input, lines, options),
  ].filter((result) => result.compressed);
  if (candidates.length === 0) return noop(input);
  return candidates.reduce((best, result) =>
    result.text.length < best.text.length ? result : best
  );
}

export function structuredDigestDecompress(result: Compressed): string {
  return result.restoreText ?? result.text;
}
