/**
 * opencode Harness 实时可视化 —— 零依赖后端
 *
 * 三个职责：
 *  1. 拉起【全局已安装】的 opencode serve 子进程（config/db/models 全隔离，
 *     不影响你现有的 opencode 使用）。
 *  2. LLM 代理（端口 45322）：opencode 的模型请求被引导到这里，我们完整记录
 *     每次调用的 system prompt / messages / tools / 响应 / 耗时，再原样转发到
 *     真实 MiniMax 端点（https://api.minimaxi.com/anthropic/v1）。
 *  3. 浏览器桥（端口 4577）：
 *     - POST /api/run        → 建会话 + 发提示词（harness=opencode|codex）
 *     - GET  /api/stream     → SSE：事件流 + LLM 调用事件（每条带 harness 字段）
 *     - GET  /api/llm-calls  → 已捕获的模型调用明细（完整提示词 + 完整响应）
 *     - GET  /api/last-run?harness= → 上次运行的全部事件（刷新页面后回放恢复现场）
 *     - POST /api/permission → 回答权限询问（仅 opencode）
 *     - POST /api/abort      → 中断（opencode: 会话 abort；codex: 杀 exec 进程）
 *     - GET  /api/models     → 可选模型列表
 *     - GET  /               → index.html
 *
 * codex 模式：
 *  - 每次运行 spawn `codex exec --json`（CODEX_HOME 隔离到 data/codex-home，
 *    沙箱 workspace-write，审批策略 Never —— exec/src/lib.rs:413）。
 *  - codex 只支持 Responses API（wire_api=chat 已于 0.147.0 移除），其模型请求
 *    被引导到本代理的 /v1/responses，由我们翻译成 Anthropic Messages 调用上游
 *    MiniMax，再把 Anthropic SSE 翻译回 Responses SSE（翻译规则见下方注释）。
 */
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { readFile, appendFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const TARGET_PROJECT = path.join(ROOT, "target-project")
const DATA_DIR = path.join(ROOT, "data")

/* 自身日志同时落盘 —— 启动时无需 -RedirectStandardOutput（那会占住父 shell 管道导致卡死） */
const SELF_LOG = path.join(DATA_DIR, "viz-server.log")
const _log = console.log.bind(console)
console.log = (...args) => {
  _log(...args)
  appendFile(SELF_LOG, args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n").catch(() => {})
}

const VIZ_PORT = Number(process.env.VIZ_PORT ?? 4577)   // 浏览器入口
const OC_PORT = Number(process.env.OC_PORT ?? 45321)    // opencode serve
const LLM_PORT = Number(process.env.LLM_PORT ?? 45322)  // LLM 代理
const HOST = "127.0.0.1"
const OC_BASE = `http://${HOST}:${OC_PORT}`
const OC_PASSWORD = "viz-local-secret"
const AUTH = "Basic " + Buffer.from(`opencode:${OC_PASSWORD}`).toString("base64")

/* ── 用户配置 viz.config.json（可选；缺省 = MiniMax 抓包模式） ──
 * {
 *   "upstream":       翻译代理转发的 Anthropic 兼容上游（默认 MiniMax），
 *   "upstreamEnvKey": 代理转发时使用的环境变量名（其值绝不落盘），
 *   "codex": { "useDefaultModel": true 则 codex 用自带默认模型（ChatGPT 登录/OPENAI_API_KEY），
 *              绕过代理 → 无提示词捕获；false 则走代理 + model 指定模型名 },
 *   "opencode": { "model": "providerID/modelID"，需与 data/config/models.json 里的条目对应 }
 * } */
let CFG = { upstream: "https://api.minimaxi.com", upstreamEnvKey: "MINIMAX_API_KEY", codex: { useDefaultModel: false, model: "MiniMax-M3" }, opencode: { model: "minimax-cn-coding-plan/MiniMax-M3" } }
try { CFG = { ...CFG, ...JSON.parse(await readFile(path.join(ROOT, "viz.config.json"), "utf8")) } } catch {}
const LLM_UPSTREAM = process.env.LLM_UPSTREAM ?? CFG.upstream

let child = null
let ocReady = false
let codexProc = null   // codex exec 子进程（每次运行一个）

/* ── CLI 版本探测（适配性锚点：README「版本适配」表） ── */
const versions = { opencode: "?", codex: "?" }
async function detectVersions() {
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const run = promisify(execFile)
  try { versions.opencode = (await run("opencode", ["--version"], { shell: process.platform === "win32", timeout: 15000 })).stdout.trim() } catch {}
  try {
    const codexJs = process.env.CODEX_CLI_JS
      ?? path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
    versions.codex = (await run(process.execPath, [codexJs, "--version"], { timeout: 30000 })).stdout.trim()
  } catch {}
  console.log(`[viz] opencode ${versions.opencode} · codex ${versions.codex}`)
}

/* ── codex 隔离：CODEX_HOME 指向 data/codex-home ──
 * useDefaultModel=false：config.toml 注册自定义 provider 把模型请求引到本代理（可捕获提示词）；
 * useDefaultModel=true：不写 model_provider，codex 直接用自带默认模型（ChatGPT 登录或
 * OPENAI_API_KEY），流量不经代理 → 无 LLM 捕获，但开箱即用。 */
const CODEX_HOME = path.join(DATA_DIR, "codex-home")
const CODEX_CONFIG = CFG.codex.useDefaultModel
  ? `model = "${CFG.codex.model}"\n`
  : `model = "${CFG.codex.model}"
model_provider = "viz"

[model_providers.viz]
name = "viz-proxy"
base_url = "http://${HOST}:${LLM_PORT}/v1"
${CFG.upstreamEnvKey ? `env_key = "${CFG.upstreamEnvKey}"` : ""}
wire_api = "responses"
`
async function ensureCodexHome() {
  const { mkdir } = await import("node:fs/promises")
  await mkdir(CODEX_HOME, { recursive: true })
  await writeFile(path.join(CODEX_HOME, "config.toml"), CODEX_CONFIG)
  /* useDefaultModel 时还要把用户的 ChatGPT 登录态复制进来（只拷贝，绝不动原文件），
   * 否则隔离 CODEX_HOME 里没有凭据，codex 会要求登录。 */
  if (CFG.codex.useDefaultModel) {
    const userHome = path.join(process.env.USERPROFILE ?? "", ".codex")
    for (const f of ["auth.json"]) {
      const src = path.join(userHome, f)
      try { await writeFile(path.join(CODEX_HOME, f), await readFile(src)) } catch {}
    }
  }
  /* exec 模式审批=Never（exec/src/lib.rs:413），execpolicy 判定 Prompt 的命令会被
   * 直接拒绝（core/src/exec_policy.rs:214 prompt_is_rejected_by_policy → :1046
   * "blocked by policy"）。codex 在 Windows 上用 powershell -Command 包命令，
   * 默认规则匹配不到 → Prompt → 全被拒。故在隔离 CODEX_HOME 里放一份放行规则
   * （加载路径：exec_policy.rs:827 → $CODEX_HOME/rules/default.rules）。 */
  await mkdir(path.join(CODEX_HOME, "rules"), { recursive: true })
  await writeFile(path.join(CODEX_HOME, "rules", "default.rules"), `prefix_rule(pattern=["powershell.exe"], decision="allow")
prefix_rule(pattern=["powershell"], decision="allow")
prefix_rule(pattern=["C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe"], decision="allow")
`)
}

/* ── LLM 调用捕获 ─────────────────────────────────────── */
const llmCalls = []        // {index,startedAt,endedAt,ms,model,path,request,response,error}
let llmIndex = 0

/* ── 本地 SSE 广播（浏览器订阅 /api/stream） ─────────────── */
const sseClients = new Set()
const EVENT_LOG = path.join(DATA_DIR, "events.jsonl")
/* 上次运行的完整事件（内存保存：刷新页面可回放恢复，重启即清）。每个 harness 独立一份 */
const runs = { opencode: { sessionID: null, events: [] }, codex: { sessionID: null, events: [] } }
function broadcast(payload) {
  if (!payload.harness) payload.harness = "opencode"
  const line = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of sseClients) {
    try { res.write(line) } catch {}
  }
  // 落盘一份，方便事后排查（无需再用 curl 抓流）
  appendFile(EVENT_LOG, JSON.stringify({ t: Date.now(), ...payload }) + "\n").catch(() => {})
  // 记入对应 harness 的“上次运行”（心跳除外），供刷新/切换后回放
  if (payload.type !== "server.heartbeat") {
    const run = runs[payload.harness] ?? runs.opencode
    run.events.push(payload)
    if (run.events.length > 40000) run.events.splice(0, run.events.length - 40000)
  }
}

/* ── 拉起隔离的 opencode serve ─────────────────────────── */
async function startOpencode() {
  // 上次运行残留的 opencode serve 可能仍占用端口（同端口同鉴权同隔离目录），
  // 直接复用而非再次 spawn —— 否则新进程 bind 失败报 ServeError 退出。
  try {
    const res = await oc("/session/status")
    if (res.ok) { console.log(`[viz] 复用已在运行的 opencode serve (:${OC_PORT})`); ocReady = true; return }
  } catch {}
  const env = {
    ...process.env,
    OPENCODE_CONFIG_DIR: path.join(DATA_DIR, "config"),
    OPENCODE_DB: path.join(DATA_DIR, "opencode.db"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_MODELS_PATH: path.join(DATA_DIR, "config", "models.json"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_SERVER_PASSWORD: OC_PASSWORD,
    OPENCODE_CLIENT: "harness-viz",
  }
  child = spawn("opencode", ["serve", "--port", String(OC_PORT), "--hostname", HOST], {
    env,
    cwd: TARGET_PROJECT,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (d) => process.stdout.write(`[opencode] ${d}`))
  child.stderr.on("data", (d) => process.stdout.write(`[opencode:err] ${d}`))
  child.on("exit", (code, signal) => {
    ocReady = false
    console.log(`[opencode] 进程退出 code=${code} signal=${signal}`)
  })
}

async function oc(pathname, init = {}) {
  return fetch(OC_BASE + pathname, {
    ...init,
    headers: {
      Authorization: AUTH,
      "x-opencode-directory": TARGET_PROJECT,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  })
}

async function waitReady(timeoutMs = 90_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await oc("/session/status")
      if (res.ok) { ocReady = true; console.log("[viz] opencode serve 就绪"); return }
    } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error("等待 opencode serve 就绪超时")
}

/* ── 共享上游事件流（/global/event，无目录过滤，TUI 同款） ── */
const norm = (s) => String(s ?? "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "")
const WANT_DIR = norm(TARGET_PROJECT)

async function upstreamLoop() {
  for (;;) {
    if (!ocReady) { await new Promise((r) => setTimeout(r, 500)); continue }
    try {
      const res = await fetch(OC_BASE + "/global/event", {
        headers: { Authorization: AUTH, Accept: "text/event-stream" },
      })
      if (!res.ok || !res.body) throw new Error("HTTP " + res.status)
      console.log("[viz] 已订阅 opencode /global/event")
      const decoder = new TextDecoder()
      let buf = ""
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true })
        let idx
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const dataLine = block.split("\n").find((l) => l.startsWith("data:"))
          if (!dataLine) continue
          let evt
          try { evt = JSON.parse(dataLine.slice(5).trim()) } catch { continue }
          const payload = evt?.payload ?? evt
          if (!payload?.type) continue
          if (payload.type === "sync") continue   // 同步副本，跳过
          if (evt?.directory && evt.directory !== "global" && norm(evt.directory) !== WANT_DIR) continue
          broadcast(payload)
        }
      }
    } catch (err) {
      console.log("[viz] 上游事件流断开，重连中:", String(err?.message ?? err))
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}

/* ── LLM 代理：捕获每次模型调用的完整提示词 ────────────── */
const llmProxy = createServer(async (req, res) => {
  const startedAt = Date.now()
  const index = ++llmIndex
  let raw = Buffer.alloc(0)
  for await (const chunk of req) raw = Buffer.concat([raw, chunk])

  let bodyJson = null
  try { bodyJson = JSON.parse(raw.toString("utf8")) } catch {}

  /* codex 只讲 Responses API（POST /v1/responses）——单独处理：捕获 + 翻译成 Anthropic 调上游 */
  if ((req.url ?? "").startsWith("/v1/responses")) return handleCodexResponses(req, res, raw, bodyJson, startedAt, index)

  const call = {
    index,
    startedAt,
    path: req.url,
    harness: "opencode",
    model: bodyJson?.model ?? null,
    request: bodyJson,          // {model, system, messages[], tools[], max_tokens, stream...}
    response: null,
    error: null,
    ms: null,
  }
  llmCalls.push(call)

  broadcast({
    id: `llm-${index}-req`,
    type: "llm.request",
    properties: {
      index, model: call.model,
      systemChars: typeof bodyJson?.system === "string" ? bodyJson.system.length
        : Array.isArray(bodyJson?.system) ? JSON.stringify(bodyJson.system).length : 0,
      messages: Array.isArray(bodyJson?.messages) ? bodyJson.messages.length : 0,
      tools: Array.isArray(bodyJson?.tools) ? bodyJson.tools.map((t) => t.name) : [],
      stream: Boolean(bodyJson?.stream),
    },
  })
  console.log(`[llm] #${index} → ${call.model}  messages=${call.request?.messages?.length ?? "?"} tools=${call.request?.tools?.length ?? 0}`)

  try {
    const headers = { ...req.headers }
    delete headers.host
    delete headers["content-length"]
    const upstream = await fetch(LLM_UPSTREAM + req.url, {
      method: req.method,
      headers,
      body: raw.length ? raw : undefined,
    })

    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    })
    res.flushHeaders()

    // 转发 + 旁路记录
    let captured = ""
    const decoder = new TextDecoder()
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        res.write(chunk)
        captured += decoder.decode(chunk, { stream: true })
      }
    }
    res.end()
    call.ms = Date.now() - startedAt
    call.endedAt = Date.now()
    call.response = parseAnthropicSSE(captured)
    broadcast({
      id: `llm-${index}-res`,
      type: "llm.response",
      properties: {
        index, ms: call.ms,
        textChars: call.response?.text?.length ?? 0,
        toolCalls: call.response?.toolCalls ?? [],
        stopReason: call.response?.stopReason ?? null,
        usage: call.response?.usage ?? null,
      },
    })
    console.log(`[llm] #${index} ← ${call.ms}ms  text=${call.response?.text?.length ?? 0}  tools=${(call.response?.toolCalls ?? []).join(",") || "-"}  stop=${call.response?.stopReason ?? "?"}`)
  } catch (err) {
    call.error = String(err?.message ?? err)
    call.ms = Date.now() - startedAt
    broadcast({ id: `llm-${index}-err`, type: "llm.response", properties: { index, ms: call.ms, error: call.error } })
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "LLM 代理转发失败: " + call.error }))
  }
})

