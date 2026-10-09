import { test } from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import { readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { withModelInputs } from "../src/trace.mjs"

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
  const wire = [], persisted = [], fetches = [], ocRequests = []
  const context = {
    URL, Buffer, TextDecoder, randomUUID,
    withModelInputs,
    console: { log() {}, error() {} },
    createServer: callback => callback,
    HOST: "127.0.0.1", VIZ_PORT: 4577, LLM_PORT: 45322, OC_PORT: 45321, OC_BASE: "http://127.0.0.1:45321",
    LLM_UPSTREAM: "https://synthetic.invalid",
    TARGET_PROJECT: "synthetic-project", SOURCE_LOCK: {}, versions: {},
    ocReady: true, CLI_DIR: "synthetic-cli-cache", codexCommand: "synthetic-node", codexPrefix: ["synthetic-codex.js"],
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
    runCodex: async () => { assert.fail("Unexpected subprocess launch") },
  }
  const handlers = vm.runInNewContext(implementation + "\n;({ server, llmProxy, broadcast, failOpencode })", context, { filename: "server.mjs (extracted)", timeout: 1000 })
  return { ...handlers, context, fetches, ocRequests, persisted, events: () => wire.flatMap(line => sseEvents(line)) }
}

function request({ url = "/api/run", host = "127.0.0.1:4577", origin, body = { prompt: "synthetic task" }, method = "POST" } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body)
  return {
    url, method, bodyRead: false,
    headers: { host, "content-type": "application/json", ...(origin === undefined ? {} : { origin }) },
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
    await b.llmProxy(request({ url: "/v1/responses", host: "127.0.0.1:45322", body: { model: "fixture", input: [], stream: true } }), res)
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
  await b.llmProxy(request({ url: "/v1/responses", host: "localhost:45322", body: { model: "fixture", input: [], stream: true } }), res)
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
    const req = request({ url: "/anthropic/v1/messages", host: "127.0.0.1:45322", body: { model: "fixture", messages: [], stream: true } })
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
