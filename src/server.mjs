/**
 * Local evidence bridge for the releases pinned in versions.json.
 * OpenCode: owned serve process, V1 REST/global SSE and Anthropic proxy capture.
 * Codex: one exec process per run; official provider + native rollout traces by
 * default, or opt-in lossy Responses/Anthropic translation for third-party models.
 * Captured client payloads are not the final server-side prompt or private reasoning.
 * Replay is bounded in-memory; raw evidence and traces remain local sensitive data.
 */
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { readFile, appendFile, writeFile, mkdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import os from "node:os"
import { readTraceEvents, summarizeResponse, requestTools, withModelInputs } from "./trace.mjs"
import { listTemplates, renderTemplatePreview } from "./template-preview.mjs"
import { resolveCodexLauncher } from "./cli.mjs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
if (process.argv.length > 2) throw new Error("请使用 npm start 启动；项目目录在 config/settings.json 的 projectPath 中设置。")
const CFG = JSON.parse(await readFile(process.env.VIZ_CONFIG_PATH ?? path.join(ROOT, "config", "settings.json"), "utf8"))
const RUNTIME_DIR = path.resolve(process.env.VIZ_RUNTIME_DIR ?? path.join(ROOT, ".runtime"))
const projectPath = process.env.VIZ_TARGET_PROJECT || CFG.projectPath
const TARGET_PROJECT = path.resolve(ROOT, projectPath || "examples/demo")
await mkdir(RUNTIME_DIR, { recursive: true })
const SOURCE_LOCK = JSON.parse(await readFile(path.join(ROOT, "src", "versions.json"), "utf8"))

/* 自身日志同时落盘 —— 启动时无需 -RedirectStandardOutput（那会占住父 shell 管道导致卡死） */
const SELF_LOG = path.join(RUNTIME_DIR, "server.log")
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
const OC_PASSWORD = randomUUID()
const AUTH = "Basic " + Buffer.from(`opencode:${OC_PASSWORD}`).toString("base64")

const LLM_UPSTREAM = process.env.LLM_UPSTREAM ?? CFG.upstream
const OC_MODEL = `minimax/${CFG.opencode.model}`

let child = null
let ocReady = false
let codexProc = null   // codex exec 子进程（每次运行一个）

/* ── CLI 版本探测（适配性锚点：README「版本适配」表） ── */
const versions = { opencode: "?", codex: "?" }
const { command: codexCommand, prefix: codexPrefix } = await resolveCodexLauncher()
async function detectVersions() {
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const run = promisify(execFile)
  try { versions.opencode = (await run("opencode", ["--version"], { shell: process.platform === "win32", timeout: 15000 })).stdout.trim() } catch {}
  try {
    versions.codex = (await run(codexCommand, [...codexPrefix, "--version"], { timeout: 30000 })).stdout.trim()
  } catch {}
  console.log(`[viz] opencode ${versions.opencode} · codex ${versions.codex}`)
  for (const h of ["codex", "opencode"]) {
    if (versions[h].replace(/^codex-cli\s+/, "") !== SOURCE_LOCK[h].version) {
      throw new Error(`${h} CLI ${versions[h]} does not match audited source ${SOURCE_LOCK[h].tag}`)
    }
  }
}

/* ── codex 隔离：CODEX_HOME 指向运行目录 ──
 * useDefaultModel=false：config.toml 注册自定义 provider 把模型请求引到本代理（可捕获提示词）；
 * useDefaultModel=true：不写 model_provider，codex 直接用自带默认模型（ChatGPT 登录或
  * API key），流量不经代理；请求上下文由本地原生 rollout trace 捕获。 */
const CODEX_HOME = path.join(RUNTIME_DIR, "codex-home")
const CODEX_CONFIG = `model = ${JSON.stringify(CFG.codex.model)}
approval_policy = "never"
` + (CFG.codex.useDefaultModel ? "" : `
model_provider = "viz"

[model_providers.viz]
name = "viz-proxy"
base_url = "http://${HOST}:${LLM_PORT}/v1"
${CFG.upstreamEnvKey ? `env_key = "${CFG.upstreamEnvKey}"` : ""}
wire_api = "responses"
`) + `
[windows]
sandbox = "unelevated"
`
async function ensureCodexHome() {
  await mkdir(CODEX_HOME, { recursive: true })
  await writeFile(path.join(CODEX_HOME, "config.toml"), CODEX_CONFIG)
  /* useDefaultModel 时还要把用户的 ChatGPT 登录态复制进来（只拷贝，绝不动原文件），
   * 否则隔离 CODEX_HOME 里没有凭据，codex 会要求登录。 */
  if (CFG.codex.useDefaultModel) {
    const userHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
    for (const f of ["auth.json"]) {
      const src = path.join(userHome, f)
      try { await writeFile(path.join(CODEX_HOME, f), await readFile(src)) } catch {}
    }
  }
  // Remove the legacy blanket shell allow rules; explicit allows can bypass sandboxing.
  await mkdir(path.join(CODEX_HOME, "rules"), { recursive: true })
  await writeFile(path.join(CODEX_HOME, "rules", "default.rules"), "# No blanket executable allow rules.\n")
}

/* ── LLM 调用捕获 ─────────────────────────────────────── */
const llmCalls = []        // {index,startedAt,endedAt,ms,model,path,request,response,error}
let llmIndex = 0

/* ── 本地 SSE 广播（浏览器订阅 /api/stream） ─────────────── */
const sseClients = new Set()
const EVENT_LOG = path.join(RUNTIME_DIR, "events.jsonl")
/* 上次运行的完整事件（内存保存：刷新页面可回放恢复，重启即清）。每个 harness 独立一份 */
const runs = { opencode: { sessionID: null, events: [] }, codex: { sessionID: null, events: [] } }
const opencodeRunIDs = new Map()
function broadcast(payload) {
  if (!payload.harness) payload.harness = "opencode"
  payload.receivedAt ??= new Date().toISOString()
  payload.source ??= payload.type.startsWith("viz.") ? "viz" : payload.type.startsWith("codex.") ? "codex-exec" : "opencode-sse"
  if (!("runID" in payload)) payload.runID = runs[payload.harness]?.runID ?? null
  const line = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of sseClients) {
    try { res.write(line) } catch {}
  }
  // 落盘一份，方便事后排查（无需再用 curl 抓流）
  appendFile(EVENT_LOG, JSON.stringify({ t: Date.now(), ...payload }) + "\n").catch(() => {})
  // 记入对应 harness 的“上次运行”（心跳除外），供刷新/切换后回放
  if (payload.type !== "server.heartbeat") {
    const run = runs[payload.harness] ?? runs.opencode
    if (payload.runID !== run.runID) return
    run.events.push(payload)
    if (run.events.length > 40000) run.events.splice(0, run.events.length - 40000)
  }
}

