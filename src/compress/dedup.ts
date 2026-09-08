/**
 * dedup.ts —— 反向引用原语
 *
 * 把重复出现的长串替换为短引用标记 @n,首次出现保留原文并登记。
 * 完全可逆:解压时把 @n 替换回原文。
 *
 * 灵感:foveance(Aimaghsoodi/foveance)——无损编解码器,省 82% 输入。
 *
 * 触发条件:重复串够长(>= minLen)、出现次数够多(>= minRepeat)。
 * 否则原样返回。只动"结构性重复",散文里的重复词不受影响(因长度门槛)。
 */

import type { Compressed } from "../core/types";

export interface DedupOptions {
  /** 触发替换的最小重复串长度(字符) */
  minLen?: number;
  /** 触发的最小重复次数(含首次) */
  minRepeat?: number;
  /** 触发的最小原始字符数 */
  minChars?: number;
}

const DEFAULTS: Required<DedupOptions> = {
  // minLen 提到 40:跳过中等表达式(如 `decisionLog.record(` 约 18 字)与常见文件路径
  // (多数 ≤40 字符)。设计文档五·甲明确"不压文件路径",dedup 盲目重复检测无法识别
  // 路径,只能靠长度门槛规避。只动"高频长串"(日志时间戳前缀、重复模板)。
  // 旧值 20 会把代码表达式、import 路径压成 @n,当场可读性极差(虽技术无损)。
  minLen: 40,
  // minRepeat 提到 4:要求更高频,避免偶发 3 次重复就被替换伤可读性。
  minRepeat: 4,
  minChars: 256,
};

export function dedupCompress(input: string, opts: DedupOptions = {}): Compressed {
  const o = { ...DEFAULTS, ...opts };
  const originalSize = input.length;

  if (originalSize < o.minChars) {
    return {
      text: input,
      compressed: false,
      originalSize,
      compressedSize: input.length,
      method: "dedup:noop",
    };
  }

  // 用滑动窗口找重复子串。为控制开销,按固定步长取样候选串。
  // 这是一个保守的实现:只找长度恰好 minLen 的重复串,贪心替换。
  const registry: string[] = []; // index 0 对应 @0
  const seen = new Map<string, number>(); // 串 → registry 下标
  let text = input;
  let replaced = 0;

  // 扫描:以 minLen 为窗口,步长 1,记录每个窗口出现的次数
  const counts = new Map<string, number>();
  for (let i = 0; i + o.minLen <= text.length; i += 1) {
    const sub = text.slice(i, i + o.minLen);
    // 跳过含换行的串(避免跨行引用破坏结构)与空白主导的串
    if (sub.includes("\n") || /^\s+$/.test(sub)) continue;
    counts.set(sub, (counts.get(sub) ?? 0) + 1);
  }

  // 筛出符合阈值的候选(出现次数 >= minRepeat),按出现频次降序
  const candidates = [...counts.entries()]
    .filter(([, c]) => c >= o.minRepeat)
    .sort((a, b) => b[1] - a[1]);

  // 限制候选数量,避免标记表过大
  const MAX_REFS = 32;

  for (const [sub] of candidates) {
    if (registry.length >= MAX_REFS) break;
    // 检查当前文本里还有几个(前面替换可能已改变分布)
    const remaining = text.split(sub).length - 1;
    if (remaining < o.minRepeat) continue;

    const idx = registry.length;
    registry.push(sub);
    const marker = `@${idx}`;
    // 全局替换:但标记本身不能与原文冲突。用 split/join 保证整串替换。
    text = text.split(sub).join(marker);
    replaced += remaining;
    seen.set(sub, idx);
  }

  if (replaced === 0 || registry.length === 0) {
    return {
      text: input,
      compressed: false,
      originalSize,
      compressedSize: input.length,
      method: "dedup:noop",
    };
  }

  // 在文本末尾附登记表(可逆解压需要)。格式紧凑。
  // 注意:登记表本身可能被误解析为正文,故用明确分隔符包裹。
  const table = registry.map((s, i) => `@${i}=${s}`).join("\n");
  const finalText = `${text}\n\n「dedup-table\n${table}\n」`;

  return {
    text: finalText,
    compressed: true,
    originalSize,
    compressedSize: finalText.length,
    method: `dedup:${registry.length}refs/${replaced}reps`,
  };
}

/** 解析登记表的正则 */
const TABLE_RE = /\n\n「dedup-table\n([\s\S]*?)\n」$/;

export function dedupDecompress(compressed: Compressed): string {
  if (!compressed.compressed) return compressed.text;

  const m = compressed.text.match(TABLE_RE);
  if (!m) return compressed.text; // 无登记表,原样返回

  const tableBlock = m[1];
  const body = compressed.text.slice(0, m.index);

  // 解析 @idx=原文。注意原文可能含 "=",故只 split 第一个 "="
  const refs: string[] = [];
  for (const line of tableBlock.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const idx = Number(line.slice(0, eq).replace("@", ""));
    refs[idx] = line.slice(eq + 1);
  }

  // 从高下标往低下标替换,避免 @1 是 @10 的前缀干扰
  // (先替换长标记 @10,再替换 @1)
  let text = body;
  for (let i = refs.length - 1; i >= 0; i--) {
    if (refs[i] === undefined) continue;
    text = text.split(`@${i}`).join(refs[i]);
  }
  return text;
}
