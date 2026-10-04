# 维护约定

- `src/` 是后端，`public/` 是网页，`config/settings.json` 是用户配置；不要重新把配置放进运行目录。
- `examples/demo/` 是只读模板。默认演示执行于 `.runtime/workspace/` 副本，不得修改模板来伪造成功。
- `.runtime/` 保存认证、日志、trace、测试输出；全部忽略，不提交。测试代码放 `tests/`，验证脚本放 `scripts/`。
- `npm start` 启动；`npm test` 不调用模型；`npm run test:integration` 会调用真实模型并产生费用。
- 浏览器检查：`npm run test:browser -- ".runtime/verification/<run>"`。加 `--record` 可生成公开演示素材，需要 Chromium 和 ffmpeg；发布前检查是否含敏感内容。
- 后端/配置改动需重启；网页每次请求读取。PowerShell 5.1 不支持 `&&`，不要用输出重定向占住常驻进程的父 shell。
- CLI 探测与执行必须同一入口；版本锚点在 `src/versions.json`，前端 `SOURCE_PINS` 与它保持一致。不要修改上游源码迁就观察器。
- 默认 Codex 为官方 `gpt-6.1-sol` + 原生 trace；第三方和 OpenCode 使用 `MiniMax-M3.1-Flash-Preview`。Preview 限制来自 [官方 Messages API](https://platform.minimax.io/docs/api-reference/text-chat-anthropic.md)，不得沿用 M3 价格或伪造价格。
- 原始请求、响应与事件必须保留来源；区分直接观测、边界捕获和推断。不用请求数、消息数或 turn 数冒充内部迭代数。
- 工具可在流期间执行；OpenCode compaction 标记不代表完成，task 工具不等于 preflight SubtaskPart，idle 不代表成功。reasoning/text delta 按 part 类型分类。
- Codex 续接可只含增量 input；工具定义可在 `additional_tools`。缺失不表示零工具；stop hooks 可续行，完成事件不反推分支。
- 不恢复宽泛 PowerShell allow 规则。隔离目录不是完整安全沙箱；Codex 原生模式复制用户认证，但不修改源认证/config。
- 页面两张流程图内部坐标统一 `700x1070`，节点固定高 `64px`；共享样式用 `.flowsvg`，每张 SVG 自带 marker；Codex 节点以 `c-` 开头。