/* ── 拉起隔离的 opencode serve ─────────────────────────── */
async function startOpencode() {
  let existing
  try {
    existing = await oc("/global/health", { signal: AbortSignal.timeout(5000) })
  } catch {}
  if (existing) throw new Error(`Port ${OC_PORT} is occupied; refusing to reuse an unverified OpenCode server`)
  const home = path.join(RUNTIME_DIR, "opencode-home")
  const configDir = path.join(home, "config")
  await mkdir(configDir, { recursive: true })
  const catalogPath = path.join(home, "models.json")
  await writeFile(catalogPath, "{}") // Prevent the embedded catalog from adding unrelated models.
  await writeFile(path.join(configDir, "opencode.json"), JSON.stringify({
    model: OC_MODEL, small_model: OC_MODEL, enabled_providers: ["minimax"], permission: { edit: "ask" },
    provider: { minimax: { name: "MiniMax", env: [CFG.upstreamEnvKey], npm: "@ai-sdk/anthropic",
      api: `http://${HOST}:${LLM_PORT}/anthropic/v1`, models: { [CFG.opencode.model]: {
        name: CFG.opencode.model, attachment: true, reasoning: true, temperature: true, tool_call: true,
        modalities: { input: ["text", "image", "video"], output: ["text"] }, limit: CFG.opencode.limit,
      } } } },
  }))
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE_")))
  const env = {
    ...inherited,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "state"),
    OPENCODE_TEST_HOME: home,
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_DB: path.join(RUNTIME_DIR, "opencode.db"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_MODELS_PATH: catalogPath,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_SERVER_PASSWORD: OC_PASSWORD,
    OPENCODE_CLIENT: "harness-viz",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
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
      const res = await oc("/global/health", { signal: AbortSignal.timeout(5000) })
      if (res.ok) {
        const health = await res.json()
        if (health.healthy && health.version === SOURCE_LOCK.opencode.version) { ocReady = true; console.log("[viz] opencode serve 就绪"); return }
      }
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
          const p = payload.properties ?? {}
          const sessionID = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID ?? p.info?.id
          if (p.info?.parentID && opencodeRunIDs.has(p.info.parentID)) opencodeRunIDs.set(p.info.id, opencodeRunIDs.get(p.info.parentID))
          const taskMetadata = p.part?.tool === "task" ? p.part.state?.metadata : null
          if (taskMetadata?.sessionId && opencodeRunIDs.has(sessionID)) opencodeRunIDs.set(taskMetadata.sessionId, opencodeRunIDs.get(sessionID))
          broadcast({ ...payload, source: "opencode-sse", runID: opencodeRunIDs.get(sessionID) ?? null,
            upstream: { directory: evt.directory, workspace: evt.workspace, project: evt.project } })
        }
      }
    } catch (err) {
      console.log("[viz] 上游事件流断开，重连中:", String(err?.message ?? err))
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}

