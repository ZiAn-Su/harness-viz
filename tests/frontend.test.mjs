import { test } from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import { readFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"

// Synthetic frontend units, not browser/layout verification or live integration.
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8")
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].filter(match => match[1].trim())
assert.equal(scripts.length, 1, "expected one inline frontend script")
const source = scripts[0][1]
const startup = /^init\(\)\.catch[^\r\n]*$/gm
assert.equal([...source.matchAll(startup)].length, 1, "isolate only the automatic init() entrypoint")
const unitSource = source.replace(startup, "")
const longText = "payload-start-" + "x".repeat(16000) + "-payload-end"
const escapeText = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// Only the DOM slots used by transcript/record rendering are modeled. No CSS,
// layout, HTML execution, real timers, EventSource, or browser globals are used.
class Element {
  constructor(className = "") {
    this.className = className
    this.style = {}
    this.dataset = {}
    this.attributes = new Map()
    this.children = []
    this.slots = new Map()
    this.parentNode = null
    this.attached = false
    this.markup = ""
    this.text = ""
    this.firstChild = { textContent: "" }
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" ") },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(" ") },
      toggle: (name, force) => {
        const enabled = force ?? !this.classList.contains(name)
        enabled ? this.classList.add(name) : this.classList.remove(name)
        return enabled
      },
    }
  }
  get isConnected() { return this.attached || (this.parentNode?.isConnected ?? false) }
  set innerHTML(value) {
    for (const child of this.children) child.parentNode = null
    this.children = []
    this.slots.clear()
    this.markup = String(value)
    this.text = ""
  }
  get innerHTML() { return this.markup }
  set textContent(value) { this.innerHTML = escapeText(value ?? ""); this.text = String(value ?? "") }
  get textContent() { return this.text }
  querySelector(selector) {
    assert.match(selector, /^\.(body|hd|detail)$/u, "unsupported synthetic DOM selector")
    const name = selector.slice(1)
    assert.ok(new RegExp(`class="[^"\\n]*\\b${name}\\b`).test(this.markup), `missing rendered ${selector} slot`)
    if (!this.slots.has(selector)) {
      const slot = new Element(name)
      this.appendChild(slot)
      this.slots.set(selector, slot)
    }
    return this.slots.get(selector)
  }
  querySelectorAll(selector) {
    assert.equal(selector, "button[data-reply]", "unsupported synthetic DOM selector")
    return []
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child }
  addEventListener() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  focus() {}
}

function createFrontend(harness = "opencode") {
  const elements = new Map()
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[0].match(/\bclass="([^"]*)"/)?.[1] ?? "")
    element.attached = true
    elements.set(match[1], element)
  }
  let calls = [], eventID = 0, timerID = 0
  const fetches = [], timers = new Map()
  const preferences = new Map()
  const context = vm.createContext({
    console,
    renderMarkdown: value => `<p>${escapeText(value)}</p>`,
    localStorage: { getItem: key => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) },
    setTimeout(callback) { timers.set(++timerID, callback); return timerID },
    clearTimeout(id) { timers.delete(id) },
    document: {
      createElement: () => new Element(),
      getElementById(id) { assert.ok(elements.has(id), `missing HTML id: ${id}`); return elements.get(id) },
      querySelectorAll(selector) {
        const names = selector.split(",").map(value => {
          assert.match(value, /^\.[\w-]+$/u)
          return value.slice(1)
        })
        return [...elements.values()].filter(element => names.some(name => element.classList.contains(name)))
      },
      body: new Element(), documentElement: new Element(),
    },
    window: { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} },
    async fetch(url, options) {
      assert.equal(url, "/api/llm-calls", "no real API/network access in synthetic units")
      fetches.push({ url, options })
      const snapshot = structuredClone(calls)
      return { ok: true, json: async () => ({ calls: snapshot }) }
    },
  })
  const evaluate = (code, fixture) => {
    context.fixture = fixture
    return vm.runInContext(code, context, { timeout: 1000 })
  }
  new vm.Script(unitSource, { filename: "index.html:synthetic-unit" }).runInContext(context, { timeout: 1000 })
  evaluate(`harness=${JSON.stringify(harness)}; selectedNode=${JSON.stringify(harness === "codex" ? "c-llm" : "llm")}`)
  return {
    elements, evaluate, fetches,
    read(code) {
      const value = evaluate(code)
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
    },
    setCalls(value) { calls = structuredClone(value) },
    event(type, properties = {}, overrides = {}) {
      const id = ++eventID
      const event = {
        id: `event-${id}`, type, harness, runID: "synthetic-run",
        receivedAt: new Date(Date.UTC(2026, 9, 4, 12, 0, 0, id)).toISOString(),
        source: type.startsWith("viz.") ? "viz" : type.startsWith("llm.") ? harness === "codex" ? "native-trace" : "proxy" : harness === "codex" ? "codex-exec" : "opencode-sse",
        properties: structuredClone(properties), ...overrides,
      }
      evaluate("handleEvent(fixture)", event)
      return event
    },
  }
}

