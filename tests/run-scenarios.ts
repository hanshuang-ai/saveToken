/**
 * run-scenarios.ts —— 场景编排器（修正版）
 *
 * 每个场景在独立子目录运行，对照/实验组共用同一目录。
 * 顺序跑 5 个场景，每个场景两组(对照组 --bare + 实验组 --plugin-dir)。
 * 运行结束后记录 session JSONL 路径供分析脚本使用。
 *
 * 用法: npx tsx tests/run-scenarios.ts
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ─── 配置 ───

const PROJECT_DIR = "E:\\WT\\saveToken";
/** 场景工作目录: E:\data analysis\1 ~ 5，可访问 test-data 子目录 */
const SCENARIO_BASE = "E:\\data analysis";
const CLAUDE_BASE = join(process.env.USERPROFILE!, ".claude", "projects");
const RESULTS_FILE = join(PROJECT_DIR, "tests", "session-results.json");
const PROMPTS_CONFIG = join(SCENARIO_BASE, "test-data", "prompts-config.json");

interface Scenario {
  name: string;
  prompt?: string;
  rounds?: string[];
}

interface SessionRecord {
  round?: number;
  sessionId: string;
  jsonlPath: string;
  jsonlSize: number;
  startedAt: string;
}

interface ScenarioResult {
  name: string;
  control: SessionRecord[];
  experiment: SessionRecord[];
}

function loadPrompts(): Record<string, Scenario> {
  const raw = readFileSync(PROMPTS_CONFIG, "utf-8");
  return JSON.parse(raw);
}

/** 扫描全局所有 project 目录，找到指定时间后创建的最新 session jsonl */
function findNewSessionGlobal(after: Date): string | null {
  if (!existsSync(CLAUDE_BASE)) return null;
  let newest: { path: string; time: number } | null = null;
  const projectDirs = readdirSync(CLAUDE_BASE, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const proj of projectDirs) {
    const projPath = join(CLAUDE_BASE, proj.name);
    try {
      const files = readdirSync(projPath).filter((f) => f.endsWith(".jsonl"));
      for (const f of files) {
        const fullPath = join(projPath, f);
        const st = statSync(fullPath);
        if (st.mtimeMs > after.getTime()) {
          if (!newest || st.mtimeMs > newest.time) {
            newest = { path: fullPath, time: st.mtimeMs };
          }
        }
      }
    } catch { /* skip unreadable */ }
  }
  return newest?.path ?? null;
}

function runClaude(args: string[], cwd: string, label: string): boolean {
  console.log(`  [${label}] 执行中 (cwd: ${cwd.replace(PROJECT_DIR, ".")})...`);
  const startTime = Date.now();
  // 不用 shell:true 避免中文引号等特殊字符被 shell 解释截断
  try {
    const result = spawnSync("claude", args, {
      cwd,
      stdio: "inherit",
      timeout: 30 * 60 * 1000,
      windowsHide: true,
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (result.status !== 0) {
      console.log(`  [${label}] 异常退出 ${result.status} (${elapsed}s)`);
      return false;
    }
    console.log(`  [${label}] 完成 (${elapsed}s)`);
    return true;
  } catch (e: any) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (e.killed) {
      console.log(`  [${label}] 超时 (${elapsed}s)`);
    } else {
      console.log(`  [${label}] 异常: ${e.message} (${elapsed}s)`);
    }
    return false;
  }
}

async function main() {
  console.log("=== frugal A/B 场景测试 ===\n");

  if (!existsSync(SCENARIO_BASE)) {
    mkdirSync(SCENARIO_BASE, { recursive: true });
  }

  const scenarios = loadPrompts();
  const results: Record<string, ScenarioResult> = {};

  for (const [scenarioKey, scenario] of Object.entries(scenarios)) {
    const sName = scenarioKey.replace(/^scenario-\d+-/, "");
    const scenarioDir = join(SCENARIO_BASE, scenarioKey);

    console.log(`\n${"=".repeat(50)}`);
    console.log(`场景: ${sName}`);
    console.log(`目录: ${scenarioDir}`);
    console.log(`${"=".repeat(50)}`);

    if (!existsSync(scenarioDir)) {
      mkdirSync(scenarioDir, { recursive: true });
    }

    const prompts: string[] = [];
    if (scenario.rounds) {
      prompts.push(...scenario.rounds);
    } else if (scenario.prompt) {
      prompts.push(scenario.prompt);
    }

    const scenarioResult: ScenarioResult = { name: sName, control: [], experiment: [] };

    for (const mode of ["control", "experiment"] as const) {
      const isControl = mode === "control";
      // 对照组和实验组用不同子目录，避免互相干扰
      const modeDir = join(scenarioDir, isControl ? "control" : "experiment");
      if (!existsSync(modeDir)) {
        mkdirSync(modeDir, { recursive: true });
      }

      const groupLabel = isControl ? "对照(--bare)" : "实验(--plugin-dir)";
      let prevSessionId: string | null = null;

      for (let roundIdx = 0; roundIdx < prompts.length; roundIdx++) {
        const roundLabel = prompts.length > 1 ? `第${roundIdx + 1}轮` : "";
        const fullLabel = `${groupLabel} ${roundLabel}`.trim();
        const before = new Date();

        const baseArgs = ["-p"];
        // 多轮对话需要 --resume
        if (prevSessionId && prompts.length > 1) {
          baseArgs.push("--resume", prevSessionId);
        }
        baseArgs.push(prompts[roundIdx]);

        const args = isControl
          ? [...baseArgs, "--bare"]
          : [...baseArgs, "--plugin-dir", PROJECT_DIR];

        const ok = runClaude(args, modeDir, fullLabel);

        await new Promise((r) => setTimeout(r, 2000));
        const jsonlPath = findNewSessionGlobal(before);

        const sessionId = jsonlPath
          ? jsonlPath.split("\\").pop()!.replace(".jsonl", "")
          : `unknown-${roundIdx}`;

        if (!ok && !jsonlPath) {
          console.log(`  [${fullLabel}] 失败且未找到 session 文件，跳过`);
          continue;
        }

        const record: SessionRecord = {
          round: prompts.length > 1 ? roundIdx + 1 : undefined,
          sessionId,
          jsonlPath: jsonlPath ?? "",
          jsonlSize: jsonlPath ? statSync(jsonlPath).size : 0,
          startedAt: before.toISOString(),
        };

        if (isControl) {
          scenarioResult.control.push(record);
        } else {
          scenarioResult.experiment.push(record);
        }

        prevSessionId = sessionId;

        console.log(`  [${fullLabel}] session: ${sessionId}`);
      }
    }

    results[scenarioKey] = scenarioResult;
    writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2), "utf-8");
  }

  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2), "utf-8");
  console.log(`\n\n结果已保存: ${RESULTS_FILE}`);
  console.log("接下来运行: npx tsx tests/analyze-sessions.ts");
}

main().catch((e) => {
  console.error("编排脚本异常:", e);
  process.exit(1);
});