/* ── LLM 代理：记录客户端请求与实际收到的上游响应 ────────────── */
const llmProxy = createServer(async (req, res) => {
  if (![`${HOST}:${LLM_PORT}`, `localhost:${LLM_PORT}`].includes(req.headers.host) || req.headers.origin) {
    res.writeHead(403); res.end("Only local CLI proxy requests are accepted"); return
  }
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
    source: "proxy",
    runID: opencodeRunIDs.get(req.headers["x-opencode-session-id"]) ?? null,
    sessionID: req.headers["x-opencode-session-id"] ?? null,
    parentSessionID: req.headers["x-opencode-parent-session-id"] ?? null,
    model: bodyJson?.model ?? null,
    request: bodyJson,          // {model, system, messages[], tools[], max_tokens, stream...}
    requestRaw: raw.toString("utf8"),
    response: null,
    error: null,
    ms: null,
  }
  llmCalls.push(call)

  broadcast({
    id: `llm-${index}-req`,
    type: "llm.request",
    source: "proxy", runID: call.runID,
    properties: {
      index, model: call.model,
      systemChars: typeof bodyJson?.system === "string" ? bodyJson.system.length
        : Array.isArray(bodyJson?.system) ? JSON.stringify(bodyJson.system).length : 0,
      messages: Array.isArray(bodyJson?.messages) ? bodyJson.messages.length : 0,
      tools: Array.isArray(bodyJson?.tools) ? bodyJson.tools.map((t) => t.name) : [],
      stream: Boolean(bodyJson?.stream),
      sessionID: call.sessionID, parentSessionID: call.parentSessionID, source: call.source,
    },
  })
  console.log(`[llm] #${index} → ${call.model}  messages=${call.request?.messages?.length ?? "?"} tools=${call.request?.tools?.length ?? 0}`)

  let captured = ""
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
    call.rawResponse = captured
    call.httpStatus = upstream.status
    if (!upstream.ok) call.error = `Upstream HTTP ${upstream.status}: ${captured.slice(0, 1000)}`
    else if (call.response.streamError) call.error = call.response.streamError
    else if (call.request?.stream && !call.response.terminal) call.error = "Upstream stream ended without message_stop"
    broadcast({
      id: `llm-${index}-res`,
      type: "llm.response",
      source: "proxy", runID: call.runID,
      properties: {
        index, ms: call.ms,
        textChars: call.response?.text?.length ?? 0,
        toolCalls: call.response?.toolCalls ?? [],
        stopReason: call.response?.stopReason ?? null,
        usage: call.response?.usage ?? null,
        error: call.error, source: call.source, sessionID: call.sessionID,
      },
    })
    console.log(`[llm] #${index} ← ${call.ms}ms  text=${call.response?.text?.length ?? 0}  tools=${(call.response?.toolCalls ?? []).join(",") || "-"}  stop=${call.response?.stopReason ?? "?"}`)
  } catch (err) {
    call.error = String(err?.message ?? err)
    call.ms = Date.now() - startedAt
    call.rawResponse = captured
    call.response = parseAnthropicSSE(captured)
    broadcast({ id: `llm-${index}-err`, type: "llm.response", source: "proxy", runID: call.runID, properties: { index, ms: call.ms, error: call.error, source: call.source, sessionID: call.sessionID } })
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "LLM 代理转发失败: " + call.error }))
  }
})