function rawSections(markup) {
  // Decode preformatted text only; never execute or parse it as HTML behavior.
  return [...markup.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/g)].flatMap(match => {
    const text = match[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    try { return [JSON.parse(text)] } catch { return [] }
  })
}

test("frontend syntax compiles without execution", () => {
  assert.doesNotThrow(() => new vm.Script(source, { filename: "index.html" }))
})

test("synthetic: panel toggles preserve run history and can hide every workspace panel", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root", prompt: "task" })
  ui.event("message.updated", { info: { id: "assistant", role: "assistant", sessionID: "root" } })
  const before = ui.read("store.loop")
  for (const name of ["input", "flow", "transcript", "details"]) ui.evaluate(`setView(${JSON.stringify(name)}, false)`)
  for (const id of ["composer", "colFlow", "colTx", "colLlm", "rz1", "rz2"]) assert.equal(ui.elements.get(id).hidden, true)
  assert.equal(ui.elements.get("workspaceEmpty").hidden, false)
  assert.equal(ui.read("runState"), "busy")
  assert.deepEqual(ui.read("store.loop"), before)
  ui.evaluate('setView("transcript", true)')
  assert.equal(ui.elements.get("colTx").hidden, false)
  assert.equal(ui.elements.get("toggle-transcript").getAttribute("aria-pressed"), "true")
  ui.evaluate("restoreLayout()")
  assert.deepEqual(ui.read("layout"), { input: false, flow: false, transcript: true, details: false })
})

test("synthetic: concise terminal state and header stop control remain usable with hidden input", () => {
  const ui = createFrontend()
  ui.evaluate("restoreLayout(); setRun('busy')")
  assert.equal(ui.elements.get("composer").hidden, true)
  assert.equal(ui.elements.get("abortBtn").hidden, false)
  assert.equal(ui.elements.get("abortBtn").disabled, false)
  ui.evaluate("setRun('ended')")
  assert.equal(ui.elements.get("runBadge").textContent, "已结束")
  assert.equal(ui.elements.get("abortBtn").hidden, true)
})

test("synthetic: text and reasoning both use field=text and snapshot part types", () => {
  const ui = createFrontend()
  ui.event("viz.run", { prompt: "fixture", sessionID: "root" })
  for (const type of ["text", "reasoning"]) {
    ui.event("message.part.updated", { part: { id: type, sessionID: "root", type, text: "" } })
    ui.event("message.part.delta", { sessionID: "root", partID: type, field: "text", delta: `${type}-delta` })
    assert.equal(ui.read(`partVocab["root:${type}"]`), type)
    assert.equal(ui.read(`bubbles["root:${type}"].dataset.rawText`), `${type}-delta`)
    ui.event("message.part.updated", { part: { id: type, sessionID: "root", type, text: `${type}-delta` } })
    assert.equal(ui.read(`bubbles["root:${type}"].dataset.rawText`), `${type}-delta`, "full snapshots must not duplicate deltas")
  }
  ui.event("message.part.delta", { sessionID: "root", partID: "unresolved", field: "text", delta: "buffered" })
  assert.equal(ui.read('bubbles["root:unresolved"]'), undefined)
  ui.event("message.part.updated", { part: { id: "unresolved", sessionID: "root", type: "reasoning", text: "" } })
  assert.equal(ui.read('bubbles["root:unresolved"].dataset.rawText'), "buffered")
  assert.equal(ui.read("pendingDeltas.size"), 0)
})

