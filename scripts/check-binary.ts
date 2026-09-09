import { readFileSync } from "node:fs";
const ps: [string, string][] = [
  ["opencode", "corpus/sdk/bin/opencode"],
  ["pak", "corpus/sdk/release-desktop/mac/TinnoveCopilot.app/Contents/Frameworks/Electron Framework.framework/Resources/en.lproj/locale.pak"],
  ["vlog", "corpus/vehicle-logs/log_1788519682349_LS6CME0F2SB395740/resources/mtklog/mobilelog/APLog_2026_0904_172741__34/main_log_6__2026_0904_181321"],
];
for (const [n, p] of ps) {
  const b = readFileSync(p).subarray(0, 100000);
  let nul = 0, ctrl = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0) nul++;
    else if (c < 32 && c !== 9 && c !== 10 && c !== 13) ctrl++;
  }
  console.log(`${n}: NUL=${nul} ctrl=${ctrl} / ${b.length} = ${((nul + ctrl) / b.length * 100) | 0}%`);
}
