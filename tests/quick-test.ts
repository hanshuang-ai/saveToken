/**
 * quick-test.ts —— 快速本地压测
 *
 * 不依赖 Claude Code,直接跑 classify→compress 管道验证:
 *   1. 分类正确性(prose 放行 / structured 压缩)
 *   2. 压缩比
 *   3. 往返校验(compress→decompress 语义等价)
 *
 * 用法: npx tsx tests/quick-test.ts
 */

import { classify } from "../src/core/classifier.ts";
import { compress, roundTripEqual } from "../src/compress/index.ts";

interface TestCase {
  name: string;
  tool: string;
  path?: string;
  text: string;
}

const cases: TestCase[] = [
  {
    name: "JSON输出",
    tool: "Bash",
    text: JSON.stringify(
      {
        users: Array.from({ length: 500 }, (_, i) => ({
          id: i,
          name: "user_" + i,
          email: "u" + i + "@test.com",
          role: i % 5 === 0 ? "admin" : "member",
        })),
      },
      null,
      2
    ),
  },
  {
    name: "日志输出",
    tool: "Bash",
    text: Array.from(
      { length: 1000 },
      (_, i) =>
        "2026-01-01 10:00:" +
        String(i).padStart(2, "0") +
        " INFO  Processing task #" +
        i +
        " - result: OK, latency: 12ms"
    ).join("\n"),
  },
  {
    name: "grep结果",
    tool: "Grep",
    text: Array.from(
      { length: 2000 },
      (_, i) =>
        `src/file_${i}.ts:${i + 10}:  const ${
          "x".repeat(20 + Math.floor(Math.random() * 30))
        } = () => {`
    ).join("\n"),
  },
  {
    name: "散文(应放行)",
    tool: "Read",
    text: "## Chapter 1\n\nthe quick brown fox jumps over the lazy dog. ".repeat(800),
  },
  {
    name: "HTML模板",
    tool: "Read",
    path: "/app/templates/index.html",
    text: "<html>\n" + Array.from({ length: 300 }, (_, i) => `  <div class="item-${i}"><p>content ${i}</p></div>`).join("\n") + "\n</html>",
  },
  {
    name: "测试失败输出",
    tool: "Bash",
    text: Array.from(
      { length: 500 },
      (_, i) =>
        i % 30 === 0
          ? `FAIL test_${i} - expected "foo" got "bar"`
          : `PASS test_${i} - all good`
    ).join("\n"),
  },
];

console.log("=".repeat(70));
console.log("frugal 快速压测");
console.log("=".repeat(70));

let pass = 0;
let fail = 0;
let totalOriginal = 0;
let totalCompressed = 0;

for (const c of cases) {
  const cls = classify({ text: c.text, tool: c.tool, path: c.path });
  const comp = compress(c.text);
  const pct = ((1 - comp.compressedSize / comp.originalSize) * 100).toFixed(1);
  const rt = roundTripEqual(c.text);

  totalOriginal += comp.originalSize;
  totalCompressed += comp.compressedSize;

  // 散文应该放行
  const proseOk = c.name.includes("散文") ? !comp.compressed : true;
  const rtOk = comp.compressed ? rt : true;

  const status = proseOk && rtOk ? "OK" : "FAIL";
  if (status === "OK") pass++;
  else fail++;

  console.log(
    `[${status}] ${c.name.padEnd(14)} | ${cls.type.padEnd(12)} | ` +
      `${String(comp.originalSize).padStart(7)} → ${String(comp.compressedSize).padStart(7)} ` +
      `省${pct.padStart(5)}% | 信号: ${cls.signals.join(",").padEnd(30)} | ` +
      `往返: ${rt ? "✓" : "✗"}`
  );
}

const overallPct = ((1 - totalCompressed / totalOriginal) * 100).toFixed(1);
console.log("-".repeat(70));
console.log(
  `总计: ${totalOriginal} → ${totalCompressed} 字符, 省 ${overallPct}% | ` +
    `通过 ${pass}/${pass + fail}`
);