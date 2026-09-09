import { readFileSync } from "node:fs";
import { classify } from "../src/core/classifier";
import { structuredDigestCompress } from "../src/compress/structured-digest";

function show(label: string, file: string, cap = 2000) {
  const text = readFileSync(file, "utf8").slice(0, 200000);
  const cls = classify({ text, path: file });
  const d = structuredDigestCompress(text);
  console.log(`\n════ ${label} ════`);
  console.log(`file: ${file}`);
  console.log(`classify: ${cls.type} (conf ${cls.confidence.toFixed(2)}, signals: ${cls.signals.join(",")})`);
  console.log(`digest: ${d.method} compressed=${d.compressed} ${d.originalSize}->${d.compressedSize}`);
  console.log(`--- digest output (first 25 lines) ---`);
  if (d.compressed) console.log(d.text.split("\n").slice(0, 25).join("\n"));
  else console.log("(noop)");
}

// 真实车载日志(MTK main_log)
const vl = "corpus/vehicle-logs/log_1788519682349_LS6CME0F2SB395740/resources/mtklog/mobilelog/APLog_2026_0904_172741__34/main_log_6__2026_0904_181321";
show("车载 MTK main_log(真实大型日志)", vl);

// 真实 Claude Code 构建日志
const build = "corpus/sdk/log/claudecode-build-2026-06-10T07-05-37-307Z.log";
show("Claude Code 构建日志(真实)", build);

// prose 文档(digest 不该 engage 但 engage 了)
const md = "corpus/sdk/md/tasks.md";
show("tasks.md(prose,digest 误命中)", md);