/** Parse observed SSE fields; raw capture remains separate from this summary. */
function parseAnthropicSSE(raw) {
  const out = { text: "", thinking: "", toolCalls: [], toolUses: [], stopReason: null, usage: null, terminal: false, streamError: null }
  const blocks = {}   // content_block index → {name, argsJson}
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue
    let evt
    try { evt = JSON.parse(line.slice(5).trim()) } catch { continue }
    if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
      out.toolCalls.push(evt.content_block.name)
      blocks[evt.index] = { name: evt.content_block.name, callID: evt.content_block.id, initialInput: evt.content_block.input, argsJson: "" }
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
    if (evt.type === "message_stop") out.terminal = true
    if (evt.type === "error") { out.streamError = evt.error?.message ?? evt.error?.type ?? "Upstream SSE error"; out.stopReason = "error: " + out.streamError }
  }
  out.toolUses = Object.values(blocks).map((b) => {
    let input
    try { input = b.argsJson ? JSON.parse(b.argsJson) : b.initialInput ?? {} } catch { input = b.argsJson }
    return { name: b.name, input, callID: b.callID }
  })
  return out
}

/* ═══════════════ codex：codex exec --json 拉起 + 事件解析 ═══════════════ */
/* exec_events::ThreadEvent is a selective presentation protocol, not a core trace.
 * This invocation explicitly configures never approvals and workspace-write. */
async function runCodex(prompt) {
  /* 直接 node 跑 codex 启动器，不走 shell:true —— cmd 的引号/特殊字符解析会把
   * 中文长 prompt 拆坏（实测 exit code 2 用法错误）。 */
  const args = [
    ...codexPrefix,
    "exec", "--json", "--skip-git-repo-check",
    "-C", TARGET_PROJECT,
    "-s", "workspace-write",
    "-m", CFG.codex.model,
    prompt,
  ]
  const run = runs.codex
  const env = { ...process.env, CODEX_HOME }
  delete env.CODEX_ROLLOUT_TRACE_ROOT
  let stopCapture = async () => {}
  if (CFG.codex.useDefaultModel) {
    const traceRoot = path.join(RUNTIME_DIR, "codex-traces", run.runID)
    await mkdir(traceRoot, { recursive: true })
    env.CODEX_ROLLOUT_TRACE_ROOT = traceRoot
    run.traceRoot = traceRoot
    stopCapture = captureCodexTrace(traceRoot, run)
  }
  codexProc = spawn(codexCommand, args, { env, cwd: TARGET_PROJECT, stdio: ["ignore", "pipe", "pipe"] })
  const proc = codexProc
  broadcast({ id: `cx-start-${Date.now()}`, harness: "codex", type: "codex.proc.start", properties: { executable: codexCommand, args: args.slice(0, -1), model: CFG.codex.model, captureSource: CFG.codex.useDefaultModel ? "native-trace" : "translation-proxy", sandbox: "workspace-write", approvalPolicy: "never", version: versions.codex } })
  console.log(`[codex] spawn exec (pid=${proc.pid})`)

  let buf = ""
  const emitLine = (line) => {
    if (!line.trim()) return
    let evt
    try { evt = JSON.parse(line) } catch { console.log("[codex:stdout] Invalid JSONL"); return }
    if (evt.type === "thread.started" && evt.thread_id) run.sessionID = evt.thread_id
    broadcast({ id: `cx-${randomUUID()}`, harness: "codex", runID: run.runID, source: "codex-exec", type: "codex." + evt.type, properties: evt })
  }
  const stdoutDecoder = new TextDecoder()
  proc.stdout.on("data", (d) => {
    buf += stdoutDecoder.decode(d, { stream: true })
    let idx
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      emitLine(line)
    }
  })
  let errBuf = ""
  proc.stderr.on("data", (d) => { errBuf += d.toString("utf8"); process.stdout.write(`[codex:err] ${d}`) })
  proc.on("error", (err) => broadcast({ harness: "codex", runID: run.runID, type: "codex.error", properties: { message: err.message } }))
  proc.on("close", async (code, signal) => {
    emitLine(buf + stdoutDecoder.decode())
    await stopCapture()
    if (codexProc === proc) codexProc = null
    run.active = false
    console.log(`[codex] 进程退出 code=${code} signal=${signal}`)
    broadcast({ id: `cx-exit-${Date.now()}`, harness: "codex", type: "codex.proc.exit",
      runID: run.runID, properties: { code, signal, aborted: Boolean(run.aborted), stderrTail: errBuf.trim().split("\n").slice(-5).join("\n") } })
  })
}

