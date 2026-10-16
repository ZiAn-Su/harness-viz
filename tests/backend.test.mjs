import { test } from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import { readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { withModelInputs } from "../src/trace.mjs"
import { summarizeProxyResponse } from "../src/proxy-response.mjs"
import { buildCallRecord } from "../src/call-record.mjs"
import { startPreparation } from "../src/preparation.mjs"

const source = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8")
function section(start, end = "\n/*") {
  const from = source.indexOf(start)
  assert(from >= 0, `Missing implementation marker: ${start}`)
  const to = source.indexOf(end, from + start.length)
  assert(to > from, `Missing implementation end: ${start}`)
  return source.slice(from, to)
}
const implementation = [
  section("function updateCliStatus(", "\nasync function prepareHarness("),
  section("function broadcast("),
  section("function failOpencode(", "\nasync function startOpencode("),
  section("function parseAnthropicSSE("),
  section("function responsesToAnthropic(", "\n/**"),
  section("async function handleCodexResponses("),
  section("const llmProxy = createServer(", "\n/**"),
  section("function json(", "\nasync function main("),
].join("\n")

// Synthetic I/O only: execute the real callbacks without booting servers or CLIs.
function backend(overrides = {}) {
  const wire = [], persisted = [], fetches = [], ocRequests = [], codexRequests = []
  const context = {
    URL, Buffer, TextDecoder, AbortSignal, randomUUID,
    withModelInputs, buildCallRecord, summarizeProxyResponse, startPreparation,
    requestTools: request => ({ names: (request?.tools ?? []).map(t => t.name ?? t.function?.name) }),
    observedProviderIDs: ["fixture"], codexModel: "fixture/native-codex", nativeOpenCode: null, nativeCodex: null,
    modelCatalogs: { opencode: { models: [{ value: "fixture/model", model: "model", providerID: "fixture", variants: ["low", "high", "max"] }], defaultModel: "fixture/model" },
      codex: { models: [{ value: "fixture/native-codex", model: "native-codex", providerID: "fixture", reasoningEfforts: ["low", "medium", "high", "xhigh"] }], defaultModel: "fixture/native-codex" } },
    console: { log() {}, error() {} },
    createServer: callback => callback,
    HOST: "127.0.0.1", VIZ_PORT: 4577, LLM_PORT: 45322, OC_PORT: 45321, OC_BASE: "http://127.0.0.1:45321",
    LLM_UPSTREAM: "https://synthetic.invalid",
    TARGET_PROJECT: "synthetic-project", SOURCE_LOCK: {}, versions: {},
    ocReady: true, CLI_DIR: "synthetic-cli-cache", codexCommand: "synthetic-node", codexPrefix: ["synthetic-codex.js"],
    extensionState: { phase: "disabled" }, configuredExtensions: () => ({ skills: [], mcp: [], plugins: [] }),
    cliStatus: { opencode: { available: true, phase: "ready" }, codex: { available: true, phase: "ready" } },
    OC_MODEL: "fixture/model",
    CFG: { upstreamEnvKey: "SYNTHETIC_KEY", opencode: { model: "fixture/model" }, codex: { model: "fixture", useDefaultModel: false } },
    process: { env: { SYNTHETIC_KEY: "not-a-real-key" } },
    runs: { opencode: { runID: "oc-current", sessionID: null, events: [] }, codex: { runID: "cx-current", sessionID: null, events: [] } },
    opencodeRunIDs: new Map(), llmCalls: [], llmIndex: 0, codexProc: null,
    sseClients: new Set([{ write: line => wire.push(line) }]), EVENT_LOG: "synthetic-log",
    appendFile: async (_file, line) => { persisted.push(JSON.parse(line)) },
    fetch: async (...args) => {
      fetches.push(args)
      assert(overrides.fetch, "Unexpected synthetic upstream request")
      return overrides.fetch(...args)
    },
    oc: async (...args) => {
      ocRequests.push(args)
      assert(overrides.oc, "Unexpected synthetic OpenCode request")
      return overrides.oc(...args)
    },
    runCodex: async (...args) => { codexRequests.push(args); assert(overrides.runCodex, "Unexpected subprocess launch"); return overrides.runCodex(...args) },
  }
  const handlers = vm.runInNewContext(implementation + "\n;({ server, llmProxy, broadcast, failOpencode, handleCodexResponses })", context, { filename: "server.mjs (extracted)", timeout: 1000 })
  return { ...handlers, context, fetches, ocRequests, codexRequests, persisted, events: () => wire.flatMap(line => sseEvents(line)) }
}

function request({ url = "/api/run", host = "127.0.0.1:4577", origin, body = { prompt: "synthetic task" }, method = "POST", headers = {} } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body)
  return {
    url, method, bodyRead: false,
    headers: { host, "content-type": "application/json", ...(origin === undefined ? {} : { origin }), ...(host === "127.0.0.1:45322" ? { "x-harness-provider": "fixture", "x-harness-upstream-url": "https://synthetic.invalid/anthropic/v1/messages" } : {}), ...headers },
    async *[Symbol.asyncIterator]() { this.bodyRead = true; yield Buffer.from(raw) },
  }
}

