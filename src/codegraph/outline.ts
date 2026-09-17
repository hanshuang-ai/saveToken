/**
 * Hook-safe code outline, INLINED into the Read placeholder so the model can
 * target tok_retrieve(handle, startLine, count) ranges instead of pulling the
 * whole file back into context.
 *
 * Two engines, dispatched by extension:
 *
 *  - tree-sitter WASM (web-tree-sitter) for TS/TSX/JS/JSX + Vue <script>.
 *    AST node types ⇒ no false matches inside strings/comments, and Vue SFCs
 *    parse their <script> block with the real TS grammar (regex outline used
 *    to mis-scan Vue). Per-Read fixed cost is ~21ms (Parser.init + one grammar
 *    load, measured), parse scales linearly with file size. Vendored ABI-15
 *    wasms live in ../extraction/wasm — copied from codegraph, because the
 *    tree-sitter-wasms npm package ships ABI-13 builds that corrupt/miss
 *    symbols under web-tree-sitter 0.25.
 *
 *  - regex/line-scan fallback for the other languages (py/go/rs/c/sql/…), so
 *    we don't ship 66MB of grammars for rarely-touched langs.
 *
 * Bounded: 150 entries / 6000 chars. Returns null (< 3 entries) ⇒ the caller
 * falls back to the pending tok_code_map pointer.
 *
 * Exported async — the hook awaits it. tree-sitter init/load/parse are async
 * (WASM compile); the regex path is sync but runs inside the same promise.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Parser,
  Language as WasmLanguage,
  type SyntaxNode,
} from "web-tree-sitter";

const MAX_OUTLINE_ENTRIES = 150;
const MAX_OUTLINE_CHARS = 6000;

/** Absolute dir of the vendored grammar wasms (../extraction/wasm from here). */
const WASM_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "extraction", "wasm");

/** ext → grammar wasm. Vue delegates its <script> block to the TS grammar. */
const GRAMMAR_FILE: Record<string, string> = {
  ts: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  mts: "tree-sitter-typescript.wasm",
  cts: "tree-sitter-typescript.wasm",
  js: "tree-sitter-javascript.wasm",
  jsx: "tree-sitter-javascript.wasm",
  mjs: "tree-sitter-javascript.wasm",
  cjs: "tree-sitter-javascript.wasm",
  vue: "tree-sitter-typescript.wasm",
};

// ── runtime bootstrap: init once per hook process, cache the one grammar ──
// A hook is a fresh node process per tool call, so this tax is paid per Read.
// Measured ~21ms for init + one 1.4MB grammar load — negligible vs. 30s timeout.
let runtimeReady = false;
const grammarCache = new Map<string, WasmLanguage>();
const parserCache = new Map<string, Parser>();

async function loadLanguage(ext: string): Promise<WasmLanguage | null> {
  const cached = grammarCache.get(ext);
  if (cached) return cached;
  if (!runtimeReady) {
    await Parser.init();
    runtimeReady = true;
  }
  const file = GRAMMAR_FILE[ext];
  if (!file) return null;
  try {
    const lang = await WasmLanguage.load(readFileSync(join(WASM_DIR, file)));
    grammarCache.set(ext, lang);
    return lang;
  } catch {
    return null;
  }
}

async function getParser(ext: string): Promise<Parser | null> {
  const cached = parserCache.get(ext);
  if (cached) return cached;
  const lang = await loadLanguage(ext);
  if (!lang) return null;
  const p = new Parser();
  p.setLanguage(lang);
  parserCache.set(ext, p);
  return p;
}

// ── AST symbol kinds (tree-sitter-typescript / -javascript node types) ──
const KIND_FN = new Set([
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
]);
const KIND_CLASS = new Set(["class_declaration", "abstract_class_declaration"]);
const KIND_TYPE = new Set([
  "interface_declaration",
  "enum_declaration",
  "type_alias_declaration",
]);
const KIND_IMPORT = new Set(["import_statement"]);
const KIND_CONST = new Set(["lexical_declaration", "variable_declaration"]);

interface Entry {
  line: number;
  kind: string;
  name: string;
}

