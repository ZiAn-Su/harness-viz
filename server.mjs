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
 *     - POST /api/run        → 建会话 + 发提示词
 *     - GET  /api/stream     → SSE：opencode /global/event 事件 + LLM 调用事件
 *     - GET  /api/llm-calls  → 已捕获的模型调用明细（完整提示词 + 完整响应）
 *     - GET  /api/last-run   → 上次运行的全部事件（刷新页面后回放恢复现场）
 *     - POST /api/permission → 回答权限询问
 *     - POST /api/abort      → 中断会话
 *     - GET  /api/models     → 可选模型列表
 *     - GET  /               → index.html
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
const LLM_UPSTREAM = process.env.LLM_UPSTREAM ?? "https://api.minimaxi.com"
const OC_PASSWORD = "viz-local-secret"
const AUTH = "Basic " + Buffer.from(`opencode:${OC_PASSWORD}`).toString("base64")

let child = null
let ocReady = false

/* ── LLM 调用捕获 ─────────────────────────────────────── */
const llmCalls = []        // {index,startedAt,endedAt,ms,model,path,request,response,error}
let llmIndex = 0

/* ── 本地 SSE 广播（浏览器订阅 /api/stream） ─────────────── */
const sseClients = new Set()
const EVENT_LOG = path.join(DATA_DIR, "events.jsonl")
/* 上次运行的完整事件（内存保存：刷新页面可回放恢复，重启即清） */
let lastRun = { sessionID: null, events: [] }
function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of sseClients) {
    try { res.write(line) } catch {}
  }
  // 落盘一份，方便事后排查（无需再用 curl 抓流）
  appendFile(EVENT_LOG, JSON.stringify({ t: Date.now(), ...payload }) + "\n").catch(() => {})
  // 记入“上次运行”（心跳除外），供刷新后回放
  if (payload.type !== "server.heartbeat") {
    lastRun.events.push(payload)
    if (lastRun.events.length > 40000) lastRun.events.splice(0, lastRun.events.length - 40000)
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
    OPENCODE_MODELS_PATH: path.join(DATA_DIR, "models.json"),
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

  const call = {
    index,
    startedAt,
    path: req.url,
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

/* ── 浏览器端 HTTP ────────────────────────────────────── */
function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(data))
}
async function readBody(req) {
  let raw = ""
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : {}
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
      json(res, { ocReady, targetProject: TARGET_PROJECT, llmCalls: llmCalls.length })
      return
    }

    if (req.method === "GET" && url.pathname === "/api/models") {
      const data = JSON.parse(await readFile(path.join(DATA_DIR, "models.json"), "utf8"))
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
      json(res, lastRun)
      return
    }

    if (req.method === "GET" && url.pathname === "/api/last-run") {
      json(res, lastRun)
      return
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      const { prompt, model } = await readBody(req)
      if (!prompt) return json(res, { error: "prompt 不能为空" }, 400)
      await writeFile(EVENT_LOG, "").catch(() => {})   // 新一轮清空事件日志
      llmCalls.length = 0; llmIndex = 0
      lastRun = { sessionID: null, events: [] }        // 新一轮清空回放缓存
      const created = await oc("/session", {
        method: "POST",
        body: JSON.stringify({ title: "harness-viz " + new Date().toLocaleTimeString("zh-CN") }),
      })
      if (!created.ok) return json(res, { error: "创建会话失败: " + (await created.text()) }, 502)
      const session = await created.json()
      lastRun.sessionID = session.id
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
      const { sessionID } = await readBody(req)
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
  llmProxy.listen(LLM_PORT, HOST, () => console.log(`[viz] LLM 代理(捕获提示词): http://${HOST}:${LLM_PORT}`))
  await startOpencode()
  await waitReady()
  upstreamLoop()
  server.listen(VIZ_PORT, HOST, () => console.log(`[viz] 可视化页面:  http://${HOST}:${VIZ_PORT}`))
}

function shutdown() {
  console.log("\n[viz] 正在退出，关闭 opencode 子进程 ...")
  try { child?.kill() } catch {}
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

main().catch((err) => {
  console.error("[viz] 启动失败:", err)
  try { child?.kill() } catch {}
  process.exit(1)
})
