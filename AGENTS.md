# AGENTS.md — harness-viz

可视化 opencode / codex harness 内部流程的零依赖本地工具。中文界面与文档；代码标识符保持英文。

## 命令

- 启动：`npm start`（= `node server.mjs`）。**不要**用 `Start-Process -RedirectStandardOutput` 包裹（占住父 shell 管道卡死）；服务自己写日志到 `data/viz-server.log`。
- 语法检查：`node --check server.mjs`；index.html 的 JS 需先抽出 `<script>` 内容再 `node --check`。
- 重启时机：改 `server.mjs` 必须重启；改 `index.html` 不用（每请求重读）。
- 重启/查进程：`Get-CimInstance Win32_Process | ? CommandLine -match 'server\.mjs'`（注意会匹配到查询命令自身，计数多 1）。不要用 `Get-NetTCPConnection`（慢）。

## 端口与进程形态

- `4577` 浏览器 UI（server.mjs）；`45321` 隔离 opencode serve（常驻子进程，启动时探测复用，勿重复 spawn）；`45322` LLM 代理。
- opencode = 常驻 serve + REST/SSE 桥接；codex = 每次 run spawn 一次性 `codex exec --json`（通过 `node .../@openai/codex/bin/codex.js` 直接跑，**禁止 shell:true**——cmd 引号解析会把中文 prompt 拆坏，实测 exit 2）。
- `MINIMAX_API_KEY` 必须在环境里（opencode 转发 + codex env_key + 代理上游鉴权都靠它）。

## 架构要点（不看源码猜不到的）

- **事件必须用 `/global/event`**，不能用 `/event`（后者按 directory 严格相等过滤会丢事件）。
- **`POST /session/{id}/message` 同步跑完整个 runLoop**（遇权限询问挂起）→ 必须**发后即忘**。
- LLM 捕获靠代理：opencode 走 Anthropic 透传（models.json 把 api 指向 :45322）；codex 只讲 Responses API（≥0.147 已移除 wire_api=chat），代理在 `/v1/responses` 做 **Responses↔Anthropic 双向翻译**再转 MiniMax。
- 每个事件带**顶层** `harness` 字段（opencode/codex），不在 `properties` 里——前端路由按 `evt.harness` 判别（曾因错读 `p.harness` 导致 codex 的 LLM 记录不可见）。
- `llmCalls` / `runs.{opencode,codex}` 全在内存：刷新页面用 `/api/last-run?harness=` 回放恢复；server 重启即清。`data/events.jsonl` 落盘仅供排查，不自动回放。
- 隔离：opencode 靠环境变量（见 README 表格）；codex 靠 `CODEX_HOME=data/codex-home`（启动时重建 config.toml + rules/default.rules）。都不触碰用户真实配置。
- codex exec 审批固定 `Never`（exec/src/lib.rs:413），execpolicy 判 Prompt 即拒（"blocked by policy"）→ 靠 `data/codex-home/rules/default.rules` 放行 powershell 包装命令。**没有权限弹窗是架构差异，不是缺陷**。

## 流程图几何纪律（反复踩坑）

- SVG `viewBox` = `.flowsvg` CSS 高度 = `#flowCanvas` 高度，三者必须一致（当前 700×1070），否则连线层被拉伸错位。
- 节点固定 `height:64px`（副标题两行截断）；菱形 170×64 clip-path；状态光晕用 `filter:drop-shadow`（clip-path 会裁掉 box-shadow）。
- 线条/虚线框样式挂在 **`.flowsvg` 类**上，不要用 `#flowSvg` id 选择器（opencode 和 codex 两张图共用）；每个 SVG 必须自带 `<defs>` marker（引用 `display:none` SVG 里的 marker 会失效）。
- opencode 图与 codex 图是 `#flowCanvas` 下两个绝对定位图层（`#flowOpencode`/`#flowCodex`）切隐显；codex 节点 id 一律 `c-` 前缀。

## 文档纪律（本项目方法论）

- 流程图、节点说明、源码三者必须一致：**每条说明都要有 file:line 支撑**。opencode 源码 =
  opencode 仓库的 `packages/opencode/src`（本工具锚定 2026-08 前后的 dev 分支，版本 1.18.21）；
  codex 源码 = `openai/codex` 的 `codex-rs/`（锚定 0.147.0+）。本仓库不含上游源码——需要核对
  行号时自行克隆上游（opencode：github.com/sst/opencode 或其组织 fork；codex：github.com/openai/codex）。
  上游更新后行号可能漂移，改动前先重读源码核实。
- **实测抓包是终极裁判**：messages/input 项数逐轮增长、stop_reason 序列、system 字符数，比读文档可靠。验证方式：`POST /api/run {prompt, harness}` → 轮询 `/api/last-run?harness=` 与 `/api/llm-calls`。
- headless 浏览器一次性截图会因 SSE 长连接挂死——自动视觉验证不可行，靠接口数据 + 人工查看。

## Shell 陷阱（PowerShell 5.1）

- 没有 `??` 操作符；发中文 JSON 用 `[System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))` 写文件再 `-InFile` 上传（避免 BOM/引号问题）。
- `data/` 下运行时状态（db/log/events.jsonl/codex-home）已 gitignore，勿提交；`data/models.json`、`data/config/opencode.json` 是需入库的隔离配置。

## 参考文档

- `README.md`：启动、原理图、隔离表格、opencode runLoop 与 codex run_turn 的逐步源码定位、两 harness 差异对照表。
- 上游架构文档：`../opencode/CONTEXT.md`、`../opencode/AGENTS.md`、`../opencode/specs/v2/`（注意：已发布版本实际跑的是 V1 runLoop）。
