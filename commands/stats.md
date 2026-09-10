---
description: 查看 frugal 压缩统计并启动网页面板
allowed-tools: Bash
---

先启动网页面板(后台运行,端口 3721):

!npx tsx "${CLAUDE_PLUGIN_ROOT}/src/dashboard/server.ts" &

然后运行统计脚本:

!npx tsx "${CLAUDE_PLUGIN_ROOT}/scripts/frugal-stats.ts"

基于统计脚本的输出,直接展示结果。末尾附一行:

网页面板已启动: http://localhost:3721 (浏览器打开查看详细图表)