function captureCodexTrace(root, run) {
  const cursors = new Map(), calls = new Map()
  let pending = Promise.resolve(), warned = false
  const pull = () => pending = pending.then(async () => {
    for (const { bundle, event, payloads, rawPayloads } of await readTraceEvents(root, cursors)) {
      const p = event.payload
      const evidence = { bundle, event }
      const base = { harness: "codex", runID: run.runID, source: "native-trace" }
      if (p.type === "inference_started") {
        const request = payloads.request_payload
        const r = request?.request ?? request ?? {}
        const call = { index: ++llmIndex, harness: "codex", runID: run.runID, source: "native-trace", model: p.model,
          sessionID: p.thread_id, turnID: p.codex_turn_id, inferenceCallID: p.inference_call_id,
          startedAt: event.wall_time_unix_ms, request, requestRaw: rawPayloads.request_payload, response: null, error: null, trace: evidence }
        calls.set(p.inference_call_id, call)
        llmCalls.push(call)
        broadcast({ ...base, id: `trace-${bundle}-${event.seq}`, type: "llm.request", properties: {
          index: call.index, model: call.model, source: call.source, sessionID: call.sessionID, turnID: call.turnID,
          inferenceCallID: call.inferenceCallID, systemChars: (r.instructions ?? "").length,
          messages: r.input?.length ?? null, tools: requestTools(request).names, toolsLocation: requestTools(request).location,
          transport: r.type === "response.create" ? "websocket" : "http-or-logical-request",
          previousResponseID: r.previous_response_id ?? null,
        } })
      } else if (["inference_completed", "inference_failed", "inference_cancelled"].includes(p.type)) {
        const call = calls.get(p.inference_call_id)
        if (!call) continue
        call.rawResponse = payloads.response_payload ?? payloads.partial_response_payload ?? null
        call.response = summarizeResponse(call.rawResponse)
        call.endedAt = event.wall_time_unix_ms
        call.ms = call.endedAt - call.startedAt
        call.error = p.error ?? p.reason ?? null
        call.trace.terminal = event
        broadcast({ ...base, id: `trace-${bundle}-${event.seq}`, type: "llm.response", properties: {
          index: call.index, ms: call.ms, source: call.source, sessionID: call.sessionID,
          textChars: call.response.text.length, toolCalls: call.response.toolCalls, usage: call.response.usage, error: call.error,
        } })
      } else {
        broadcast({ ...base, id: `trace-${bundle}-${event.seq}`, type: "codex.trace", properties: { ...evidence, payloads } })
      }
    }
  }).catch(err => {
    if (!warned) broadcast({ harness: "codex", runID: run.runID, source: "viz", type: "codex.trace.warning", properties: { message: "Trace capture incomplete: " + err.message } })
    warned = true
  })
  const timer = setInterval(pull, 300)
  timer.unref()
  return async () => { clearInterval(timer); await pull() }
}

/* ═══════════════ codex：Responses API → Anthropic Messages 翻译 ═══════════════ */
/* Request shape: codex-api::ResponsesApiRequest / protocol::ResponseItem.
 *   {model, instructions, input:[ResponseItem], tools, tool_choice:"auto",
 *    parallel_tool_calls, reasoning, store:false, stream:true, include, ...}
 * ResponseItem examples:
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
    /* Unsupported reasoning items are omitted; this is a lossy conversion, not an equivalence claim. */
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

/** Adapt selected Anthropic SSE events to Responses; retain raw upstream evidence.
 * This is not a complete or semantically equivalent Responses implementation. */