test("synthetic: OpenCode user text is not echoed as assistant, while genuine assistant repetition is preserved", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root", prompt: "ORIGINAL_PROMPT" })
  ui.event("message.updated", { info: { id: "user-message", sessionID: "root", role: "user" } })
  ui.event("message.part.updated", { part: { id: "user-part", messageID: "user-message", sessionID: "root", type: "text", text: "ORIGINAL_PROMPT" } })
  ui.event("message.part.delta", { sessionID: "root", messageID: "user-message", partID: "user-part", field: "text", delta: "ORIGINAL_PROMPT" })
  assert.equal(ui.read("bubbles['root:user-part']"), undefined)
  assert.equal(ui.elements.get("transcript").children.length, 1)
  ui.event("message.updated", { info: { id: "assistant-message", sessionID: "root", role: "assistant" } })
  ui.event("message.part.updated", { part: { id: "assistant-part", messageID: "assistant-message", sessionID: "root", type: "text", text: "ORIGINAL_PROMPT" } })
  assert.equal(ui.read("bubbles['root:assistant-part'].dataset.rawText"), "ORIGINAL_PROMPT")
})

test("synthetic: text arriving before message role waits instead of being labelled assistant", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  ui.event("message.part.updated", { part: { id: "late-part", messageID: "late-message", sessionID: "root", type: "text", text: "LATE_TEXT" } })
  assert.equal(ui.read("bubbles['root:late-part']"), undefined)
  ui.event("message.updated", { info: { id: "late-message", sessionID: "root", role: "assistant" } })
  assert.equal(ui.read("bubbles['root:late-part'].dataset.rawText"), "LATE_TEXT")
  assert.equal(ui.read("pendingMessageText.size"), 0)
})

test("synthetic: JSON readability formatting changes whitespace only, retaining numeric and string lexemes", () => {
  const ui = createFrontend()
  const raw = '{"integer":123456789012345678901234567890,"float":1.00e+004,"escaped":"\\u4e2d\\n\\\"quoted\\\"","nested":[{},[],true,null]}'
  const output = ui.evaluate("formatRequestJSON(fixture)", raw)
  const tokenize = text => text.match(/"(?:\\[\s\S]|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g)
  assert.deepEqual(tokenize(output), tokenize(raw))
  assert.ok(output.includes('\n  "integer":'))
  assert.ok(output.includes("123456789012345678901234567890"))
  assert.ok(output.includes("1.00e+004"))
  assert.deepEqual(JSON.parse(output), JSON.parse(raw))
})

test("synthetic: unrelated sessions stay raw-only until ancestry is known", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  const foreign = ui.event("message.updated", { info: { id: "foreign-msg", sessionID: "foreign", role: "assistant" } })
  ui.event("session.status", { sessionID: "foreign", status: { type: "idle" } })
  assert.equal(ui.read('isChild({sessionID:"foreign"})'), false)
  assert.equal(ui.read('seenAssistantMsgs.has("foreign-msg")'), false)
  assert.equal(ui.read("runState"), "busy")
  assert.ok(rawSections(ui.elements.get("eventlog").children[1].innerHTML).some(value => value.id === foreign.id))
  ui.event("session.updated", { info: { id: "foreign", parentID: "root" } })
  assert.equal(ui.read('isChild({sessionID:"foreign"})'), true)
  assert.equal(ui.read('seenAssistantMsgs.has("foreign-msg")'), true)
  assert.equal(ui.read("runState"), "busy", "child idle must not end the root")
  ui.event("llm.request", { index: 2, sessionID: "grandchild", parentSessionID: "foreign", tools: [] })
  assert.equal(ui.read('isChild({sessionID:"grandchild"})'), true)
  assert.equal(ui.read('isChild({sessionID:"root"})'), false)
  assert.equal(ui.read('isChild({sessionID:"unknown"})'), false)
})

