/**
 * Local evidence bridge for the releases pinned in versions.json.
 * OpenCode: owned serve process, native configuration and lossless SDK HTTP observation.
 * Codex: native TOML/profile discovery, one exec process per run and rollout traces.
 * Captured client payloads are not the final server-side prompt or private reasoning.
 * Replay is bounded in-memory; raw evidence and traces remain local sensitive data.
 */
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { readFile, appendFile, writeFile, mkdir, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import os from "node:os"
import { readTraceEvents, summarizeResponse, requestTools, withModelInputs } from "./trace.mjs"
import { listTemplates, renderTemplatePreview } from "./template-preview.mjs"
import { preparePinnedCli } from "./cli.mjs"
import { listenLocal, openCodeRequestedPort, opencodeListeningPort } from "./ports.mjs"
import { prepareExtensions, opencodeExtensions, codexExtensions, installCodexSkills, extensionInventory, DCP_CONFIG } from "./extensions.mjs"
import { copyNativeCodexHome, discoverCodexModels, nativeOpenCodePaths, nativeOpenCodeProviderIDs, opencodeModelCatalog } from "./native-models.mjs"
import { summarizeProxyResponse } from "./proxy-response.mjs"
import { buildCallRecord } from "./call-record.mjs"
import { startPreparation } from "./preparation.mjs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
if (process.argv.length > 2) throw new Error("请使用 npm start 启动；项目目录在 config/settings.json 的 projectPath 中设置。")
const CFG = JSON.parse(await readFile(process.env.VIZ_CONFIG_PATH ?? path.join(ROOT, "config", "settings.json"), "utf8"))
const RUNTIME_DIR = path.resolve(process.env.VIZ_RUNTIME_DIR ?? path.join(ROOT, ".runtime"))
// Verification runs isolate their data but reuse the repository's pinned binaries.
const CLI_DIR = path.resolve(process.env.VIZ_CLI_DIR ?? path.join(ROOT, ".runtime", "cli"))
const EXTENSIONS_DIR = path.resolve(process.env.VIZ_EXTENSIONS_DIR ?? path.join(ROOT, ".runtime", "extensions"))
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

let VIZ_PORT = Number(process.env.VIZ_PORT ?? 4577)     // 浏览器入口
let OC_PORT = Number(process.env.OC_PORT ?? 0)          // owned OpenCode listener
let LLM_PORT = Number(process.env.LLM_PORT ?? 0)        // owned proxy listener
const HOST = "127.0.0.1"
let OC_BASE = null
const OC_PASSWORD = randomUUID()
const AUTH = "Basic " + Buffer.from(`opencode:${OC_PASSWORD}`).toString("base64")

// Legacy translated records remain readable; new runs use native provider configuration.
const LLM_UPSTREAM = process.env.LLM_UPSTREAM ?? "https://api.minimaxi.com"
let OC_MODEL = null, codexModel = null, nativeCodex = null, nativeOpenCode = null
const modelCatalogs = { opencode: { models: [], defaultModel: null }, codex: { models: [], defaultModel: null } }
let observedProviderIDs = [], codexOverrides = []

let child = null
let ocReady = false
let codexProc = null   // codex exec 子进程（每次运行一个）

/* ── 专用固定 CLI：网页先启动，两个入口分别准备／失败 ── */
const versions = { opencode: "?", codex: "?" }
let codexCommand = null, codexPrefix = [], ocLauncher = null
const setupProcesses = new Set()
let extensionBundle = { skills: [], mcp: [], plugins: [], selection: { enabled: false } }, extensionPromise = null
const extensionState = { phase: CFG.extensions?.enabled ? "pending" : "disabled", error: null, message: "等待准备扩展", requested: CFG.extensions ?? { enabled: false } }
function trackSetupProcess(proc) {
  setupProcesses.add(proc)
  proc.once("close", () => setupProcesses.delete(proc))
}
async function ensureExtensions() {
  extensionPromise ??= prepareExtensions({ config: CFG.extensions, cacheRoot: EXTENSIONS_DIR, onProcess: trackSetupProcess,
    onState: state => { Object.assign(extensionState, state); console.log(`[viz] 扩展: ${state.message}`) } })
    .then(bundle => { extensionBundle = bundle; if (!bundle.selection.enabled) Object.assign(extensionState, { phase: "disabled", message: "扩展已关闭，可用于基线对比" }); return bundle })
    .catch(err => { Object.assign(extensionState, { phase: "error", error: err.message, message: "扩展准备失败，使用无外部扩展的基线运行" }); console.log(`[viz] 扩展准备失败: ${err.message}`); return extensionBundle })
  return extensionPromise
}
function configuredExtensions(harness) {
  const bundle = harness === "codex" ? { ...extensionBundle, mcp: extensionBundle.mcp.filter(item => !modelCatalogs.codex.nativeMcpNames?.includes(item.name)) } : extensionBundle
  return extensionInventory(bundle, harness, CODEX_HOME)
}
const cliStatus = Object.fromEntries(["opencode", "codex"].map(h => [h, {
  phase: "pending", available: false, version: SOURCE_LOCK[h].version, message: "等待准备固定 CLI…", error: null,
}]))
function updateCliStatus(harness, patch) {
  const previous = cliStatus[harness].message
  Object.assign(cliStatus[harness], patch)
  if (patch.message && patch.message !== previous) console.log(`[viz] ${harness}: ${patch.message}`)
}
async function prepareHarness(harness) {
  try {
    const launcher = await preparePinnedCli({ harness, version: SOURCE_LOCK[harness].version, cacheRoot: CLI_DIR,
      onState: state => updateCliStatus(harness, state), onProcess: trackSetupProcess })
    versions[harness] = launcher.version
    updateCliStatus(harness, { phase: "starting", message: "固定版本已核验，正在准备运行环境…",
      executable: launcher.command, launcher: launcher.prefix[0] ?? null, directory: launcher.directory })
    await ensureExtensions()
    if (harness === "codex") {
      codexCommand = launcher.command
      codexPrefix = launcher.prefix
      await ensureCodexHome()
      modelCatalogs.codex = await discoverCodexModels(launcher, CODEX_HOME, TARGET_PROJECT, trackSetupProcess)
      // Do not replace an MCP service already declared by native Codex configuration.
      const names = new Set(modelCatalogs.codex.nativeMcpNames ?? [])
      codexOverrides = codexOverrides.filter((value, index, list) => value === "-c" ? ![...names].some(name => list[index + 1]?.startsWith(`mcp_servers.${name}.`)) : ![...names].some(name => value.startsWith(`mcp_servers.${name}.`)))
      codexModel = modelCatalogs.codex.defaultModel
      console.log(`[viz] Codex 原生模型发现: ${modelCatalogs.codex.models.length} 项；capture=native-trace`)
    } else {
      ocLauncher = launcher
      await startOpencode()
      await waitReady()
      const providers = await oc("/config/providers", { signal: AbortSignal.timeout(120000) })
      if (!providers.ok) throw new Error("无法读取 OpenCode 原生模型目录")
      const configured = await oc("/config", { signal: AbortSignal.timeout(30000) })
      const config = configured.ok ? await configured.json() : {}
      modelCatalogs.opencode = opencodeModelCatalog((await providers.json()).providers ?? [], config.model)
      OC_MODEL = modelCatalogs.opencode.defaultModel
      console.log(`[viz] OpenCode 原生模型发现: ${modelCatalogs.opencode.models.length} 项`)
      upstreamLoop()
    }
    updateCliStatus(harness, { phase: "ready", available: true, message: `专用 ${harness} ${SOURCE_LOCK[harness].version} 已就绪`, error: null })
  } catch (err) {
    const error = String(err?.message ?? err)
    if (harness === "opencode") { failOpencode(error); killProcess(child) }
    else updateCliStatus(harness, { phase: "error", available: false, message: error.split("\n")[0], error })
  }
}

/* Codex loads a private snapshot of native config/auth; model configuration is not authored here. */
const CODEX_HOME = path.join(RUNTIME_DIR, "codex-home")
async function ensureCodexHome() {
  nativeCodex = await copyNativeCodexHome(CODEX_HOME, process.env.VIZ_CODEX_SOURCE_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"))
  await installCodexSkills(extensionBundle, CODEX_HOME)
  codexOverrides = extensionBundle.mcp.flatMap(item => [
    "-c", `mcp_servers.${item.name}.command=${JSON.stringify(item.command)}`,
    "-c", `mcp_servers.${item.name}.args=${JSON.stringify(item.args)}`,
    "-c", `mcp_servers.${item.name}.enabled=true`,
    ...(item.name === "context7" ? ["-c", 'mcp_servers.context7.env_vars=["CONTEXT7_API_KEY"]'] : []),
  ])
}

/* ── LLM 调用捕获 ─────────────────────────────────────── */
const llmCalls = []        // {index,startedAt,endedAt,ms,model,path,request,response,error}
let llmIndex = 0

/* ── 本地 SSE 广播（浏览器订阅 /api/stream） ─────────────── */
const sseClients = new Set()
const EVENT_LOG = path.join(RUNTIME_DIR, "events.jsonl")
/* 当前观察对话的完整事件（包含用户续聊各轮；刷新可恢复，重启即清）。每个 harness 独立一份。 */
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
    run.preparationTracker?.observe(payload)
  }
}