function response() {
  return {
    statusCode: null, headersSent: false, ended: false, chunks: [],
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; this.headersSent = true },
    flushHeaders() {},
    write(chunk) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk); return true },
    end(chunk) { if (chunk !== undefined) this.write(chunk); this.ended = true },
    get body() { return this.chunks.join("") },
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function sseEvents(raw) {
  return raw.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)))
}

function anthropic(events) {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")
}

function upstream(raw, failure) {
  return {
    ok: true, status: 200, headers: { get: () => "text/event-stream" },
    body: (async function* () {
      const bytes = Buffer.from(raw)
      for (let offset = 0; offset < bytes.length; offset += 19) yield bytes.subarray(offset, offset + 19)
      if (failure) throw new Error(failure)
    })(),
  }
}

test("synthetic extension discovery starts independent reads together and preserves partial failures with their harness source", async () => {
  const waiting = new Map(["/skill", "/mcp", "/experimental/tool?provider=fixture&model=model"].map(route => [route, deferred()]))
  const b = backend({ oc: (route, init) => {
    assert(init.signal instanceof AbortSignal)
    assert(waiting.has(route), "only read-only discovery routes are expected")
    return waiting.get(route).promise
  } })
  const req = request({ url: "/api/extensions", method: "GET" }), res = response()
  const checking = b.server(req, res)
  assert.equal(b.ocRequests.length, 3, "all discovery reads must start before any project initialization completes")
  assert.equal(res.ended, false)
  waiting.get("/skill").resolve({ ok: true, json: async () => [{ name: "synthetic-skill" }] })
  waiting.get("/mcp").reject(new Error("synthetic MCP discovery failure"))
  waiting.get("/experimental/tool?provider=fixture&model=model").resolve({ ok: false, status: 503 })
  await checking
  assert.equal(res.statusCode, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.observed.harness, "opencode")
  assert.equal(data.observed.available, true)
  assert.deepEqual(data.observed.skills, [{ name: "synthetic-skill" }])
  assert.match(data.observed.mcp.error, /synthetic MCP discovery failure/)
  assert.equal(data.observed.tools.error, "HTTP 503")
  assert.equal(req.bodyRead, false)
  assert.equal(b.fetches.length, 0, "discovery must not access a model upstream")
  b.context.ocReady = false
  const unavailable = response()
  await b.server(request({ url: "/api/extensions", method: "GET" }), unavailable)
  assert.equal(b.ocRequests.length, 3, "an unavailable CLI must not receive discovery requests")
  assert.deepEqual(JSON.parse(unavailable.body).observed, { harness: "opencode", available: false })
})

