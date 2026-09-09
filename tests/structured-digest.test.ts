/**
 * structured-digest.test.ts —— 结构化信号提取原语测试(借鉴 CCE 第 1 项)
 *
 * 验证:
 *   1. 噪声主导的测试输出 → 抽出 FAIL/error/堆栈/摘要行,省略 PASS 噪声
 *   2. 代码(高符号密度)→ 不启用,回退 snip
 *   3. 短输出(<minLines)→ 不启用
 *   4. 全信号 grep(>35% 信号)→ 不启用,回退 snip
 *   5. size guard:摘要不比原文短才压缩(永不劣化)
 *   6. 往返:decompress 还原严格相等全文
 *   7. 存取:digest-handle 全文可取回,行号对齐
 *   8. 聚合管道:compress() 含 digest 步骤往返
 *
 * 运行:bun test
 */

import { test, expect } from "bun:test";
import {
  structuredDigestCompress,
  structuredDigestDecompress,
} from "../src/compress/structured-digest";
import { compress, roundTripEqual } from "../src/compress";
import { FIXTURES } from "./fixtures";

const testRunner = FIXTURES.find((f) => f.name === "test-runner")!.content;

// ─── 命中:测试运行器输出 ─────────────────────────────────────────────────────

test("digest: 测试输出抽出失败信号行,省略 PASS 噪声", () => {
  const r = structuredDigestCompress(testRunner);
  expect(r.compressed).toBe(true);
  expect(r.method).toBe("structured-digest");
  // 必含失败测试名(✗ 行)
  expect(r.text).toContain("snip.test.ts");
  expect(r.text).toContain("format-strip.test.ts");
  // 必含错误/断言信号
  expect(r.text).toMatch(/AssertionError|error/i);
  // 必含堆栈帧
  expect(r.text).toContain("[L");
  // 必含摘要计数
  expect(r.text).toMatch(/\d+\s*failed/i);
  // 体积显著下降(原文 ~350 行,摘要应远小)
  expect(r.compressedSize).toBeLessThan(r.originalSize / 2);
  // 不含 PASS 噪声行(✓ dispatcher 的 200 行不该全进来)
  expect((r.text.match(/✓ src\/core\/dispatcher/g) || []).length).toBe(0);
});

test("digest: handle 存全文,行号对齐", () => {
  const r = structuredDigestCompress(testRunner);
  expect(r.handle).toBeDefined();
  expect(r.handle).toMatch(/^digest-/);
  // decompress 还原严格相等全文
  const restored = structuredDigestDecompress(r);
  expect(restored).toBe(testRunner);
});

// ─── 不启用:代码(高符号密度) ────────────────────────────────────────────────

test("digest: 代码不启用(留给 snip+codegraph)", () => {
  const code = FIXTURES.find((f) => f.name === "code")!.content;
  const r = structuredDigestCompress(code);
  expect(r.compressed).toBe(false);
  expect(r.method).toBe("structured-digest:noop");
});

// ─── 不启用:短输出 ──────────────────────────────────────────────────────────

test("digest: 短输出不启用", () => {
  const short = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const r = structuredDigestCompress(short);
  expect(r.compressed).toBe(false);
});

// ─── 不启用:全信号 grep(>35% 信号) ───────────────────────────────────────────

test("digest: 全信号 grep 输出不启用(留 snip)", () => {
  // 每行都是 file:line:content 形式,但含 error 关键词 → 全是信号行
  const grep = Array.from(
    { length: 100 },
    (_, i) => `src/file${i}.ts:${i + 1}:7 error TS1234: cannot find name 'foo${i}'`
  ).join("\n");
  const r = structuredDigestCompress(grep);
  expect(r.compressed).toBe(false);
  expect(r.method).toBe("structured-digest:noop");
});

// ─── 不启用:无信号 ──────────────────────────────────────────────────────────

test("digest: 全 PASS 无信号不启用(留 snip 展示形状)", () => {
  const allPass = Array.from({ length: 200 }, (_, i) => `✓ test-${i}`).join("\n");
  const r = structuredDigestCompress(allPass);
  expect(r.compressed).toBe(false);
});

// ─── size guard ─────────────────────────────────────────────────────────────

test("digest: size guard — 信号行太多时若摘要不短则不压缩", () => {
  // 构造:大量行,每行都是不同信号(摘要后可能不比原文短)
  // 但 30% 密度(< 35% 阈值)→ 进组装,然后 size guard 兜底
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) {
    lines.push(`✗ failure case number ${i} with a fairly long descriptive message here`);
  }
  for (let i = 0; i < 300; i++) {
    lines.push(`normal noise line ${i}`);
  }
  const input = lines.join("\n");
  const r = structuredDigestCompress(input);
  // 100 信号行 > maxSignalLines(50) → 截断到 50,但仍应比原文短
  // 这里只验证 size guard 语义:若 compressed=true,必比原文短
  if (r.compressed) {
    expect(r.compressedSize).toBeLessThan(r.originalSize);
  }
});

// ─── 聚合管道往返 ───────────────────────────────────────────────────────────

test("compress: 含 digest 的聚合管道往返相等", () => {
  // testRunner 经 format-strip → digest(命中)→ snip(noop)
  expect(roundTripEqual(testRunner)).toBe(true);
});

test("compress: digest 命中后 snip 不叠加", () => {
  const r = compress(testRunner);
  // 应有 digest 步骤
  const digestStep = r.steps.find((s) => s.method.startsWith("structured-digest"));
  expect(digestStep).toBeDefined();
  expect(digestStep!.compressed).toBe(true);
  // digest 命中后文本已短,snip 应 noop
  const snipStep = r.steps.find((s) => s.method.startsWith("snip"));
  if (snipStep) expect(snipStep.compressed).toBe(false);
});