/* ── 拉起隔离的 opencode serve ─────────────────────────── */
function failOpencode(error) {
  ocReady = false
  updateCliStatus("opencode", { phase: "error", available: false,
    message: error.split("\n")[0] + (error.includes("\n") ? "；详细原因见「专用 CLI」，修复后重启 npm start。" : ""), error })
  const run = runs.opencode
  if (run.active) {
    run.active = false
    run.preparationTracker?.fail(error)
    broadcast({ harness: "opencode", runID: run.runID, type: "session.error", source: "viz",
      properties: { sessionID: run.sessionID, error: { name: "SubmissionError", message: error } } })
  }
}
async function startOpencode() {
  OC_PORT = await openCodeRequestedPort(OC_PORT, HOST)
  const home = path.join(RUNTIME_DIR, "opencode-home")
  const configDir = path.join(home, "config")
  await mkdir(configDir, { recursive: true })
  nativeOpenCode = await nativeOpenCodePaths(ocLauncher, TARGET_PROJECT)
  const overlay = { $schema: "https://opencode.ai/config.json", autoupdate: false, ...opencodeExtensions(extensionBundle) }
  await writeFile(path.join(configDir, "opencode.json"), JSON.stringify(overlay))
  const authTarget = path.join(home, "data", "opencode", "auth.json")
  await mkdir(path.dirname(authTarget), { recursive: true })
  try { await writeFile(authTarget, await readFile(path.join(nativeOpenCode.data, "auth.json"))) }
  catch (err) { if (err.code !== "ENOENT") throw err; await rm(authTarget, { force: true }) }
  if (extensionBundle.plugins.some(item => item.name === "dcp")) {
    await writeFile(path.join(configDir, "dcp.json"), JSON.stringify(DCP_CONFIG, null, 2))
    // DCP also reads XDG_CONFIG_HOME/opencode; keep that generated layer scoped.
    await mkdir(path.join(configDir, "opencode"), { recursive: true })
    await writeFile(path.join(configDir, "opencode", "dcp.json"), JSON.stringify(DCP_CONFIG, null, 2))
  }
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE_")))
  const env = {
    ...inherited,
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "state"),
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_DB: path.join(RUNTIME_DIR, "opencode.db"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "0",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_SERVER_PASSWORD: OC_PASSWORD,
    OPENCODE_CLIENT: "harness-viz",
    OPENCODE_ENABLE_QUESTION_TOOL: CFG.tools?.question ? "1" : "0",
    OPENCODE_ENABLE_EXA: CFG.tools?.websearch === "exa" ? "1" : "0",
    OPENCODE_ENABLE_PARALLEL: CFG.tools?.websearch === "parallel" ? "1" : "0",
    ...(CFG.tools?.websearch ? { OPENCODE_WEBSEARCH_PROVIDER: CFG.tools.websearch } : {}),
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  }
  // Keep native model/env configuration; isolate only auth/runtime writes.
  for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_MODELS_PATH"]) if (process.env[key]) env[key] = process.env[key]
  observedProviderIDs = await nativeOpenCodeProviderIDs(ocLauncher, TARGET_PROJECT, env)
  overlay.plugin.push(pathToFileURL(path.join(ROOT, "src", "observer-plugin.mjs")).href)
  await writeFile(path.join(configDir, "opencode.json"), JSON.stringify(overlay))
  env.HARNESS_VIZ_PROXY = `http://${HOST}:${LLM_PORT}`
  env.HARNESS_VIZ_PROVIDERS = JSON.stringify(observedProviderIDs)
  child = spawn(ocLauncher.command, [...ocLauncher.prefix, "serve", "--port", String(OC_PORT), "--hostname", HOST], {
    env,
    cwd: TARGET_PROJECT,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let announcement = ""
  const stdoutDecoder = new TextDecoder()
  child.stdout.on("data", (d) => {
    process.stdout.write(`[opencode] ${d}`)
    if (OC_BASE) return
    announcement = (announcement + stdoutDecoder.decode(d, { stream: true })).slice(-16384)
    const port = opencodeListeningPort(announcement, HOST)
    if (!port) return
    OC_PORT = port
    OC_BASE = `http://${HOST}:${OC_PORT}`
    console.log(`[viz] OpenCode 内部地址: ${OC_BASE}`)
  })
  child.stderr.on("data", (d) => process.stdout.write(`[opencode:err] ${d}`))
  child.on("error", err => failOpencode(err.message))
  child.on("exit", (code, signal) => {
    ocReady = false
    console.log(`[opencode] 进程退出 code=${code} signal=${signal}`)
    const error = `OpenCode 服务已退出（code=${code}, signal=${signal}）；请重启 npm start。`
    if (cliStatus.opencode.phase !== "error") failOpencode(error)
  })
}

async function oc(pathname, init = {}) {
  if (!OC_BASE) throw new Error("OpenCode 服务尚未报告监听地址")
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
    if (cliStatus.opencode.phase === "error") throw new Error(cliStatus.opencode.error)
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

  if (req.url !== "/opencode-observe") { res.writeHead(404); res.end(); return }
  const providerID = req.headers["x-harness-provider"]
  if (!observedProviderIDs.includes(providerID)) { res.writeHead(403); res.end("Unknown native provider"); return }
  let target
  try { target = new URL(req.headers["x-harness-upstream-url"]) } catch { res.writeHead(400); res.end("Missing native target"); return }
  if (!["https:", "http:"].includes(target.protocol) || target.username || target.password) { res.writeHead(400); res.end("Invalid native target"); return }
  const protocol = target.pathname.endsWith("/responses") ? "responses" : target.pathname.endsWith("/chat/completions") ? "chat" : "anthropic"

  const call = {
    index,
    startedAt,
    path: target.pathname,
    upstreamOrigin: target.origin,
    providerID,
    harness: "opencode",
    source: "proxy",
    protocol,
    extensions: configuredExtensions("opencode"),
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
      index, model: call.model, startedAt: call.startedAt,
      protocol: call.protocol, providerID: call.providerID, path: call.path, upstreamOrigin: call.upstreamOrigin,
      systemChars: protocol === "chat" ? (bodyJson?.messages ?? []).filter(m => ["system", "developer"].includes(m.role)).reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length), 0)
        : typeof bodyJson?.instructions === "string" ? bodyJson.instructions.length : typeof bodyJson?.system === "string" ? bodyJson.system.length
        : Array.isArray(bodyJson?.system) ? JSON.stringify(bodyJson.system).length : 0,
      messages: Array.isArray(bodyJson?.messages) ? bodyJson.messages.length : bodyJson?.input?.length ?? 0,
      tools: requestTools(bodyJson).names,
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
    delete headers["x-harness-upstream-url"]
    delete headers["x-harness-provider"]
    const upstream = await fetch(target.href, {
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
    call.response = protocol === "anthropic" ? parseAnthropicSSE(captured) : summarizeProxyResponse(captured, protocol)
    if (call.response.responseData) call.responseData = call.response.responseData
    call.rawResponse = captured
    call.httpStatus = upstream.status
    if (!upstream.ok) call.error = `Upstream HTTP ${upstream.status}: ${captured.slice(0, 1000)}`
    else if (call.response.streamError) call.error = call.response.streamError
    else if (call.request?.stream && !call.response.terminal) call.error = "Upstream stream ended without its terminal event"
    broadcast({
      id: `llm-${index}-res`,
      type: "llm.response",
      source: "proxy", runID: call.runID,
      properties: {
        index, ms: call.ms, endedAt: call.endedAt,
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
    call.endedAt = Date.now()
    call.rawResponse = captured
    call.response = protocol === "anthropic" ? parseAnthropicSSE(captured) : summarizeProxyResponse(captured, protocol)
    broadcast({ id: `llm-${index}-err`, type: "llm.response", source: "proxy", runID: call.runID, properties: { index, ms: call.ms, endedAt: call.endedAt, error: call.error, source: call.source, sessionID: call.sessionID } })
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
 * Model and permission settings remain native; resume uses an explicit thread ID. */
async function runCodex(prompt, selected, reasoningEffort, resumeSessionID) {
  /* 直接 node 跑 codex 启动器，不走 shell:true —— cmd 的引号/特殊字符解析会把
   * 中文长 prompt 拆坏（实测 exit code 2 用法错误）。 */
  const args = [
    ...codexPrefix,
    "exec", "--json", "--skip-git-repo-check",
    "-C", TARGET_PROJECT,
    ...(selected?.profile ? ["--profile", selected.profile] : []),
    ...(selected?.model ? ["-m", selected.model] : []),
    ...(selected?.providerID ? ["-c", `model_provider=${JSON.stringify(selected.providerID)}`] : []),
    ...codexOverrides,
    ...(reasoningEffort ? ["-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`] : []),
    ...(resumeSessionID ? ["resume", resumeSessionID] : []),
    prompt,
  ]
  const run = runs.codex
  const env = { ...process.env, CODEX_HOME }
  delete env.CODEX_ROLLOUT_TRACE_ROOT
  let stopCapture = async () => {}
  {
    const traceRoot = path.join(RUNTIME_DIR, "codex-traces", run.runID, String(run.turnNumber ?? 1))
    await mkdir(traceRoot, { recursive: true })
    env.CODEX_ROLLOUT_TRACE_ROOT = traceRoot
    run.traceRoot = traceRoot
    stopCapture = captureCodexTrace(traceRoot, run)
  }
  codexProc = spawn(codexCommand, args, { env, cwd: TARGET_PROJECT, stdio: ["ignore", "pipe", "pipe"] })
  const proc = codexProc
  broadcast({ id: `cx-start-${Date.now()}`, harness: "codex", conversationTurn: run.turnNumber, type: "codex.proc.start", properties: { executable: codexCommand, args: args.slice(0, -1), resumedSessionID: resumeSessionID ?? null, model: selected?.model, providerID: selected?.providerID, captureSource: "native-trace", sandbox: modelCatalogs.codex.sandbox ?? "原生 exec 默认", approvalPolicy: modelCatalogs.codex.approvalPolicy ?? "原生 exec 默认", version: versions.codex } })
  console.log(`[codex] spawn exec (pid=${proc.pid})`)

  let buf = ""
  const emitLine = (line) => {
    if (!line.trim()) return
    let evt
    try { evt = JSON.parse(line) } catch { console.log("[codex:stdout] Invalid JSONL"); return }
    if (evt.type === "thread.started" && evt.thread_id) run.sessionID = evt.thread_id
    broadcast({ id: `cx-${randomUUID()}`, harness: "codex", runID: run.runID, conversationTurn: run.turnNumber, source: "codex-exec", type: "codex." + evt.type, properties: evt })
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
  proc.on("error", err => run.preparationTracker?.fail(err))
  proc.on("close", async (code, signal) => {
    emitLine(buf + stdoutDecoder.decode())
    await stopCapture()
    if (run.preparationTracker?.record.status === "running") {
      if (run.aborted) run.preparationTracker.cancel()
      else if (code !== 0) run.preparationTracker.fail(new Error(`原生进程在准备完成前退出：${code}`))
      else run.preparationTracker.unconfirmed()
    }
    if (codexProc === proc) codexProc = null
    run.active = false
    console.log(`[codex] 进程退出 code=${code} signal=${signal}`)
    broadcast({ id: `cx-exit-${Date.now()}`, harness: "codex", type: "codex.proc.exit",
      runID: run.runID, conversationTurn: run.turnNumber, properties: { code, signal, aborted: Boolean(run.aborted), stderrTail: errBuf.trim().split("\n").slice(-5).join("\n") } })
  })
}

function captureCodexTrace(root, run) {
  const cursors = new Map(), calls = new Map()
  let pending = Promise.resolve(), warned = false
  const pull = () => pending = pending.then(async () => {
    for (const { bundle, event, payloads, rawPayloads } of await readTraceEvents(root, cursors)) {
      const p = event.payload
      const evidence = { bundle, event }
      const base = { harness: "codex", runID: run.runID, conversationTurn: run.turnNumber, source: "native-trace" }
      if (p.type === "inference_started") {
        const request = payloads.request_payload
        const r = request?.request ?? request ?? {}
        const call = { index: ++llmIndex, harness: "codex", runID: run.runID, conversationTurn: run.turnNumber, source: "native-trace", model: p.model, extensions: configuredExtensions("codex"),
          sessionID: p.thread_id, turnID: p.codex_turn_id, inferenceCallID: p.inference_call_id,
          startedAt: event.wall_time_unix_ms, request, requestRaw: rawPayloads.request_payload, response: null, error: null, trace: evidence }
        calls.set(p.inference_call_id, call)
        llmCalls.push(call)
        broadcast({ ...base, id: `trace-${bundle}-${event.seq}`, type: "llm.request", properties: {
          index: call.index, model: call.model, startedAt: call.startedAt, source: call.source, sessionID: call.sessionID, turnID: call.turnID,
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
          index: call.index, ms: call.ms, endedAt: call.endedAt, terminalType: p.type, source: call.source, sessionID: call.sessionID,
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
    extensions: configuredExtensions("codex"),
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
    if (req.method === "GET" && ["/vendor/marked.js", "/vendor/purify.js", "/markdown.js", "/flows.js", "/execution-records.js"].includes(url.pathname)) {
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
      json(res, { ocReady, targetProject: TARGET_PROJECT, llmCalls: llmCalls.length, codexModel, codexCapture: true,
        codexCaptureSource: "native-trace", ocModel: OC_MODEL,
        versions, sourceLock: SOURCE_LOCK, cliStatus, cliDirectory: CLI_DIR,
        conversations: Object.fromEntries(Object.entries(runs).map(([h, run]) => [h, { sessionID: run.sessionID, runID: run.runID, active: !!run.active, turnNumber: run.turnNumber ?? 0 }])),
        nativeModelConfiguration: { opencode: nativeOpenCode ? { globalDirectory: nativeOpenCode.config, projectDirectory: TARGET_PROJECT } : null,
          codex: nativeCodex, tools: CFG.tools ?? {}, counts: { opencode: modelCatalogs.opencode.models.length, codex: modelCatalogs.codex.models.length } },
        extensions: { state: extensionState, opencode: configuredExtensions("opencode"), codex: configuredExtensions("codex") },
        ports: { visualization: VIZ_PORT, opencode: OC_BASE ? OC_PORT : null, llm: LLM_PORT || null },
        codexExecutable: codexCommand, codexLauncher: codexPrefix[0] ?? null })
      return
    }

    if (req.method === "GET" && url.pathname === "/api/extensions") {
      const inventory = { state: extensionState, opencode: configuredExtensions("opencode"), codex: configuredExtensions("codex"),
        observed: { harness: "opencode", available: ocReady } }
      if (ocReady) {
        // Global health precedes lazy project initialization. Share that wait across
        // independent discovery reads and keep the total wait bounded to one minute.
        const selected = modelCatalogs.opencode.models.find(m => m.value === OC_MODEL)
        await Promise.all([["skills", "/skill"], ["mcp", "/mcp"], ...(selected ? [["tools", `/experimental/tool?provider=${encodeURIComponent(selected.providerID)}&model=${encodeURIComponent(selected.model)}`]] : [])].map(async ([key, route]) => {
          try {
            const response = await oc(route, { signal: AbortSignal.timeout(60000) })
            inventory.observed[key] = response.ok ? await response.json() : { error: `HTTP ${response.status}` }
          } catch (err) { inventory.observed[key] = { error: err.message } }
        }))
      }
      return json(res, inventory)
    }

    if (req.method === "GET" && url.pathname === "/api/models") {
      const harness = url.searchParams.get("harness") ?? "opencode"
      if (!modelCatalogs[harness]) return json(res, { error: "Unknown harness" }, 400)
      json(res, { ...modelCatalogs[harness], source: "native-cli-configuration", harness })
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
        const result = await renderTemplatePreview({ modelInput: call.modelInput, templateId, mode: url.searchParams.get("mode") ?? "request", call, events: runs[call.harness ?? "opencode"]?.events ?? [] })
        json(res, { ok: true, index, ...result })
      } catch (err) {
        json(res, { error: String(err?.message ?? err) }, 502)
      }
      return
    }

    if (req.method === "GET" && url.pathname === "/api/call-record") {
      const index = Number(url.searchParams.get("index"))
      const call = llmCalls.find(c => c.index === index)
      if (!call) return json(res, { error: "未找到调用" }, 404)
      return json(res, buildCallRecord(call, runs[call.harness ?? "opencode"]?.events ?? []))
    }

    if (req.method === "GET" && url.pathname === "/api/last-run") {
      const h = url.searchParams.get("harness") ?? "opencode"
      json(res, runs[h] ?? runs.opencode)
      return
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      const { prompt, model, variant, reasoningEffort, continueSessionID, harness = "opencode" } = await readBody(req)
      const preparationStartedAt = Date.now()
      if (!["codex", "opencode"].includes(harness)) return json(res, { error: "Unknown harness" }, 400)
      if (typeof prompt !== "string" || !prompt.trim()) return json(res, { error: "prompt 不能为空" }, 400)
      if (!cliStatus[harness].available) return json(res, { error: cliStatus[harness].error ?? cliStatus[harness].message, cliStatus: cliStatus[harness] }, 503)
      if (Object.values(runs).some(run => run.active)) return json(res, { error: "A run is active; abort or wait before starting another task" }, 409)
      const previous = runs[harness], continuing = continueSessionID != null
      if (continuing && (typeof continueSessionID !== "string" || !continueSessionID || !previous.runID || continueSessionID !== previous.sessionID)) return json(res, { error: "没有可继续的当前会话，请取消勾选后开启新会话。" }, 400)
      const selected = modelCatalogs[harness].models.find(m => m.value === (model ?? modelCatalogs[harness].defaultModel))
      if (!selected) return json(res, { error: "未找到已配置的原生模型；请在原生配置中设置模型并重启后选择。" }, 400)
      if (variant != null && variant !== "" && (harness !== "opencode" || typeof variant !== "string" || !selected.variants?.includes(variant))) return json(res, { error: "未找到该模型已配置的原生变体" }, 400)
      if (reasoningEffort != null && reasoningEffort !== "" && (harness !== "codex" || typeof reasoningEffort !== "string" || !selected.reasoningEfforts?.includes(reasoningEffort))) return json(res, { error: "该模型不支持此思考强度" }, 400)
      const validatedAt = Date.now()
      if (!continuing) for (let i = llmCalls.length - 1; i >= 0; i--) if ((llmCalls[i].harness ?? "opencode") === harness) llmCalls.splice(i, 1)
      // runID groups this observed conversation; turnNumber counts submitted user inputs,
      // not native loop iterations or model calls. Each turn owns a separate active flag.
      runs[harness] = { sessionID: continuing ? continueSessionID : null, events: continuing ? previous.events : [],
        runID: continuing ? previous.runID : randomUUID(), turnNumber: continuing ? (previous.turnNumber ?? 1) + 1 : 1, active: true, versions: { ...versions },
        sourceLock: SOURCE_LOCK, targetProject: TARGET_PROJECT,
        extensions: configuredExtensions(harness),
        configuration: { model: selected.model, providerID: selected.providerID, profile: selected.profile ?? null, variant: variant || null,
          reasoningEffort: (harness === "codex" ? reasoningEffort : variant) || null, captureSource: harness === "codex" ? "native-trace" : "proxy" } }
      admittedRun = runs[harness]
      broadcast({ id: `run-${randomUUID()}`, harness, conversationTurn: admittedRun.turnNumber, type: "viz.run",
        properties: { prompt, model: selected.value, configuration: admittedRun.configuration, sessionID: admittedRun.sessionID, continuing, turnNumber: admittedRun.turnNumber } })
      let preparationRevision = 0
      const preparationRun = admittedRun
      const preparation = startPreparation({ harness, runID: admittedRun.runID, turnNumber: admittedRun.turnNumber,
        startedAt: preparationStartedAt, input: { prompt, projectPath: TARGET_PROJECT, continuing, ...admittedRun.configuration,
          cliVersion: versions[harness] ?? null }, initialSteps: [{ id: "validate", label: "校验运行参数与模型选择", status: "completed",
          startedAt: new Date(preparationStartedAt).toISOString(), endedAt: new Date(validatedAt).toISOString(),
          details: { cliReady: true, selectedModel: selected.value, projectPath: TARGET_PROJECT } }] }, record => {
        preparationRun.preparation = record
        broadcast({ id: `preparation-${record.id}-${++preparationRevision}`, harness, runID: preparationRun.runID,
          conversationTurn: preparationRun.turnNumber, type: "viz.preparation", properties: { execution: record } })
      })
      Object.defineProperty(admittedRun, "preparationTracker", { value: preparation })

      if (harness === "codex") {
        /* codex exec：一次性进程，prompt 作为参数；事件走 stdout JSONL（exec_events.rs:11）。
         * viz.run 先广播，前端据此清空/重建现场。 */
        preparation.step("native", continuing ? "恢复原生线程并交付本轮输入" : "启动原生客户端并交付用户输入", { threadID: continueSessionID ?? null })
        await runCodex(prompt, selected, reasoningEffort || null, continuing ? continueSessionID : null)
        json(res, { sessionID: runs.codex.sessionID, harness: "codex", continuing, turnNumber: admittedRun.turnNumber })
        return
      }

      let session = { id: continueSessionID }
      preparation.step("session", continuing ? "使用当前原生会话" : "创建原生会话")
      if (!continuing) {
        const created = await oc("/session", {
          method: "POST",
          body: JSON.stringify({ title: "harness-viz " + new Date().toLocaleTimeString("zh-CN") }),
        })
        if (!created.ok) {
          const message = "创建会话失败: " + (await created.text())
          preparation.fail(message); runs.opencode.active = false
          return json(res, { error: message }, 502)
        }
        session = await created.json()
      }
      runs.opencode.sessionID = session.id
      opencodeRunIDs.set(session.id, admittedRun.runID)
      preparation.done("session", { sessionID: session.id })
      // Public native API messageID is supplied by the caller for exact receipt correlation.
      const messageID = "msg_" + randomUUID().replaceAll("-", "")
      preparation.session(session.id, messageID)
      preparation.step("native", "提交用户输入并等待原生保存确认", { sessionID: session.id, messageID })
      const body = { messageID, parts: [{ type: "text", text: prompt }] }
      if (variant) body.variant = variant
      body.model = { providerID: selected.providerID, modelID: selected.model }
      // prompt() 会同步跑完整个 runLoop 才返回（遇权限询问会挂起），所以这里
      // 【发后即忘】：立即把 sessionID 还给浏览器，运行过程全部由事件流呈现。
      const run = runs.opencode
      oc(`/session/${session.id}/message`, { method: "POST", body: JSON.stringify(body) })
        .then(async (r) => {
          if (!r.ok) throw new Error(`Prompt HTTP ${r.status}: ${await r.text()}`)
          const result = await r.json()
          if (preparation.record.status === "running") preparation.unconfirmed()
          broadcast({ harness: "opencode", runID: run.runID, conversationTurn: run.turnNumber, type: "viz.prompt.returned", properties: { sessionID: session.id, result } })
        })
        .catch(err => {
          preparation.fail(err)
          broadcast({ harness: "opencode", runID: run.runID, type: "session.error", source: "viz", properties: { sessionID: session.id, error: { name: "SubmissionError", message: err.message } } })
        })
        .finally(() => { run.active = false })
      json(res, { sessionID: session.id, continuing, turnNumber: admittedRun.turnNumber })
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

    if (req.method === "GET" && url.pathname === "/api/questions") {
      if (!ocReady || !runs.opencode.runID) return json(res, { questions: [] })
      const response = await oc("/question")
      if (!response.ok) return json(res, { error: "无法读取待答问题" }, response.status)
      const questions = await response.json()
      return json(res, { questions: questions.filter(q => opencodeRunIDs.get(q.sessionID) === runs.opencode.runID) })
    }

    if (req.method === "POST" && url.pathname === "/api/question") {
      const { requestID, action = "reply", answers } = await readBody(req)
      if (!runs.opencode.runID) return json(res, { error: "没有可答复的当前运行" }, 404)
      if (typeof requestID !== "string" || !["reply", "reject"].includes(action)) return json(res, { error: "缺少有效的 requestID/action" }, 400)
      if (action === "reply" && (!Array.isArray(answers) || answers.some(a => !Array.isArray(a) || a.some(v => typeof v !== "string")))) return json(res, { error: "answers 必须是按问题顺序排列的字符串数组列表" }, 400)
      const listed = await oc("/question")
      if (!listed.ok) return json(res, { error: "无法核对待答问题" }, listed.status)
      const question = (await listed.json()).find(q => q.id === requestID && opencodeRunIDs.get(q.sessionID) === runs.opencode.runID)
      if (!question) return json(res, { error: "问题已结束或不属于当前运行" }, 404)
      if (action === "reply" && answers.length !== question.questions.length) return json(res, { error: "答案数量与问题数量不一致" }, 400)
      const response = await oc(`/question/${encodeURIComponent(requestID)}/${action}`, { method: "POST", body: JSON.stringify(action === "reply" ? { answers } : {}) })
      return json(res, { ok: response.ok, status: response.status }, response.ok ? 200 : response.status)
    }

    if (req.method === "POST" && url.pathname === "/api/abort") {
      const { sessionID, harness = "opencode" } = await readBody(req)
      if (harness === "codex") {
        if (!codexProc) return json(res, { ok: true, killed: false })
        runs.codex.aborted = true
        runs.codex.preparationTracker?.cancel()
        const killed = process.platform === "win32"
          ? spawnSync("taskkill", ["/PID", String(codexProc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).status === 0
          : codexProc.kill()
        broadcast({ harness, type: "viz.abort.accepted", properties: { killed } })
        return json(res, { ok: killed, killed })
      }
      if (!sessionID) return json(res, { error: "缺少 sessionID" }, 400)
      const r = await oc(`/session/${sessionID}/abort`, { method: "POST", body: JSON.stringify({}) })
      if (r.ok) runs.opencode.preparationTracker?.cancel()
      if (r.ok) broadcast({ harness, type: "viz.abort.accepted", properties: { sessionID } })
      json(res, { ok: r.ok, status: r.status })
      return
    }

    json(res, { error: "Not Found" }, 404)
  } catch (err) {
    if (admittedRun) { admittedRun.preparationTracker?.fail(err); admittedRun.active = false }
    console.error("[viz] 请求处理异常:", err)
    json(res, { error: String(err?.message ?? err) }, 500)
  }
})

async function main() {
  console.log(`[viz] 目标项目目录: ${TARGET_PROJECT}`)
  console.log("[viz] 模型配置: OpenCode/Codex 原生配置；观察器不指定 provider、模型或密钥。")
  try { VIZ_PORT = await listenLocal(server, { port: VIZ_PORT, host: HOST, fallback: false }) } catch (err) {
    if (["EADDRINUSE", "EACCES"].includes(err.code)) throw new Error(`网页端口 ${VIZ_PORT} 被占用或不可用；请检查是否已启动 harness-viz，关闭已有实例后重试 npm start。`, { cause: err })
    throw err
  }
  console.log(`[viz] 可视化页面: http://${HOST}:${VIZ_PORT}`)
  console.log(`[viz] 专用 CLI 缓存: ${CLI_DIR}`)
  LLM_PORT = await listenLocal(llmProxy, { port: LLM_PORT, host: HOST })
  console.log(`[viz] 模型代理内部地址: http://${HOST}:${LLM_PORT}`)
  await Promise.all([prepareHarness("opencode"), prepareHarness("codex")])
}

function killProcess(proc) {
  if (!proc?.pid || proc.exitCode !== null) return
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
  else { try { proc.kill() } catch {} }
}
function shutdown(exitCode = 0) {
  console.log("\n[viz] 正在退出，关闭子进程 ...")
  for (const proc of [...setupProcesses, child, codexProc]) killProcess(proc)
  process.exit(exitCode)
}
if (process.send) process.on("message", message => { if (message === "shutdown") shutdown() })
process.on("SIGINT", () => shutdown())
process.on("SIGTERM", () => shutdown())

main().catch((err) => {
  console.error("[viz] 启动失败:", err)
  shutdown(1)
})
