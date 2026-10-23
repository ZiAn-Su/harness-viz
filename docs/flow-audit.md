# OpenCode / Codex 教学流程核对

更新日期：2026-10-22。当前核对把**源码控制流、职责归并和运行证据**分开，避免图形连得通就被当成每个分支都正确或已执行。

## 1. 固定版本与图的范围

| 框架 | 版本 | 源码 commit | 本项目入口 |
|---|---|---|---|
| OpenCode | 1.18.34 | `aec0b9a6d8898f68f923aaf08b7306d931fd9d76` | V1 REST message → `SessionPrompt.prompt` → `runLoop` |
| Codex | 0.160.0 | `a956835d020762cb2b570053af06f643a11c0ecc` | `codex exec --json` → `RegularTask` → `run_turn` |

`src/versions.json` 和前端链接使用相同锚点。源码审计直接读取相邻 Git 仓库中的固定 commit，不要求或改动其当前 checkout；缺少对象时先 fetch 对应 commit。没有修改上游源码。

主图展示所选入口的核心循环和关键分支，**不是整个 CLI 的所有入口或逐函数时间线**。Review、手动压缩、实时模式、内部记忆整理等其他任务模式未展开。普通处理框可以收起内部处理；不能把改变主线去向的正常结果隐藏成一个必经出口。

当前 OpenCode **19 个节点（含环境区域）、27 条边、7 个判断**；Codex **17 个节点、24 条边、6 个判断**。模型输出与工具执行可重叠；工具类别和反馈是明示的职责归并，不能按图的纵向位置推断严格串行时序。

### 图形约定

- 椭圆：入口或本层返回，含义由名称确定；“本轮返回”不等于进程退出。
- 矩形：处理；双边矩形：收起的子流程，不保证它启动新智能体或等待到完工。
- 菱形：有标签的二向或多向结果。入口与各出口使用独立端口。
- 虚线框：主循环范围；实线区域：环境与权限，区域不作为控制步骤。
- 青色回线：继续主循环；紫色连线：子任务管理相关；红线：明确声明的终止异常，不代表每次捕获错误都终止。
- 交叉断口不连接；通往同一结果的汇合端点仍连接。

默认说明按“做什么—例子—接下来”讲解，变量、协议、计数、来源及省略路径折叠。工作记忆是当前可用上下文；跨任务记忆需要额外保存与读取机制。

## 2. OpenCode：已确认的顺序与条件

以下源码以 `packages/opencode/src/` 为根。

| 路径 | 源码依据 | 图与记录的处理 |
|---|---|---|
| 保存输入并进入循环 | `session/prompt.ts:1052-1071` | 运行准备后读历史。本页常规提交不设置 `noReply`；该额外直接返回路径不在主图内。 |
| 读取历史与提取待办 | `prompt.ts:1088-1098` | 先 `filterCompactedEffect`，再取得最新 user / assistant / finished 与 tasks；不是已完整装配模型输入。 |
| 入口可结束判断 | `prompt.ts:1100-1129` | finish 存在且非 tool-calls/unknown、没有符合条件的本地工具 part、parentID 对应最新 user 才退出；排除 providerExecuted 和孤立中断工具。不能仅凭 finish 或普通“完成”文字断言 break。 |
| 三类待办 | `prompt.ts:1142-1168` | `tasks.pop()` 取一项：subtask、compaction、无待办。不推断“总是先处理所有子任务”的优先级。 |
| 指定子任务 | `prompt.ts:255-449,1144-1147` | `handleSubtask` 调 TaskTool，写父工具结果/错误后**直接 continue 到循环头**，跳过本轮父模型与其结果判断。bypassAgentCheck 不是绕过全部权限；仅带 command 时追加合成 user。 |
| 执行已有压缩任务 | `prompt.ts:1149-1159`；`compaction.ts:319-458,552-556` | 先执行，再独立检查 stop/continue；stop 则 break，否则直接 continue。摘要错误或再次要求 compact 等情况可停止。 |
| 主动容量检查 | `prompt.ts:1161-1168` | 只有无待办后检查；还受 latestFinished、summary、isOverflow 条件约束。命中时创建标记并 continue。 |
| 创建压缩标记 | `compaction.ts:559-582`；`prompt.ts:1320-1335` | 创建 user/compaction part，**不执行摘要**。主动检查及 processor compact 都可进入；下一轮取出待办再处理。 |
| 装配与模型调用 | `prompt.ts:1226-1286`；`session/llm.ts:276-324` | 工具、环境、指令、消息转换在采样前进一步装配。模型框收起流处理与重试。 |
| 权限与派发 | `session/tools.ts:81-132`；`permission/index.ts:67-166`；`tool/edit.ts:102-111` | 可用工具过滤及各工具内部按需 ask，不存在“统一授权后再分类”的必经门。权限区域保存真实询问与答复，弹窗仍可使用。 |
| 拒绝后的处理 | `session/processor.ts:190-204,647,693-695` | `continue_loop_on_deny` 影响阻断行为，不能把所有拒绝认定为继续或任务失败。 |
| 写回反馈 | `processor.ts:160-204`；`message-v2.ts:294-364` | 输出/工具执行期间逐步保存；“汇总反馈”不是独立的后置函数，file.edited 不证明某个 callID 执行。 |
| 处理结果 | `processor.ts:693-695`；`prompt.ts:1288-1335` | continue、compact、stop；结构化输出成功/缺失及 content-filter 等 break 归结束。continue 后入口还会再检查，下一轮不一定调用模型。 |
| 退出 | `prompt.ts:1338-1339`；`run-state.ts:52-68` | 正常退出 fork prune 并返回助手，runner 发布 idle。异常也可转 idle；界面保留失败/中断证据，不将 idle 当作成功证明。 |