test("synthetic malformed concurrent /api/run cannot release another admitted run", { timeout: 5000 }, async () => {
  const entered = deferred(), created = deferred(), prompt = deferred()
  const b = backend({ oc: (url) => {
    if (url === "/session") { entered.resolve(); return created.promise }
    assert.equal(url, "/session/synthetic-session/message")
    return prompt.promise
  } })
  const first = response()
  const pending = b.server(request(), first)
  await entered.promise
  const admitted = b.context.runs.opencode
  assert.equal(admitted.active, true)
  assert.equal(admitted.sessionID, null)
  try {
    const malformed = response()
    await b.server(request({ body: "{" }), malformed)
    assert.equal(malformed.statusCode, 500)
    assert.strictEqual(b.context.runs.opencode, admitted)
    assert.equal(admitted.active, true)
    for (const harness of ["opencode", "codex"]) {
      const competing = response()
      await b.server(request({ body: { prompt: "competing task", harness } }), competing)
      assert.equal(competing.statusCode, 409)
      assert.strictEqual(b.context.runs.opencode, admitted)
    }
    assert.equal(b.ocRequests.length, 1)
    created.resolve({ ok: true, json: async () => ({ id: "synthetic-session" }) })
    await pending
    assert.equal(first.statusCode, 200)
    assert.equal(admitted.active, true)
    assert.equal(b.context.opencodeRunIDs.get("synthetic-session"), admitted.runID)
    assert.equal(b.events().filter(event => event.type === "viz.run").length, 1)
    assert.equal(b.events().find(event => event.type === "viz.run").runID, admitted.runID)
  } finally {
    created.resolve({ ok: true, json: async () => ({ id: "synthetic-session" }) })
    prompt.resolve({ ok: true, json: async () => ({ synthetic: true }) })
    await pending
    await new Promise(setImmediate)
  }
  assert.equal(admitted.active, false)
  assert.equal(b.fetches.length, 0)
})

test("question replies use native answer arrays and cannot reach another run's pending question", async () => {
  const questions = [{ id: "que-own", sessionID: "root", questions: [{ question: "pick" }] }, { id: "que-other", sessionID: "other", questions: [] }]
  const b = backend({ oc: async (route, init) => {
    if (route === "/question") return { ok: true, json: async () => questions }
    assert.equal(route, "/question/que-own/reply")
    assert.deepEqual(JSON.parse(init.body), { answers: [["中文自定义"]] })
    return { ok: true, status: 200 }
  } })
  b.context.opencodeRunIDs.set("root", "oc-current")
  const list = response()
  await b.server(request({ url: "/api/questions", method: "GET" }), list)
  assert.equal(JSON.parse(list.body).questions.length, 1)
  const denied = response()
  await b.server(request({ url: "/api/question", body: { requestID: "que-other", answers: [] } }), denied)
  assert.equal(denied.statusCode, 404)
  const accepted = response()
  await b.server(request({ url: "/api/question", body: { requestID: "que-own", answers: [["中文自定义"]] } }), accepted)
  assert.equal(accepted.statusCode, 200)
  assert.equal(b.fetches.length, 0)
})

test("native variant rejection preserves history and cannot admit a task", async () => {
  const b = backend()
  const previous = b.context.runs.opencode, other = b.context.runs.codex
  b.context.llmCalls.push({ index: 1, harness: "opencode" })
  for (const [harness, variant] of [["opencode", "medium"], ["opencode", "unknown"], ["opencode", 0], ["opencode", false], ["opencode", {}], ["codex", "high"]]) {
    const res = response()
    await b.server(request({ body: { prompt: "must not execute", harness, variant } }), res)
    assert.equal(res.statusCode, 400)
    assert.strictEqual(b.context.runs.opencode, previous)
    assert.strictEqual(b.context.runs.codex, other)
    assert.equal(b.context.llmCalls.length, 1)
    assert.equal(b.events().length, 0)
    assert.equal(b.ocRequests.length, 0)
  }
})

