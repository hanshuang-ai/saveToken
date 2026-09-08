/**
 * classifier.ts —— 内容分类路由器
 *
 * 判定单条内容是 structured / prose / mixed。
 * hook 据此决定压不压:structured→压,prose→放行,mixed→分段。
 *
 * 通用启发式信号(不依赖任何标记格式,对代码/日志/JSON/HTML/LaTeX/纯文本通用):
 *   - 强符号密度:{} ; 占比高 → 结构化(代码/JSON/CSS,散文几乎为零)
 *   - 标记标签密度:<tag> 出现频率 → 结构化(HTML/XML 真实标签,非 Markdown 软标记)
 *   - 行结构相似度:大量等长/前缀相似行 → 结构化(日志)
 *   - JSON 合法性:能解析为对象 → 结构化
 *   - ANSI 码:有 → 结构化(CLI 输出)
 *   - 自然语言密度:高频虚词/常用字 + 全角标点 → 散文
 *
 * 安全侧倾斜(最高优先级):散文绝不误判为 structured。
 *   散文误判比结构化漏判危险得多——散文被压会失真,结构化漏压只是没省。
 *   故:只要有明显自然语言迹象,structuredScore 必须足够强才允许 mixed,绝不直接 structured。
 *
 * 设计依据:BLOG 全量扫描基线评估(见 tests/evaluate.ts)。
 *   旧版用 code-keywords / 代码围栏 / Markdown 标题等偏科信号,
 *   且 PROSE_MARKERS 缺 g flag 导致散文检测失效,散文误判率 31.9%。
 *   新版:删偏科信号,换通用结构化度信号,修复 prose 检测。
 */

import type { ContentType } from "./types";
import { decisionLog } from "./decision-log";
import { extFilter } from "./ext-filter";

export interface ClassifyInput {
  /** 工具输出文本 */
  text: string;
  /** 工具名(可选,辅助判断) */
  tool?: string;
  /** mime 类型(可选) */
  mime?: string;
  /** 来源文件路径(可选,扩展名/文件名快筛 + 决策日志用)。Bash stdout 无路径 */
  path?: string;
}

export interface ClassifyResult {
  type: ContentType;
  /** 置信度 0-1 */
  confidence: number;
  /** 命中的信号(调试/度量用) */
  signals: string[];
}

/** 明确结构化的工具(无论内容长短) */
const STRUCTURED_TOOLS = new Set(["Bash", "Read", "Grep", "Glob"]);

const ANSI_RE =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

/**
 * 二进制内容检测。
 *
 * 判据(参考 git 的 binary detection):
 *   - 含 NUL 字节(\x00)→ 几乎必是二进制(纯文本永不出现)
 *   - 前 2KB 里控制字符(除 \n \r \t 外的 <32 字符)占比 >10% → 编码/压缩数据
 *
 * 只扫前 2KB:大文件全扫太慢,头部足够表征。日志/代码/散文头部不可能高密度控制字符。
 */
function isBinary(text: string): boolean {
  if (text.includes("\x00")) return true;
  const head = text.slice(0, 2048);
  let bad = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i);
    if (c < 32 && c !== 10 && c !== 13 && c !== 9) bad++;
  }
  return bad / Math.max(1, head.length) > 0.1;
}

/**
 * 自然语言标记(散文信号)。
 *
 * 关键:g flag 必须有。不带 g 时 text.match() 只返回首个匹配,
 * 散文检测会严重失效(旧版 bug,散文误判率 31.9% 的根因)。
 *
 * 选词原则:代码里几乎不出现,散文里高频。
 *   - 中文虚词/常用字 + 全角标点:鉴别力最强,代码(ASCII)几乎不含,无需词边界
 *   - 英文虚词只留"代码罕见、散文高频"的:冠词/be动词/情态动词/连词,
 *     且必须带 \b 词边界——否则 the 匹配 there、is 匹配 this、an 匹配 any
 *     (去掉 this/that/which/with/from/of/in/for/if/do/will 等代码高频词)
 *   - 不用 ASCII 标点(,.;:),代码也用;改用中文全角标点(，。、；)
 *   - 英文句末标点+空白(\\.[空白] ![空白] ?[空白]):散文句尾高频,
 *     代码 .method() 是方法调用无空格,几乎不触发——补英文散文虚词稀疏的短板
 */
const PROSE_MARKERS =
  /[，。、；：！？]|的|是|和|与|或|了|在|有|不|这|那|也|都|就|还|又|被|把|给|因为|所以|虽然|但是|因此|如果|可以|需要|应该|\b(?:the|an|is|are|was|were|been|being|has|have|had|would|could|should|might|must|because|although|however|therefore|very|more|most|some|any|each|every|both|also|only|just|really)\b|\.\s+|!\s+|\?\s+/g;