2026-10-10 再核对入口、指定子任务、压缩、流内工具、反馈写回、处理器返回与 runner 生命周期。图底部改为「本次处理退出」，说明处理函数返回与随后发布 idle 是两个相邻阶段。常规入口为 `server → loop → decide → subflow1 → subflow3 → llm`；普通无工具文本收尾为 `llm → decide2 → exec → outcome → loop → decide → done`，不能增加准备到模型的直连，也不能把 `continue` 解释为必定再次采样。

显式子任务标记只证明安排存在；task 工具快照不能区分显式入口和模型委派，因此以中性的“task 工具调用”归档，不凭它填造 `pre-sub` 或模型派发判断记录。压缩标记归“安排压缩”，完成报告归“执行压缩”，不混计或反推创建入口、取出待办或返回条件。

读取历史缺少 user、模型/agent 解析失败、准备与工具内部异常、中断等低层提前退出没有逐条画线；保留原始错误与终态。红线仅表示模型框内的最终终止异常，不能从一条 API 错误反推它。

## 3. Codex：已确认的顺序与条件

以下源码以 `codex-rs/` 为根。

| 路径 | 源码依据 | 图与记录的处理 |
|---|---|---|
| 启动及外层循环 | `core/src/tasks/regular.rs:51,104-124` | TurnStarted 在 run_turn 前；外层可能因 pending input 再次调用 run_turn。本轮函数返回不是 task 完成，也不是 exec 退出。 |
| 预采样维护 | `core/src/session/turn.rs:183-221,1298-1326` | 新输入记录前进行按需维护；失败时保留输入并返回/报错。收在运行准备，不随主循环重复。 |
| 主循环与上下文 | `turn.rs:426-449,515-534,1583-1599` | 条件吸收 pending input，输入 hooks 可提前返回；history、工具及基础指令用于本次请求。内部注入/启动检查与异常收起，不伪造执行事件。 |
| 流内派发及结果 | `core/src/stream_events_utils.rs:315-425`；`turn.rs:2466-2493,2766-2780,3140-3171` | 路由客户端工具、记录调用项、排队 future 并收集结果。模型项也逐步保存；派发和反馈不是严格后置串行步骤。 |
| 处理器、hooks 与权限 | `core/src/tools/registry.rs:535-626,790-831`；`tools/sandboxing.rs:151-216` | 先解析具体处理器，派发 hooks 可阻断/改参数，执行策略由具体实现约束。环境区域不表示所有工具共用授权门。 |
| 是否还需处理 | `turn.rs:566,2973-2979` | `model_needs_follow_up || has_pending_input`，不限于工具调用；end_turn=false、preempt 等也可影响跟进。没有内部判定事件时保持空记录。 |
| 继续阶段容量判断 | `turn.rs:601-650` | **needs_follow_up 且**新窗口请求或阈值命中才维护；否则回到输入准备。 |
| 维护与错误 | `turn.rs:614-639,1471-1534` | TokenBudget 可能重置窗口，不生成摘要；普通压缩失败发布错误后 Ok(None)，TurnAborted 返回 Err。红线是失败/中断返回，不代表正常继续。 |
| 维护后的启动检查 | `turn.rs:640-650` | 成功后独立检查 pending session-start hooks：阻断则提前返回，否则调整 pending-input 接收条件并 continue。不能从压缩完成猜此结果。 |
| 三向收尾结果 | `turn.rs:653-713` | should_block **且有有效 continuation** 才继续；无片段只警告。should_stop break，legacy hook 可直接返回；正常路径进入收尾维护。内部记忆整理模式另有拒绝错误，不在本页普通任务范围内。 |
| 正常收尾维护 | `turn.rs:716-755` | 阈值启用、非 TokenBudget、达到阈值、无 pending input、未取消才 PostTurn 压缩。Interrupted/TurnAborted 返回 Err；其他错误保留回答并警告，UsageLimitExceeded 还发布错误生命周期；随后返回。 |
| 特殊恢复与终止错误 | `turn.rs:759-837` | 模型框收起 Guardian 恢复：ContextWindowExceeded、非 TokenBudget、存在 ExhaustedReviewBudget、当前模型 step 未做过恢复压缩才一次重试。不是所有容量错误自动恢复。取消/无法恢复错误返回上层。 |
| 上层生命周期 | `core/src/tasks/mod.rs:812-887`；`exec/src/event_processor_with_jsonl_output.rs:513-564` | 单独保留 turn 完成/失败与进程退出报告；底部是相关记录入口，不宣称已观测 run_turn return。code=0 不覆盖失败/中断。 |

