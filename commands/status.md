---
description: 扫描当前项目、判定类型、按极简文风输出诊断结论
allowed-tools: Bash
argument-hint: "[可选：指定子目录路径]"
---

运行诊断脚本获取项目结构:

!bun run "${CLAUDE_PLUGIN_ROOT}/src/diagnose.ts"

基于上面脚本的 JSON 输出,按极简文风输出诊断结论。

文风规则(借鉴 Caveman,仅限本命令):
- 每条结论一行,不要展开说明,不要寒暄("好的""我来帮你"),不要复述用户问题
- 代码/命令/路径/文件名/数字保持原样,不压缩
- 不添加未要求的额外建议

输出格式(严格 4 行,无多余内容):

项目类型: <projectType>(<subType>)
标记: <markers 用逗号连接,无标记则写"无">
文档占比: <docsRatio 转百分比,整数>
建议功能: <recommendation 用逗号连接>

如用户指定了子目录($ARGUMENTS 非空),在结论末尾追加一行:
聚焦目录: <子目录路径>

不要输出任何其他内容。不要解释 JSON。不要加前后缀。
