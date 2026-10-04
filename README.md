# harness-viz

**在浏览器里看清 Codex 和 OpenCode 如何完成一个编程任务。**

运行真实 CLI，查看工具调用、执行结果和客户端模型上下文；点击流程图节点，对照源码理解每一步。

[![操作演示](docs/assets/demo.gif)](docs/assets/demo.webm)

点击查看视频：输入任务、运行、查看工具结果和上下文。演示使用真实任务记录的加速回放，不模拟模型输出。

## 快速开始

先安装 [Node.js 22+](https://nodejs.org/)、[Codex CLI](https://developers.openai.com/codex/cli) 和 [OpenCode](https://opencode.ai/docs/)。CLI 按各自官方方式安装即可，**不要求用 npm 安装**；已安装可跳过。当前适配 Codex `0.160.0`、OpenCode `1.18.34`。

首次使用 Codex，先登录一次（已登录可跳过）：

```sh
codex login
```

下载或克隆此仓库后，在 `harness-viz` 文件夹打开终端，启动：

```sh
npm start
```

打开 **http://127.0.0.1:4577**，点击顶部「输入」→「演示」→「运行」。

默认工作目录为 `examples/demo`。

使用自己的项目：修改 [`config/settings.json`](config/settings.json) 中的 `projectPath`，然后重启。

## 能看到什么

- **流程图**：源码机制及对应的事件记录。
- **实时转写**：助手输出、工具调用、结果和权限询问。
- **上下文详情**：直接查看客户端请求、工具定义和响应，并区分证据来源。

查看模型输入：点击流程图中的「LLM 采样／调用」，展开请求记录。Codex 增量请求会按已捕获的响应链重建上下文；可复制或下载。它不是服务端最终加工后的提示词。

顶部可独立开关输入框、流程图、转写和详情；隐藏面板后，其余面板自动扩展。转写支持 Markdown。

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
| `.runtime/` | 日志、认证和验证记录，**不提交 Git** |

## 边界与开发

流程图是源码机制简图，不是逐函数追踪；客户端捕获不等于服务端最终提示词或完整内部推理，流程结束也不代表代码正确。捕获可能含敏感内容，请勿公开 `.runtime/`。

`npm test` 运行无模型回归测试；`npm run test:integration` 使用临时项目调用真实模型；`npm run test:browser -- ".runtime/verification/<run>"` 检查记录回放。CLI 版本和源码固定在 [`src/versions.json`](src/versions.json)，详细定位在界面节点说明中。

[MIT License](LICENSE)