### 子任务与能力版本

- `core/src/tools/spec_plan.rs:668-683,1298-1420` 决定 Disabled / V1 / V2 与可用能力；不能把两版本工具并集说成本次都启用。
- V1 有 spawn、send_input、resume、wait、close；V2 可有 spawn、send_message、followup_task、wait、interrupt、list，没有 close，部分能力可禁用。
- spawn 返回管理标识，不表示子任务完工；wait 可超时；send_message/发送、追加任务、关闭/中断含义不同。
- 成功 spawn 的明确 receiver 或 `agent_result_observed` 的 parent/child 字段才建立本页面的父子关联。send/wait/close 的 sender/receiver 只证明交互；失败或尚未完成的 spawn 不建立父子。
- 原生 tagged kind 依据 `rollout-trace/src/tool_dispatch.rs:261-275` 归类。`close_agent` kind 也可表示 interrupt，不能据 kind 声称调用了关闭能力；Other 或缺失开始记录的事件中性归档在工具分类节点，不从名称片段猜处理器，也不推定分类条件命中。
- exec JSONL 选择性省略部分 V2 项，ResumeAgent 映射成 Wait（`exec/src/event_processor_with_jsonl_output.rs:243-256`）；“没有 item”不等于没有该能力。

## 4. 实际可观测与不可确认

- **OpenCode 权限**：Asked/Replied 是直接事件；API 接受本地答复不是工具恢复/执行证明；allow/deny 不一定询问用户。
- **Codex 审批与 hooks**：固定版本 `rollout-trace/src/protocol_event.rs:483-506` 对 ExecApprovalRequest、ApplyPatchApprovalRequest、HookStarted/Completed 返回 None。已移除虚构的逐次授权事件归档及正向测试；不支持的 wrapper 只保留原始日志。启动策略仅是 boundary 配置，never 不等于禁用沙箱或每次已批准。
- **压缩阶段**：内部 `core/src/responses_metadata.rs:122-160,407-449` 有 phase；当前 raw compaction schema (`rollout-trace/src/raw_event.rs:183-207`) 不提供它。remote 记录请求也只拷贝有限字段。phase-less 事件归上下文，不定位 pre/mid/post。
- **摘要请求**：本地压缩 `core/src/compact.rs:768-770` 使用 disabled inference trace；remote 的 inference trace 也禁用，另用 compaction lifecycle（`compact_remote_v2.rs:386-415`）。不能把缺少普通 LLM 请求计数当作没有维护。
- **请求边界**：原生 trace 不是逐字节网络抓包。`core/src/client.rs:1987-1991,2050-2051` 在特定未记录 warmup 续接时保存全量逻辑请求，否则 WS 可记录 delta；原文下载仍保存实际捕获文本。响应链重建和模板渲染另行标明。
- 徽标与高亮统计相关观测对象，不是函数调用 trace、内部迭代数或判断命中次数。完成事件不反推 stop、压缩或跟进分支。
- 2026-10-09 展示层加入按 `receivedAt` 排序的关键事件时间线，分别保留工具开始与终态，并区分主／子／未关联会话。节点的持久标记表示相关证据，不是已执行所有内部分支；灰色不表示未执行。点击时间线可定位图和节点记录，所选时刻原始事件与节点最新快照分别保留。
- “读取历史”展示实际模型请求中的可读消息清单，不声称捕获了内部数据库读取函数或完整历史；缺失消息数组表示未知，增量及重建另行标注。工具结果即使位于 Anthropic `user` 消息，也标成工具反馈。模型响应统一展示文字与工具调用；执行状态按调用 ID 关联，API 原报文与观察器精简通知分层保留。
- 2026-10-10 增加默认「调用全流程」：事件间紫色阶段来自同源机制模板，没有原生时间戳，不增加采集事件数。模板每一段必须对应图的已有边；分支是该路线的条件，不包装为实际判断事件。请求/响应、工具调用/结果按编号及调用 ID 关联；新输入的工具反馈要从实际请求核对。重试、未关联会话、未完成压缩标记不能套成普通入口。子会话采样归子任务子流程，不接成父主线。
- 小型提示词分析扩展已按来源锁安装：两项 Anthropic 技能、Context7 MCP 和仅 OpenCode 的 DCP。OpenCode 原生发现、Codex skills.list 和 MCP initialize/tools.list 均已做无模型检查。网页发现结果明确标注 OpenCode 来源，同一配置轮询保留、配置变化失效；Codex 显示原生发现检查命令，不借用 OpenCode 结果。扩展配置在调用旁保存快照，不改原始请求；界面字段命中仅表示可见线索。插件可能改系统指导、工具或发送前上下文，因此「原请求」始终指最终捕获边界处的实际客户端载荷，不声称它等于插件处理前数据。

