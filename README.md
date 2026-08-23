# opencode Harness 实时可视化

一个**零依赖**的本地网页程序：在网页输入提示词 → 驱动**真实的 opencode 二进制**在
**真实项目目录**里执行任务 → 把 harness（agentic loop）的内部事件流在网页上**实时动态可视化**。

## 启动

```bash
npm start          # 等价于 node server.mjs（不要用 Start-Process -RedirectStandardOutput 包裹，会占住父 shell 管道）
# 打开 http://127.0.0.1:4577
```

点「演示任务」会自动填入一个真实任务（列出 `src/` 文件并修 README 错别字），它会真实触发
`glob` → `read` → `edit` 工具链。隔离配置里 `edit: "ask"`，所以 `edit` 会触发**权限询问**：
harness 挂起等待（`Permission.ask` 的 Deferred），网页弹窗点「允许一次 / 总是允许 / 拒绝」后流程继续。

界面三栏：
- 左：**流程图**——含 runLoop 循环回边（结果回灌→下一轮）、工具分支判断、权限门、task 子代理子流程，节点实时高亮并标注源码 file:line。
- 中：**实时转写**——user / assistant 流式文本 / 工具调用卡片（入参、结果、状态）。
- 右：**LLM 调用明细**——每一次模型调用的完整提示词（system + messages + tools）、发生时机、耗时、响应摘要（点击展开）。由本地 LLM 代理捕获。

## 原理

```
浏览器 ──POST /api/run──▶ server.mjs ──POST /session + /session/{id}/message(发后即忘)─▶ opencode serve (子进程)
浏览器 ◀─GET /api/stream(SSE)─ server.mjs ◀──GET /global/event(SSE 实时事件流)──────────┤
浏览器 ──POST /api/permission────────────▶ POST /permission/{id}/reply（回答权限询问）  │
opencode ──模型请求──▶ LLM 代理 :45322（记录完整提示词/响应/耗时）──▶ https://api.minimaxi.com/anthropic/v1
```

- opencode `serve` 以子进程方式拉起，REST API 为 v2（`packages/sdk/js/src/v2/gen/sdk.gen.ts`）。
- 事件来自 `GET /global/event`（GlobalBus 广播，无目录过滤；格式 `{directory, payload:{id,type,properties}}`，
  `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts`）。
  注意：`/event` 端点有 `location.directory` 严格相等过滤，路径表示不一致时会丢事件，故用 `/global/event`。
- 模型调用捕获：隔离配置把 MiniMax provider 的 `api` 指向本地代理（`data/models.json`），
  代理解析每次调用的 `system/messages/tools` 与 SSE 响应（完整 text / thinking / tool_use+入参 / stop_reason / usage），再原样转发。
- 所有事件同时落盘 `data/events.jsonl`，方便事后排查。
- 刷新恢复：server 内存保留上次运行的全部事件（`GET /api/last-run`），页面加载时回放重建现场；
  server 重启后即清空（events.jsonl 仍在磁盘，但不自动回放）。

## 界面交互

- **流程图节点可点击**：点击左侧任意节点，右栏切换为该节点的双 tab 面板——
  - `运行记录`：本次任务该节点的关键输入/输出按时间顺序逐条记录，点击展开完整详情
    （LLM 节点含完整提示词与完整响应；工具调度的记录会在执行完成后自动回填输出）。
  - `节点说明`：该节点的关键流程逻辑 + 关键输入/输出表格 + 源码定位。
  - 虚线框 = runLoop 循环体范围，框内为每一轮的完整流程；③ runLoop 循环体节点位于虚线框上部，
    表示「先判断再循环」（与实际一致：每轮开头 prompt.ts:1111 先做退出判定）。
    框内两个判断菱形：「可退出循环?」（:1111 退出判定）与「模型请求工具?」（llm.stream 内部
    step loop，工具结果回灌④后继续生成）；③b 为每轮的子代理/压缩/溢出子流程节点。
- **三栏拖拽调宽**：左/中/右栏之间有分隔条，按住左右拖动即可改变宽度（300px ~ 55% 视口）。

## 与你现有 opencode 的隔离（互不影响）

子进程使用完全独立的环境，**不触碰**你日常使用的 opencode 配置、数据库与模型缓存：

| 环境变量 | 指向 | 作用 |
|---|---|---|
| `OPENCODE_CONFIG_DIR` | `data/config` | 独立配置（默认模型 `minimax-cn-coding-plan/MiniMax-M3`） |
| `OPENCODE_DB` | `data/opencode.db` | 独立 SQLite 数据库 |
| `OPENCODE_MODELS_PATH` | `data/models.json` | 本地模型目录快照（仅 MiniMax），不联网拉取 |
| `OPENCODE_DISABLE_MODELS_FETCH` | `1` | 禁止联网刷新模型目录 |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | `1` | 不读取任何项目的 `.opencode` 配置 |
| `OPENCODE_SERVER_PASSWORD` | `viz-local-secret` | 给 serve 加 Basic 鉴权 |
| 端口 | `45321` | 与你日常使用的端口不冲突 |
| 工作目录 | `target-project/` | opencode 只在这个目录里读写 |