async function handleCodexResponses(req, res, raw, bodyJson, startedAt, index) {
  const customTools = new Set()
  const call = {
    index, startedAt, path: req.url, harness: "codex",
    model: bodyJson?.model ?? null,
    source: "translation-proxy", runID: runs.codex.runID,
    request: bodyJson,       // Responses 原始请求（完整捕获：instructions/input/tools）
    requestRaw: raw.toString("utf8"),
    anthropicRequest: null,  // 翻译后的 Anthropic 请求（供对照）
    response: null, error: null, ms: null,
  }
  llmCalls.push(call)
  broadcast({
    id: `llm-${index}-req`, harness: "codex", source: "translation-proxy", type: "llm.request",
    properties: {
      index, model: call.model,
      systemChars: (bodyJson?.instructions ?? "").length,
      messages: Array.isArray(bodyJson?.input) ? bodyJson.input.length : 0,
      tools: (bodyJson?.tools ?? []).map((t) => t.name ?? t.type),
      stream: Boolean(bodyJson?.stream),
      source: call.source,
    },
  })
  console.log(`[llm] #${index} (codex) → ${call.model}  input=${bodyJson?.input?.length ?? "?"} tools=${bodyJson?.tools?.length ?? 0}`)

  const sse = (type, obj) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`)
  const respId = `resp_viz_${index}`
  let captured = "", terminalSeen = false
  try {
    const anthropicReq = responsesToAnthropic(bodyJson ?? {}, customTools)
    call.anthropicRequest = anthropicReq
    call.upstreamRequestRaw = JSON.stringify(anthropicReq)
    call.translationWarnings = [
      "Responses message roles other than assistant become Anthropic user; instructions become system.",
      "Reasoning items/settings are omitted; non-text input becomes a type placeholder.",
      "Only function/custom tools are forwarded; custom grammar becomes an input-string JSON schema.",
      "tool_choice is forced to auto; parallel/output-schema settings are not forwarded; max_tokens is fixed at 16384.",
      "Native model/provider semantics and private reasoning are not reproduced by this translator.",
    ]
    const KEY = process.env[CFG.upstreamEnvKey] ?? ""
    const upstream = await fetch(LLM_UPSTREAM + "/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": KEY,
        Authorization: `Bearer ${KEY}`,
        "anthropic-version": "2023-06-01",
      },
      body: call.upstreamRequestRaw,
    })
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "")
      throw new Error(`上游 HTTP ${upstream.status}: ${text.slice(0, 400)}`)
    }

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" })
    res.flushHeaders()
    sse("response.created", { response: { id: respId, status: "in_progress", model: call.model } })

    const decoder = new TextDecoder()
    let buf = ""
    const blocks = {}   // content_block index → {kind,itemId,name,callId,text,argsJson}
    let usage = {}, stopReason = null
    const handleEvent = (evt) => {
      if (evt.type === "message_start") {
        if (evt.message?.usage) usage = { ...usage, ...evt.message.usage }
      } else if (evt.type === "content_block_start") {
        const i = evt.index, b = evt.content_block ?? {}
        if (b.type === "text") {
          blocks[i] = { kind: "text", itemId: `msg_${index}_${i}`, text: "" }
          sse("response.output_item.added", { item: { type: "message", id: blocks[i].itemId, role: "assistant", status: "in_progress", content: [] } })
        } else if (b.type === "tool_use") {
          blocks[i] = { kind: "tool", name: b.name, callId: b.id, argsJson: "", initialInput: b.input ?? {} }
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
          const argumentsJson = b.argsJson || JSON.stringify(b.initialInput)
          if (customTools.has(b.name)) {
            let input = argumentsJson
            try { const o = JSON.parse(argumentsJson); input = typeof o.input === "string" ? o.input : JSON.stringify(o) } catch {}
            sse("response.output_item.done", { item: { type: "custom_tool_call", id: b.callId, call_id: b.callId, name: b.name, input } })
          } else {
            sse("response.output_item.done", { item: { type: "function_call", id: b.callId, call_id: b.callId, name: b.name, arguments: argumentsJson } })
          }
        }
      } else if (evt.type === "message_delta") {
        if (evt.usage) usage = { ...usage, ...evt.usage }
        stopReason = evt.delta?.stop_reason ?? stopReason
      } else if (evt.type === "message_stop") {
        terminalSeen = true
        const input_tokens = usage.input_tokens ?? 0, output_tokens = usage.output_tokens ?? 0
        if (stopReason === "max_tokens") {
          call.error = "Upstream output truncated (max_tokens)"
          sse("response.failed", { response: { id: respId, status: "failed", error: { code: "max_tokens", message: call.error } } })
        } else if (!call.error) sse("response.completed", { response: { id: respId, status: "completed", usage: { input_tokens, output_tokens, total_tokens: input_tokens + output_tokens } } })
      } else if (evt.type === "error") {
        call.error = evt.error?.message ?? evt.error?.type ?? "Upstream SSE error"
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
    if (!terminalSeen && !call.error) throw new Error("Upstream stream ended without message_stop")
    res.end()
    call.ms = Date.now() - startedAt
    call.endedAt = Date.now()
    call.rawResponse = captured
    call.response = parseAnthropicSSE(captured)
    broadcast({
      id: `llm-${index}-res`, harness: "codex", source: "translation-proxy", runID: call.runID, type: "llm.response",
      properties: {
        index, ms: call.ms,
        textChars: call.response?.text?.length ?? 0,
        toolCalls: call.response?.toolCalls ?? [],
        stopReason: call.response?.stopReason ?? null,
        usage: call.response?.usage ?? null,
        source: call.source, error: call.error,
      },
    })
    console.log(`[llm] #${index} (codex) ← ${call.ms}ms  text=${call.response?.text?.length ?? 0}  tools=${(call.response?.toolCalls ?? []).join(",") || "-"}  stop=${call.response?.stopReason ?? "?"}`)
  } catch (err) {
    call.error = String(err?.message ?? err)
    call.ms = Date.now() - startedAt
    call.rawResponse = captured
    call.response = parseAnthropicSSE(captured)
    broadcast({ id: `llm-${index}-err`, harness: "codex", source: "translation-proxy", runID: call.runID, type: "llm.response", properties: { index, ms: call.ms, error: call.error, source: call.source } })
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
  let admittedRun = null
  try {
    if (![`${HOST}:${VIZ_PORT}`, `localhost:${VIZ_PORT}`].includes(req.headers.host)) return json(res, { error: "Invalid local Host" }, 403)
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, { error: "Cross-origin requests are not allowed" }, 403)
    if (req.method === "POST" && !req.headers["content-type"]?.startsWith("application/json")) return json(res, { error: "application/json is required" }, 415)
    if (req.method === "GET" && ["/vendor/marked.js", "/vendor/purify.js", "/markdown.js", "/flows.js"].includes(url.pathname)) {
      const javascript = await readFile(path.join(ROOT, "public", url.pathname.slice(1)))
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "X-Content-Type-Options": "nosniff" })
      res.end(javascript)
      return
    }
    if (req.method === "GET" && url.pathname === "/") {
      const html = await readFile(path.join(ROOT, "public", "index.html"))
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(html)
      return
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      json(res, { ocReady, targetProject: TARGET_PROJECT, llmCalls: llmCalls.length, codexModel: CFG.codex.model, codexCapture: true,
        codexCaptureSource: CFG.codex.useDefaultModel ? "native-trace" : "translation-proxy", ocModel: OC_MODEL,
        versions, sourceLock: SOURCE_LOCK, codexExecutable: codexCommand, codexLauncher: codexPrefix[0] ?? null })
      return
    }

    if (req.method === "GET" && url.pathname === "/api/models") {
      json(res, { models: [{ value: OC_MODEL, label: CFG.opencode.model }] })
      return
    }

    if (req.method === "GET" && url.pathname === "/api/llm-calls") {
      json(res, { calls: withModelInputs(llmCalls) })
      return
    }

    if (req.method === "GET" && url.pathname === "/api/templates") {
      json(res, { templates: listTemplates() })
      return
    }

    /* 模板预览：本地离线渲染，不是服务端实际 prompt；模板文件固定在 src/templates/。 */
    if (req.method === "GET" && url.pathname === "/api/template-preview") {
      const index = Number(url.searchParams.get("index"))
      const templateId = url.searchParams.get("template") ?? ""
      if (!Number.isInteger(index)) return json(res, { error: "缺少有效的 index" }, 400)
      if (!listTemplates().some(t => t.id === templateId)) return json(res, { error: `未知模板: ${templateId}` }, 400)
      const call = withModelInputs(llmCalls).find(c => c.index === index)
      if (!call) return json(res, { error: `未找到调用 #${index}` }, 404)
      try {
        const result = await renderTemplatePreview({ modelInput: call.modelInput, templateId })
        json(res, { ok: true, index, ...result })
      } catch (err) {
        json(res, { error: String(err?.message ?? err) }, 502)
      }
      return
    }

    if (req.method === "GET" && url.pathname === "/api/last-run") {
      const h = url.searchParams.get("harness") ?? "opencode"
      json(res, runs[h] ?? runs.opencode)
      return
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      const { prompt, model, harness = "opencode" } = await readBody(req)
      if (!["codex", "opencode"].includes(harness)) return json(res, { error: "Unknown harness" }, 400)
      if (typeof prompt !== "string" || !prompt.trim()) return json(res, { error: "prompt 不能为空" }, 400)
      if (Object.values(runs).some(run => run.active)) return json(res, { error: "A run is active; abort or wait before starting another task" }, 409)
      for (let i = llmCalls.length - 1; i >= 0; i--) if ((llmCalls[i].harness ?? "opencode") === harness) llmCalls.splice(i, 1)
      runs[harness] = { sessionID: null, events: [], runID: randomUUID(), active: true, versions: { ...versions },
        sourceLock: SOURCE_LOCK, targetProject: TARGET_PROJECT,
        configuration: { model: harness === "codex" ? CFG.codex.model : model ?? OC_MODEL, captureSource: harness === "codex" ? CFG.codex.useDefaultModel ? "native-trace" : "translation-proxy" : "proxy" } }
      admittedRun = runs[harness]

      if (harness === "codex") {
        /* codex exec：一次性进程，prompt 作为参数；事件走 stdout JSONL（exec_events.rs:11）。
         * viz.run 先广播，前端据此清空/重建现场。 */
        broadcast({ id: `run-${Date.now()}`, harness: "codex", type: "viz.run", properties: { prompt, configuration: runs.codex.configuration } })
        await runCodex(prompt)
        json(res, { sessionID: null, harness: "codex" })
        return
      }

      const created = await oc("/session", {
        method: "POST",
        body: JSON.stringify({ title: "harness-viz " + new Date().toLocaleTimeString("zh-CN") }),
      })
      if (!created.ok) { runs.opencode.active = false; return json(res, { error: "创建会话失败: " + (await created.text()) }, 502) }
      const session = await created.json()
      runs.opencode.sessionID = session.id
      opencodeRunIDs.set(session.id, admittedRun.runID)
      broadcast({ id: `run-${Date.now()}`, harness: "opencode", type: "viz.run", properties: { prompt, model: model ?? null, sessionID: session.id } })
      const body = { parts: [{ type: "text", text: prompt }] }
      if (model ?? OC_MODEL) {
        const [providerID, ...rest] = String(model ?? OC_MODEL).split("/")
        body.model = { providerID, modelID: rest.join("/") }
      }
      // prompt() 会同步跑完整个 runLoop 才返回（遇权限询问会挂起），所以这里
      // 【发后即忘】：立即把 sessionID 还给浏览器，运行过程全部由事件流呈现。
      const run = runs.opencode
      oc(`/session/${session.id}/message`, { method: "POST", body: JSON.stringify(body) })
        .then(async (r) => {
          if (!r.ok) throw new Error(`Prompt HTTP ${r.status}: ${await r.text()}`)
          const result = await r.json()
          broadcast({ harness: "opencode", runID: run.runID, type: "viz.prompt.returned", properties: { sessionID: session.id, result } })
        })
        .catch(err => broadcast({ harness: "opencode", runID: run.runID, type: "session.error", source: "viz", properties: { sessionID: session.id, error: { name: "SubmissionError", message: err.message } } }))
        .finally(() => { run.active = false })
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
        res.write(`data: ${JSON.stringify({ type: "viz.connected", source: "viz", receivedAt: new Date().toISOString(), properties: {} })}\n\n`)
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
        if (!codexProc) return json(res, { ok: true, killed: false })
        runs.codex.aborted = true
        const killed = process.platform === "win32"
          ? spawnSync("taskkill", ["/PID", String(codexProc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).status === 0
          : codexProc.kill()
        broadcast({ harness, type: "viz.abort.accepted", properties: { killed } })
        return json(res, { ok: killed, killed })
      }
      if (!sessionID) return json(res, { error: "缺少 sessionID" }, 400)
      const r = await oc(`/session/${sessionID}/abort`, { method: "POST", body: JSON.stringify({}) })
      if (r.ok) broadcast({ harness, type: "viz.abort.accepted", properties: { sessionID } })
      json(res, { ok: r.ok, status: r.status })
      return
    }

    json(res, { error: "Not Found" }, 404)
  } catch (err) {
    if (admittedRun) admittedRun.active = false
    console.error("[viz] 请求处理异常:", err)
    json(res, { error: String(err?.message ?? err) }, 500)
  }
})