/** 从 Anthropic SSE 流里提取完整响应（文本 / 思考 / 工具调用+入参 / usage） */
function parseAnthropicSSE(raw) {
  const out = { text: "", thinking: "", toolCalls: [], toolUses: [], stopReason: null, usage: null }
  const blocks = {}   // content_block index → {name, argsJson}
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue
    let evt
    try { evt = JSON.parse(line.slice(5).trim()) } catch { continue }
    if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
      out.toolCalls.push(evt.content_block.name)
      blocks[evt.index] = { name: evt.content_block.name, argsJson: "" }
    }
    if (evt.type === "content_block_delta") {
      if (evt.delta?.type === "text_delta") out.text += evt.delta.text ?? ""
      if (evt.delta?.type === "thinking_delta") out.thinking += evt.delta.thinking ?? ""
      if (evt.delta?.type === "input_json_delta" && blocks[evt.index])
        blocks[evt.index].argsJson += evt.delta.partial_json ?? ""
    }
    if (evt.type === "message_delta") {
      if (evt.delta?.stop_reason) out.stopReason = evt.delta.stop_reason
      if (evt.usage) out.usage = { ...(out.usage ?? {}), ...evt.usage }
    }
    if (evt.type === "message_start" && evt.message?.usage)
      out.usage = { ...(out.usage ?? {}), ...evt.message.usage }
    if (evt.type === "error") out.stopReason = "error: " + (evt.error?.message ?? "")
  }
  out.toolUses = Object.values(blocks).map((b) => {
    let input
    try { input = JSON.parse(b.argsJson || "{}") } catch { input = b.argsJson }
    return { name: b.name, input }
  })
  return out
}