test("synthetic: capture before root initialization is deferred, not misattributed", () => {
  const ui = createFrontend()
  const request = ui.event("llm.request", { index: 1, sessionID: "root", model: "fixture", tools: [] })
  assert.equal(ui.read("llmCallCount"), 0)
  ui.event("viz.run", { sessionID: "root" })
  assert.equal(ui.read("llmCallCount"), 1)
  assert.deepEqual(ui.read("store.llm[0].event"), request)
  assert.equal(ui.read("store.llm[0].time"), request.receivedAt)
  assert.deepEqual(ui.read("store.loop ?? []"), [], "boundary capture is not a loop observation")
})

test("synthetic: repeated OpenCode tool updates count once by call identity", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  const part = { id: "part-1", sessionID: "root", type: "tool", callID: "call-1", tool: "task", state: { status: "pending", input: "{invalid-json" } }
  ui.event("message.part.updated", { part })
  ui.event("message.part.updated", { part })
  ui.event("message.part.updated", { part: { ...part, id: "part-2", state: { ...part.state, status: "running" } } })
  const completed = { ...part, id: "part-2", state: { status: "completed", output: longText, metadata: { sessionId: "child", parentSessionId: "root" }, attachments: [{ content: "attachment-marker" }] } }
  ui.event("message.part.updated", { part: completed })
  ui.event("message.part.updated", { part: completed })
  assert.equal(ui.read("store.tool.length"), 1)
  assert.equal(ui.read("store.exec.length"), 1)
  assert.equal(ui.elements.get("cnt-tool").textContent, "1")
  assert.equal(ui.read("Object.keys(toolCards).length"), 1)
  assert.deepEqual(ui.read("store.tool[0].data"), completed)
  assert.deepEqual(ui.read("store.subflow1 ?? []"), [], "ordinary task is not preflight SubtaskPart execution")
  assert.equal(ui.read('isChild({sessionID:"child"})'), true)
})

test("synthetic: Codex command/MCP/collaboration item updates preserve one card and full result", () => {
  const ui = createFrontend("codex")
  ui.event("viz.run")
  for (const type of ["command_execution", "mcp_tool_call", "collab_tool_call"]) {
    const item = { id: type, type, status: "in_progress", command: "fixture", tool: "spawn_agent", server: "fixture-server", arguments: "{invalid", receiver_thread_ids: ["child"] }
    ui.event("codex.item.started", { item })
    ui.event("codex.item.updated", { item })
    const completed = { ...item, status: "completed", result: { content: [{ type: "text", text: longText }] }, agents_states: { child: { status: "completed", message: "child-marker" } } }
    ui.event("codex.item.completed", { item: completed })
    ui.event("codex.item.completed", { item: completed })
    ui.event("codex.item.updated", { item })
    assert.deepEqual(ui.read(`codexItems.get(${JSON.stringify(type)}).item`), completed)
    assert.deepEqual(ui.read(`store["c-tool"].find(r => r.data.id === ${JSON.stringify(type)}).data`), completed)
    assert.ok(rawSections(ui.read(`toolCards[${JSON.stringify("cx-" + type)}].innerHTML`)).some(section => isDeepStrictEqual(section, completed)))
  }
  assert.equal(ui.read('store["c-tool"].length'), 3)
  assert.equal(ui.read("Object.keys(toolCards).length"), 3)
  assert.equal(ui.elements.get("cnt-c-tool").textContent, "3")
  ui.event("codex.item.completed", { item: { id: "plan", type: "todo_list", items: [] } })
  ui.event("codex.item.completed", { item: { id: "error", type: "error", message: "recoverable item" } })
  assert.equal(ui.elements.get("cnt-c-tool").textContent, "3")
  assert.equal(ui.read("runState"), "busy")
})

