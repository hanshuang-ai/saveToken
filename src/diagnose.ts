/**
 * diagnose.ts —— 项目类型诊断脚本
 *
 * 扫描当前工作目录的文件结构,启发式判定项目类型(coding/docs/mixed),
 * 输出 JSON 到 stdout,供 /tok-status slash command 消费。
 *
 * 设计原则:
 * - 只读,不改任何文件
 * - 轻量(深度 2),排除常见噪声目录
 * - 无依赖,纯 Bun 标准库
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";

// ─── 配置 ───────────────────────────────────────────────────────────────────

/** 扫描深度 */
const MAX_DEPTH = 2;

/** 排除目录(不递归进入) */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "coverage",
  ".idea",
  ".vscode",
  ".claude",
]);

/** 代码项目标记文件 → 子类型映射 */
const CODE_MARKERS: Record<string, string> = {
  "package.json": "node-bun",
  "tsconfig.json": "node-bun",
  "bun.lockb": "bun",
  "Cargo.toml": "rust",
  "go.mod": "go",
  "pyproject.toml": "python",
  "setup.py": "python",
  "requirements.txt": "python",
  "pom.xml": "java-maven",
  "build.gradle": "java-gradle",
  "build.gradle.kts": "java-gradle",
  "composer.json": "php",
  "Gemfile": "ruby",
  "mix.exs": "elixir",
  "CMakeLists.txt": "cmake",
  "Package.swift": "swift",
};

/** 代码文件扩展名 */
const CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".ex",
  ".exs",
  ".scala",
  ".lua",
]);

/** 文档文件扩展名 */
const DOC_EXTS = new Set([".md", ".markdown", ".txt", ".rst", ".adoc", ".org"]);

// ─── 扫描 ───────────────────────────────────────────────────────────────────

interface ScanResult {
  codeCount: number;
  docCount: number;
  otherCount: number;
  markers: string[];
}

/** 递归扫描目录,统计文件类型并收集标记文件 */
function scan(dir: string, depth: number, result: ScanResult): void {
  if (depth > MAX_DEPTH) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // 无权限或不存在
  }

  for (const entry of entries) {
    // 标记文件检测(根目录优先,任意层级都收)
    if (CODE_MARKERS[entry]) {
      result.markers.push(entry);
    }

    const fullPath = join(dir, entry);

    let st;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      scan(fullPath, depth + 1, result);
    } else if (st.isFile()) {
      const ext = extname(entry).toLowerCase();
      if (CODE_EXTS.has(ext)) {
        result.codeCount++;
      } else if (DOC_EXTS.has(ext)) {
        result.docCount++;
      } else {
        result.otherCount++;
      }
    }
  }
}

// ─── 判定 ───────────────────────────────────────────────────────────────────

type ProjectType = "coding" | "docs" | "mixed" | "empty";

interface Diagnosis {
  projectType: ProjectType;
  subType: string;
  markers: string[];
  fileDistribution: {
    code: number;
    docs: number;
    other: number;
    docsRatio: number;
  };
  recommendation: string[];
}

/** 根据扫描结果判定项目类型并给出建议 */
function diagnose(scanResult: ScanResult): Diagnosis {
  const { codeCount, docCount, otherCount, markers } = scanResult;
  const total = codeCount + docCount + otherCount;

  const fileDistribution = {
    code: codeCount,
    docs: docCount,
    other: otherCount,
    docsRatio: total === 0 ? 0 : Math.round((docCount / total) * 100) / 100,
  };

  // 子类型:取第一个命中标记文件的映射,否则 unknown
  const subType =
    markers.length > 0
      ? CODE_MARKERS[markers[0]] ?? "unknown"
      : "unknown";

  let projectType: ProjectType;
  if (total === 0) {
    projectType = "empty";
  } else if (codeCount === 0 && docCount > 0) {
    projectType = "docs";
  } else if (docCount === 0 && codeCount > 0) {
    projectType = "coding";
  } else if (markers.length > 0 && codeCount > 0 && docCount > 0) {
    // 有代码标记 + 代码和文档都有 → 视编码项目为主
    projectType = docCount / total > 0.4 ? "mixed" : "coding";
  } else if (codeCount > 0 && docCount > 0) {
    projectType = "mixed";
  } else if (codeCount > 0) {
    projectType = "coding";
  } else {
    projectType = "docs";
  }

  // 建议功能(MVP 后的适配器指引)
  const recommendation: string[] = [];
  switch (projectType) {
    case "coding":
      recommendation.push("CLI 去噪", "工具输出压缩", "代码图索引");
      break;
    case "docs":
      recommendation.push("检索优先", "渐进式披露");
      break;
    case "mixed":
      recommendation.push("工具输出压缩", "检索优先", "代码图索引");
      break;
    case "empty":
      recommendation.push("无文件,暂不建议");
      break;
  }

  return { projectType, subType, markers, fileDistribution, recommendation };
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────

function main(): void {
  const cwd = process.cwd();
  const scanResult: ScanResult = {
    codeCount: 0,
    docCount: 0,
    otherCount: 0,
    markers: [],
  };

  scan(cwd, 0, scanResult);
  const diagnosis = diagnose(scanResult);

  // 去重标记文件(保留出现顺序)
  diagnosis.markers = [...new Set(diagnosis.markers)];

  console.log(JSON.stringify(diagnosis, null, 2));
}

main();
