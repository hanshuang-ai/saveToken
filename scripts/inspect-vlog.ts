import { readFileSync } from "node:fs";
import { compress } from "../src/compress";
const f = "corpus/vehicle-logs/log_1788519682349_LS6CME0F2SB395740/resources/mtklog/mobilelog/APLog_2026_0904_172741__34/main_log_17__2026_0904_185827";
const text = readFileSync(f, "utf8").slice(0, 200000);
const r = compress(text);
const dstep = r.steps.find(s => s.method.startsWith("structured-digest") && s.compressed);
console.log(`compressed=${r.compressed} ${r.originalSize}->${r.compressedSize} digestStep=${!!dstep}`);
if (dstep) console.log(dstep.text.split("\n").slice(0, 30).join("\n"));