/**
 * 强散文信号(用于局部散文段检测)。
 *
 * 比 PROSE_MARKERS 严格得多,只保留二进制乱码几乎不可能稳定命中的:
 *   - 中文虚词/常用字 + 全角标点(特定 Unicode 码点序列,随机字节凑不出)
 *
 * 不含英文虚词:实测发现二进制乱码里 `an`/`is`(0x61 0x6e 等)作为字节序列
 * 出现概率不低,词边界在乱码里也易满足,会把含乱码段的 30MB 日志误判 mixed。
 * 英文散文靠整体 proseRatio(PROSE_MARKERS,含英文虚词)在纯英文场景判定,
 * 不靠局部 prose-lines——纯英文日志乱码段不会被判 mixed,是可接受的权衡。
 */
const PROSE_STRONG =
  /[，。、；：！？]|的|是|和|与|或|了|在|有|不|这|那|也|都|就|还|又|被|把|给|因为|所以|虽然|但是|因此|如果|可以|需要|应该/g;

export function classify(input: ClassifyInput): ClassifyResult {
  const { text, tool } = input;
  const signals: string[] = [];

  if (text.length === 0) {
    const r = { type: "empty" as ContentType, confidence: 1, signals: ["empty"] };
    decisionLog.record(text, r, { path: input.path, tool }, Date.now());
    return r;
  }

  // ─── 前置:二进制检测 ──────────────────────────────────────────────────
  // 真实场景会出现二进制/编码内容(.gz 解压乱码、MTK scp 日志、压缩数据)。
  // 这些没有正常散文/结构化信号,会落进"无信号→默认 prose"兜底被放行,
  // 或乱码里的 . / 空格巧合命中散文信号被误判 mixed——两者都导致该压的没压。
  // 二进制内容是机器产出的垃圾数据,既非散文也非正常文本 → 直接判 structured 压掉。
  //
  // 判据(参考 git/jury 的二进制检测):含 NUL 字节,或前 2KB 控制字符占比 >10%
  // (控制字符 = 除 \n \r \t 外的 <32 字符)
  if (isBinary(text)) {
    const r = { type: "structured" as ContentType, confidence: 0.95, signals: ["binary"] };
    decisionLog.record(text, r, { path: input.path, tool }, Date.now());
    return r;
  }

  // ─── 扩展名/文件名快筛(有路径时优先,比内容启发式准且快) ────────────────
  // 数据依据:13167 条决策库反推。第一档(.yml/.log/.html/.json 等)直接 structured,
  // 不读内容——.yml 实测 91% 被内容误判散文,扩展名兜底。
  // 第二档(.md/.txt/.pug 等)给提示但仍内容细判(可能是散文)。
  const extResult = extFilter(input.path);
  if (extResult.type === "structured") {
    const sig = extResult.nameKeywords.length > 0
      ? [`name:${extResult.nameKeywords[0]}`]
      : [extResult.ext ? `ext:${extResult.ext}` : "name"];
    const r = { type: "structured" as ContentType, confidence: 0.9, signals: sig };
    decisionLog.record(text, r, { path: input.path, tool }, Date.now());
    return r;
  }

  const lines = text.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const lineCount = nonEmpty.length;

  // 信号 1:JSON 合法性(强结构化)
  let isJson = false;
  try {
    const parsed = JSON.parse(text.trim());
    isJson = parsed !== null && typeof parsed === "object";
    if (isJson) signals.push("json-valid");
  } catch {
    // 不是合法 JSON
  }

  // 信号 2:强符号密度 —— {} ; 占比(代码/JSON/CSS 特征,散文几乎为零)
  // 不用 ()[]<> :散文的链接/表格/数学符号也会触发,鉴别力差
  const strongSymbols = (text.match(/[{};]/g) || []).length;
  const strongSymbolRatio = strongSymbols / text.length;
  if (strongSymbolRatio > 0.008) signals.push("strong-symbol");

  // 信号 3:标记标签密度 —— <tag> 出现频率(HTML/XML 真实结构化,非 Markdown 软标记)
  // 散文偶有 <example> 等示意标签,但密度低(每 100 字符 <1);HTML 模板整篇高密度
  const markupTags =
    (text.match(/<\/?[a-zA-Z][a-zA-Z0-9]*(\s[^>]*)?\/?>/g) || []).length;
  const markupRatio = markupTags / Math.max(1, text.length / 100);
  if (markupRatio > 1) signals.push("markup-tag");

  // 信号 4:ANSI 码
  const hasAnsi = ANSI_RE.test(text);
  if (hasAnsi) signals.push("ansi");

  // 信号 5:行结构相似度(前 6 字符的前缀重复度)—— 日志/表格特征
  // 关键:先排除项目符号/引用开头的行(- * + > 数字.)——列表散文也有相似前缀,
  // 但那不是结构化。只有非列表行(日志时间戳、JSON 键、表格 |)前缀相似才算。
  const isListLine = (l: string): boolean => {
    const t = l.trimStart();
    return (
      // 无序列表:符号后跟空白 或 非符号字符(覆盖 -✅ 这种非标准写法,排除 --flag / ---)
      /^[-*+](?:\s|[^-*+\s])/.test(t) ||
      /^>\s?/.test(t) || // 引用
      /^\d+[.)]\s/.test(t) // 有序列表
    );
  };
  const structuralLines = nonEmpty.filter((l) => !isListLine(l));
  if (structuralLines.length > 5) {
    const prefixes = structuralLines
      .slice(0, Math.min(50, structuralLines.length))
      .map((l) => l.slice(0, 6));
    const uniq = new Set(prefixes).size;
    const prefixRepeats = 1 - uniq / prefixes.length; // 越高越结构化
    if (prefixRepeats > 0.5) signals.push("line-structured");
  }

  // 信号 6:自然语言密度(散文强信号)。proseRatio = 每 100 字符的散文标记数
  const proseHits = (text.match(PROSE_MARKERS) || []).length;
  const proseRatio = proseHits / Math.max(1, text.length / 100);
  if (proseRatio > 1.5) signals.push("prose-heavy");

  // 信号 7:散文段(局部散文检测)——混合内容里散文被代码稀释,整体 proseRatio 过不了门槛,
  // 但"有没有连续散文段"才是 mixed 的本质。
  //
  // 关键:用 PROSE_STRONG(只含虚词+中文标点,不含英文句末标点 . ! ?)判定散文行。
  // 为什么排除句末标点:二进制乱码里 `. ` `! ` 是随机字节巧合,会大量误触发,
  // 把含乱码段的日志误判 mixed(实测 476MB 日志因乱码 . 误判)。虚词和中文标点
  // 乱码几乎不可能稳定命中——英文虚词要词边界,中文标点是特定 Unicode 码点。
  // 散文行 = 一行内 PROSE_STRONG 命中 >=2;连续 >=3 行才算真散文段。
  let maxConsecProse = 0;
  let curConsec = 0;
  for (const l of nonEmpty) {
    if ((l.match(PROSE_STRONG) || []).length >= 2) {
      curConsec++;
      if (curConsec > maxConsecProse) maxConsecProse = curConsec;
    } else {
      curConsec = 0;
    }
  }
  if (maxConsecProse >= 3) signals.push("prose-lines");

  // 工具信号
  if (tool && STRUCTURED_TOOLS.has(tool)) signals.push(`tool:${tool}`);

  // ─── 判定(安全侧倾斜:散文宁可放过) ────────────────────────────────────

  // structuredScore:结构化证据强度。任一强信号即可独立成立(均 1.5+)
  const structuredScore =
    (isJson ? 2 : 0) +
    (signals.includes("strong-symbol") ? 1.5 : 0) +
    (signals.includes("markup-tag") ? 1.5 : 0) +
    (hasAnsi ? 1.5 : 0) +
    (signals.includes("line-structured") ? 1.5 : 0);

  // proseScore:散文证据强度。prose-heavy 一旦触发(proseRatio>1.5)即起算 0.6,
  // 确保任何有明显自然语言迹象的内容都进入散文保护(不被零星结构化符号压成 structured)。
  // 英文散文虚词密度低,proseRatio 常 1.5~2,门槛必须足够低才保护得到。
  const proseScore = proseRatio > 1.5 ? 0.6 + (proseRatio - 1.5) * 0.8 : 0;

  // hasProse:整体散文密度高(proseScore) 或 有连续散文段(prose-lines)。任一即视为含散文。
  const hasProse = proseScore >= 0.6 || signals.includes("prose-lines");

  let type: ContentType;
  let confidence: number;

  // 安全侧核心:hasProse(有散文迹象)时,结构化证据必须足够强(>=1.5)才允许 mixed,
  // 绝不直接 structured;结构化不够强则判 prose
  if (hasProse && structuredScore >= 2.5) {
    // 强结构化 + 强散文共存
    type = "mixed";
    confidence = 0.7;
  } else if (hasProse && structuredScore >= 1.5) {
    // 结构化段 + 散文共存
    type = "mixed";
    confidence = 0.6;
  } else if (proseScore >= 0.6) {
    // 散文主导,结构化证据弱 → prose(安全侧)
    type = "prose";
    confidence = Math.min(1, 0.6 + (proseScore - 0.6) * 0.2);
  } else if (signals.includes("prose-lines") && structuredScore < 1.5) {
    // 有散文段但结构化弱 → prose
    type = "prose";
    confidence = 0.55;
  } else if (structuredScore >= 2) {
    // 无散文,结构化证据明确
    type = "structured";
    confidence = Math.min(1, structuredScore / 3);
  } else if (structuredScore >= 1.5) {
    // 单一强结构化信号且无散文 → 结构化(低置信)
    type = "structured";
    confidence = 0.5;
  } else {
    // 既无结构化证据也无明显散文 → 默认 prose(安全侧)
    type = "prose";
    confidence = 0.5;
  }

  const result = { type, confidence, signals };
  // 记录决策(日志未开启时为空操作,不影响性能)
  decisionLog.record(text, result, { path: input.path, tool }, Date.now());

  return result;
}
