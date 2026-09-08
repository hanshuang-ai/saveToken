/**
 * round-trip.test.ts —— 无损往返测试
 *
 * 契约:解压(压缩(x)) 与 x 语义等价(纯噪声剥离后字节相等)。
 * 覆盖:各原语单独往返 + 聚合管道往返 + fuzz 随机输入。
 *
 * 运行:bun test
 */

import { test, expect } from "bun:test";
import { snipCompress, snipDecompress } from "../src/compress/snip";
import {
  formatStripCompress,
  formatStripDecompress,
  normalizeForCompare,
} from "../src/compress/format-strip";
import { dedupCompress, dedupDecompress } from "../src/compress/dedup";
import { compress, roundTripEqual } from "../src/compress";

// ─── snip 截断往返 ─────────────────────────────────────────────────────────

test("snip: 超长文本截断后可完整还原", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
  const original = lines.join("\n");
  const compressed = snipCompress(original, { minLines: 120, headLines: 10, tailLines: 10 });
  expect(compressed.compressed).toBe(true);
  expect(compressed.handle).toBeDefined();
  const restored = snipDecompress(compressed);
  // snip 是严格相等(中间片段完整存盘)
  expect(restored).toBe(original);
});

test("snip: 短文本不截断", () => {
  const original = "only a few\nlines\nhere";
  const compressed = snipCompress(original);
  expect(compressed.compressed).toBe(false);
  expect(compressed.text).toBe(original);
});

test("snip: 压缩确实减少了体积", () => {
  const lines = Array.from({ length: 500 }, (_, i) => `content line number ${i + 1} here`);
  const original = lines.join("\n");
  const compressed = snipCompress(original);
  expect(compressed.compressedSize).toBeLessThan(compressed.originalSize);
});

// ─── format-strip 去噪往返 ─────────────────────────────────────────────────

test("format-strip: ANSI 码剥离后语义不变", () => {
  const original = "\x1b[32m✓\x1b[0m  passed    \n\x1b[31m✗\x1b[0m failed";
  const compressed = formatStripCompress(original, { minChars: 0 });
  expect(compressed.compressed).toBe(true);
  const restored = formatStripDecompress(compressed);
  // 语义等价:规范化后相等
  expect(normalizeForCompare(restored)).toBe(normalizeForCompare(original));
});

test("format-strip: 短文本不去噪", () => {
  const original = "\x1b[32mok\x1b[0m";
  const compressed = formatStripCompress(original); // minChars 默认 256
  expect(compressed.compressed).toBe(false);
});

test("format-strip: 纯文本无 ANSI 时不误伤", () => {
  const original = "just plain text with spaces    and more".repeat(8);
  const compressed = formatStripCompress(original, { minChars: 0 });
  const restored = formatStripDecompress(compressed);
  expect(normalizeForCompare(restored)).toBe(normalizeForCompare(original));
});

// ─── dedup 反向引用往返 ────────────────────────────────────────────────────

test("dedup: 重复串替换后可严格还原", () => {
  const repeated = "this-is-a-long-repeated-string-token";
  const original = `${repeated} aaa ${repeated} bbb ${repeated} ccc ${repeated}`;
  const compressed = dedupCompress(original, { minLen: 15, minRepeat: 3, minChars: 0 });
  expect(compressed.compressed).toBe(true);
  const restored = dedupDecompress(compressed);
  // dedup 是严格相等
  expect(restored).toBe(original);
});

test("dedup: 无重复时不动", () => {
  const original = "each word here is unique and different from others";
  const compressed = dedupCompress(original, { minLen: 20, minRepeat: 3, minChars: 0 });
  expect(compressed.compressed).toBe(false);
});

// ─── 聚合管道往返 ──────────────────────────────────────────────────────────

test("聚合: 三原语串联后往返语义等价", () => {
  const repeated = "repeated-structural-token-xyz";
  const noisy = `\x1b[32m${repeated}\x1b[0m start\n`;
  const block = `${noisy}${repeated} middle ${repeated} end`;
  const original = block.repeat(8); // 足够长触发各阈值
  expect(roundTripEqual(original, { minChars: 0 })).toBe(true);
});

test("聚合: 短于阈值不压缩且往返通过", () => {
  const original = "short text";
  const r = compress(original);
  expect(r.compressed).toBe(false);
  expect(roundTripEqual(original)).toBe(true);
});

// ─── fuzz 随机输入 ──────────────────────────────────────────────────────────

// 简单确定性伪随机(不用 Math.random):线性同余
function seededRand(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function randomText(n: number, rand: () => number): string {
  const alphabet = "abcde \n\t\x1b[32m\x1b[0m重复token-xyz";
  let out = "";
  for (let i = 0; i < n; i++) {
    out += alphabet[Math.floor(rand() * alphabet.length)];
  }
  return out;
}

test("fuzz: 50 组随机输入往返全部语义等价", () => {
  const rand = seededRand(42);
  for (let i = 0; i < 50; i++) {
    const original = randomText(1000 + Math.floor(rand() * 4000), rand);
    // 某些随机输入可能不触发任何原语,那也算通过
    const ok = roundTripEqual(original, {
      minChars: 0,
      snip: { minLines: 50 },
      dedup: { minLen: 10, minRepeat: 2, minChars: 0 },
    });
    if (!ok) {
      console.log(`FAIL at i=${i} len=${original.length}`);
    }
    expect(ok).toBe(true);
  }
});