## 5. 验证方法与最新结果

- `public/flows.js` 同时驱动网页、结构检查和 `docs/assets/coding-agent-flows.drawio`，两份图不会分别手改。
- `node scripts/audit-flows.mjs` 校验固定 Git commit、36 个节点的说明覆盖及源码定位的文件和行号，以及形状、全部声明的二向/多向结果、显式异常出口、区域、可达性、独立端口、正交线和节点穿越。源码定位数量随说明补充变化，以脚本输出为准。
- 同源机制模板共21条（OpenCode 12、Codex 9），校验每个中间节点及连续边。`audit-runtime-routes.mjs` 已从持久真实日志核对截图中的请求 #17：323条原事件、6条关键记录、无子会话；入口和正常收尾模板与图一致，结果仍明确标为源码机制而非原生判断 trace。
- 该脚本**不证明源码语义**；上面的条件和顺序来自人工阅读固定源码。构造事件单测只证明观察器如何处理输入，不证明 CLI 会发出该事件。
- `node scripts/export-flow-drawio.mjs` / `--check`：同源导出及同步检查通过；XML 解析确认2页、51条边、唯一 ID、父容器/起点/终点引用和连线几何有效。
- 2026-10-06 提交前 `npm test` **93/93**、2026-10-09 **113/113**、扩展阶段 **126/126** 均为历史计数。原生配置阶段 **144/144**：除机制路径与扩展外，增加原生配置快照不改写源、目录不暴露凭据、Responses/Chat原协议解析与续接、question答复隔离、含响应模板/JSON不污染请求及Flash独立模板兼容验证。最新计数见下方2026-10-12补充。
- 2026-10-10 双框架浏览器回放 **20项通过、无 JS 错误**。验证分别可选模型目录、question单选/多选/自定义原生答案数组、请求/含响应模板与JSON两范围、完整记录后仍能逐字下载原请求，以及390px布局。扩展和question界面使用明确标注的构造配置，模型目录来自历史回放，不冒充当前真实模型发现。当前实际任务与保存父子任务此前各12项通过；捕获目录分别为 `.runtime/verification/2026-10-10T02-57-22-165Z-live-opencode/` 和 `.runtime/verification/2026-10-09T10-17-48-216Z-live-opencode/`。以上只读或离线回放，不提交新真实模型任务。公开素材仍为此前真实记录。
- 2026-10-09 启动 smoke **4/4**，含占用内部端口的真实启动、固定缓存复用与单 CLI 安装失败隔离，不调用模型；目录 `.runtime/verification/2026-10-09T05-46-50-446Z/`。此前2026-10-06的 **2/2** 仅属于旧启动验证。
- 扩展阶段smoke **5/5**属于历史验证，目录 `.runtime/verification/2026-10-10T05-52-19-309Z/`。原生配置阶段 **6/6**，目录 `.runtime/verification/2026-10-10T12-36-49-984Z/`：真实固定CLI读取原生OpenCode JSON和Codex TOML模型目录，观察器配置不含provider/model；确认question、客户端websearch和扩展注册；并通过本地模拟Responses服务验证原协议/请求原文字节一致、真实question API提问/答复/结果回传。模拟输出不作为GLM能力证据，没有外部真实模型推理。`native-mock-calls.json` 保留模拟传输验证报文。模型服务认证和真实联网搜索尚未调用验证。
- 发现接口并行等待初始化（最多60秒），局部失败不覆盖其他结果；CLI健康与原生模型目录准备分开，验证等待两者就绪。`extensions:check` 目录 `.runtime/verification/2026-10-10T05-48-58-517Z-extensions/` 保存MCP实际说明/工具和Codex技能发现，不提交生成任务。Flash模板单独固定 `eb9eb208eb0d988989d07a6a12d0fdeb5f52574a`，SHA256 `0c4099f3382d6c92700dfb99725025360966fd73032f0ecf32377c0d9e6309c5`，与GLM-5.3旧模板不同。

普通任务回放没有覆盖所有压缩阶段、显式子任务、后台任务、多智能体版本、hooks 和 Guardian 恢复；因此本报告不宣称“所有分支实测”。执行条件、策略结果或内部阶段没有记录时，保持未知。旧稿89/89、32节点及65链接等验证只属于旧稿，不能作为本版结论。