你的 `MINIMAX_API_KEY` 环境变量仅被**转发**进该子进程，不落盘、不修改。

## 模型

- 默认：`minimax-cn-coding-plan/MiniMax-M3`（国内 coding-plan 端点 `https://api.minimaxi.com/anthropic/v1`，免费）。
- 页面右上角下拉可切换其他 MiniMax 模型（M2 / M2.1 / M2.5 / M2.7 / highspeed 变体）。
- 注：你提到的免费 `hy3` 实为腾讯混元 3，不在 MiniMax provider 下；MiniMax token plan 的全部模型本身即免费（cost=0），故默认直接用 `MiniMax-M3`。

## 目录

```
harness-viz/
  server.mjs          零依赖 Node 后端（拉起隔离 opencode serve + REST/SSE 桥接）
  index.html          中文前端（泳道实时高亮 + 转写 + 权限弹窗 + 事件日志）
  package.json        npm start
  README.md           本文件
  target-project/     真实演示项目（opencode 实际操作的目录）
  data/
    config/opencode.json   隔离配置
    models.json            本地模型目录快照（MiniMax only）
    opencode.db            运行时生成的隔离数据库
```

## harness 11 步流程（源码定位）

| # | 步骤 | 源码（`packages/opencode/src`） |
|---|---|---|
| 1 | 提示词受理 | `session/prompt.ts:1052 SessionPrompt.prompt` / `core session/input.ts:41 admit` |
| 2 | 载入历史 · 循环启动 | `session/prompt.ts:1081 runLoop`、`1092 filterCompactedEffect` |
| 3 | 装配工具与系统提示 | `session/tools.ts:41 SessionTools.resolve` |
| 4 | 模型流式输出 | `session/llm.ts → AI SDK streamText` |
| 5 | 工具调用登记 | `session/processor.ts:331 ensureToolCall`（doom-loop 守卫 :358） |
| 6 | 权限求值 | `permission/index.ts:67 ask`（deny / allow / ask + Deferred 挂起 :100） |
| 7 | 权限答复 | `permission/index.ts:109 reply`（once/always/reject） |
| 8 | 工具执行完成 | `session/processor.ts:160 completeToolCall` |
| 9 | 结果回灌模型 | AI SDK 多步；`prompt.ts:1272 handle.process` 下一轮 |
| 10 | 循环退出 | `prompt.ts:1111`：assistant 的 finish 为终止性原因（∉{tool-calls, unknown}）且无待执行工具 → break；其余退出路径见下方「runLoop 详解」 |
| 11 | 收尾 | `prompt.ts:1338 compaction.prune`，终态经事件流渲染 |

## runLoop 详解（`session/prompt.ts:1081-1341`）

**每一轮做什么**（`while (true)`）：
1. `status=busy`；从 SQLite 重载完整历史（`filterCompactedEffect`，:1092）
2. **顶部退出检查**（:1111）：上一条 assistant 消息 finish 终止性 + 无待执行工具 + 属于当前 user 消息 → `break`
3. `step++`（第 1 步并行起标题/摘要生成）；处理任务队列：子代理（`handleSubtask`）、压缩、溢出检查
4. 取 agent/model；`maxSteps = agent.steps ?? Infinity`，到最后一步则在末尾追加 MAX_STEPS_PROMPT 逼模型收尾（:1281）
5. 落库空的 assistant 消息（:1201）→ `SessionTools.resolve` 装配工具（:1226）→ 构建 system + modelMessages（:1257-1269）
6. `handle.process`（:1272）→ `llm.stream` → AI SDK `streamText`：**单次调用内部可自行多步**（模型→工具→模型…直到 finish），step-start/step-finish 即其内部步
7. `process` 返回（`processor.ts:679-681`）：`continue` 继续下一轮 / `stop` → break / `compact` → 建压缩任务后 continue

**退出条件（全部路径）**：
| 退出路径 | 触发 | 源码 |
|---|---|---|
| 正常完成 | finish 终止性（stop/end_turn…）且无工具调用 | `prompt.ts:1111-1130` |
| 权限/问题被拒绝 | reply=reject → `ctx.blocked` → process 返回 "stop" | `processor.ts:200-202, 679`（除非 `experimental.continue_loop_on_deny`） |
| 错误 / 中断 | `assistantMessage.error`（重试耗尽、abort）→ "stop" | `processor.ts:679`、`prompt.ts:1203-1211` |
| maxSteps 兜底 | 追加 MAX_STEPS_PROMPT 让模型不再发工具，从而命中「正常完成」 | `prompt.ts:1178-1179, 1281` |
| structured output | json_schema 模式拿到结果即 break | `prompt.ts:1288-1293` |

> 所以「没有工具调用」是**正常完成**的必要条件之一，完整表述是：**模型自己收尾（finish 终止性）且没有待执行的工具调用**。finish==="tool-calls" 表示模型还在等工具结果，循环继续。