/* ═══════════════ codex：codex exec --json 拉起 + 事件解析 ═══════════════ */
/* 源码依据：exec/src/lib.rs:246 run_main；--json 输出 ThreadEvent JSONL
 * （exec/src/exec_events.rs:11：thread.started / turn.started / item.started /
 *  item.updated / item.completed / turn.completed / turn.failed / error）。
 * 审批策略在 exec 模式下固定为 Never（exec/src/lib.rs:413），沙箱由 -s 指定。 */
function runCodex(prompt) {
  if (codexProc) { try { codexProc.kill() } catch {} }
  /* 直接 node 跑 codex 启动器，不走 shell:true —— cmd 的引号/特殊字符解析会把
   * 中文长 prompt 拆坏（实测 exit code 2 用法错误）。 */
  const codexJs = process.env.CODEX_CLI_JS
    ?? path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
  const args = [
    codexJs,
    "exec", "--json", "--skip-git-repo-check",
    "-C", TARGET_PROJECT,
    "-s", "workspace-write",
    "-m", CFG.codex.model,
    prompt,
  ]
  const env = { ...process.env, CODEX_HOME }
  codexProc = spawn(process.execPath, args, { env, cwd: TARGET_PROJECT, stdio: ["ignore", "pipe", "pipe"] })
  const proc = codexProc
  broadcast({ id: `cx-start-${Date.now()}`, harness: "codex", type: "codex.proc.start", properties: { cmd: "codex " + args.slice(1, -1).join(" ") } })
  console.log(`[codex] spawn exec (pid=${proc.pid})`)

  let buf = ""
  proc.stdout.on("data", (d) => {
    buf += d.toString("utf8")
    let idx
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let evt
      try { evt = JSON.parse(line) } catch { console.log("[codex:stdout]", line.slice(0, 200)); continue }
      if (evt.type === "thread.started" && evt.thread_id) runs.codex.sessionID = evt.thread_id
      broadcast({ id: `cx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, harness: "codex", type: "codex." + evt.type, properties: evt })
    }
  })
  let errBuf = ""
  proc.stderr.on("data", (d) => { errBuf += d.toString("utf8"); process.stdout.write(`[codex:err] ${d}`) })
  proc.on("exit", (code, signal) => {
    if (codexProc === proc) codexProc = null
    console.log(`[codex] 进程退出 code=${code} signal=${signal}`)
    broadcast({ id: `cx-exit-${Date.now()}`, harness: "codex", type: "codex.proc.exit",
      properties: { code, signal, stderrTail: errBuf.trim().split("\n").slice(-5).join("\n") } })
  })
}

/* ═══════════════ codex：Responses API → Anthropic Messages 翻译 ═══════════════ */
/* 请求契约（codex-api/src/common.rs:252 ResponsesApiRequest）：
 *   {model, instructions, input:[ResponseItem], tools, tool_choice:"auto",
 *    parallel_tool_calls, reasoning, store:false, stream:true, include, ...}
 * ResponseItem 线上形态（protocol/src/models.rs:950）：
 *   message {type:"message", role, content:[{type:"input_text"|"output_text", text}]}
 *   function_call {type:"function_call", name, arguments:<JSON 字符串>, call_id}
 *   function_call_output {type:"function_call_output", call_id, output:<字符串或对象>}
 *   reasoning / custom_tool_call 等。
 * 翻译目标：Anthropic Messages（model/system/messages/tools/stream）。 */
function responsesToAnthropic(body, customTools) {
  const messages = []
  const push = (role, block) => {
    const last = messages[messages.length - 1]
    if (last && last.role === role) last.content.push(block)
    else messages.push({ role, content: [block] })
  }
  for (const item of body.input ?? []) {
    if (item.type === "message") {
      const role = item.role === "assistant" ? "assistant" : "user"
      for (const c of item.content ?? []) {
        if (c.type === "input_text" || c.type === "output_text") push(role, { type: "text", text: c.text ?? "" })
        else push(role, { type: "text", text: `[${c.type}]` })
      }
    } else if (item.type === "function_call") {
      let input
      try { input = JSON.parse(item.arguments || "{}") } catch { input = { _raw: item.arguments } }
      push("assistant", { type: "tool_use", id: item.call_id, name: item.name, input })
    } else if (item.type === "custom_tool_call") {
      push("assistant", { type: "tool_use", id: item.call_id, name: item.name, input: { input: item.input ?? "" } })
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      let out = item.output
      if (out && typeof out === "object") out = out.content ?? JSON.stringify(out)
      push("user", { type: "tool_result", tool_use_id: item.call_id, content: typeof out === "string" ? out : JSON.stringify(out) })
    }
    /* reasoning 摘要不回灌：对模型无增量信息，且 Anthropic 拒收无签名的 thinking 块 */
  }
  if (!messages.length) messages.push({ role: "user", content: [{ type: "text", text: "(空输入)" }] })
  if (messages[0].role !== "user") messages.unshift({ role: "user", content: [{ type: "text", text: "(会话开始)" }] })
  const tools = (body.tools ?? [])
    .filter((t) => t.type === "function" || t.type === "custom")
    .map((t) => {
      if (t.type === "custom") customTools.add(t.name)
      return {
        name: t.name,
        description: t.description ?? "",
        input_schema: t.type === "custom"
          ? { type: "object", properties: { input: { type: "string", description: "自由文本入参" } }, required: ["input"] }
          : (t.parameters ?? { type: "object", properties: {} }),
      }
    })
  return {
    model: body.model,
    system: body.instructions || undefined,
    messages,
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? { type: "auto" } : undefined,
    max_tokens: 16384,
    stream: true,
  }
}

/** Anthropic SSE → Responses SSE 实时翻译转发，同时把原始流交给 parseAnthropicSSE 捕获。
 *  codex 消费的最小事件契约（codex-api/src/sse/responses.rs:348 process_responses_event）：
 *   response.created(:403) → output_item.added(:482) → output_text.delta(:360) →
 *   output_item.done(:352，触发工具执行 stream_events_utils.rs:289) →
 *   response.completed(:464，缺失则报 "stream closed before response.completed") */
async function handleCodexResponses(req, res, raw, bodyJson, startedAt, index) {
  const customTools = new Set()
  const call = {
    index, startedAt, path: req.url, harness: "codex",
    model: bodyJson?.model ?? null,
    request: bodyJson,       // Responses 原始请求（完整捕获：instructions/input/tools）
    anthropicRequest: null,  // 翻译后的 Anthropic 请求（供对照）
    response: null, error: null, ms: null,
  }
  llmCalls.push(call)
  broadcast({
    id: `llm-${index}-req`, harness: "codex", type: "llm.request",
    properties: {
      index, model: call.model,
      systemChars: (bodyJson?.instructions ?? "").length,
      messages: Array.isArray(bodyJson?.input) ? bodyJson.input.length : 0,
      tools: (bodyJson?.tools ?? []).map((t) => t.name ?? t.type),
      stream: Boolean(bodyJson?.stream),
    },
  })
  console.log(`[llm] #${index} (codex) → ${call.model}  input=${bodyJson?.input?.length ?? "?"} tools=${bodyJson?.tools?.length ?? 0}`)

  const sse = (type, obj) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`)
  const respId = `resp_viz_${index}`
  try {
    const anthropicReq = responsesToAnthropic(bodyJson ?? {}, customTools)
    call.anthropicRequest = anthropicReq
    const KEY = process.env.MINIMAX_API_KEY ?? ""
    const upstream = await fetch(LLM_UPSTREAM + "/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": KEY,
        Authorization: `Bearer ${KEY}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(anthropicReq),
    })
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "")
      throw new Error(`上游 HTTP ${upstream.status}: ${text.slice(0, 400)}`)
    }

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" })
    res.flushHeaders()
    sse("response.created", { response: { id: respId, status: "in_progress", model: call.model } })

    let captured = ""
    const decoder = new TextDecoder()
    let buf = ""
    const blocks = {}   // content_block index → {kind,itemId,name,callId,text,argsJson}
    let usage = {}
    const handleEvent = (evt) => {
      if (evt.type === "message_start") {
        if (evt.message?.usage) usage = { ...usage, ...evt.message.usage }
      } else if (evt.type === "content_block_start") {
        const i = evt.index, b = evt.content_block ?? {}
        if (b.type === "text") {
          blocks[i] = { kind: "text", itemId: `msg_${index}_${i}`, text: "" }
          sse("response.output_item.added", { item: { type: "message", id: blocks[i].itemId, role: "assistant", status: "in_progress", content: [] } })
        } else if (b.type === "tool_use") {
          blocks[i] = { kind: "tool", name: b.name, callId: b.id, argsJson: "" }
          const item = customTools.has(b.name)
            ? { type: "custom_tool_call", id: b.id, call_id: b.id, name: b.name, input: "" }
            : { type: "function_call", id: b.id, call_id: b.id, name: b.name, arguments: "" }
          sse("response.output_item.added", { item })
        }
      } else if (evt.type === "content_block_delta") {
        const b = blocks[evt.index]
        if (!b) return
        if (evt.delta?.type === "text_delta") {
          b.text += evt.delta.text ?? ""
          sse("response.output_text.delta", { item_id: b.itemId, delta: evt.delta.text ?? "" })
        } else if (evt.delta?.type === "input_json_delta") {
          b.argsJson += evt.delta.partial_json ?? ""
        }
      } else if (evt.type === "content_block_stop") {
        const b = blocks[evt.index]
        if (!b) return
        if (b.kind === "text") {
          sse("response.output_item.done", { item: { type: "message", id: b.itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: b.text }] } })
        } else {
          if (customTools.has(b.name)) {
            let input = b.argsJson
            try { const o = JSON.parse(b.argsJson || "{}"); input = typeof o.input === "string" ? o.input : JSON.stringify(o) } catch {}
            sse("response.output_item.done", { item: { type: "custom_tool_call", id: b.callId, call_id: b.callId, name: b.name, input } })
          } else {
            sse("response.output_item.done", { item: { type: "function_call", id: b.callId, call_id: b.callId, name: b.name, arguments: b.argsJson || "{}" } })
          }
        }
      } else if (evt.type === "message_delta") {
        if (evt.usage) usage = { ...usage, ...evt.usage }
      } else if (evt.type === "message_stop") {
        const input_tokens = usage.input_tokens ?? 0, output_tokens = usage.output_tokens ?? 0
        sse("response.completed", { response: { id: respId, status: "completed", usage: { input_tokens, output_tokens, total_tokens: input_tokens + output_tokens } } })
      } else if (evt.type === "error") {
        sse("response.failed", { response: { id: respId, status: "failed", error: { code: evt.error?.type ?? "error", message: evt.error?.message ?? "" } } })
      }
    }
    for await (const chunk of upstream.body) {
      const text = decoder.decode(chunk, { stream: true })
      captured += text
      buf += text
      let idx
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const blockText = buf.slice(0, idx); buf = buf.slice(idx + 2)
        const dataLine = blockText.split("\n").find((l) => l.startsWith("data:"))
        if (!dataLine) continue
        let evt
        try { evt = JSON.parse(dataLine.slice(5).trim()) } catch { continue }
        handleEvent(evt)
      }
    }
    res.end()
    call.ms = Date.now() - startedAt
    call.response = parseAnthropicSSE(captured)
    broadcast({
      id: `llm-${index}-res`, harness: "codex", type: "llm.response",
      properties: {
        index, ms: call.ms,
        textChars: call.response?.text?.length ?? 0,
        toolCalls: call.response?.toolCalls ?? [],
        stopReason: call.response?.stopReason ?? null,
        usage: call.response?.usage ?? null,
      },
    })
    console.log(`[llm] #${index} (codex) ← ${call.ms}ms  text=${call.response?.text?.length ?? 0}  tools=${(call.response?.toolCalls ?? []).join(",") || "-"}  stop=${call.response?.stopReason ?? "?"}`)
  } catch (err) {
    call.error = String(err?.message ?? err)
    call.ms = Date.now() - startedAt
    broadcast({ id: `llm-${index}-err`, harness: "codex", type: "llm.response", properties: { index, ms: call.ms, error: call.error } })
    if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream" })
    sse("response.failed", { response: { id: respId, status: "failed", error: { code: "proxy_error", message: call.error } } })
    res.end()
  }
}