// ─── 可关闭 ─────────────────────────────────────────────────────────────────

test("compress: enableStructuredDigest=false 时走 snip", () => {
  const r = compress(testRunner, { enableStructuredDigest: false });
  const digestStep = r.steps.find((s) => s.method.startsWith("structured-digest"));
  expect(digestStep).toBeUndefined();
  const snipStep = r.steps.find((s) => s.method.startsWith("snip"));
  expect(snipStep).toBeDefined();
});

// ─── 对抗性探针:假阳性必须 noop(防御纵深)────────────────────────────────
// 这些是结构性检测要挡掉的假阳性类:散文/HTML/二进制/JSON 里对 fail/error 的"提及"。
// 即便分类器守卫泄漏(prose 被误判 structured),digest 也不该 engage。

test("digest: HTML 内容提及 fail/error 不启用(<p>内提及非结构信号)", () => {
  // 50 行 HTML,内容里写 "fails"/"error",但行首是 <p> 标签
  const html = Array.from(
    { length: 50 },
    (_, i) => `<p>If step ${i} fails, the error is shown here.</p>`
  ).join("\n");
  const r = structuredDigestCompress(html);
  expect(r.compressed).toBe(false);
  expect(r.method).toBe("structured-digest:noop");
});

test("digest: 二进制(控制字符)不启用(避免字节里散落的 fail 误命中)", () => {
  // 50 段,每段含 NUL/控制字符 + "error fail warning" 字节
  const bin = Array.from(
    { length: 50 },
    (_, i) => `\x00\x01\x02\x03 error${i} fail${i} warning${i}`
  ).join("\n");
  const r = structuredDigestCompress(bin);
  expect(r.compressed).toBe(false);
  expect(r.method).toBe("structured-digest:noop");
});

test("digest: 散文提及 pass/fail/error/⚠ 不启用(防御纵深——守卫泄漏时也不吃散文)", () => {
  // 任务文档,行首是 markdown 列表/强调,内容提到 pass/fail/errors/⚠️ CRITICAL
  const prose = Array.from(
    { length: 50 },
    (_, i) =>
      i % 7 === 0
        ? `**⚠️ CRITICAL**: 确认 token 可用,否则 ${i} 步会 fail,记录 errors`
        : `- [ ] T${i} Verify readability; confirm pass/fail; record errors`
  ).join("\n");
  const r = structuredDigestCompress(prose);
  expect(r.compressed).toBe(false);
  expect(r.method).toBe("structured-digest:noop");
});

test("digest: JSON 串值含 fail 不启用(高符号密度挡住)", () => {
  const json = Array.from(
    { length: 50 },
    (_, i) => `  {"msg": "will fail at provider ${i}", "ok": false},`
  ).join("\n");
  const r = structuredDigestCompress(json);
  expect(r.compressed).toBe(false);
});

// ─── 对抗性探针:真阳性必须命中(结构性检测不丢真信号)──────────────────────

test("digest: 位置前缀诊断(tsc/eslint path:line:col: error)抽出来", () => {
  // 48 行噪声 + 2 行 tsc 错误
  const lines = Array.from({ length: 48 }, (_, i) => `info: building module ${i}`);
  lines.push("src/components/Button.tsx:10:5: error TS2322: Type 'string' is not assignable to 'number'");
  lines.push("src/utils/helper.ts:42:3: error TS2304: Cannot find name 'foo'");
  const tsc = lines.join("\n");
  const r = structuredDigestCompress(tsc);
  expect(r.compressed).toBe(true);
  expect(r.text).toContain("TS2322");
  expect(r.text).toContain("TS2304");
  // 噪声行不该进摘要
  expect((r.text.match(/info: building module/g) || []).length).toBe(0);
});

test("digest: 日志型行(时间戳+级别 E/W)抽出来,info 级别不抽", () => {
  // Android 风格日志:E/W 是信号,I 是噪声
  const lines = Array.from({ length: 40 }, (_, i) => `09-04 18:54:1${i % 10}.123 100 200 I Service: started ok ${i}`);
  lines.push("09-04 18:54:17.872 2283 2283 E Offline_C928: getOfflineData: fail ! retry in 1s");
  lines.push("09-04 18:54:18.610 797 3052 I EvsService: CpuMonitor: warning level : 150.");
  const log = lines.join("\n");
  const r = structuredDigestCompress(log);
  expect(r.compressed).toBe(true);
  expect(r.text).toContain("Offline_C928"); // E 级信号
  // I 级噪声行不该作为信号(注:warning 词可能被 (B) 词级匹配,但这里测 E 级真信号在)
});

test("digest: HTML 文档内嵌 <script> 的 i18n 键(error:'...')不启用", () => {
  // 模拟 Hexo 生成 HTML:大量 <div>/<p> 标签 + 内嵌 <script> i18n 对象 error 键
  const lines: string[] = ['<!DOCTYPE html>', '<html><body>'];
  for (let i = 0; i < 40; i++) lines.push(`<div class="row${i}">content ${i}</div>`);
  lines.push('<script>', "  const i18n = {", "    error: '复制错误',", "    warning: '低电量',", "  };", '</script>');
  lines.push('</body></html>');
  const html = lines.join("\n");
  const r = structuredDigestCompress(html);
  expect(r.compressed).toBe(false);
  expect(r.method).toBe("structured-digest:noop");
});
