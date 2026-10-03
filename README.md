# harness-viz — opencode / codex Harness 实时可视化

一个**零依赖**的本地网页程序：在网页输入提示词 → 驱动**真实的 opencode 或 codex CLI 二进制**在
**真实项目目录**里执行任务 → 把 harness（agentic loop）的内部事件流在网页上**实时动态可视化**。

页面顶部可切换 **opencode / codex** 两个 harness：各自独立的流程图、实时转写、节点运行记录与说明。
所有节点说明都带源码行号（opencode → `packages/opencode/src`；codex → `codex-rs`），
流程图、文档、源码三者严格一致，并经真实抓包验证（messages/input 项数逐轮增长、stop_reason 序列）。

你能看到什么：

- **agent 循环的真实形状**——循环体、每轮内务检查（子代理/压缩/溢出）、退出判定、回边
- **每次 LLM 调用的完整内容**——system prompt、全部 messages、tools 定义、模型响应（含 thinking、tool_use 入参），由本地代理透明捕获
- **两个 harness 的架构差异**——审批模型（交互弹窗 vs 静态沙箱）、退出信号载体（落库字段 vs 内存计算值）、事件协议（SSE vs JSONL）

## 前置条件

| 依赖 | 说明 |
|---|---|
| Node.js ≥ 18 | 运行 server.mjs（无需任何 npm 依赖） |
| opencode CLI | [opencode.ai](https://opencode.ai)，全局安装即可，**你的日常使用不受影响** |
| codex CLI ≥ 0.147 | `npm i -g @openai/codex`；仅 codex 模式需要 |
| 模型凭据 | 二选一：`MINIMAX_API_KEY` 环境变量（默认配置，[MiniMax 开放平台](https://platform.minimaxi.com)申请）；或 codex 的 ChatGPT 登录 / `OPENAI_API_KEY`（`viz.config.json` 设 `codex.useDefaultModel=true`，无需 MiniMax）；opencode 也可按上文换任意 Anthropic 兼容 provider |

> 默认模型 `MiniMax-M3`（Anthropic 兼容端点）。想换其他 provider/模型：改 `data/config/models.json`
> （opencode）或 `data/codex-home/config.toml` 由 server 启动时重建（codex，见 server.mjs 的
> `CODEX_CONFIG`）——翻译代理的目标端点在 server.mjs 的 `LLM_UPSTREAM`。

### 配置自己的模型（viz.config.json，可选）

运行时**不需要**任何源码——只依赖全局安装的 opencode / codex CLI 二进制。模型配置集中在
`viz.config.json`（仓库自带默认值 = MiniMax 抓包模式）：

```jsonc
{
  "upstream": "https://api.minimaxi.com",   // 翻译代理转发的 Anthropic 兼容上游
  "upstreamEnvKey": "MINIMAX_API_KEY",      // 代理转发时读的环境变量名（值不落盘）
  "codex": {
    "useDefaultModel": false,               // true = codex 用自带默认模型（ChatGPT 登录/OPENAI_API_KEY）
    "model": "MiniMax-M3"
  },
  "opencode": { "model": "minimax-cn-coding-plan/MiniMax-M3" }
}
```

- **codex 最简用法**：把 `codex.useDefaultModel` 改为 `true`——直接用 codex 自带的默认模型
  （ChatGPT 登录态会从 `~/.codex/auth.json` **复制**进隔离目录，绝不动原文件；或设
  `OPENAI_API_KEY`）。此时流量不经过代理，**无提示词捕获**（界面徽标会标明），其余可视化全部可用。
- **codex 走代理抓包**：保持 `false`，`model` 换成任意名（元数据警告可忽略），`upstream` 换成
  任意 **Anthropic 兼容** 端点，`upstreamEnvKey` 换成对应密钥的环境变量名。
- **opencode 换模型/Provider**：编辑 `data/config/models.json`——它就是 opencode 的 provider 定义，
  每个 provider 的 `api` 已指向本地代理 `http://127.0.0.1:45322/anthropic/v1`；新增 provider =
  照抄现有结构改 `id/name/api(保留指向代理)/models`，再把 `viz.config.json` 的
  `opencode.model` 指到 `providerID/modelID`（页面下拉默认选中它）。代理按 `upstream` 转发，
  所以**所有 provider 共用同一个上游**——需要多上游时改 `server.mjs` 的 `LLM_UPSTREAM` 为按
  路径分发即可。

## 快速开始

```bash
npm start        # = node server.mjs
# 打开 http://127.0.0.1:4577
```

1. 顶部选 **opencode** 或 **codex**
2. 点「演示任务」（或自己输入提示词）→ 运行
3. 左栏流程图节点实时高亮；点击任意节点看它的**运行记录**（关键输入/输出）与**节点说明**（源码定位）
4. 中栏实时转写：user / assistant 流式文本 / 工具调用卡片
5. LLM 记录点击展开 = 完整提示词与响应（system prompt 支持复制 / 下载 .md / Markdown 预览）

**演示任务**会真实触发 `glob → read → edit` 工具链（opencode），并因隔离配置 `edit: "ask"`
触发**权限询问**——harness 挂起等待，网页弹窗「允许一次 / 总是允许 / 拒绝」后流程继续。
codex 模式没有权限弹窗：exec 模式审批固定 `Never`，由沙箱 `workspace-write` 静态约束（架构差异，详见下文）。

交互：流程图滚轮缩放（以光标为中心）、空白处拖拽平移、三栏分隔条拖拽调宽、刷新页面自动回放恢复现场（server 内存，重启即清）。

## 界面三栏

- 左：**流程图**——runLoop / run_turn 循环体（虚线框）、内务判断（子代理/压缩/溢出）、退出判定、工具分支、回边；节点实时高亮并标注源码 file:line
- 中：**实时转写**——user / assistant / reasoning / 工具调用卡片（入参、结果、状态、exit_code）
- 右：**节点面板**——双 tab：`运行记录`（该节点按时间序的关键输入/输出，可展开完整详情）+ `节点说明`（关键流程 + 输入/输出表 + 源码定位）

## 原理

```
浏览器 ──POST /api/run──▶ server.mjs ──▶ opencode serve (常驻子进程, REST/SSE)
浏览器 ◀─GET /api/stream(SSE)─ server.mjs ◀──GET /global/event(上游事件流)────┤
浏览器 ──POST /api/permission──▶ POST /permission/{id}/reply（opencode 权限答复）
                                   │
(opencode Anthropic 透传)          │ (codex Responses↔Anthropic 翻译)
模型请求 ──▶ LLM 代理 :45322（捕获完整提示词/响应）──▶ MiniMax 上游
```

- **opencode**：常驻 `serve` 子进程；事件来自 `GET /global/event`（无目录过滤；
  `/event` 端点有 `location.directory` 严格相等过滤会丢事件，故不用）。`POST /session/{id}/message`
  会同步跑完整个 runLoop（遇权限询问挂起）→ 必须**发后即忘**。
- **codex**：每次 run spawn 一次性 `codex exec --json`（stdout JSONL ThreadEvent，
  `codex-rs/exec/src/exec_events.rs:11`）。子进程 `CODEX_HOME=data/codex-home` 隔离，
  config.toml 把 model_provider 指向本代理 `/v1/responses`。codex ≥0.147 只支持
  **Responses API**（`wire_api=chat` 已移除），代理将其**翻译成 Anthropic Messages** 调
  MiniMax，再把响应流翻译回 Responses SSE（最小事件契约依据 `codex-api/src/sse/responses.rs:348`）。
- 所有事件落盘 `data/events.jsonl` 供排查；刷新恢复靠 server 内存（`/api/last-run?harness=`），重启即清。
- 每个事件带**顶层** `harness` 字段（opencode/codex），前端按它路由与回放。

## 源码剖析（图上文档的依据）

### opencode runLoop（`session/prompt.ts:1081-1341`）

**每一轮**：`status=busy`（:1089）→ 从 SQLite 重载历史（:1092）→ **退出判定**（:1111：最后一条
assistant 的 `finish` 终止性 ∉ {tool-calls, unknown} + 无待执行工具 + 属于本轮）→ `step++`（:1132）→
内务检查（有子任务? :1142 → 有压缩任务? :1149 → 溢出? :1161，命中即 continue）→ 装配工具
（:1226）→ 构建 system+messages（:1257）→ `llm.stream`（:1272）→ 流处理+工具执行。

关键事实（抓包实证）：`llm.ts:280 streamText` **无 stopWhen = 单步**，一次 HTTP 调用只产出一个
step；工具结果靠下一轮重载历史回灌。退出信号是**落库的** `assistant.finish` 字段
（`processor.ts:443` 写入 SQLite）。全部退出路径：

| 退出路径 | 触发 | 源码 |
|---|---|---|
| 正常完成 | finish 终止性且无工具调用 | `prompt.ts:1111-1130` |
| 权限被拒绝 | reply=reject → ctx.blocked | `processor.ts:200-202, 679` |
| 错误/中断 | finish=error / abort | `processor.ts:534, 610` |
| maxSteps 兜底 | 追加收尾提示逼模型收尾 | `prompt.ts:1178, 1281` |

### codex run_turn（`codex-rs/core/src/session/turn.rs:153`）

turn 前：`run_pre_sampling_compact`（:169）。**循环体**（:301）：排干插队输入（:305）→ 采集 step
上下文（:334）→ 克隆历史（:370）→ `build_prompt`（:1383）→ `try_run_sampling_request`（:2179）→
POST /responses → SSE 事件循环（:2250），一次 HTTP = 一步。工具调用在 `output_item.done` 被
`handle_output_item_done`（`stream_events_utils.rs:289`）识别（ToolRouter :297 → needs_follow_up=true
:326）并入队（:2391），流末 `drain_in_flight`（:2749→:2130）把结果**写回历史**（:2139）。
退出判定：`needs_follow_up = 工具调用 || 插队输入`（:423，`end_turn=false` 亦置跟进 :2577）；
否 → stop hooks（:502）→ **break**（:549）→ turn.completed → 进程退出。

**实测验证**（演示任务 11 次调用）：input 项数 3→8→11→…→32 逐轮增长，末轮 stop=end_turn 无工具
——与 opencode 同构：工具结果靠下一轮克隆全量历史回灌。

### 两 harness 关键差异

| 维度 | opencode | codex |
|---|---|---|
| 运行形态 | 常驻 serve，REST + SSE | 一次性 exec 进程，stdout JSONL |
| 模型协议 | Anthropic Messages（可配） | 仅 Responses API（0.147 起） |
| 审批 | 运行时交互弹窗（Deferred 挂起） | exec 固定 Never + 沙箱/execpolicy 静态授权（`exec/src/lib.rs:413`） |
| 退出信号 | **落库**的 finish 字段（processor.ts:443） | **内存计算** needs_follow_up（turn.rs:423） |
| 权限弹窗 | 有（permission.ask） | 无（execpolicy 判 Prompt 即拒，`exec_policy.rs:214`；隔离 rules 放行 powershell 包装命令，加载路径 :827） |

### 版本适配

本工具通过**公开 CLI 接口**驱动两个 harness（REST/SSE + stdout JSONL），不侵入上游代码。
页面页头实时显示探测到的 CLI 版本（`opencode --version` / `codex --version`）。

| | 已验证版本 | 适配性 |
|---|---|---|
| opencode | **1.18.21**（2026-08 dev 分支行为） | 依赖 `/global/event` 事件词表与 v2 REST——**小版本升级通常兼容**；若上游改事件 schema 或路由，表现为事件缺失/报错，按 README 故障排查表核对 |
| codex | **0.147.0+** | 依赖 `codex exec --json`（ThreadEvent 词表）与 Responses API（≥0.147 唯一协议）——同族小版本兼容；`wire_api=chat` 已被上游移除，回不去旧版 |

流程图/节点说明里的 `file:line` 是**上述版本的源码锚点**，仅作阅读参考，不影响运行；上游升级后
行号可能漂移（逻辑位置通常稳定），以文档描述的函数名/行为为准重新核对即可。

## 隐私与安全

- **密钥**：`MINIMAX_API_KEY` 只从环境变量读取、只转发给上游模型端点，**不落盘、不入库**（.gitignore 已排除全部运行时数据）。
- **隔离**：opencode 子进程用独立 `OPENCODE_CONFIG_DIR` / `OPENCODE_DB` / `OPENCODE_MODELS_PATH` /
  独立端口 45321 / Basic 鉴权 / 独立工作目录 `target-project/`；codex 子进程用独立
  `CODEX_HOME=data/codex-home`。**不读取、不修改你的真实配置**（`~/.config/opencode`、`~/.codex`）。
- **数据留在本机**：所有捕获（提示词、响应、事件流）只在本地内存与 `data/` 目录，不发往任何第三方（除模型上游）。
- **codex 沙箱**：`workspace-write`（只读系统 + 可写 `target-project/`）+ 隔离 execpolicy 规则。
  请勿在含敏感文件的目录运行演示。
- 服务只监听 `127.0.0.1`。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| codex 命令 `blocked by policy` / `declined` | execpolicy 判 Prompt 而审批=Never 即拒；确认 `data/codex-home/rules/default.rules` 存在（server 启动时自动重建） |
| codex `Model metadata for ... not found` 警告 | 内置元数据库无此模型名（影响上下文窗口估计），**不影响实际调用**，可忽略 |
| 端口被占 / ServeError | server 启动时会探测复用残留的 opencode serve；彻底清理：杀掉 `opencode.*serve` 与 `node.*server.mjs` 进程 |
| 中文 prompt 下 codex 用法错误（exit 2） | 已修复（直接 node 跑 codex.js 启动器）；若复现请检查 server.mjs `runCodex` 是否被改回 shell spawn |
| 页面无 LLM 记录 | 确认事件含顶层 `harness` 字段且与当前视图一致；`data/events.jsonl` 可核对原始流 |
| opencode 事件丢失 | 必须用 `/global/event`；`/event` 有目录过滤会丢 |

## 目录

```
harness-viz/
  server.mjs          零依赖 Node 后端（opencode serve 管理 + codex exec spawn + Responses↔Anthropic 翻译代理 + SSE 桥）
  index.html          单文件前端（harness 切换 + 双流程图 + 转写 + 权限弹窗 + 节点记录/说明）
  viz.config.json     模型/上游配置（见「配置自己的模型」）
  AGENTS.md           给编码代理的仓库须知
  target-project/     演示项目（两个 harness 实际读写的目录）
  data/
    config/opencode.json   opencode 隔离配置（入库）
    config/models.json     opencode 的 provider/模型目录定义，api 指向本地代理（入库；换模型改这里）
    codex-home/            codex 隔离 CODEX_HOME（启动时自动重建，不入库）
    opencode.db / events.jsonl / viz-server.log   运行时产物（不入库）
```

## License

[MIT](LICENSE)