### 2026-10-12 Kimi K3 核验补充

- K3解析补充时无模型回归 **147/147**。K3显式effort/tool-choice/response-format进入离线预览，schema排序及reasoning回退与固定Python编码器对齐；Chat系统消息统计不再只看顶层system。调用记录/通知增加原协议元数据，不修改原始请求体。
- `research/LLM_prompt/task2` 两份实际任务的调用记录文本，当前JS与固定官方Python重建均与输入UTF-8字节完全一致。历史日志同run关联webfetch running/completed，输出hash与第一份文本工具结果一致。第二份仅在旧工具结果中多下一轮DCP消息标签，并保留前一assistant思考/调用。
- 这只证明可见XTML拼接，不能还原服务内部token IDs；任务#1/#2原API JSON未保留，当前#3是另一任务，不混用其原文作为旧任务证据。协议判断结合旧Chat usage/finish_reason形态和同provider当前HTTP捕获。细节见 `research/LLM_prompt/task2/kimi-k3-analysis.md` 与 `kimi-k3-audit.json`。没有重跑真实模型任务。

### 2026-10-12 显式 effort 与变体验证

- 首轮无模型回归 **152/152**，简化双框架强度控件后最新 **154/154**。新增原生目录仅公开可用变体名称、disabled过滤、未知/错误类型/Codex变体在清历史前拒绝、OpenCode消息顶层variant及运行快照、模型切换与选择隔离验证；Codex强度档位和默认值来源于原生model/list与配置，未知模型不猜测档位，非法强度在清历史前拒绝。
- 最新smoke **8/8**，目录 `.runtime/verification/2026-10-12T05-57-11-418Z/`（首轮7/7目录 `.runtime/verification/2026-10-12T04-17-09-868Z/`）。固定OpenCode `1.18.34` 读取演示K3选项的隔离原生配置，并使用实际OpenAI-compatible SDK请求本地Chat模拟服务：不选variant仍显式发送`reasoning_effort:"high"`，选择low/high/max分别发送对应值，捕获原文与模拟服务收到的body完全相同。请求版与含响应版K3预览均保留显式档位；`explicit-effort-proof.json`、`effort-*-request.json`、`effort-*-call.json`及预览文本保存证据。固定Codex `0.160.0` 读取隔离原生模型目录，默认沿用medium，选择low/high通过原生CLI配置覆盖分别发送Responses `reasoning.effort`；`codex-effort-proof.json`和`codex-effort-*-wire-request.json`保留证据。原Responses/question、占用端口、缓存独立、失败安装隔离仍通过。模拟接收端先合并UTF-8字节再解码，避免跨块中文被替换导致错误的原文字节不一致。
- 最新双框架浏览器回放 **22项通过、无 JS 错误**，目录 `.runtime/verification/2026-10-05T09-38-42-895Z/`。一个「思考强度」控件使用「默认／低／中／高／超高／最高」短标签；按harness和模型保留选择，无强度档位及仅思考开关的模型直接隐藏。390px两行输入区和单行任务输入已核验。菜单使用明确的构造目录，截图已检查；历史调用原文不改写。没有真实模型推理调用，服务端实际模板与思考质量不在这些测试的证明范围内。

### 2026-10-12 Jinja effort 传递修复

- 修复Jinja预览只传messages/tools、遗漏实际请求effort的问题。Qwen默认xhigh、GLM默认max不再覆盖显式值；从Chat `reasoning_effort`、Responses `reasoning.effort`、Anthropic `output_config.effort`及公开编码字段读取。旧转译记录以实际上游请求为准，不从转译前参数猜补。
- Qwen固定模板源第25–27行仅接受low/medium/xhigh，high或max没有确定的等价映射，明确报错且禁用下载；两份GLM模板先验证low/high/max，阻止上游Jinja将其他输入静默变成max。原请求没有显式值时仍保留公开模板默认，并在渲染详情注明来源。vendored模板、revision与哈希均未修改。
- 最新无模型回归 **158/158**，包含全部现有Python基准golden，以及兼容档位/多个API字段/请求与含响应两范围、high跨K3/Qwen不兼容、默认来源、关闭思考处理和原报文不变。
- 最新浏览器回放 **23项通过、无 JS 错误**，同上回放目录。新增隔离的预览构造记录，不加入历史任务/请求计数：high在K3保留，切到Qwen明确不兼容、下载无残留；low在K3和Qwen渲染及下载文本一致。延迟返回的Qwen失败不能覆盖切回K3后的high。未调用真实模型。

### 2026-10-12 多轮对话验证