async function main() {
  console.log("[viz] 正在拉起隔离的 opencode serve ...")
  console.log(`[viz] 目标项目目录: ${TARGET_PROJECT}`)
  console.log(`[viz] LLM 上游: ${LLM_UPSTREAM}`)
  await ensureCodexHome()
  await detectVersions()
  console.log(`[viz] codex CODEX_HOME: ${CODEX_HOME}; capture=${CFG.codex.useDefaultModel ? "native-trace" : "translation-proxy"}`)
  await new Promise((resolve, reject) => {
    llmProxy.once("error", reject)
    llmProxy.listen(LLM_PORT, HOST, resolve)
  })
  await startOpencode()
  await waitReady()
  upstreamLoop()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(VIZ_PORT, HOST, resolve)
  })
  console.log(`[viz] 可视化页面: http://${HOST}:${VIZ_PORT}`)
}

function shutdown(exitCode = 0) {
  console.log("\n[viz] 正在退出，关闭子进程 ...")
  for (const proc of [child, codexProc]) {
    if (!proc?.pid) continue
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
    else { try { proc.kill() } catch {} }
  }
  process.exit(exitCode)
}
if (process.send) process.on("message", message => { if (message === "shutdown") shutdown() })
process.on("SIGINT", () => shutdown())
process.on("SIGTERM", () => shutdown())

main().catch((err) => {
  console.error("[viz] 启动失败:", err)
  shutdown(1)
})
