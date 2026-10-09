# harness-viz

**在浏览器里看清 Codex 和 OpenCode 如何完成一个编程任务。**

运行真实 CLI，查看工具调用、执行结果和客户端模型上下文；点击流程图节点，对照源码理解每一步。

[![操作演示](docs/assets/demo.gif)](docs/assets/demo.webm)

点击查看视频：输入任务、运行、查看工具结果和上下文。演示使用真实任务记录的加速回放，不模拟模型输出。

## 快速开始

先安装包含 npm 的 [Node.js 22+](https://nodejs.org/)。

下载或克隆此仓库后，在 `harness-viz` 文件夹打开终端，启动：

```sh
npm start
```

打开 **http://127.0.0.1:4577**。**自动安装发生在运行 `npm start` 时**：软件启动后先显示网页，在后台检查专用 Codex `0.160.0` 和 OpenCode `1.18.34`；缺少、损坏或版本不符才自动安装，需要能访问 npm registry。缓存正确时直接复用，不会每次重装。网页显示准备状态，就绪后点击顶部「输入」→「演示」→「运行」。

固定 CLI 缓存于 `.runtime/cli/`，后续启动核验并复用；全局 CLI 的安装、升级不会改变这里的运行版本。专用 OpenCode 禁止自动更新。某个 CLI 准备失败只禁用其运行入口，另一个仍可使用；顶部「信息」显示错误及专用入口。修复网络／代理或目录权限后重启 `npm start` 即可重试。

模型代理与 OpenCode 服务使用自动分配的内部端口，实际地址会打印在终端；无需手动设置或释放 `45322`／`45321`。网页入口仍是 `4577`，若该端口被占用，终端会提示检查已有实例。

首次使用官方 Codex，需登录或设置官方 API key。已有 Codex 登录态会被复制到隔离运行目录；未登录时，等专用 CLI 安装完成后在另一终端运行：

```sh
node .runtime/cli/codex/0.160.0/node_modules/@openai/codex/bin/codex.js login
```

登录后重启 `npm start`。登录命令使用 Codex 的用户认证目录；观察器仅复制认证，不修改原配置或认证文件。

默认工作目录为 `examples/demo`。

使用自己的项目：修改 [`config/settings.json`](config/settings.json) 中的 `projectPath`，然后重启。

## 能看到什么

- **流程图**：面向学习的智能体机制图，突出循环、上下文、工具、权限、执行环境和子智能体。
- **实时转写**：助手输出、工具调用、结果和权限询问。
- **执行顺序**：按观察器接收时间排列模型请求／响应、工具开始／结果返回和会话状态，区分主／子会话；点击记录定位图中节点，支持逐条前后查看。青色节点保留相关证据，未标记不等于未执行；没有逐分支 trace 的判断保持未知。
- **上下文详情**：直接查看客户端请求、工具定义和响应，并区分证据来源。

节点说明默认使用中文例子讲解机制，源码和运行细节可展开查看。图例区分处理、二向/多向结果、主循环与环境权限；子流程使用双边矩形。压缩的安排与执行分开，权限由各工具按需检查；工具分类和反馈明确按职责归并。逐路径核对及观测边界见 [流程核对](docs/flow-audit.md)，可编辑图源见 [coding-agent-flows.drawio](docs/assets/coding-agent-flows.drawio)。

查看模型请求：点击「调用模型」，切换到「运行记录」并展开请求。「下载 JSON」带缩进、只调整空白；「下载原文」保留捕获文本用于核验。两者不加入重建历史或分析字段；第三方模式下载发给上游的请求体。Codex 原生 trace 是 CLI 请求记录，不是网络抓包。

「读取历史」的运行记录提供实际模型请求中的可读清单：用户任务、已有模型输出／工具调用、工具结果回传。它说明本次模型看到了哪些可见材料，不冒充数据库完整读取或内部循环 trace；工具结果即使编码在 `user` 消息中，也不是用户又提了一条问题。增量请求与重建历史单独标注。

一次模型响应可以同时包含文字与工具调用，界面统一放在「模型响应」下。工具调用是模型提出的动作，框架工具事件记录实际状态；可按调用 ID 跳到执行顺序。「技术详情」保留完整 API 请求体、原始响应流与解析摘要；「观察器通知」中的 `llm.request/llm.response` 是发给网页的精简捕获通知，不是完整模型报文。

「模板预览」把已捕获的请求 JSON 按所选公开模板拼接成送入 tokenizer 前的文本，可选 Qwen3.8（开放版）、GLM5.3、Kimi K3（官方 XTML 编码器的等价移植），可复制、下载。模板文件随仓库固定在 [`src/templates/`](src/templates)（来源 URL+提交哈希+sha256 锁定，无需联网）；渲染由本地 `@huggingface/jinja`（vendored 于 `src/vendor/jinja/`）完成。来源、版本和具体字段转换可展开「渲染详情」查看。

顶部可独立开关输入框、流程图、过程和详情；「过程」面板内切换执行顺序／转写。隐藏面板后，其余面板自动扩展。转写支持 Markdown。

## 模型设置

只需编辑 **[`config/settings.json`](config/settings.json)**，然后重启。

| 模式 | 默认模型 | 认证 |
|---|---|---|
| Codex | `gpt-6.1-sol` | Codex 登录或官方 API key |
| OpenCode | `MiniMax-M3.1-Flash-Preview` | `MINIMAX_API_KEY`，需支持该 Preview 模型的 M Plan 凭据 |

使用 OpenCode 前设置密钥环境变量：PowerShell 用 `$env:MINIMAX_API_KEY="你的密钥"`，macOS/Linux 用 `export MINIMAX_API_KEY="你的密钥"`。

Codex 也支持第三方模型：将 `codex.useDefaultModel` 设为 `false`，`codex.model` 改为 `MiniMax-M3.1-Flash-Preview`。该模式使用有损协议转换，不能视为官方模型的等价链路。

## 项目结构

| 目录 | 用途 |
|---|---|
| `config/` | 唯一的用户设置 |
| `src/`、`public/` | 后端、版本信息与网页 |
| `examples/demo/` | 默认工作目录和演示文件 |
| `tests/`、`scripts/` | 回归测试与开发验证工具 |
| `docs/assets/` | 使用演示 GIF 与视频 |
| `.runtime/` | 固定 CLI 缓存、日志、认证和验证记录，**不提交 Git** |

## 边界与开发

流程图是源码机制简图，不是逐函数追踪；客户端捕获不等于服务端最终提示词或完整内部推理，流程结束也不代表代码正确。捕获可能含敏感内容，请勿公开 `.runtime/`。

`npm test` 运行无模型回归测试；`npm run test:integration` 使用临时项目调用真实模型；`npm run test:integration -- --smoke` 只验证安装／启动，不调用模型；`npm run test:browser -- ".runtime/verification/<run>"` 检查记录回放；`npm run test:browser -- --live-opencode` 只读捕获当前已完成的 OpenCode 实例，保存到忽略的 `.runtime/verification/` 并做离线浏览器回放，不提交任务或调用模型。CLI 版本和源码固定在 [`src/versions.json`](src/versions.json)，详细定位在界面节点说明中。Windows 直接执行专用二进制或 Node 启动器，不经 shell 改写提示词参数。

[MIT License](LICENSE)。第三方模板及编码器沿用 [`src/templates/`](src/templates) 中保留的上游许可证；Jinja 引擎许可证见 [`src/vendor/jinja/LICENSE`](src/vendor/jinja/LICENSE)。