- 增加任务结束后的「继续当前对话」，默认关闭。勾选向当前OpenCode session追加消息，或向原生Codex exec resume传明确线程ID；不使用--last、不把历史文本手工放入新提示词。默认运行继续开启新会话。
- 续聊保留观察runID、所有请求原文与事件。turnNumber/conversationTurn是本地用户输入轮次，不冒充内部循环或原生turn ID。每轮新建active状态对象；Codex trace路径按轮次分开，避免读回旧请求；局部exec item ID按用户轮次区分，避免覆盖上一轮回答和工具卡片。原始事件中的ID保持原样。
- 最新无模型回归 **164/164**：增加续聊原生消息/明确resume ID、历史保留、默认新会话、无效或跨框架会话拒绝、前端勾选与失败恢复、同ID跨轮回答/工具不覆盖验证。
- 最新本地模拟smoke **10/10**，目录 `.runtime/verification/2026-10-12T07-38-11-998Z/`。固定OpenCode与Codex分别完成三轮：原生session/thread和观察runID不变，第二轮请求包含第一轮用户输入与助手回答，第三轮含两轮先前用户输入；旧请求原文字节仍可读取。再以默认方式开启新会话，ID改变，请求不包含旧输入。记录保存为 `<harness>-multiturn-events.json` 和 `<harness>-multiturn-calls.json`。没有真实模型推理。
- 最新浏览器检查 **26项通过、无 JS 错误**：原双框架回放增加复选框显示/默认/框架隔离；使用上面的固定CLI本地模拟三轮记录回放，确认各有三条用户输入、三条回答、全部请求记录和同一原生会话，刷新后勾选关闭。截图已核对；素材仅保存在忽略的验证目录，不作为真实模型能力或公开演示证据。
- 提交前重新核对 `npm test` **164/164**、流程源码定位审计及draw.io同步。扩展发现脚本改为加载原生Codex配置快照，修复仍读取已移除`config.codex.model`的问题；`extensions:check` **2/2**、modelCalls=0，目录 `.runtime/verification/2026-10-12T11-55-34-990Z-extensions/`，包含Context7实际工具发现和Codex内置／托管技能发现。

### 2026-10-13 历史节点与记录时间修正

- 读取历史机制仍对应OpenCode `prompt.ts:1092-1096` 的有效会话读取与latest状态提取；是否发生压缩是条件，tasks具体是compaction/subtask，不等同于普通计划清单。当前采集没有直接跟踪该函数执行，模型请求中的历史仅作为参考。
- 实际截图中的8条是4条助手消息状态＋4份请求历史参考，原来混归到读取历史。普通助手状态现归调用模型，明确summary状态归压缩；读取历史标题显示「4份模型输入参考」，明示不是读取次数。
- 原updateRec覆盖time却不改变首次插入位置，导致第一条助手记录显示16:57:38、第二条请求显示16:57:33。实际首次助手事件是16:57:31，16:57:38是后续更新。现在time保留首次receivedAt，updatedAt、首次事件和最新事件分开保存，列表按首次时间排序；跳转使用稳定记录标识，不依显示位置。
- 无模型回归 **167/167**：新增历史归属、四请求/四状态分离、首次/最新时间、乱序接收排序与稳定跳转、Chat系统指令折叠验证。双框架及三轮回放 **27项通过、无JS错误**；原JSON、事件日志和模板源未改写。
- 对当前已完成OpenCode实例只读捕获并离线回放，目录 `.runtime/verification/2026-10-13T09-28-49-433Z-live-opencode/`，**21项通过、无JS错误**。实际历史面板仅保留4份输入参考，顺序16:57:33、16:57:38、16:58:55、16:59:15，截图已核对。检查兼容多条用户输入与模板参数不兼容提示，没有新增模型任务。

### 2026-10-14 执行记录与关联资料分离

- 针对新的单轮任务，运行准备原有10条实际上是1次session.created、5次session.updated快照、同一用户消息的4次message.updated。模型始终k3-256k/low。流程没有执行10次准备，是前端把持续状态更新错列在节点运行记录。
- 新增独立「关联资料」页签。节点运行记录只保留可确认的模型请求、按调用身份合并的实际工具处理、权限交互、明确压缩完成、原生处理返回或Codex turn完成等边界。准备、历史读取及内部判断没有直接执行采集时明确显示未采集，不把关联事件当作执行，也不凭源码路线补造记录。
- 会话快照、用户／助手状态、模型输入参考、启动状态、推断和待办标记均为关联资料；会话事件标题改为快照更新。图徽标只按执行记录计数，助手消息状态不再与实际模型请求相加；当前任务模型节点从旧的4条混合观测变为2次实际请求。pending工具保留为资料，running/终态更新同一记录后才计入执行记录。
- 无模型回归 **169/169**；新增单提交/10生命周期更新不能变成10准备执行、工具pending转实际执行的回归。当前任务只读捕获与回放 **22项通过、无JS错误**，目录 `.runtime/verification/2026-10-14T07-35-29-423Z-live-opencode/`，截图分别核对未采集的运行准备页和10条关联资料页。双框架及三轮回放 **28项通过、无JS错误**。没有新增模型任务，原始请求与事件数据保持原样。