test("synthetic: submission failure releases frontend busy state and survives idle", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  ui.event("session.error", { sessionID: "root", error: { name: "SubmissionError", message: "Prompt HTTP 500" } })
  assert.equal(ui.read("runState"), "failed")
  ui.event("session.status", { sessionID: "root", status: { type: "idle" } })
  assert.equal(ui.read("runState"), "failed")
})

test("synthetic: recoverable OpenCode errors remain evidence; idle is ended and deduplicated", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  const error = { name: "ContextOverflowError", message: "context too long" }
  ui.event("session.error", { sessionID: "root", error })
  assert.equal(ui.read("runState"), "busy")
  assert.deepEqual(ui.read("store.subflow3 ?? []"), [])
  ui.event("message.updated", { info: { id: "final", sessionID: "root", role: "assistant", finish: "stop" } })
  ui.event("session.status", { sessionID: "root", status: { type: "idle" } })
  const records = ui.read("store.done.length")
  ui.event("session.idle", { sessionID: "root" })
  assert.equal(ui.read("runState"), "ended")
  assert.equal(ui.read("store.done.length"), records)
  assert.deepEqual(ui.read("store.done.at(-1).data.errorEvidence"), error)
  ui.event("message.updated", { info: { id: "final", sessionID: "root", role: "assistant", error: { name: "APIError", message: "late terminal failure" } } })
  ui.event("session.idle", { sessionID: "root" })
  assert.equal(ui.read("runState"), "failed", "final error need not have finish=error")
})

for (const [name, error, expected] of [
  ["terminal error", { name: "APIError", message: "failure" }, "failed"],
  ["terminal abort", { name: "MessageAbortedError", message: "abort" }, "interrupted"],
]) {
  test(`synthetic: OpenCode ${name} survives redundant idle`, () => {
    const ui = createFrontend()
    ui.event("viz.run", { sessionID: "root" })
    ui.event("message.updated", { info: { id: "final", sessionID: "root", role: "assistant", error } })
    ui.event("session.status", { sessionID: "root", status: { type: "idle" } })
    ui.event("session.idle", { sessionID: "root" })
    assert.equal(ui.read("runState"), expected)
    assert.equal(ui.read("store.done.length"), 1)
  })
}

test("synthetic: local abort evidence survives OpenCode idle and Codex process close", () => {
  for (const harness of ["opencode", "codex"]) {
    const ui = createFrontend(harness)
    ui.event("viz.run", { sessionID: "root" })
    ui.event("viz.abort.accepted", { sessionID: "root", api: "/api/abort" })
    if (harness === "opencode") ui.event("session.status", { sessionID: "root", status: { type: "idle" } })
    else { ui.event("codex.turn.failed", { error: { message: "abort" } }); ui.event("codex.proc.exit", { code: 0 }) }
    assert.equal(ui.read("runState"), "interrupted")
  }
})

test("synthetic: Codex failed/completed/aborted process states are distinct", () => {
  for (const [turn, exit, expected] of [
    ["codex.turn.failed", { code: 0 }, "failed"],
    ["codex.turn.completed", { code: 0 }, "ended"],
    ["codex.turn.started", { code: null, aborted: true }, "interrupted"],
    ["codex.turn.started", { code: 2 }, "failed"],
  ]) {
    const ui = createFrontend("codex")
    ui.event("viz.run")
    ui.event(turn, turn === "codex.turn.failed" ? { error: { message: "fixture" } } : turn === "codex.turn.completed" ? { usage: { input_tokens: 5 } } : {})
    ui.event("codex.proc.exit", exit)
    assert.equal(ui.read("runState"), expected)
    assert.deepEqual(ui.read('store["c-decide"] ?? []'), [], "terminal reports do not observe the internal follow-up predicate")
  }
})

