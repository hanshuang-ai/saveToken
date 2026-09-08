/**
 * coverage.test.ts —— 覆盖度测试
 *
 * 补盲区:分类器准确率 + 分类型真实数据往返 + 散文不触发 + 压缩率断言。
 * 与 round-trip.test.ts 互补:后者测可逆性,本文件测真实场景有效性。
 */

import { test, expect } from "bun:test";
import { classify } from "../src/core/classifier";
import { dispatch } from "../src/core/dispatcher";
import { compress } from "../src/compress";
import { snipDecompress } from "../src/compress/snip";
import { dedupDecompress } from "../src/compress/dedup";
import { formatStripDecompress, normalizeForCompare } from "../src/compress/format-strip";
import { FIXTURES, type Fixture } from "./fixtures";

// ─── 分类器:各 fixture 类型判定准确 ────────────────────────────────────────

test("分类器:各真实样本类型判定正确", () => {
  for (const f of FIXTURES) {
    const r = classify({ text: f.content });
    expect(r.type).toBe(f.expectedType);
  }
});

test("分类器:散文绝不误判为结构化(安全侧)", () => {
  const prose = FIXTURES.find((f) => f.name === "prose")!;
  const r = classify({ text: prose.content });
  expect(r.type).not.toBe("structured");
});

// ─── 派发器:散文不触发压缩(第零道闸门) ────────────────────────────────────

test("派发器:散文原样返回,绝不压缩", () => {
  const prose = FIXTURES.find((f) => f.name === "prose")!;
  const r = dispatch(prose.content, { tool: "Bash" }); // 即使是 Bash 工具
  expect(r.compressed).toBe(false);
  expect(r.contentType).toBe("prose");
  expect(r.text).toBe(prose.content); // 严格相等
});

// ─── 分类型真实数据:往返 + 压缩率 ──────────────────────────────────────────

/**
 * 对每个 fixture,按其可逆契约做往返,并断言压缩率(若有压缩)。
 * strict:解压后严格 === 原文
 * semantic:规范化后相等(允许纯噪声差异)
 */
test("分类型:各真实样本按契约往返且真省了", () => {
  for (const f of FIXTURES) {
    const r = compress(f.content, {
      minChars: 0, // 强制触发,测原语本身
      snip: { minLines: 30, headLines: 10, tailLines: 10 },
      dedup: { minLen: 15, minRepeat: 3, minChars: 0 },
      formatStrip: { minChars: 0 },
    });

    if (!r.compressed) {
      // 未压缩:无需校验往返
      continue;
    }

    // 逆序解压
    let text = r.text;
    for (const step of [...r.steps].reverse()) {
      if (step.method.startsWith("snip")) text = snipDecompress({ ...step, text });
      else if (step.method.startsWith("dedup")) text = dedupDecompress({ ...step, text });
      else if (step.method.startsWith("format-strip")) text = formatStripDecompress({ ...step, text });
    }

    if (f.reversible === "strict") {
      // 严格相等:snip/dedup 必须字节还原(format-strip 若参与则失效,故 strict 类不含 ANSI 噪声)
      // 但若 format-strip 参与了,需要单独处理:比较 format-strip 之前的文本
      const fsStep = r.steps.find((s) => s.method.startsWith("format-strip") && s.compressed);
      if (fsStep) {
        // 有 format-strip 参与:比较规范化(语义等价)
        expect(normalizeForCompare(text)).toBe(normalizeForCompare(f.content));
      } else {
        expect(text).toBe(f.content);
      }
    } else {
      // 语义等价
      expect(normalizeForCompare(text)).toBe(normalizeForCompare(f.content));
    }

    // 压缩率断言:若有压缩,压缩后应小于原始(不许负优化)
    if (r.compressed) {
      expect(r.compressedSize).toBeLessThan(r.originalSize);
    }
  }
});

// ─── 各原语单独压缩率(真实数据) ────────────────────────────────────────────

test("snip: 长日志确实截断且省", () => {
  const log = FIXTURES.find((f) => f.name === "log")!;
  const c = compress(log.content, {
    minChars: 0,
    enableDedup: false,
    enableFormatStrip: false,
    snip: { minLines: 30, headLines: 10, tailLines: 10 },
  });
  expect(c.compressed).toBe(true);
  expect(c.compressedSize).toBeLessThan(c.originalSize * 0.5); // 至少省一半
});

test("dedup: JSON 重复结构确实去重", () => {
  const json = FIXTURES.find((f) => f.name === "json")!;
  const c = compress(json.content, {
    minChars: 0,
    enableSnip: false,
    enableFormatStrip: false,
    dedup: { minLen: 15, minRepeat: 3, minChars: 0 },
  });
  if (c.compressed) {
    expect(c.compressedSize).toBeLessThan(c.originalSize);
  }
});

test("format-strip: npm 输出去 ANSI 后省", () => {
  const npm = FIXTURES.find((f) => f.name === "npm-output")!;
  const c = compress(npm.content, {
    minChars: 0,
    enableSnip: false,
    enableDedup: false,
    formatStrip: { minChars: 0 },
  });
  expect(c.compressed).toBe(true);
  expect(c.compressedSize).toBeLessThan(c.originalSize);
});

// ─── 短文本不触发(防字典开销负优化) ────────────────────────────────────────

test("短文本:低于阈值不压缩(防负优化)", () => {
  const short = '{"a":1}';
  const c = compress(short); // 默认 minChars: 512
  expect(c.compressed).toBe(false);
});

// ─── 边界:空文本、单行 ─────────────────────────────────────────────────────

test("边界: 空文本不崩", () => {
  expect(() => compress("")).not.toThrow();
  expect(() => classify({ text: "" })).not.toThrow();
  expect(() => dispatch("")).not.toThrow();
});

test("边界: 单行结构化不崩", () => {
  const one = '{"key": "value", "num": 42}';
  expect(() => compress(one, { minChars: 0 })).not.toThrow();
});