### 2026-10-16 运行准备样例

- 移除关联资料页签。为运行准备新增实际入口采集 `viz.preparation`，每次提交一个execution ID；持续进度只更新同一条，时间与输入/动作/结果有专门详情，不从历史快照补造旧日志。
- 起点记录实际入口校验时刻；OpenCode记录创建／续接会话、交付消息，再以public API本次messageID匹配原生text part已保存事件；Codex记录启动／恢复进程并以本轮turn.started确认。该边界覆盖观察器入口动作及原生输入接收，不声称已跟踪CLI内部全部初始化函数、工具发现或权限加载。原生和模型报文保留原样；本次messageID是原生API允许的调用方参数，用于明确关联。
- 用户消息后续更新和模型回答不延长已完成准备；会话创建失败、接收前取消、未采集接收确认分别保留。缺确认时结束时间和耗时保持未知，不拿整个模型生成时长替代准备时长。旧记录未埋点的不补时间。
- 无模型回归 **175/175**；固定CLI本地模拟smoke **10/10**，目录 `.runtime/verification/2026-10-16T06-47-46-431Z/`。双框架各三轮均确认每轮一条准备、相同execution ID的进度更新、明确原生接收证据及前后轮隔离；保存`<harness>-preparation-proof.json`和多轮事件。
- 浏览器回放 **30项通过、无JS错误**，在历史回放上叠加上述本地模拟三轮记录。核对准备卡的完整本地时分秒毫秒、耗时、实际输入、动作和结果；截图`opencode-preparation-prototype.png`、`codex-preparation-prototype.png`已检查。没有真实模型推理调用。

### 2026-10-17 原生可见节点的统一运行记录

- 已先提交运行准备样例：`f983232`。用户随后明确选择保持原版CLI，不修改OpenCode/Codex源码或切换埋点构建；仅实现现有原生事件/接口能直接支持的记录。完整逐节点边界与缺口见[node-execution-coverage.md](node-execution-coverage.md)。
- 新增纯数据适配器`public/execution-records.js`，将模型调用、工具/子任务管理、工具反馈、权限交互、可观测压缩请求/完成报告及处理返回统一为执行信息、输入、实际处理、结果。模型专属原文、工具定义、模板与下载继续保留。
- 工具使用原生state.time起止；Codex stdout item没有原生执行时间时仅保留首次/最近接收，不由接收差补执行耗时。反馈接收、单点提交或完成报告缺开始时不补零耗时。子任务管理返回不表示后台子任务全部完成。
- 权限询问/答复按requestID和sessionID更新同一记录。Codex上下文整理请求按compaction_request_id聚合原生开始/终态，展示请求和返回载荷，保持无phase时不猜维护阶段。模型inference_cancelled保留取消与部分输出；原错误字段不改写，网页不将其当成主任务失败。
- 模型响应到达时使先前展开产生的报文缓存失效，记录最近接收时间；即使卡片已收起，也不继续把缓存中的部分输出当作最终结果。双框架均覆盖已展开自动刷新、收起后终态更新的回归。
- 无模型回归 **186/186**，包含时间来源、原文不变、权限合并、整理请求合并、取消和通用详情验证。双框架及三轮浏览器回放 **36项通过、无JS错误**，工具、权限、反馈、返回截图已检查。固定CLI本地模拟smoke **10/10**，目录`.runtime/verification/2026-10-16T23-46-29-342Z/`；新增静态适配器资源和模型边界通知字段验证通过，没有真实模型推理调用。固定源码定位/流程结构审计及draw.io同源同步检查通过。

### 2026-10-19 用户复核后的可读性修正

- 用户指出统一四个标题仍不足以提供可读内容：关键参数、输出和结果藏在完整对象中。新增按职责生成的实际内容展示，文件读取直接展示路径/范围/正文，命令展示命令/退出码/输出，文件修改展示涉及文件和前后内容，权限代码翻译为具体选择，模型展示最近用户文本、回答和工具提案。字段按可读列表呈现，长正文保留首段和继续阅读入口；JSON/事件ID仍折叠供回溯。
- 「读取历史」/「整理上下文」直接展示各次捕获请求携带的用户文本、已有回答和工具结果，最新请求默认展开。原版未提供内部读取过程，仍明确不生成该函数执行记录、不虚构次数或耗时。增量请求不被称为完整历史，工具反馈即使编码在user角色中也不冒充新用户要求。
- Codex返回详情只按明确的同run/session/用户轮次关联已完成的原生助手消息及报告成功的文件活动，标明内容来自关联活动而非完成报告自身，不混入上一轮回答，也不把助手陈述视为独立验证。
- 本轮无模型回归 **190/190**；浏览器双框架及三轮回放 **38项通过、无JS错误**，检查在技术详情全部关闭时仍能读到实际输入和结果，原文下载与原始调用数据保持一致。已检查`opencode-tool-execution.png`、`opencode-readable-model.png`、`opencode-readable-history.png`、`codex-readable-context.png`等回放截图；没有发起真实模型请求。
- 对当前服务只读核对发现`/execution-records.js`返回404：运行中的后端尚未提供新组件资源，会退回旧展示。没有擅自重启或清除运行记录；加载完整新展示需先导出需保留记录，再重启服务。节点在组件缺失时给出明确加载说明，避免将其误称为历史正文为空。