test("synthetic: turn.started counts turns, not API requests, loops or unobserved branches", () => {
  const ui = createFrontend("codex")
  ui.event("viz.run")
  const started = ui.event("codex.turn.started")
  ui.event(started.type, started.properties, started)
  for (let index = 1; index <= 3; index++) {
    ui.event("llm.request", { index, model: "gpt-6.1-sol", tools: ["shell"] })
    ui.event("llm.response", { index, toolCalls: ["shell"], textChars: 0, usage: {} })
  }
  ui.event("codex.turn.completed", { usage: { input_tokens: 5 } })
  assert.equal(ui.read('store["c-loop"].length'), 1)
  assert.match(ui.read('store["c-loop"][0].meta'), /\u4e0d\u8ba1\u5185\u90e8 loop \u8fed\u4ee3/u)
  assert.equal(ui.elements.get("cnt-c-loop").textContent, "1")
  assert.equal(ui.read("llmCallCount"), 3)
  assert.equal(ui.read('store["c-llm"].filter(r => r.kind === "llm").length'), 3)
  assert.deepEqual(ui.read('store["c-decide2"].map(r => r.evidence)'), ["inferred", "inferred", "inferred"])
  for (const node of ["c-precompact", "c-tool", "c-decide", "c-compact", "c-stop", "c-postcompact"])
    assert.deepEqual(ui.read(`store[${JSON.stringify(node)}] ?? []`), [], `${node}: no fabricated observed branch`)
})

test("synthetic: native trace/warning records retain direct evidence without invented API calls", () => {
  const ui = createFrontend("codex")
  ui.event("viz.run")
  const trace = ui.event("codex.trace", { event: { seq: 9, payload: { type: "compaction_started", detail: longText } } }, { source: "native-trace" })
  const warning = ui.event("codex.trace.warning", { message: "incomplete capture", inferenceCallID: "inference-9" }, { source: "native-trace" })
  assert.deepEqual(ui.read('store["c-compact"][0].event'), trace)
  assert.equal(ui.read('store["c-compact"][0].evidence'), "direct")
  assert.deepEqual(ui.read('store["c-llm"][0].event'), warning)
  assert.equal(ui.read("llmCallCount"), 0)
  assert.deepEqual(ui.read('store["c-precompact"] ?? []'), [])
  assert.deepEqual(ui.read('store["c-postcompact"] ?? []'), [])
})

test("synthetic: native WS request rendering preserves complete raw JSON and invalid arguments", () => {
  const ui = createFrontend("codex")
  const call = {
    index: 42, harness: "codex", source: "native-trace",
    request: { type: "response.create", envelopeField: "preserved", request: {
      model: "gpt-6.1-sol", previous_response_id: "previous-42", instructions: "captured instructions",
      input: [{ type: "function_call", arguments: "{invalid-json", call_id: "call-42" }, { type: "message", content: [{ text: longText + "<safe>&" }] }],
      tools: [{ type: "custom", format: { grammar: longText }, strict: false, extra: { nested: "tool-marker" } }],
    } },
    rawResponse: { output_items: [{ type: "reasoning", encrypted_content: longText }, { type: "function_call", arguments: "{invalid-json" }], token_usage: { input_tokens: 2 } },
    response: { text: "visible text", thinking: "visible summary", stopReason: null, toolUses: [{ name: "tool", input: "{invalid-json", callID: "call-42" }] },
    trace: { transport: "websocket", inferenceCallID: "inference-42" },
  }
  const rendered = ui.evaluate("renderLlmCall(fixture)", call)
  const sections = rawSections(rendered)
  for (const value of [call.request, call.request.request.tools, call.rawResponse, call.response, call.trace])
    assert.ok(sections.some(section => isDeepStrictEqual(section, value)), "full JSON section must survive without truncation or omitted fields")
  assert.match(rendered, /previous_response_id/)
  assert.match(rendered, /previous-42/)
  assert.match(rendered, /Codex 原生记录/)
  assert.ok(rendered.includes("增量请求"))
  assert.doesNotMatch(rendered, /instructions\uff08=system/u)
  assert.ok(rendered.includes(escapeText(longText + "<safe>&")))
})