function classifyKind(node: SyntaxNode): string | null {
  if (KIND_FN.has(node.type)) return "fn";
  if (KIND_CLASS.has(node.type)) return "class";
  if (KIND_TYPE.has(node.type)) return "type";
  if (KIND_IMPORT.has(node.type)) return "import";
  if (KIND_CONST.has(node.type)) return "const";
  return null;
}

function symbolName(node: SyntaxNode, source: string): string | null {
  // function/class/interface/enum/type/method carry a `name` field.
  const nameNode = node.childForFieldName("name");
  if (nameNode) {
    return source.slice(nameNode.startIndex, nameNode.endIndex);
  }
  // lexical/variable declaration: name sits on the inner variable_declarator.
  if (KIND_CONST.has(node.type)) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c && c.type === "variable_declarator") {
        const nm = c.childForFieldName("name");
        if (nm) return source.slice(nm.startIndex, nm.endIndex);
      }
    }
  }
  // import: show the module path (source field) for compactness.
  if (KIND_IMPORT.has(node.type)) {
    const src = node.childForFieldName("source");
    if (src) {
      const mod = source.slice(src.startIndex, src.endIndex).replace(/['"]/g, "");
      if (mod) return `from ${mod}`;
    }
    return null;
  }
  return null;
}

function collectTree(
  root: SyntaxNode,
  source: string,
  baseLine: number,
  out: Entry[],
  seen: Set<string>,
): void {
  if (out.length >= MAX_OUTLINE_ENTRIES) return;
  const kind = classifyKind(root);
  if (kind) {
    const name = symbolName(root, source);
    if (name) {
      const n = name.trim().replace(/\s+/g, " ").slice(0, 90);
      if (n) {
        const key = `${kind}:${n}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ line: baseLine + root.startPosition.row + 1, kind, name: n });
        }
      }
    }
  }
  for (let i = 0; i < root.namedChildCount; i++) {
    if (out.length >= MAX_OUTLINE_ENTRIES) return;
    const c = root.namedChild(i);
    if (c) collectTree(c, source, baseLine, out, seen);
  }
}

function formatEntries(entries: Entry[]): string | null {
  if (entries.length < 3) return null;
  entries.sort((a, b) => a.line - b.line);
  let out = entries.map((e) => `  L${e.line} ${e.kind} ${e.name}`).join("\n");
  if (out.length > MAX_OUTLINE_CHARS) {
    out =
      out.slice(0, MAX_OUTLINE_CHARS) +
      `\n  ... (outline truncated; tok_code_map(handle) for the full AST symbol map)`;
  }
  return out;
}

// ── Vue SFC: extract <script> blocks, delegate each to the TS/JS grammar ──
const SCRIPT_RE = /<script(\s[^>]*)?>(?<content>[\s\S]*?)<\/script>/g;

function vueScriptBlocks(
  source: string,
): Array<{ content: string; contentStartRow: number; isTs: boolean }> {
  const blocks: Array<{ content: string; contentStartRow: number; isTs: boolean }> = [];
  let m: RegExpExecArray | null;
  while ((m = SCRIPT_RE.exec(source)) !== null) {
    const attrs = m[1] || "";
    const content = m.groups?.content || "";
    const isTs = /lang\s*=\s*["'](ts|typescript)["']/.test(attrs);
    // 0-indexed row in the .vue where the script CONTENT begins: count newlines
    // up to the char right after the opening tag's `>`.
    const tagEndOffset = m.index + m[0].indexOf(">") + 1;
    const contentStartRow = (source.slice(0, tagEndOffset).match(/\n/g) || []).length;
    blocks.push({ content, contentStartRow, isTs });
  }
  return blocks;
}

/** <template>/<style> block markers, for the Vue outline's structural skeleton. */
function vueBlockMarkers(source: string): Entry[] {
  const lines = source.split("\n");
  const out: Entry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const b = lines[i].trim().match(/^<\/?(template|style)\b/);
    if (b) out.push({ line: i + 1, kind: "block", name: `<${b[1]}>` });
  }
  return out;
}

/**
 * Build the outline. Returns the text to inline, or null when there's nothing
 * worth showing (caller falls back to the pending tok_code_map pointer).
 *
 * Exported async: the hook awaits it. tree-sitter init/load/parse are async.
 */
export async function codeOutline(content: string, ext: string): Promise<string | null> {
  // ── tree-sitter path ──
  if (ext in GRAMMAR_FILE) {
    try {
      if (ext === "vue") {
        const blocks = vueScriptBlocks(content);
        if (blocks.length === 0) return regexOutline(content, ext);
        const entries: Entry[] = [];
        const seen = new Set<string>();
        for (const b of blocks) {
          const grammarExt = b.isTs ? "ts" : "js";
          const p = await getParser(grammarExt);
          if (!p) continue;
          const tree = p.parse(b.content);
          if (tree) collectTree(tree.rootNode, b.content, b.contentStartRow, entries, seen);
        }
        entries.push(...vueBlockMarkers(content));
        return formatEntries(entries) ?? regexOutline(content, ext);
      }
      const p = await getParser(ext);
      if (!p) return regexOutline(content, ext);
      const tree = p.parse(content);
      if (!tree) return regexOutline(content, ext);
      const entries: Entry[] = [];
      collectTree(tree.rootNode, content, 0, entries, new Set());
      return formatEntries(entries) ?? regexOutline(content, ext);
    } catch {
      // WASM/parse failure ⇒ degrade to the regex outline rather than crash the hook.
      return regexOutline(content, ext);
    }
  }
  return regexOutline(content, ext);
}

// ── regex/line-scan fallback: non-TS langs + Vue fallback when no <script> ──
const CLIKE = new Set([
  "ts", "tsx", "js", "jsx", "cjs", "mjs", "cts", "mts",
  "java", "go", "rs", "c", "h", "cpp", "cc", "hpp", "cs", "kt", "scala",
]);

function regexOutline(content: string, ext: string): string | null {
  const lines = content.split("\n");
  const entries: string[] = [];
  const seen = new Set<string>();
  const push = (ln: number, kind: string, name: string) => {
    const n = name.trim().replace(/\s+/g, " ").slice(0, 90);
    if (!n) return;
    const key = `${kind}:${n}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(`  L${ln + 1} ${kind} ${n}`);
  };
  const clike = CLIKE.has(ext);
  const vue = ext === "vue";
  const py = ext === "py" || ext === "pyi";
  const sql = ext === "sql";
  for (let i = 0; i < lines.length && entries.length < MAX_OUTLINE_ENTRIES; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if ((clike || vue) && line.startsWith("//")) continue;
    if (py && line.startsWith("#")) continue;
    if (vue) {
      const b = line.match(/^<\/?(template|script|style)\b/);
      if (b) {
        push(i, "block", `<${b[1]}>`);
        continue;
      }
    }
    let m: RegExpMatchArray | null;
    if (clike || vue) {
      if ((m = line.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/))) {
        push(i, "class", m[1]);
        continue;
      }
      if ((m = line.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z0-9_$]+)/))) {
        push(i, "fn", m[1]);
        continue;
      }
      if ((m = line.match(/^(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z0-9_$]+)/))) {
        push(i, "type", m[1]);
        continue;
      }
      if ((m = line.match(/^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=/))) {
        push(i, "const", m[1]);
        continue;
      }
      if ((m = line.match(/^import\b/))) {
        push(i, "import", line.slice(0, 90));
        continue;
      }
    }
    if (py) {
      if ((m = line.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)/))) {
        push(i, "def", m[1]);
        continue;
      }
      if ((m = line.match(/^class\s+([A-Za-z0-9_]+)/))) {
        push(i, "class", m[1]);
        continue;
      }
      if ((m = line.match(/^(?:from\s+[\w.]+\s+)?import\b/))) {
        push(i, "import", line.slice(0, 90));
        continue;
      }
    }
    if (sql) {
      if ((m = line.match(/^\s*(?:create|alter)\s+(?:table|view|index)\s+[`"\[]?([\w.]+)[`"\]]?/i))) {
        push(i, "obj", m[1]);
        continue;
      }
    }
  }
  if (entries.length < 3) return null;
  let out = entries.join("\n");
  if (out.length > MAX_OUTLINE_CHARS) {
    out =
      out.slice(0, MAX_OUTLINE_CHARS) +
      `\n  ... (outline truncated; tok_code_map(handle) for the full AST symbol map)`;
  }
  return out;
}
