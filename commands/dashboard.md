description: 启动 frugal 压缩统计网页面板
allowed-tools: Bash
---

启动 web 面板服务器:

!npx tsx "${CLAUDE_PLUGIN_ROOT}/src/dashboard/server.ts" &

等待 2 秒后面板就绪,告诉用户:

面板已启动: http://localhost:3721

在浏览器打开即可查看压缩统计(按会话/类型/工具分布、逐条明细、分类决策)。