### 读取历史按节点职责精简

- 用户再次复核指出历史面板混杂了完整输入、工具参数与输出，不符合节点说明。移除逐消息展示和多请求同时展开；默认只看一个最新时点，下拉切换历史时点。面板仅保留可获取且有用的用户要求、助手已有进度、最近可明确关联的反馈摘要。
- 未知字段直接省略；不推断内部待办队列、压缩阶段或读取耗时。工具反馈只凭明确call ID关联，只概括反馈已存在或已报告错误，不搬运输出正文、不将它当作新的用户要求，也不混入本次请求后生成的回答。完整消息/参数/结果可从按钮跳到对应模型调用。
- Codex仅采用已有采集器验证完整的同run/session响应链补全摘要；不完整增量载荷保持缺失，不凭相邻请求补历史。原请求和原始事件不改写，执行计数仍不由这些摘要产生。
- 针对性前端/适配器验证 **82项通过**，完整无模型回归 **192/192**；双框架与三轮浏览器回放 **38项通过、无JS错误**，覆盖单时点切换、精确跳转、节点职责字段白名单和默认视图长度。已核对精简后的`opencode-readable-history.png`与`codex-readable-context.png`，无模型调用。

### 2026-10-22 OpenCode 主图逐分支复核

- 核对固定 `v1.18.34` commit 的 prompt、processor、compaction、tools、task、message-v2、overflow 及 runner 实现，主图仍为19节点、27边、7个判断，12条机制路线不改拓扑。普通入口、指定子任务直接 continue、压缩 stop/continue、两处安排压缩入口及普通文字回答先回循环头再退出，均与源码一致。
- 明确图的纵向连线不是严格执行时序：客户端工具按响应流中的工具项逐次派发，模型文字和工具调用可同时存在，多项工具可并行；反馈也在输出和执行期间保存。「调用模型」框收起装配、流消费和重试，其后节点展开相关职责，不能按图位置认定工具等到整次模型请求返回才开始。页面提示和节点说明均已补充。
- 修正OpenCode专属子任务说明：通过同一个 task 工具创建或按task_id续用子会话，前台通常等待结果；只有启用相应后台能力并选择/转入后台时可先返回running。不能将Codex的独立send/wait等管理工具语义套给OpenCode。显式SubtaskPart与模型task工具仍共用TaskTool，入口与continue路径不同。
- 容量节点解释为主动压缩阈值，而非服务端硬上限已被突破。`overflow.ts:8-33`会考虑可用容量及配置；自动压缩关闭或上下文上限未知时不命中主动检查。循环待办来自`message-v2.ts:586-601`的有效compaction/subtask标记，不是todowrite清单。
- 源码定位审计改为`git show <固定commit>:<file>`，不再把已更新的checkout HEAD当成审计版本。运行路线审计兼容异步准入：viz.run尚无sessionID时，只采用准备记录或原生根会话创建中的明确ID，不从模型请求先后猜根会话。
- 只读核对当前截图任务：176条原事件、23条关键记录、4次主会话模型请求、3次工具终态（glob、glob、read）、末次响应无工具且处理接口返回finish=stop，无子会话。对应36个紫色源码阶段是条件机制说明，不是36个原生函数执行或判断命中。没有发起新模型任务，也没有重启现有服务。
- 固定源码定位与结构审计通过：OpenCode45处、Codex38处源码定位；draw.io同源同步检查通过。浏览器仅打开已有任务页面并检查流程图：节点、连线、循环框和图例可见。压缩说明补充专用摘要模型、保留尾部和自动续接，不借用Codex窗口切换语义。压缩、显式子任务、后台任务与异常分支本次仅源码核对，未宣称被该普通任务实测覆盖。
- 无模型回归 **195/195**，新增3项覆盖异步准入后确认根会话、旧记录兼容和不从请求顺序/子会话猜根的回归。浏览器工具在Windows上的命令进程退出等待超时，但页面导航和流程图截图已完成并实际读取核对；这不是完整浏览器回归套件通过的声明。