/* ── 浏览器端 HTTP ────────────────────────────────────── */
function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(data))
}
async function readBody(req) {
  let raw = ""
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw.replace(/^﻿/, "")) : {}
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  try {
    if (req.method === "GET" && url.pathname === "/") {
      const html = await readFile(path.join(ROOT, "index.html"))
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(html)
      return
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      json(res, { ocReady, targetProject: TARGET_PROJECT, llmCalls: llmCalls.length, codexModel: CFG.codex.model, codexCapture: !CFG.codex.useDefaultModel, ocModel: CFG.opencode.model, versions })
      return
    }

    if (req.method === "GET" && url.pathname === "/api/models") {
      const data = JSON.parse(await readFile(path.join(DATA_DIR, "config", "models.json"), "utf8"))
      const models = []
      for (const [pid, provider] of Object.entries(data))
        for (const modelID of Object.keys(provider.models ?? {}))
          models.push({ value: `${pid}/${modelID}`, label: `${modelID} (${pid})` })
      json(res, { models })
      return
    }

    if (req.method === "GET" && url.pathname === "/api/llm-calls") {
      json(res, { calls: llmCalls })
      return
    }

    if (req.method === "GET" && url.pathname === "/api/last-run") {
      const h = url.searchParams.get("harness") ?? "opencode"
      json(res, runs[h] ?? runs.opencode)
      return
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      const { prompt, model, harness = "opencode" } = await readBody(req)
      if (!prompt) return json(res, { error: "prompt 不能为空" }, 400)
      await writeFile(EVENT_LOG, "").catch(() => {})   // 新一轮清空事件日志
      for (let i = llmCalls.length - 1; i >= 0; i--) if ((llmCalls[i].harness ?? "opencode") === harness) llmCalls.splice(i, 1)
      runs[harness] = { sessionID: null, events: [] }  // 清空该 harness 的回放缓存

      if (harness === "codex") {
        /* codex exec：一次性进程，prompt 作为参数；事件走 stdout JSONL（exec_events.rs:11）。
         * viz.run 先广播，前端据此清空/重建现场。 */
        broadcast({ id: `run-${Date.now()}`, harness: "codex", type: "viz.run", properties: { prompt } })
        runCodex(prompt)
        json(res, { sessionID: null, harness: "codex" })
        return
      }

      const created = await oc("/session", {
        method: "POST",
        body: JSON.stringify({ title: "harness-viz " + new Date().toLocaleTimeString("zh-CN") }),
      })
      if (!created.ok) return json(res, { error: "创建会话失败: " + (await created.text()) }, 502)
      const session = await created.json()
      runs.opencode.sessionID = session.id
      broadcast({ id: `run-${Date.now()}`, harness: "opencode", type: "viz.run", properties: { prompt, model: model ?? null, sessionID: session.id } })
      const body = { parts: [{ type: "text", text: prompt }] }
      if (model) {
        const [providerID, ...rest] = String(model).split("/")
        body.model = { providerID, modelID: rest.join("/") }
      }
      // prompt() 会同步跑完整个 runLoop 才返回（遇权限询问会挂起），所以这里
      // 【发后即忘】：立即把 sessionID 还给浏览器，运行过程全部由事件流呈现。
      oc(`/session/${session.id}/message`, { method: "POST", body: JSON.stringify(body) })
        .then(async (r) => { if (!r.ok) console.log("[viz] prompt 提交失败: HTTP " + r.status, await r.text().catch(() => "")) })
        .catch((err) => console.log("[viz] prompt 提交异常:", String(err?.message ?? err)))
      json(res, { sessionID: session.id })
      return
    }

    if (req.method === "GET" && url.pathname === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      })
      res.flushHeaders()
      res.write(`data: ${JSON.stringify({ type: "viz.connected", properties: {} })}\n\n`)
      sseClients.add(res)
      req.on("close", () => sseClients.delete(res))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/permission") {
      const { requestID, reply } = await readBody(req)
      if (!requestID || !reply) return json(res, { error: "缺少 requestID/reply" }, 400)
      const r = await oc(`/permission/${requestID}/reply`, { method: "POST", body: JSON.stringify({ reply }) })
      json(res, { ok: r.ok, status: r.status })
      return
    }

    if (req.method === "POST" && url.pathname === "/api/abort") {
      const { sessionID, harness = "opencode" } = await readBody(req)
      if (harness === "codex") {
        if (codexProc) { try { codexProc.kill() } catch {}; codexProc = null }
        return json(res, { ok: true, killed: true })
      }
      if (!sessionID) return json(res, { error: "缺少 sessionID" }, 400)
      const r = await oc(`/session/${sessionID}/abort`, { method: "POST", body: JSON.stringify({}) })
      json(res, { ok: r.ok, status: r.status })
      return
    }

    json(res, { error: "Not Found" }, 404)
  } catch (err) {
    console.error("[viz] 请求处理异常:", err)
    json(res, { error: String(err?.message ?? err) }, 500)
  }
})

async function main() {
  console.log("[viz] 正在拉起隔离的 opencode serve ...")
  console.log(`[viz] 目标项目目录: ${TARGET_PROJECT}`)
  console.log(`[viz] LLM 上游: ${LLM_UPSTREAM}`)
  await ensureCodexHome()
  detectVersions()
  console.log(`[viz] codex CODEX_HOME: ${CODEX_HOME}（模型请求 → 本代理 /v1/responses）`)
  llmProxy.listen(LLM_PORT, HOST, () => console.log(`[viz] LLM 代理(捕获提示词): http://${HOST}:${LLM_PORT}`))
  await startOpencode()
  await waitReady()
  upstreamLoop()
  server.listen(VIZ_PORT, HOST, () => console.log(`[viz] 可视化页面:  http://${HOST}:${VIZ_PORT}`))
}

function shutdown() {
  console.log("\n[viz] 正在退出，关闭子进程 ...")
  try { child?.kill() } catch {}
  try { codexProc?.kill() } catch {}
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

main().catch((err) => {
  console.error("[viz] 启动失败:", err)
  try { child?.kill() } catch {}
  process.exit(1)
})