test("synthetic: translated request is its own complete JSON, not a content-equivalence claim", () => {
  const ui = createFrontend("codex")
  const call = {
    index: 7, harness: "codex", source: "translation-proxy",
    request: { instructions: "original-only", input: [{ type: "message", content: [{ text: "original marker" }] }] },
    anthropicRequest: { system: "translated-only", messages: [{ role: "user", content: longText }], tools: [{ name: "read", input_schema: { extra: "translated-tool-marker" } }], max_tokens: 123 },
    translationWarnings: ["reasoning omitted", "custom tool transformed"],
  }
  const rendered = ui.evaluate("renderLlmCall(fixture)", call)
  const sections = rawSections(rendered)
  assert.ok(sections.some(section => isDeepStrictEqual(section, call.anthropicRequest)))
  assert.ok(sections.some(section => isDeepStrictEqual(section, call.translationWarnings)))
  assert.match(rendered, /转译后上游请求/)
  assert.ok(rendered.includes("不保证与上游等价"))
})

test("synthetic: request download preserves original JSON, not rebuilt context or duplicate tools", () => {
  const ui = createFrontend("codex")
  const request = { model: "model", reasoning: { effort: "high" }, store: false, input: [
    { type: "additional_tools", role: "developer", tools: [{ name: "read" }] },
    { type: "message", role: "developer", content: [{ text: longText }] },
  ] }
  const raw = JSON.stringify(request, null, 4) + "\n"
  const modelInput = { kind: "reconstructed", complete: true, format: "responses", system: "", chain: [1, 2], items: [
    { type: "additional_tools", role: "developer", tools: [] },
    { type: "message", role: "developer", content: [{ text: longText }] },
    { type: "function_call_output", call_id: "tool-1", output: "FEEDBACK" },
  ] }
  const rendered = ui.evaluate("renderLlmCall(fixture)", { index: 2, harness: "codex", source: "native-trace", request, requestRaw: raw, modelInput })
  assert.ok(rendered.includes("下载 JSON") && rendered.includes("下载原文"))
  assert.match(rendered, /重建上下文（分析结果，非原始请求）/)
  assert.match(rendered, /class="input-message" open><summary>2\. developer/)
  assert.ok(rendered.includes(longText), "readable input must not truncate instructions")
  assert.equal(ui.read("requestCache[2]"), raw)
  assert.deepEqual(JSON.parse(ui.read("requestCache[2]")), request)
  assert.doesNotMatch(rendered, /工具定义（完整）|tools（请求顶层字段）/)
})

test("synthetic: third-party download is exactly the upstream body, including generation parameters", () => {
  const ui = createFrontend("codex")
  const upstream = { model: "third-party", max_tokens: 16384, stream: true, messages: [{ role: "user", content: "adapted" }] }
  const raw = JSON.stringify(upstream)
  ui.evaluate("renderLlmCall(fixture)", { index: 3, harness: "codex", request: { instructions: "original" }, anthropicRequest: upstream, upstreamRequestRaw: raw })
  assert.equal(ui.read("requestCache[3]"), raw)
})

test("synthetic: OpenCode raw requests retain non-text blocks and complete tool schemas", () => {
  const ui = createFrontend()
  const call = { index: 8, harness: "opencode", source: "proxy", request: {
    system: [{ type: "text", text: longText, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "image", source: { data: longText } }, { type: "tool_result", tool_use_id: "tool-8", content: [{ type: "text", text: longText }] }] }],
    tools: [{ name: "read", description: longText, input_schema: { properties: { path: { type: "string" } } }, extra: { strict: false } }],
  } }
  const rendered = ui.evaluate("renderLlmCall(fixture)", call)
  assert.ok(rawSections(rendered).some(section => isDeepStrictEqual(section, call.request)))
  assert.ok(rawSections(rendered).some(section => isDeepStrictEqual(section, call.request.tools)))
})

