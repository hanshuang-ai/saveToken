import { readFileSync } from "node:fs";
import { compress } from "../src/compress";
import { structuredDigestCompress } from "../src/compress/structured-digest";
const f = "corpus/blog/public/2022/03/07/qian-duan-cuo-wu-jian-kong/index.html";
const text = readFileSync(f, "utf8").slice(0, 100000);
const r = compress(text);
const dstep = r.steps.find(s => s.method.startsWith("structured-digest") && s.compressed);
console.log(`compressed=${r.compressed} ${r.originalSize}->${r.compressedSize} digestStep=${!!dstep}`);
console.log(`strongSymbolRatio check: 总行数=${text.split("\n").length}`);
if (dstep) {
  const lines = dstep.text.split("\n");
  console.log(`--- digest 抽出的信号行(前 20)---`);
  for (const l of lines.slice(0, 20)) console.log(l.slice(0, 150));
  console.log(`... 共 ${lines.length} 行输出`);
}