test("native variants are sent at the message root and preserved in run evidence; no selection adds no override", async () => {
  for (const variant of [undefined, "", null, "low", "high", "max"]) {
    const b = backend({ oc: async url => ({ ok: true, json: async () => url === "/session" ? { id: "variant-session" } : { info: {} } }) })
    const res = response()
    await b.server(request({ body: { prompt: "effort task", variant } }), res)
    await new Promise(setImmediate)
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(b.ocRequests[1][1].body)
    assert.deepEqual(body.model, { providerID: "fixture", modelID: "model" })
    assert.equal(body.variant, variant || undefined)
    assert.equal(body.model.variant, undefined)
    assert.equal(body.reasoningEffort, undefined, "Parameter values belong to the native configuration")
    assert.equal(b.context.runs.opencode.configuration.variant, variant || null)
    assert.equal(b.events().find(e => e.type === "viz.run").properties.configuration.variant, variant || null)
    assert.equal(b.context.runs.opencode.active, false)
  }
})

test("Codex admits only native supported efforts and preserves history on invalid choices", async () => {
  const b = backend({ runCodex: async () => {} })
  const previous = b.context.runs.codex
  b.context.llmCalls.push({ index: 1, harness: "codex" })
  for (const reasoningEffort of ["max", "unsupported", 0, false, {}]) {
    const res = response()
    await b.server(request({ body: { harness: "codex", prompt: "task", reasoningEffort } }), res)
    assert.equal(res.statusCode, 400)
    assert.strictEqual(b.context.runs.codex, previous)
    assert.equal(b.context.llmCalls.length, 1)
    assert.equal(b.codexRequests.length, 0)
  }
  const res = response()
  await b.server(request({ body: { harness: "codex", prompt: "task", reasoningEffort: "xhigh" } }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(b.codexRequests[0][2], "xhigh")
  assert.equal(b.context.runs.codex.configuration.reasoningEffort, "xhigh")
})

test("OpenCode continuation appends a native message and retains the same conversation's calls/events; default creates a new session", async () => {
  let created = 0
  const b = backend({ oc: async url => ({ ok: true, json: async () => url === "/session" ? { id: "session-" + ++created } : { info: { finish: "stop" } } }) })
  await b.server(request({ body: { prompt: "first turn" } }), response())
  await new Promise(setImmediate)
  const first = b.context.runs.opencode, original = { harness: "opencode", index: 1, requestRaw: "EXACT_FIRST_BODY" }
  b.context.llmCalls.push(original)
  const result = response()
  await b.server(request({ body: { prompt: "follow up", continueSessionID: first.sessionID } }), result)
  await new Promise(setImmediate)
  const second = b.context.runs.opencode
  assert.equal(created, 1)
  assert.notStrictEqual(second, first, "Each submission owns its own active flag")
  assert.equal(second.sessionID, first.sessionID)
  assert.equal(second.runID, first.runID)
  assert.equal(second.turnNumber, 2)
  assert.strictEqual(b.context.llmCalls[0], original)
  assert.equal(second.events.filter(e => e.type === "viz.run").length, 2)
  assert.deepEqual(JSON.parse(b.ocRequests.at(-1)[1].body).parts, [{ type: "text", text: "follow up" }])
  assert.equal(b.ocRequests.at(-1)[0], "/session/session-1/message")
  assert.equal(JSON.parse(result.body).continuing, true)
  await b.server(request({ body: { prompt: "new conversation" } }), response())
  await new Promise(setImmediate)
  assert.equal(created, 2)
  assert.notEqual(b.context.runs.opencode.runID, first.runID)
  assert.equal(b.context.runs.opencode.turnNumber, 1)
  assert.equal(b.context.llmCalls.length, 0)
  assert.equal(b.context.runs.opencode.events.filter(e => e.type === "viz.run").length, 1)
})

test("continuation rejects stale, missing and another harness's session before admitting or clearing history", async () => {
  const b = backend()
  b.context.runs.opencode.sessionID = "own-opencode"
  b.context.runs.codex.sessionID = "own-codex"
  const previous = b.context.runs.opencode
  b.context.llmCalls.push({ harness: "opencode", index: 1 })
  for (const continueSessionID of ["stale", "own-codex", "", false, 123]) {
    const res = response()
    await b.server(request({ body: { prompt: "must not run", continueSessionID } }), res)
    assert.equal(res.statusCode, 400)
    assert.strictEqual(b.context.runs.opencode, previous)
    assert.equal(b.context.llmCalls.length, 1)
    assert.equal(b.ocRequests.length, 0)
  }
})

test("Codex continuation passes the current explicit thread ID to native resume and preserves earlier evidence", async () => {
  const b = backend({ runCodex: async () => {} })
  Object.assign(b.context.runs.codex, { sessionID: "thread-own", turnNumber: 1, events: [{ type: "first-turn-evidence" }] })
  const previous = b.context.runs.codex
  b.context.llmCalls.push({ harness: "codex", index: 10 })
  const res = response()
  await b.server(request({ body: { harness: "codex", prompt: "second turn", continueSessionID: "thread-own" } }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(b.codexRequests[0][3], "thread-own")
  assert.equal(b.context.runs.codex.runID, previous.runID)
  assert.equal(b.context.runs.codex.turnNumber, 2)
  assert.equal(b.context.runs.codex.events[0].type, "first-turn-evidence")
  assert.equal(b.context.llmCalls[0].index, 10)
  assert.equal(JSON.parse(res.body).sessionID, "thread-own")
})

test("preparation is one timed execution confirmed by the exact persisted user message, not later session snapshots", async () => {
  const prompt = deferred()
  const b = backend({ oc: async route => route === "/session" ? { ok: true, json: async () => ({ id: "prepared-session" }) } : prompt.promise })
  const res = response()
  await b.server(request({ body: { prompt: "PREP_TASK", variant: "high" } }), res)
  const run = b.context.runs.opencode, body = JSON.parse(b.ocRequests[1][1].body)
  assert.equal(run.preparation.status, "running")
  assert.equal(run.preparation.input.reasoningEffort, "high")
  assert.equal(body.messageID, run.preparation.output.messageID)
  b.broadcast({ type: "message.part.updated", properties: { part: { type: "text", sessionID: "prepared-session", messageID: "msg-old", text: "old" } } })
  assert.equal(run.preparation.status, "running")
  b.broadcast({ id: "persisted-user-part", type: "message.part.updated", properties: { part: { id: "part", type: "text", sessionID: "prepared-session", messageID: body.messageID, text: "PREP_TASK" } } })
  assert.equal(run.preparation.status, "completed")
  const finish = run.preparation.endedAt
  b.broadcast({ type: "session.updated", properties: { info: { id: "prepared-session", tokens: { input: 999 } } } })
  assert.equal(run.preparation.endedAt, finish)
  assert.equal(new Set(b.events().filter(e=>e.type==='viz.preparation').map(e=>e.properties.execution.id)).size, 1)
  assert.equal(b.events().findIndex(e=>e.type==='viz.run') < b.events().findIndex(e=>e.type==='viz.preparation'), true)
  assert(!JSON.stringify(run).includes("preparationTracker"))
  prompt.resolve({ ok: true, json: async () => ({ info: {} }) }); await new Promise(setImmediate)
})

test("failed session creation produces a failed preparation with real action details", async () => {
  const b = backend({ oc: async () => ({ ok: false, status: 503, text: async () => "local session service unavailable" }) })
  const res = response()
  await b.server(request(), res)
  assert.equal(res.statusCode, 502)
  const preparation = b.context.runs.opencode.preparation
  assert.equal(preparation.status, "failed")
  assert(preparation.error.includes("local session service unavailable"))
  assert(preparation.endedAt && preparation.durationMs >= 0)
  assert.equal(preparation.steps.at(-1).status, "failed")
  assert.equal(b.ocRequests.length, 1)
})

test("Ark proxy forwards the exact body to the coding endpoint rather than the legacy provider", async () => {
  const raw = '{"model":"glm-5.3-flash","stream":true,"n":1e2}'
  const b = backend({ fetch: async (url, init) => {
    assert.equal(url, "https://ark.cn-beijing.volces.com/api/coding/v1/messages")
    assert.equal(init.body.toString(), raw)
    return upstream(anthropic([{ type: "message_stop" }]))
  } })
  const res = response()
  await b.llmProxy(request({ url: "/opencode-observe", host: "127.0.0.1:45322", body: raw, headers: { "x-harness-upstream-url": "https://ark.cn-beijing.volces.com/api/coding/v1/messages" } }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(b.context.llmCalls[0].requestRaw, raw)
})

test("native Chat request notification retains protocol and counts system messages rather than claiming zero system text", async () => {
  const b = backend({ fetch: async () => upstream('data: {"choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') })
  const body = { model: "k3-256k", stream: true, messages: [{ role: "system", content: "SYSTEM" }, { role: "developer", content: "DEV" }, { role: "user", content: "known" }] }
  const req = request({ url: "/opencode-observe", host: "127.0.0.1:45322", body, headers: { "x-harness-upstream-url": "https://example.invalid/coding/v1/chat/completions" } })
  await b.llmProxy(req, response())
  const event = b.events().find(e => e.type === "llm.request")
  assert.equal(event.properties.protocol, "chat")
  assert.equal(event.properties.path, "/coding/v1/chat/completions")
  assert.equal(event.properties.systemChars, 9)
})

test("synthetic admitted session creation failure releases its own lock for retry", async () => {
  const b = backend({ oc: async () => { throw new Error("synthetic creation failure") } })
  const first = response()
  await b.server(request(), first)
  const failed = b.context.runs.opencode
  assert.equal(first.statusCode, 500)
  assert.equal(failed.active, false)
  const retry = response()
  await b.server(request(), retry)
  assert.equal(retry.statusCode, 500)
  assert.notEqual(b.context.runs.opencode.runID, failed.runID)
  assert.equal(b.context.runs.opencode.active, false)
  assert.equal(b.ocRequests.length, 2)
})

test("unavailable CLI returns 503 without clearing history or blocking the other harness", async () => {
  const b = backend({ oc: async () => { throw new Error("synthetic OC submission reached") } })
  b.context.cliStatus.codex = { available: false, phase: "error", error: "synthetic install failed" }
  const previous = b.context.runs.codex
  b.context.llmCalls.push({ harness: "codex", index: 1 })
  const rejected = response()
  await b.server(request({ body: { harness: "codex", prompt: "task" } }), rejected)
  assert.equal(rejected.statusCode, 503)
  assert.equal(JSON.parse(rejected.body).error, "synthetic install failed")
  assert.strictEqual(b.context.runs.codex, previous)
  assert.equal(b.context.llmCalls.length, 1)
  assert.equal(b.events().length, 0)
  const accepted = response()
  await b.server(request(), accepted)
  assert.equal(b.ocRequests.length, 1, "The other CLI remains runnable")
  assert.match(JSON.parse(accepted.body).error, /OC submission reached/)
  const status = response()
  await b.server(request({ url: "/api/status", method: "GET" }), status)
  assert.equal(status.statusCode, 200)
  assert.equal(JSON.parse(status.body).cliStatus.codex.phase, "error")
})

test("owned OpenCode service failure releases only its active run and reports a local error", () => {
  const b = backend()
  b.context.runs.opencode.active = true
  b.context.runs.opencode.sessionID = "synthetic-session"
  const other = b.context.runs.codex
  b.failOpencode("synthetic service exit\nfull diagnostic")
  assert.equal(b.context.ocReady, false)
  assert.equal(b.context.cliStatus.opencode.available, false)
  assert.equal(b.context.runs.opencode.active, false)
  assert.strictEqual(b.context.runs.codex, other)
  assert.equal(b.context.cliStatus.codex.available, true)
  const event = b.events().find(event => event.type === "session.error")
  assert.equal(event.source, "viz")
  assert.equal(event.runID, "oc-current")
  assert.equal(event.properties.error.name, "SubmissionError")
  assert.equal(event.properties.error.message, "synthetic service exit\nfull diagnostic")
})

test("broadcast preserves explicit old/null ownership without storing it in current replay", () => {
  const b = backend()
  for (const harness of ["opencode", "codex"]) {
    const current = b.context.runs[harness]
    const old = { harness, type: "llm.response", runID: "old-run", properties: { index: 1 } }
    const unknown = { harness, type: "session.updated", runID: null, properties: {} }
    const owned = { harness, type: "llm.request", runID: current.runID, properties: { index: 2 } }
    const local = { harness, type: "viz.abort.accepted", properties: {} }
    for (const event of [old, unknown, owned, local]) b.broadcast(event)
    assert.equal(old.runID, "old-run")
    assert.equal(unknown.runID, null)
    assert.equal(local.runID, current.runID)
    assert.deepEqual(current.events, [owned, local])
  }
  assert.equal(b.events().length, 8, "Excluded replay events still reach live subscribers")
  assert.equal(b.persisted.length, 8, "Excluded replay events still retain diagnostic evidence")
  assert.equal(b.events().filter(event => event.runID === null).length, 2)
})

const partial = [
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "synthetic partial marker" } },
]
const streamError = { type: "error", error: { type: "overloaded_error", message: "synthetic overload" } }
const completed = [
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
]

for (const fixture of [
  { name: "SSE error", tail: [streamError], error: "synthetic overload", code: "overloaded_error", terminal: false },
  { name: "SSE error followed by message_stop", tail: [streamError, { type: "message_stop" }], error: "synthetic overload", code: "overloaded_error", terminal: true },
  { name: "premature EOF", tail: [], error: "Upstream stream ended without message_stop", code: "proxy_error", terminal: false },
  { name: "max_tokens", tail: [{ type: "message_delta", delta: { stop_reason: "max_tokens" } }, { type: "message_stop" }], error: "Upstream output truncated (max_tokens)", code: "max_tokens", terminal: true },
  { name: "mid-stream transport exception", tail: [], error: "synthetic socket failure", code: "proxy_error", terminal: false, failure: "synthetic socket failure" },
]) {
  test(`synthetic translated ${fixture.name} preserves failure and partial capture`, async () => {
    const raw = anthropic([...partial, ...fixture.tail])
    const b = backend({ fetch: async () => upstream(raw, fixture.failure) })
    const res = response()
    const body = { model: "fixture", input: [], stream: true }
    await b.handleCodexResponses(request({ url: "/v1/responses", body }), res, Buffer.from(JSON.stringify(body)), body, Date.now(), 1)
    assert.equal(b.fetches.length, 1)
    assert.equal(b.ocRequests.length, 0)
    assert.equal(b.context.llmCalls.length, 1)
    const call = b.context.llmCalls[0]
    assert.equal(call.upstreamRequestRaw, b.fetches[0][1].body)
    assert.deepEqual(JSON.parse(call.upstreamRequestRaw), JSON.parse(JSON.stringify(call.anthropicRequest)))
    assert.equal(call.source, "translation-proxy")
    assert.equal(call.error, fixture.error)
    assert.equal(call.rawResponse, raw)
    assert.equal(call.response.text, "synthetic partial marker")
    assert.equal(call.response.terminal, fixture.terminal)
    assert.equal(call.response.streamError, fixture.code === "overloaded_error" ? fixture.error : null)
    if (fixture.code === "max_tokens") assert.equal(call.response.stopReason, "max_tokens")
    const wire = sseEvents(res.body)
    assert.equal(wire.filter(event => event.type === "response.failed").length, 1)
    assert.equal(wire.find(event => event.type === "response.failed").response.error.code, fixture.code)
    assert.equal(wire.find(event => event.type === "response.failed").response.error.message, call.error)
    assert.equal(wire.some(event => event.type === "response.completed"), false)
    const captured = b.events().filter(event => event.type === "llm.response")
    assert.equal(captured.length, 1)
    assert.equal(captured[0].properties.error, call.error)
    assert.equal(captured[0].runID, call.runID)
    assert.equal(res.ended, true)
  })
}

test("synthetic translated complete stream remains successful", async () => {
  const raw = anthropic([...partial, ...completed])
  const b = backend({ fetch: async () => upstream(raw) })
  const res = response()
  const body = { model: "fixture", input: [], stream: true }
  await b.handleCodexResponses(request({ url: "/v1/responses", body }), res, Buffer.from(JSON.stringify(body)), body, Date.now(), 1)
  const call = b.context.llmCalls[0]
  assert.equal(b.fetches.length, 1)
  assert.equal(call.error, null)
  assert.equal(call.rawResponse, raw)
  assert.equal(call.response.terminal, true)
  assert.equal(call.response.text, "synthetic partial marker")
  const wire = sseEvents(res.body)
  assert.equal(wire.filter(event => event.type === "response.completed").length, 1)
  assert.equal(wire.some(event => event.type === "response.failed"), false)
  assert.equal(b.events().find(event => event.type === "llm.response").properties.error, null)
})

for (const fixture of [
  { name: "rebound Host with matching Origin", host: "attacker.invalid:4577", origin: "http://attacker.invalid:4577" },
  { name: "cross Origin on allowed Host", host: "127.0.0.1:4577", origin: "https://attacker.invalid" },
  { name: "null Origin", host: "localhost:4577", origin: "null" },
]) {
  test(`synthetic main guard rejects ${fixture.name} before reading or submitting`, async () => {
    const b = backend(), req = request(fixture), res = response()
    await b.server(req, res)
    assert.equal(res.statusCode, 403)
    assert.equal(req.bodyRead, false)
    assert.equal(b.ocRequests.length, 0)
    assert.equal(b.fetches.length, 0)
    assert.equal(b.events().length, 0)
  })
}

test("synthetic main guard accepts both fixed local Hosts and their own Origins", async () => {
  const b = backend()
  for (const host of ["127.0.0.1:4577", "localhost:4577"]) {
    const res = response()
    await b.server(request({ url: "/api/llm-calls", method: "GET", host, origin: `http://${host}` }), res)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(JSON.parse(res.body), { calls: [] })
  }
  assert.equal(b.ocRequests.length, 0)
  assert.equal(b.fetches.length, 0)
})

for (const fixture of [
  { name: "rebound Host with matching Origin", host: "attacker.invalid:45322", origin: "http://attacker.invalid:45322" },
  { name: "bad Host without Origin", host: "attacker.invalid:45322" },
  { name: "cross Origin on allowed Host", host: "127.0.0.1:45322", origin: "http://127.0.0.1:4577" },
  { name: "even same Origin on allowed Host", host: "localhost:45322", origin: "http://localhost:45322" },
]) {
  test(`synthetic proxy guard rejects ${fixture.name} before reading or forwarding`, async () => {
    const b = backend(), req = request({ ...fixture, url: "/v1/responses" }), res = response()
    await b.llmProxy(req, res)
    assert.equal(res.statusCode, 403)
    assert.equal(req.bodyRead, false)
    assert.equal(b.fetches.length, 0)
    assert.equal(b.ocRequests.length, 0)
    assert.equal(b.context.llmCalls.length, 0)
    assert.equal(b.events().length, 0)
  })
}

test("synthetic OpenCode proxy uses session ownership instead of the current run", async () => {
  const raw = anthropic([...partial, ...completed])
  for (const [session, owner] of [["old-session", "old-run"], ["unknown-session", null], ["current-session", "oc-current"]]) {
    const b = backend({ fetch: async () => upstream(raw) })
    if (owner !== null) b.context.opencodeRunIDs.set(session, owner)
    const req = request({ url: "/opencode-observe", host: "127.0.0.1:45322", body: { model: "fixture", messages: [], stream: true } })
    req.headers["x-opencode-session-id"] = session
    const res = response()
    await b.llmProxy(req, res)
    assert.equal(res.statusCode, 200)
    assert.equal(b.fetches.length, 1)
    assert.equal(b.context.llmCalls[0].runID, owner)
    assert.equal(b.context.llmCalls[0].rawResponse, raw)
    assert.equal(b.context.llmCalls[0].requestRaw, b.fetches[0][1].body.toString("utf8"))
    assert.deepEqual(b.events().map(event => event.runID), [owner, owner])
    assert.equal(b.context.runs.opencode.events.length, owner === "oc-current" ? 2 : 0)
  }
})