test("synthetic: completed records and expanded logs retain event IDs, received time and full envelope", async () => {
  const ui = createFrontend("codex")
  ui.event("viz.run")
  const completed = ui.event("codex.turn.completed", { usage: { input_tokens: 5 }, detail: longText }, {
    id: "completion-event", receivedAt: "2026-10-04T12:34:56.789Z", runID: "synthetic-run", extraEnvelope: { marker: "preserved" },
  })
  assert.deepEqual(ui.read('store["c-done"][0].event'), completed)
  assert.equal(ui.read('store["c-done"][0].time'), completed.receivedAt)
  assert.equal(ui.read('store["c-done"][0].source'), completed.source)
  assert.equal(ui.read('store["c-done"][0].evidence'), "direct")
  ui.evaluate('selectNode("c-done")')
  const record = ui.elements.get("nodePanel").children[0]
  await ui.evaluate('toggleRecDetail(fixture, store["c-done"][0])', record)
  assert.ok(rawSections(record.querySelector(".detail").innerHTML).some(section => isDeepStrictEqual(section, completed)))
  const line = ui.elements.get("eventlog").children.at(-1).innerHTML
  assert.ok(line.includes(completed.receivedAt))
  assert.ok(line.includes(completed.source))
  assert.ok(rawSections(line).some(section => isDeepStrictEqual(section, completed)))
})

for (const harness of ["opencode", "codex"]) {
  test(`synthetic: ${harness} pending call details refresh automatically after completion`, async () => {
    const ui = createFrontend(harness)
    const node = harness === "codex" ? "c-llm" : "llm"
    ui.event("viz.run", { sessionID: "root" })
    ui.setCalls([{ index: 9, harness, request: { input: [], messages: [] } }])
    const request = ui.event("llm.request", { index: 9, sessionID: "root", model: "fixture", tools: [] })
    const panel = ui.elements.get("nodePanel"), pending = panel.children[0]
    await ui.evaluate(`toggleRecDetail(fixture, store[${JSON.stringify(node)}][0])`, pending)
    assert.doesNotMatch(pending.querySelector(".detail").innerHTML, /completion-marker/)
    ui.setCalls([{ index: 9, harness, request: { input: [], messages: [] }, rawResponse: { output_items: [{ text: "completion-marker" }] }, response: { text: "completion-marker", stopReason: null, usage: {} } }])
    const response = ui.event("llm.response", { index: 9, sessionID: "root", ms: 10, toolCalls: [], textChars: 17, usage: {} })
    await new Promise(resolve => setImmediate(resolve))
    const refreshed = panel.children[0]
    assert.notEqual(refreshed, pending)
    assert.equal(pending.isConnected, false)
    assert.ok(refreshed.classList.contains("open"))
    const detail = refreshed.querySelector(".detail").innerHTML
    assert.match(detail, /completion-marker/)
    assert.ok(rawSections(detail).some(section => isDeepStrictEqual(section, request)))
    assert.ok(rawSections(detail).some(section => isDeepStrictEqual(section, response)))
    assert.ok(ui.fetches.length >= 2, "completion must fetch fresh detail rather than reuse pending data")
    assert.ok(ui.fetches.every(fetch => fetch.options.cache === "no-store"))
  })
}

test("synthetic: a new run resets canonical records; late old-run failure remains raw only", () => {
  const ui = createFrontend("codex")
  ui.event("viz.run", {}, { runID: "run-A" })
  ui.event("codex.item.completed", { item: { id: "reused", type: "command_execution", status: "completed" } }, { runID: "run-A" })
  ui.event("viz.run", {}, { runID: "run-B" })
  assert.equal(ui.read("codexItems.size"), 0)
  assert.equal(ui.read("llmCallCount"), 0)
  const late = ui.event("codex.turn.failed", { error: { message: "old failure" } }, { runID: "run-A" })
  assert.equal(ui.read("runState"), "busy")
  assert.deepEqual(ui.read('store["c-done"] ?? []'), [])
  assert.ok(rawSections(ui.elements.get("eventlog").children.at(-1).innerHTML).some(section => isDeepStrictEqual(section, late)))
})
