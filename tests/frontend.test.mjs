import { test } from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import { readFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"

// Synthetic frontend units, not browser/layout verification or live integration.
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8")
const flowSource = await readFile(new URL("../public/flows.js", import.meta.url), "utf8")
const executionSource = await readFile(new URL("../public/execution-records.js", import.meta.url), "utf8")
const flowMarkup = vm.runInNewContext(flowSource + '; HarnessFlows.render("opencode") + HarnessFlows.render("codex")')
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
    assert.match(selector, /^\.(body|hd|detail|execution-state|history-snapshot|history-picker)$/u, "unsupported synthetic DOM selector")
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
  for (const match of (html + flowMarkup).matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[0].match(/\bclass="([^"]*)"/)?.[1] ?? "")
    element.attached = true
    for (const attr of match[0].matchAll(/\bdata-([\w-]+)="([^"]*)"/g)) element.dataset[attr[1]] = attr[2]
    elements.set(match[1], element)
  }
  let calls = [], eventID = 0, timerID = 0, extensionResponse = null, runResponse = null
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
      if (url === "/api/run") {
        assert(runResponse, "task submission requires an explicit synthetic response")
        fetches.push({ url, options })
        return runResponse()
      }
      if (url === "/api/questions") return { ok: true, json: async () => ({ questions: [] }) }
      if (url === "/api/extensions") {
        assert(extensionResponse, "extension discovery requires an explicit synthetic response")
        fetches.push({ url, options })
        return extensionResponse()
      }
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
  new vm.Script(flowSource, { filename: "flows.js:synthetic-unit" }).runInContext(context, { timeout: 1000 })
  new vm.Script(executionSource, { filename: "execution-records.js:synthetic-unit" }).runInContext(context, { timeout: 1000 })
  new vm.Script(unitSource, { filename: "index.html:synthetic-unit" }).runInContext(context, { timeout: 1000 })
  evaluate(`harness=${JSON.stringify(harness)}; activeTab="records"; selectedNode=${JSON.stringify(harness === "codex" ? "c-llm" : "llm")}`)
  return {
    elements, evaluate, fetches,
    read(code) {
      const value = evaluate(code)
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
    },
    setCalls(value) { calls = structuredClone(value) },
    setExtensionResponse(value) { extensionResponse = value },
    setRunResponse(value) { runResponse = value },
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

test("synthetic: history contains only request-boundary references, while assistant snapshots belong to model/compaction work", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  let first, last
  for (let index = 1; index <= 4; index++) {
    const info = { id: "assistant-" + index, sessionID: "root", role: "assistant" }
    const initial = ui.event("message.updated", { info })
    if (index === 1) first = initial
    ui.event("llm.request", { index, sessionID: "root", tools: [] })
    const final = ui.event("message.updated", { info: { ...info, finish: "stop", tokens: { input: 10 } } })
    if (index === 1) last = final
  }
  assert.equal(ui.read("store.loop.length"), 4)
  assert(ui.read("store.loop.every(r=>r.kind==='context' && r.evidence==='boundary')"))
  assert.equal(ui.read("store.llm.filter(r=>r.data.role==='assistant').length"), 4)
  const rec = ui.read("store.llm.find(r=>r.data.id==='assistant-1')")
  assert.equal(rec.time, first.receivedAt)
  assert.equal(rec.updatedAt, last.receivedAt)
  assert.deepEqual(rec.firstEvent, first)
  assert.deepEqual(rec.event, last)
  assert.equal(rec.data.finish, "stop")
  ui.event("message.updated", { info: { id: "summary", sessionID: "root", role: "assistant", summary: true } })
  assert.equal(ui.read("store.subflow2[0].data.id"), "summary")
  assert.equal(ui.read("store.loop.length"), 4)
  ui.evaluate("selectNode('loop')")
  assert.match(ui.elements.get("nodeTitle").innerHTML, /未采集执行记录/)
  assert.equal(ui.read("store.loop.filter(r=>r.recordType==='execution').length"), 0)
  assert(!html.includes('data-tab="references"'))
  assert.equal(ui.read("store.llm.filter(r=>r.recordType==='execution').length"), 4)
  assert.equal(ui.elements.get("cnt-llm").textContent, "4")
})

test("synthetic: node cards sort by first reception, keep latest update separately and still focus the correct stable record", async () => {
  const ui = createFrontend("codex")
  ui.event("viz.run")
  const late = ui.event("codex.item.started", { item: { id: "late", type: "command_execution", command: "late command", status: "in_progress" } }, { receivedAt: "2026-10-04T12:00:03Z" })
  ui.event("codex.item.completed", { item: { id: "early", type: "command_execution", command: "early command", status: "completed" } }, { receivedAt: "2026-10-04T12:00:02Z" })
  const updated = ui.event("codex.item.completed", { item: { id: "late", type: "command_execution", command: "late command", status: "completed" } }, { receivedAt: "2026-10-04T12:00:10Z" })
  ui.evaluate("selectNode('c-tool')")
  const panel = ui.elements.get("nodePanel")
  assert.deepEqual(panel.children.map(el => el.dataset.recordSeq), ["2", "1"])
  assert.equal(ui.read("store['c-tool'][0].time"), late.receivedAt)
  assert.equal(ui.read("store['c-tool'][0].updatedAt"), updated.receivedAt)
  assert(panel.children[1].innerHTML.includes("最近更新"))
  ui.evaluate("focusExecution(execution.entries().findIndex(row=>row.kind==='tool-completed' && row.callID==='early'))")
  assert(panel.children[0].classList.contains("open"))
  assert(rawSections(panel.children[0].querySelector(".detail").innerHTML).some(value => value.id === "early"))
})

test("synthetic: one submission with ten lifecycle snapshots cannot appear as ten preparation executions", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  ui.event("session.created", { info: { id: "root" } })
  for (let n=0;n<5;n++) ui.event("session.updated", { info: { id: "root", model: { id: "k3", providerID: "fixture" }, tokens: { input: n } } })
  for (let n=0;n<4;n++) ui.event("message.updated", { info: { id: "same-user", role: "user", sessionID: "root", summary: { version: n } } })
  assert.equal(ui.read("store.server.length"), 10)
  assert(ui.read("store.server.every(rec=>rec.recordType==='reference')"))
  ui.evaluate("selectNode('server')")
  assert.match(ui.elements.get("nodeTitle").innerHTML, /未采集执行记录/)
  assert.match(ui.elements.get("nodePanel").innerHTML, /未采集到.*实际执行记录/)
  assert.equal(ui.elements.get("cnt-server").textContent, "0")
  assert.equal(ui.elements.get("nodePanel").children.filter(el=>el.className==='rec').length, 0)
  assert.equal(ui.read("logN"), 11, "All ten native updates remain in the raw event log alongside submission")
})

test("synthetic: preparation progress updates one record and exposes timed input/actions/result details", async () => {
  const ui = createFrontend()
  ui.event("viz.run", { prompt: "task", turnNumber: 1 })
  const execution = { id: "prep-one", nodeID: "server", status: "running", turnNumber: 1,
    startedAt: "2026-10-14T12:00:00.000Z", endedAt: null, durationMs: null,
    input: { prompt: "ACTUAL_USER_TASK", projectPath: "actual-project", model: "k3", providerID: "fixture", reasoningEffort: "high", continuing: false, cliVersion: "1.18.34" },
    steps: [{ id: "session", label: "创建原生会话", status: "running", startedAt: "2026-10-14T12:00:00.000Z", endedAt: null, details: {} }], output: {}, boundary: "actual entry to native receipt" }
  ui.event("viz.preparation", { execution })
  execution.status = "completed"; execution.endedAt = "2026-10-14T12:00:00.100Z"; execution.durationMs = 100
  execution.output = { sessionID: "native-session", messageID: "native-message", confirmation: "本条用户消息已保存到原生会话" }
  execution.steps[0].status = "completed"
  ui.event("viz.preparation", { execution })
  assert.equal(ui.read("store.server.length"), 1)
  assert.equal(ui.read("store.server[0].recordType"), "execution")
  assert.equal(ui.elements.get("cnt-server").textContent, "1")
  assert.equal(ui.read("currentSession"), "native-session")
  ui.evaluate("selectNode('server')")
  assert.match(ui.elements.get("nodeTitle").innerHTML, /1 条执行记录/)
  const card = ui.elements.get("nodePanel").children[0]
  assert(card.innerHTML.includes("100 ms"))
  assert.match(card.innerHTML, /\d{2}:\d{2}:\d{2}\.\d{3}/, "Preparation summaries show full local clock times, not just milliseconds")
  await ui.evaluate("toggleRecDetail(fixture,store.server[0])", card)
  for (const text of ["本次输入", "实际处理", "本次结果", "ACTUAL_USER_TASK", "actual-project", "创建原生会话", "本条用户消息已保存"]) assert(card.querySelector(".detail").innerHTML.includes(text))
  assert.equal(ui.read("execution.entries().filter(row=>row.kind.startsWith('preparation-')).length"), 2)
})

test("synthetic: pending tool metadata becomes one execution record only after the tool starts", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  const part = { id: "part", type: "tool", tool: "read", callID: "call", sessionID: "root", state: { status: "pending", input: {} } }
  ui.event("message.part.updated", { part })
  assert.equal(ui.read("store.tool.filter(rec=>rec.recordType==='execution').length"), 0)
  ui.event("message.part.updated", { part: { ...part, state: { status: "running", input: {} } } })
  ui.event("message.part.updated", { part: { ...part, state: { status: "completed", input: {}, output: "actual output" } } })
  assert.equal(ui.read("store.tool.length"), 1)
  assert.equal(ui.read("store.tool[0].recordType"), "execution")
  assert.equal(ui.elements.get("cnt-tool").textContent, "1")
  assert.equal(ui.read("store.tool[0].data.state.output"), "actual output")
})

test("synthetic: tool and permission execution details share the approved input/work/result structure", async () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  const part = { id: "part", type: "tool", tool: "read", callID: "call", sessionID: "root", state: { status: "running", input: { path: "README.md" }, time: { start: 1000 } } }
  ui.event("message.part.updated", { part })
  ui.event("message.part.updated", { part: { ...part, state: { ...part.state, status: "completed", output: "ACTUAL_TOOL_RESULT", time: { start: 1000, end: 1700 } } } })
  ui.evaluate("selectNode('tool')")
  const panel = ui.elements.get("nodePanel")
  assert.equal(panel.children.length, 1)
  assert(panel.children[0].innerHTML.includes("700 ms"))
  await ui.evaluate("toggleRecDetail(fixture,store.tool[0])", panel.children[0])
  for (const text of ["执行信息", "本次输入", "实际处理", "本次结果", "README.md", "ACTUAL_TOOL_RESULT"]) assert(panel.children[0].querySelector(".detail").innerHTML.includes(text))
  ui.event("permission.asked", { id: "perm", sessionID: "root", permission: "edit", patterns: ["target"] })
  ui.event("permission.replied", { requestID: "perm", sessionID: "root", reply: "once" })
  assert.equal(ui.read("store.sandbox.length"), 1)
  ui.evaluate("selectNode('sandbox')")
  await ui.evaluate("toggleRecDetail(fixture,store.sandbox[0])", panel.children[0])
  assert(panel.children[0].querySelector(".detail").innerHTML.includes("等待并记录用户答复"))
})

test("synthetic: native compaction request updates merge by explicit request ID and stay in phase-neutral context", async () => {
  const ui = createFrontend("codex")
  ui.event("viz.run")
  ui.event("codex.trace", { event: { wall_time_unix_ms: 1000, payload: { type: "compaction_request_started", compaction_request_id: "request", compaction_id: "job", thread_id: "thread", model: "fixture" } }, payloads: { request_payload: { instructions: "ORIGINAL_CONTEXT" } } })
  ui.event("codex.trace", { event: { wall_time_unix_ms: 2000, payload: { type: "compaction_request_completed", compaction_request_id: "request", compaction_id: "job" } }, payloads: { response_payload: { summary: "ACTUAL_SUMMARY" } } })
  assert.equal(ui.read("store['c-context'].length"), 1)
  assert.equal(ui.read("store['c-context'][0].recordType"), "execution")
  assert.equal(ui.read("store['c-compact']"), undefined)
  ui.evaluate("selectNode('c-context')")
  const card = ui.elements.get("nodePanel").children[0]
  await ui.evaluate("toggleRecDetail(fixture,store['c-context'][0])", card)
  assert(card.querySelector(".detail").innerHTML.includes("ORIGINAL_CONTEXT"))
  assert(card.querySelector(".detail").innerHTML.includes("ACTUAL_SUMMARY"))
  assert(card.innerHTML.includes("1000 ms"))
})

test("synthetic: cancelled model inference is displayed as cancellation rather than task failure", () => {
  const ui = createFrontend("codex")
  ui.event("viz.run")
  ui.event("llm.request", { index: 1, model: "fixture", tools: [], startedAt: 1000 })
  ui.event("llm.response", { index: 1, endedAt: 1500, terminalType: "inference_cancelled", error: "response consumer dropped", toolCalls: [], usage: null })
  ui.evaluate("selectNode('c-llm')")
  assert(ui.elements.get("nodePanel").children[0].innerHTML.includes("已取消"))
  assert.equal(ui.read("runState"), "busy")
})

test("synthetic: learner-facing tool and permission details expose actual values without opening raw JSON", async () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root", prompt: "Read the configuration" })
  const part = { id: "read-part", type: "tool", tool: "read", callID: "read-call", sessionID: "root", state: {
    status: "completed", input: { filePath: "settings.conf", offset: 2, limit: 10 }, time: { start: 1000, end: 1100 },
    output: "<path>settings.conf</path>\n<type>file</type>\n<content>2: enabled=true\n3: mode=demo</content>" } }
  ui.event("message.part.updated", { part })
  ui.evaluate("selectNode('tool')")
  const card = ui.elements.get("nodePanel").children[0]
  await ui.evaluate("toggleRecDetail(fixture,store.tool[0])", card)
  const readable = card.querySelector(".detail").innerHTML.split('<details class="raw">')[0]
  for (const expected of ["读取文件", "目标文件", "settings.conf", "起始位置", "enabled=true", "mode=demo"]) assert(readable.includes(expected), expected)
  assert.doesNotMatch(readable, /&lt;path&gt;|&quot;filePath&quot;|"filePath":/)
  ui.event("permission.asked", { id: "permission", sessionID: "root", permission: "edit", patterns: ["settings.conf"] })
  ui.event("permission.replied", { requestID: "permission", sessionID: "root", reply: "once" })
  ui.evaluate("selectNode('sandbox')")
  const permission = ui.elements.get("nodePanel").children[0]
  await ui.evaluate("toggleRecDetail(fixture,store.sandbox[0])", permission)
  const visible = permission.querySelector(".detail").innerHTML.split('<details class="raw">')[0]
  assert(visible.includes("修改文件") && visible.includes("允许这一次操作"))
})

test("synthetic: history node shows only requirement and progress, without payload clutter or invented read executions", async () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  ui.setCalls([{ index: 3, harness: "opencode", runID: "synthetic-run", sessionID: "root", protocol: "chat", request: { messages: [
    { role: "user", content: "ACTUAL_USER_REQUIREMENT" }, { role: "assistant", content: "ACTUAL_PRIOR_ANSWER" },
    { role: "tool", tool_call_id: "call", content: "BULKY_TOOL_OUTPUT_SHOULD_STAY_IN_TOOL_DETAIL" } ] } },
    { index: 3, harness: "codex", runID: "synthetic-run", request: { input: [{ role: "user", content: "FOREIGN_THREAD" }] } }])
  ui.event("llm.request", { index: 3, sessionID: "root", model: "fixture", tools: [] })
  ui.evaluate("selectNode('loop')")
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(ui.read("store.loop.filter(r=>r.recordType==='execution').length"), 0)
  assert.equal(ui.elements.get("cnt-loop").textContent, "0")
  const section = ui.elements.get("nodePanel").children.find(child=>child.className === "history-evidence")
  assert(section)
  const snapshot = section.querySelector(".history-snapshot").innerHTML
  for (const text of ["内部读取日志尚未采集", "用户要求", "助手已有进度", "ACTUAL_USER_REQUIREMENT", "ACTUAL_PRIOR_ANSWER"]) assert(snapshot.includes(text), text)
  for (const text of ["FOREIGN_THREAD", "BULKY_TOOL_OUTPUT", "history-message", "工具参数", "退出码"]) assert(!snapshot.includes(text), text)
  const native = ui.evaluate("renderHistorySnapshot(fixture)", { index: 4, harness: "codex", source: "native-trace", request: { previous_response_id: "missing", input: [
    { type: "function_call_output", call_id: "unlinked", output: [{ type: "input_text", text: JSON.stringify({ exit_code: 1, output: "UNKNOWN_OUTPUT" }) }] },
  ] } })
  assert(native.includes("没有可确认的用户要求或助手进度") && native.includes("增量内容"))
  assert(!native.includes("UNKNOWN_OUTPUT") && !native.includes('"exit_code":'))
  ui.evaluate("globalThis.HarnessExecutions=undefined; selectNode('loop')")
  const unavailable = ui.elements.get("nodePanel").children.find(child=>child.className === "history-evidence")
  assert(unavailable.innerHTML.includes("可读详情组件未加载") && unavailable.innerHTML.includes("先导出"))
})

test("synthetic: Codex return shows task, command result and only the same turn's explicitly associated answer", async () => {
  const ui = createFrontend("codex")
  ui.event("viz.run", { sessionID: "thread", prompt: "FIRST_TASK", turnNumber: 1 }, { conversationTurn: 1 })
  ui.event("codex.item.completed", { item: { id: "answer", type: "agent_message", text: "FIRST_ANSWER" } }, { conversationTurn: 1 })
  ui.event("codex.turn.completed", { usage: { input_tokens: 20, output_tokens: 5 } }, { conversationTurn: 1 })
  ui.event("viz.run", { sessionID: "thread", prompt: "SECOND_TASK", turnNumber: 2, continuing: true }, { conversationTurn: 2 })
  ui.event("codex.item.completed", { item: { id: "command", type: "command_execution", command: "npm test", status: "completed", exit_code: 1, aggregated_output: "ACTUAL_FAILURE_OUTPUT" } }, { conversationTurn: 2 })
  ui.event("codex.item.completed", { item: { id: "answer", type: "agent_message", text: "SECOND_ANSWER" } }, { conversationTurn: 2 })
  ui.event("codex.turn.completed", { usage: { input_tokens: 30, output_tokens: 9 } }, { conversationTurn: 2 })
  ui.evaluate("selectNode('c-tool')")
  let card = ui.elements.get("nodePanel").children[0]
  await ui.evaluate("toggleRecDetail(fixture,store['c-tool'][0])", card)
  let body = card.querySelector(".detail").innerHTML.split('<details class="raw">')[0]
  for (const value of ["npm test", "非零退出码", "ACTUAL_FAILURE_OUTPUT"]) assert(body.includes(value), value)
  ui.evaluate("selectNode('c-done')")
  card = ui.elements.get("nodePanel").children[1]
  await ui.evaluate("toggleRecDetail(fixture,store['c-done'][1])", card)
  body = card.querySelector(".detail").innerHTML.split('<details class="raw">')[0]
  for (const value of ["SECOND_TASK", "SECOND_ANSWER", "输出 token"]) assert(body.includes(value), value)
  assert(!body.includes("FIRST_ANSWER") && !body.includes("FIRST_TASK"))
})

test("synthetic: thinking strength follows each native model, hides unsupported toggles and preserves per-harness selection", () => {
  const ui = createFrontend()
  ui.evaluate("modelMenus.opencode=fixture; paintModelMenu()", { defaultModel: "fixture/k3", models: [
    { value: "fixture/k3", variants: ["low", "high", "max"] },
    { value: "fixture/other", variants: ["medium", "high"] }, { value: "fixture/plain" }, { value: "fixture/toggle", variants: ["none", "thinking"] },
  ] })
  const model = ui.elements.get("modelSel"), variant = ui.elements.get("effortSel"), control = ui.elements.get("effortControl")
  assert.deepEqual(variant.children.map(option => option.value), ["", "low", "high", "max"])
  assert.deepEqual(variant.children.map(option => option.textContent), ["默认", "低", "高", "最高"])
  assert.equal(variant.value, "")
  variant.value = "max"; variant.onchange()
  model.value = "fixture/other"; model.onchange()
  assert.equal(variant.value, "")
  assert.deepEqual(variant.children.map(option => option.value), ["", "medium", "high"])
  model.value = "fixture/plain"; model.onchange()
  assert.equal(variant.disabled, true)
  assert.equal(control.hidden, true)
  assert.equal(variant.value, "")
  model.value = "fixture/toggle"; model.onchange()
  assert.equal(control.hidden, true, "An on/off thinking toggle is not an effort scale")
  model.value = "fixture/k3"; model.onchange()
  assert.equal(variant.value, "max")
  ui.evaluate("modelMenus.codex={models:[{value:'fixture/k3',reasoningEfforts:['low','medium','high','xhigh']}],defaultModel:'fixture/k3'}; switchHarness('codex')")
  assert.equal(control.hidden, false)
  assert.equal(variant.disabled, false)
  assert.equal(variant.value, "")
  assert.deepEqual(variant.children.map(option => option.textContent), ["默认", "低", "中", "高", "超高"])
  variant.value = "high"; variant.onchange()
  ui.evaluate("switchHarness('opencode')")
  assert.equal(control.hidden, false)
  assert.equal(variant.value, "max")
  ui.evaluate("switchHarness('codex')")
  assert.equal(variant.value, "high")
  ui.evaluate("switchHarness('opencode')")
  ui.evaluate("modelMenus.opencode.models[0].variants=['low','high']; paintModelMenu()")
  assert.equal(variant.value, "", "A removed native variant cannot remain selected")
})

test("synthetic: strength selection sends an OpenCode native variant or Codex reasoning effort, and default adds no override", async () => {
  for (const [harness, variant] of [["opencode", "max"], ["opencode", ""], ["codex", "max"]]) {
    const ui = createFrontend(harness)
    ui.evaluate("statusSnapshot={ocReady:true,versions:{codex:'0.160.0'}}")
    ui.elements.get("prompt").value = "local fixture"
    ui.elements.get("modelSel").value = "fixture/k3"
    ui.elements.get("effortSel").value = variant
    ui.setRunResponse(async () => ({ ok: true, json: async () => ({ sessionID: "fixture-root" }) }))
    await ui.evaluate("run()")
    const body = JSON.parse(ui.fetches.find(f => f.url === "/api/run").options.body)
    assert.deepEqual(body, { harness, prompt: "local fixture", model: "fixture/k3", ...(variant ? { [harness === "opencode" ? "variant" : "reasoningEffort"]: variant } : {}) })
  }
})

test("synthetic: continue-current-conversation defaults off, appears after completion and sends only the current session ID without clearing evidence", async () => {
  const ui = createFrontend()
  ui.evaluate("statusSnapshot={ocReady:true}")
  ui.event("viz.run", { prompt: "first", sessionID: "root", turnNumber: 1 })
  ui.event("llm.request", { index: 1, sessionID: "root", tools: [] })
  ui.event("session.status", { sessionID: "root", status: { type: "idle" } })
  const control = ui.elements.get("continueControl"), checkbox = ui.elements.get("continueCheck")
  assert.equal(control.hidden, false)
  assert.equal(checkbox.checked, false)
  checkbox.checked = true; checkbox.onchange()
  ui.elements.get("prompt").value = "second"
  ui.setRunResponse(async () => ({ ok: true, json: async () => ({ sessionID: "root", continuing: true }) }))
  await ui.evaluate("run()")
  assert.equal(JSON.parse(ui.fetches.find(f => f.url === "/api/run").options.body).continueSessionID, "root")
  assert.equal(ui.read("store.llm.length"), 1)
  assert.equal(ui.read("llmCallCount"), 1)
  assert.equal(checkbox.disabled, true)
  ui.event("viz.run", { prompt: "second", sessionID: "root", continuing: true, turnNumber: 2 })
  ui.event("llm.request", { index: 2, sessionID: "root", tools: [] })
  ui.event("session.status", { sessionID: "root", status: { type: "idle" } })
  assert.equal(ui.read("runState"), "ended", "Second turn can finish after clearing the previous terminal marker")
  assert.equal(ui.read("store.llm.length"), 2)
  assert.equal(ui.read("execution.entries().filter(row=>row.kind==='start').length"), 2)
  assert.equal(ui.elements.get("transcript").children.filter(e => e.className.includes("user")).length, 2)
  assert.equal(checkbox.checked, true)
})

test("synthetic: continuation choices are independent per harness and rejected continuations preserve the completed conversation", async () => {
  const ui = createFrontend()
  ui.evaluate("statusSnapshot={ocReady:true,versions:{codex:'0.160.0'}}")
  ui.event("viz.run", { sessionID: "root", turnNumber: 1 })
  ui.event("llm.request", { index: 1, sessionID: "root", tools: [] })
  ui.event("session.status", { sessionID: "root", status: { type: "idle" } })
  const checkbox = ui.elements.get("continueCheck")
  checkbox.checked = true; checkbox.onchange()
  ui.evaluate("harness='codex'; updateContinueControl()")
  assert.equal(checkbox.checked, false)
  ui.evaluate("harness='opencode'; updateContinueControl()")
  assert.equal(checkbox.checked, true)
  ui.elements.get("prompt").value = "follow up"
  ui.setRunResponse(async () => ({ ok: false, json: async () => ({ error: "stale conversation" }) }))
  await ui.evaluate("run()")
  assert.equal(ui.read("runState"), "ended")
  assert.equal(ui.read("store.llm.length"), 1)
  assert.equal(ui.read("currentSession"), "root")
  checkbox.checked = false; checkbox.onchange()
  ui.setRunResponse(async () => ({ ok: true, json: async () => ({ sessionID: "new-root" }) }))
  await ui.evaluate("run()")
  assert.equal(ui.read("llmCallCount"), 0)
  assert.equal(JSON.parse(ui.fetches.filter(f => f.url === "/api/run").at(-1).options.body).continueSessionID, undefined)
})

test("synthetic: resumed Codex exec item IDs cannot overwrite earlier turns' answers or tool evidence", () => {
  const ui = createFrontend("codex")
  ui.event("viz.run", { prompt: "first", sessionID: "thread", turnNumber: 1 })
  ui.event("codex.item.completed", { item: { id: "item_0", type: "agent_message", text: "FIRST_ANSWER" } }, { conversationTurn: 1 })
  ui.event("codex.item.completed", { item: { id: "item_1", type: "command_execution", command: "first", status: "completed" } }, { conversationTurn: 1 })
  ui.event("codex.turn.completed")
  ui.event("viz.run", { prompt: "second", sessionID: "thread", turnNumber: 2, continuing: true })
  ui.event("codex.item.completed", { item: { id: "item_0", type: "agent_message", text: "SECOND_ANSWER" } }, { conversationTurn: 2 })
  ui.event("codex.item.completed", { item: { id: "item_1", type: "command_execution", command: "second", status: "completed" } }, { conversationTurn: 2 })
  ui.event("codex.turn.completed")
  assert.equal(ui.read("codexItems.size"), 4)
  assert.equal(ui.read("toolCards['cx-item_0'].dataset.rawText"), "FIRST_ANSWER")
  assert.equal(ui.read("toolCards['cx-2:item_0'].dataset.rawText"), "SECOND_ANSWER")
  assert.deepEqual(ui.read("store['c-tool'].map(r=>r.data.command)"), ["first", "second"])
  assert.equal(ui.read("execution.entries().filter(row=>row.kind==='tool-completed').length"), 2)
})

test("synthetic: CLI preparation disables only its entry and status refresh preserves records/drafts", async () => {
  const ui = createFrontend("codex")
  ui.event("viz.run", { prompt: "previous task" })
  ui.evaluate("setRun('ended')")
  ui.elements.get("prompt").value = "保留草稿"
  const before = ui.read("store")
  const status = { cliStatus: { codex: { phase: "installing", available: false, message: "正在安装固定 Codex" },
    opencode: { phase: "ready", available: true, message: "OpenCode 已就绪" } } }
  ui.evaluate("applyStatus(fixture)", status)
  assert.equal(ui.elements.get("runBtn").disabled, true)
  assert.equal(ui.elements.get("runBtn").textContent, "准备中…")
  await ui.evaluate("run()")
  assert.equal(ui.fetches.length, 0, "Enter cannot bypass an unavailable CLI")
  assert.deepEqual(ui.read("store"), before)
  assert.equal(ui.elements.get("prompt").value, "保留草稿")
  status.cliStatus.codex = { phase: "error", available: false, message: "固定 Codex 安装失败" }
  ui.evaluate("applyStatus(fixture)", status)
  assert.equal(ui.elements.get("runBtn").textContent, "CLI 不可用")
  assert.equal(ui.elements.get("cliMessage").textContent, "固定 Codex 安装失败")
  ui.evaluate("harness='opencode'; setRun('idle')")
  assert.equal(ui.elements.get("runBtn").disabled, false)
  status.cliStatus.codex = { phase: "ready", available: true, message: "Codex 已就绪" }
  ui.evaluate("harness='codex'; applyStatus(fixture)", status)
  assert.equal(ui.elements.get("runBtn").disabled, false)
  ui.evaluate("setRun('busy'); applyStatus(fixture)", status)
  assert.equal(ui.elements.get("runBtn").disabled, true, "Polling must not unlock an active run")
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
  assert.equal(ui.read("store.loop[0].evidence"), "boundary", "prepared input is a request-boundary observation, not a loop iteration")
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
  assert.equal(ui.read("store.sub.length"), 1)
  assert.equal(ui.read("store.exec.length"), 1)
  assert.equal(ui.elements.get("cnt-sub").textContent, "1")
  assert.equal(ui.read("Object.keys(toolCards).length"), 1)
  assert.deepEqual(ui.read("store.sub[0].data"), completed)
  assert.deepEqual(ui.read("store.subflow1 ?? []"), [], "ordinary task is not preflight SubtaskPart execution")
  assert.equal(ui.read('isChild({sessionID:"child"})'), true)
})

test("synthetic: Codex command/MCP/collaboration/search updates preserve one card and full result", () => {
  const ui = createFrontend("codex")
  ui.event("viz.run")
  for (const type of ["command_execution", "mcp_tool_call", "collab_tool_call", "web_search"]) {
    const item = { id: type, type, status: "in_progress", command: "fixture", tool: "spawn_agent", server: "fixture-server", arguments: "{invalid", receiver_thread_ids: ["child"] }
    ui.event("codex.item.started", { item })
    ui.event("codex.item.updated", { item })
    const completed = { ...item, status: "completed", result: { content: [{ type: "text", text: longText }] }, agents_states: { child: { status: "completed", message: "child-marker" } } }
    ui.event("codex.item.completed", { item: completed })
    ui.event("codex.item.completed", { item: completed })
    ui.event("codex.item.updated", { item })
    assert.deepEqual(ui.read(`codexItems.get(${JSON.stringify(type)}).item`), completed)
    assert.deepEqual(ui.read(`store[${JSON.stringify(type === "collab_tool_call" ? "c-sub" : "c-tool")}].find(r => r.data.id === ${JSON.stringify(type)}).data`), completed)
    assert.ok(rawSections(ui.read(`toolCards[${JSON.stringify("cx-" + type)}].innerHTML`)).some(section => isDeepStrictEqual(section, completed)))
  }
  assert.equal(ui.read('store["c-tool"].length'), 3)
  assert.equal(ui.read('store["c-sub"].length'), 1)
  assert.equal(ui.read("Object.keys(toolCards).length"), 4)
  assert.equal(ui.elements.get("cnt-c-tool").textContent, "3")
  assert.equal(ui.read('store["c-feedback"].find(record => record.data.type === "web_search").title'), "网页搜索返回结果")
  ui.event("codex.item.completed", { item: { id: "plan", type: "todo_list", items: [] } })
  ui.event("codex.item.completed", { item: { id: "error", type: "error", message: "recoverable item" } })
  assert.equal(ui.elements.get("cnt-c-tool").textContent, "3")
  assert.equal(ui.read("runState"), "busy")
  assert.equal(ui.read('store["c-feedback"].at(-2).data.type'), "todo_list")
  assert.equal(ui.read('store["c-feedback"].at(-1).data.type'), "error")
  assert.deepEqual(ui.read('store["c-done"] ?? []'), [], "recoverable error items are not turn completion")
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
  assert.equal(ui.read('store["c-server"].length'), 1)
  assert.equal(ui.elements.get("cnt-c-server").textContent, "0", "Native turn-start is reference material, not a full preparation execution")
  assert.equal(ui.read("llmCallCount"), 3)
  assert.equal(ui.read('store["c-llm"].filter(r => r.kind === "llm").length'), 3)
  assert.deepEqual(ui.read('store["c-history"] ?? []'), [], "the same request is not archived twice")
  assert.deepEqual(ui.read('store["c-decide2"].map(r => r.evidence)'), ["inferred", "inferred", "inferred"])
  for (const node of ["c-budget", "c-tool", "c-decide", "c-compact", "c-stop"])
    assert.deepEqual(ui.read(`store[${JSON.stringify(node)}] ?? []`), [], `${node}: no fabricated observed branch`)
})

test("synthetic: native trace/warning records retain direct evidence without invented API calls", () => {
  const ui = createFrontend("codex")
  ui.event("viz.run")
  const trace = ui.event("codex.trace", { event: { seq: 9, payload: { type: "compaction_request_started", detail: longText } } }, { source: "native-trace" })
  const warning = ui.event("codex.trace.warning", { message: "incomplete capture", inferenceCallID: "inference-9" }, { source: "native-trace" })
  assert.deepEqual(ui.read('store["c-context"][0].event'), trace)
  assert.equal(ui.read('store["c-context"][0].evidence'), "direct")
  assert.deepEqual(ui.read('store["c-llm"][0].event'), warning)
  assert.equal(ui.read("llmCallCount"), 0)
  assert.deepEqual(ui.read('store["c-precompact"] ?? []'), [])
  assert.deepEqual(ui.read('store["c-compact"] ?? []'), [], "phase-less compaction is not classified as MidTurn")
  assert.deepEqual(ui.read('store["c-postcompact"] ?? []'), [])
})

test("synthetic: child lifecycle and user messages stay in the child node", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  const created = ui.event("session.created", { info: { id: "child", parentID: "root" } })
  const user = ui.event("message.updated", { info: { id: "child-user", role: "user", sessionID: "child" } })
  assert.deepEqual(ui.read("store.server ?? []"), [])
  assert.deepEqual(ui.read("store.sub.map(r => r.event)"), [created, user])
})

test("synthetic: permission interaction stays usable in the environment without fabricating execution", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  const ask = ui.event("permission.asked", { id: "permission-1", sessionID: "root", permission: "edit", patterns: ["fixture"], tool: { callID: "tool-1" } })
  assert.equal(ui.elements.get("permModal").classList.contains("show"), true)
  assert.equal(ui.elements.get("cnt-sandbox").textContent, "1")
  assert.deepEqual(ui.read("store.sandbox[0].event"), ask)
  const reply = { sessionID: "root", requestID: "permission-1", reply: "once" }
  const event = ui.event("permission.replied", reply)
  assert.equal(ui.read("store.sandbox.length"), 1, "A permission reply completes the same interaction")
  assert.deepEqual(ui.read("store.sandbox[0].data"), reply)
  assert.deepEqual(ui.read("store.sandbox[0].event"), event)
  assert.equal(ui.elements.get("permModal").classList.contains("show"), false)
  assert.deepEqual(ui.read("store.tool ?? []"), [], "an approval does not prove tool execution")
  const retry = { sessionID: "root", status: { type: "retry", attempt: 2, action: "retry", next: 1791193123000, message: "temporary error" } }
  ui.event("session.status", retry)
  assert.deepEqual(ui.read("store.llm[0].data"), retry)
})

test("synthetic: task tool snapshots do not claim the ordinary or preflight route executed", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  const marker = { id: "subtask-marker", sessionID: "root", type: "subtask", prompt: "fixture", agent: "general" }
  ui.event("message.part.updated", { part: marker })
  const part = { id: "task-part", sessionID: "root", callID: "task-1", type: "tool", tool: "task", state: { status: "running", input: {} } }
  ui.event("message.part.updated", { part })
  assert.equal(ui.read("store.sub[0].title"), "task 工具调用")
  assert.deepEqual(ui.read("store.subflow1[0].data"), marker)
  assert.deepEqual(ui.read("store.sub[0].data"), part)
  assert.deepEqual(ui.read("store.delegate ?? []"), [], "task snapshots cannot prove the model-dispatch path")
  assert.deepEqual(ui.read('store["pre-sub"] ?? []'), [], "a pending marker is not preflight execution")
})

test("synthetic: OpenCode compaction completion does not count the request marker twice", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  const part = { id: "compact-1", sessionID: "root", type: "compaction", auto: true }
  ui.event("message.part.updated", { part })
  ui.event("message.part.updated", { part })
  const completed = ui.event("session.compacted", { sessionID: "root" })
  assert.equal(ui.elements.get("cnt-schedule").textContent, "0", "A persisted marker does not prove that the schedule function ran")
  assert.equal(ui.read("store.schedule.length"), 1)
  assert.equal(ui.read("store.subflow2.length"), 1)
  assert.deepEqual(ui.read("store.subflow2[0].event"), completed)
  assert.deepEqual(ui.read('store["compact-result"] ?? []'), [], "completion does not observe the process return decision")
})

test("synthetic: sandbox node records the supplied launch policy without claiming tool approval", () => {
  const ui = createFrontend("codex")
  ui.event("viz.run")
  const launch = { sandbox: "workspace-write", approvalPolicy: "never", args: ["exec", "--json"] }
  const event = ui.event("codex.proc.start", launch)
  assert.deepEqual(ui.read('store["c-sandbox"][0].data'), launch)
  assert.equal(ui.read('store["c-sandbox"][0].evidence'), "boundary")
  assert.deepEqual(ui.read('store["c-sandbox"][0].event'), event)
  assert.deepEqual(ui.read('store["c-tool"] ?? []'), [])
})

test("synthetic: tagged native agent tool lifecycle stays in the child node", () => {
  const ui = createFrontend("codex")
  ui.event("viz.run")
  const observed = [
    { type: "tool_call_started", tool_call_id: "agent-call-1", kind: { type: "spawn_agent" } },
    { type: "tool_call_runtime_ended", tool_call_id: "agent-call-1", status: "completed" },
    { type: "tool_call_ended", tool_call_id: "agent-call-1", status: "completed" },
  ].map((payload, seq) => ui.event("codex.trace", { event: { seq, payload } }, { source: "native-trace" }))
  assert.deepEqual(ui.read('store["c-sub"].map(record => record.event)'), observed)
  assert.deepEqual(ui.read('store["c-tool"] ?? []'), [])
  assert.equal(ui.read("runState"), "busy", "agent management completion is not task completion")
})

test("synthetic: Other tool kinds or missing starts do not infer a dispatch category", () => {
  const ui = createFrontend("codex")
  ui.event("viz.run")
  const observed = [
    { type: "tool_call_started", tool_call_id: "other-1", kind: { type: "other", name: "list_agents" } },
    { type: "tool_call_ended", tool_call_id: "other-1", status: "completed" },
    { type: "tool_call_runtime_ended", tool_call_id: "missing-start", status: "completed" },
  ].map((payload, seq) => ui.event("codex.trace", { event: { seq, payload } }, { source: "native-trace" }))
  assert.deepEqual(ui.read('store["c-delegate"].map(record => record.event)'), observed)
  assert.deepEqual(ui.read('store["c-tool"] ?? []'), [])
  assert.deepEqual(ui.read('store["c-sub"] ?? []'), [])
  assert.deepEqual(ui.read("[...codexThreadParents]"), [])
})

test("synthetic: child model work is associated only through explicit thread relationships", () => {
  const ui = createFrontend("codex")
  ui.event("viz.run")
  ui.event("codex.thread.started", { thread_id: "root" })
  ui.event("codex.item.completed", { item: { id: "agent-1", type: "collab_tool_call", tool: "spawn_agent", sender_thread_id: "root", receiver_thread_ids: ["child"], status: "completed" } })
  const child = ui.event("llm.request", { index: 1, sessionID: "child", model: "fixture", tools: [] })
  ui.event("llm.request", { index: 2, sessionID: "unrelated", model: "fixture", tools: [] })
  assert.deepEqual(ui.read('store["c-sub"].filter(record => record.data.index).map(record => record.event)'), [child])
  assert.equal(ui.read('store["c-llm"].filter(record => record.kind === "llm").length'), 2)
  assert.equal(ui.read('codexThreadParents.has("unrelated")'), false)
})

test("synthetic: collaboration interaction or unsuccessful spawn is not a parent relationship", () => {
  const ui = createFrontend("codex")
  ui.event("viz.run")
  ui.event("codex.thread.started", { thread_id: "root" })
  for (const [id, tool, status, done] of [
    ["wait", "wait", "completed", true],
    ["send", "send_input", "completed", true],
    ["close", "close_agent", "completed", true],
    ["failed", "spawn_agent", "failed", true],
    ["pending", "spawn_agent", "in_progress", false],
  ]) {
    ui.event(done ? "codex.item.completed" : "codex.item.started", { item: { id, type: "collab_tool_call", tool, status, sender_thread_id: "root", receiver_thread_ids: [id + "-receiver"] } })
    ui.event("llm.request", { index: id, sessionID: id + "-receiver", model: "fixture", tools: [] })
  }
  assert.deepEqual(ui.read("[...codexThreadParents]"), [])
  assert.deepEqual(ui.read('store["c-sub"].filter(record => record.kind === "llm" || record.data.index)'), [])
  const proof = ui.event("codex.trace", { event: { payload: { type: "agent_result_observed", child_thread_id: "native-child", parent_thread_id: "root" } } }, { source: "native-trace" })
  const child = ui.event("llm.request", { index: 99, sessionID: "native-child", model: "fixture", tools: [] })
  assert.equal(ui.read('codexThreadParents.get("native-child")'), "root")
  assert.deepEqual(ui.read('store["c-sub"].filter(record => record.data.index === 99).map(record => record.event)'), [child])
  assert.ok(ui.read('store["c-sub"].some(record => record.event.id === ' + JSON.stringify(proof.id) + ')'))
})

test("synthetic: unsupported native protocol wrappers remain raw logs, not approval facts", () => {
  const ui = createFrontend("codex")
  ui.event("viz.run")
  const approval = ui.event("codex.trace", { event: { seq: 1, payload: { type: "protocol_event_observed", event_type: "exec_approval_request" } }, payloads: { event_payload: { call_id: "exec-1", command: ["fixture"], cwd: "project" } } }, { source: "native-trace" })
  assert.deepEqual(ui.read('store["c-sandbox"] ?? []'), [], "the fixed trace wrapper does not capture approvals")
  assert.deepEqual(ui.read('store["c-perm"] ?? []'), [])
  assert.ok(ui.elements.get("eventlog").children.some(line => rawSections(line.innerHTML).some(event => event.id === approval.id)), "unsupported event envelopes remain available")
  assert.deepEqual(ui.read('store["c-done"] ?? []'), [])
})

test("synthetic: function runtime reports remain tool observations, not model requests", () => {
  const ui = createFrontend("codex")
  ui.event("viz.run")
  const events = ["code_cell_started", "code_cell_initial_response", "code_cell_ended"].map((type, seq) => ui.event("codex.trace", { event: { seq, payload: { type, runtime_cell_id: "cell-1" } } }, { source: "native-trace" }))
  assert.deepEqual(ui.read('store["c-tool"].map(record => record.event)'), events)
  assert.equal(ui.read("llmCallCount"), 0)
  assert.deepEqual(ui.read('store["c-done"] ?? []'), [])
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
  assert.match(rendered, /class="input-message" open><summary>2\. 开发者要求（developer）/)
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
    const completed = ui.read(`HarnessExecutions.fromRecord(store[${JSON.stringify(node)}][0], ${JSON.stringify(node)})`)
    assert.equal(completed.status, "completed")
    assert.equal(completed.observations.lastReceivedAt, response.receivedAt)
    assert.equal(ui.read(`store[${JSON.stringify(node)}][0].updatedAt`), response.receivedAt)
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

  test(`synthetic: ${harness} closed model card discards stale partial output when the terminal notification arrives`, async () => {
    const ui = createFrontend(harness)
    const node = harness === "codex" ? "c-llm" : "llm"
    ui.event("viz.run", { sessionID: "root" })
    ui.setCalls([{ index: 9, harness, request: { input: [], messages: [] }, response: { text: "partial-marker" } }])
    ui.event("llm.request", { index: 9, sessionID: "root", model: "fixture", tools: [] })
    const pending = ui.elements.get("nodePanel").children[0]
    await ui.evaluate(`toggleRecDetail(fixture, store[${JSON.stringify(node)}][0])`, pending)
    assert.match(pending.querySelector(".detail").innerHTML, /partial-marker/)
    await ui.evaluate(`toggleRecDetail(fixture, store[${JSON.stringify(node)}][0])`, pending)
    const response = ui.event("llm.response", { index: 9, sessionID: "root", textChars: 100, toolCalls: [], usage: { output_tokens: 25 } })
    const completed = ui.read(`HarnessExecutions.fromRecord(store[${JSON.stringify(node)}][0], ${JSON.stringify(node)})`)
    assert.equal(completed.status, "completed")
    assert.equal(completed.output.textChars, 100)
    assert.equal(completed.observations.lastReceivedAt, response.receivedAt)
    assert.doesNotMatch(JSON.stringify(completed.output), /partial-marker/)
    assert.equal(ui.fetches.length, 1, "a closed card must not refetch until reopened")
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

test("synthetic: execution order retains tool starts/results, sorts reception times and never fabricates branches", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root", prompt: "task" }, { receivedAt: "2026-10-04T12:00:00Z" })
  ui.event("llm.request", { index: 1, sessionID: "root", messages: 1, tools: ["read"] }, { receivedAt: "2026-10-04T12:00:01Z" })
  ui.event("llm.response", { index: 1, sessionID: "root", toolCalls: ["read"], textChars: 0 }, { receivedAt: "2026-10-04T12:00:03Z" })
  const part = { id: "p", sessionID: "root", type: "tool", tool: "read", callID: "call-1", state: { status: "running", input: { filePath: "fixture.txt" } } }
  ui.event("message.part.updated", { part }, { receivedAt: "2026-10-04T12:00:02Z" })
  ui.event("message.part.updated", { part }, { receivedAt: "2026-10-04T12:00:04Z" })
  ui.event("message.part.updated", { part: { ...part, state: { ...part.state, status: "completed", output: "result" } } }, { receivedAt: "2026-10-04T12:00:05Z" })
  assert.deepEqual(ui.read("execution.entries().map(r=>r.kind)"), ["start", "model-request", "tool-running", "model-response", "tool-completed"])
  assert.equal(ui.read("execution.entries()[2].time"), "2026-10-04T12:00:02Z", "Later snapshots must not erase the original start")
  const coverage = ui.read("execution.coverage()")
  assert(coverage.tool && coverage.exec && coverage.llm)
  assert.match(coverage.loop.labels[0], /输入可见；内部读取未跟踪/)
  for (const node of ["decide", "decide2", "delegate", "outcome", "pre-sub", "subflow3"]) assert.equal(coverage[node], undefined)
  ui.evaluate("renderExecution()")
  assert.match(ui.elements.get("executionList").innerHTML, /工具开始执行：read/)
  assert.equal(ui.elements.get("fn-tool").classList.contains("observed"), true)
  assert.equal(ui.elements.get("fn-outcome").classList.contains("observed"), false)
  assert.match(ui.elements.get("coverageList").innerHTML, /未直接记录，不能判断未执行/)
})

test("synthetic: child timeline is explicitly associated and filters do not destroy evidence", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  ui.event("llm.request", { index: 2, sessionID: "child", tools: [] })
  assert.equal(ui.read("execution.entries().length"), 1, "Unassociated child event waits for evidence")
  ui.event("session.created", { info: { id: "child", parentID: "root" } })
  const child = ui.read("execution.entries().find(r=>r.index===2)")
  assert.equal(child.child, true)
  assert.match(child.scope, /子会话/)
  ui.elements.get("executionScope").value = "parent"
  assert.equal(ui.read("visibleExecution().some(r=>r.child)"), false)
  ui.elements.get("executionScope").value = "child"
  assert.equal(ui.read("visibleExecution().length"), 2)
  assert.equal(ui.read("execution.entries().length"), 3)
  ui.evaluate("resetUI()")
  assert.deepEqual(ui.read("execution.entries()"), [])
})

test("synthetic: duplicate idle reports merge, but a resumed session keeps its later idle", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  ui.event("session.status", { sessionID: "root", status: { type: "idle" } })
  ui.event("session.idle", { sessionID: "root" })
  ui.event("session.status", { sessionID: "root", status: { type: "busy" } })
  ui.event("session.status", { sessionID: "root", status: { type: "idle" } })
  assert.equal(ui.read("execution.entries().filter(r=>r.kind==='idle').length"), 2)
})

test("synthetic: readable history separates a user task, model tool proposal and returned result without mutating payload", () => {
  const ui = createFrontend()
  const call = { index: 13, harness: "opencode", request: { system: "system-instructions", messages: [
    { role: "user", content: [{ type: "text", text: "用户原问题" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "task-call", name: "task", input: { prompt: "search" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "task-call", content: longText }] },
  ], tools: [{ name: "task" }] } }
  const before = structuredClone(call)
  const rendered = ui.evaluate("renderHistory(fixture)", call)
  assert.match(rendered, /用户任务或补充信息/)
  assert.match(rendered, /模型提出工具调用/)
  assert.match(rendered, /工具结果回传.*task/)
  assert.match(rendered, /不是数据库完整历史/)
  assert.match(rendered, /不是你又发了一条问题/)
  assert(rendered.includes(longText), "Full returned content is still inspectable")
  assert.deepEqual(call, before)
  assert.deepEqual(JSON.parse(ui.read("requestCache[13]")), call.request)
})

test("synthetic: Chat history keeps system instructions folded and opens the actual conversation message", () => {
  const ui = createFrontend()
  const rendered = ui.evaluate("renderHistory(fixture)", { index: 1, harness: "opencode", protocol: "chat", request: { messages: [
    { role: "system", content: "SYSTEM_REFERENCE" }, { role: "user", content: "USER_TASK" },
  ] } })
  assert.match(rendered, /class="input-message"><summary>1\.[\s\S]*?（system）/)
  assert.match(rendered, /class="input-message" open><summary>2\.[\s\S]*?（user）/)
})

test("synthetic: one model response displays both text and proposals, and proposal alone is not tool execution", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  const call = { index: 1, harness: "opencode", sessionID: "root", request: { messages: [] },
    response: { text: "先检查文件", toolUses: [{ name: "read", callID: "read-1", input: { filePath: "fixture" } }] } }
  let rendered = ui.evaluate("renderLlmCall(fixture)", call)
  assert.match(rendered, /模型响应 · 文字与工具调用/)
  assert.match(rendered, /响应中的文字/)
  assert.match(rendered, /模型提出调用：read/)
  assert.match(rendered, /尚无关联的执行记录/)
  assert.match(rendered, /定位工具执行记录<\/button>/)
  assert.doesNotMatch(rendered, /已有工具结果／结束记录/)
  const part = { id: "tool-part", sessionID: "root", type: "tool", tool: "read", callID: "read-1", state: { status: "completed", input: {}, output: "found" } }
  ui.event("message.part.updated", { part })
  rendered = ui.evaluate("renderLlmCall(fixture)", call)
  assert.match(rendered, /已有工具结果／结束记录/)
  assert.match(rendered, /onclick="focusToolCall\(1,0\)"/)
})

test("synthetic: request/response notifications stay separate from full API payloads", () => {
  const ui = createFrontend()
  const request = { type: "llm.request", id: "req", properties: { index: 1, messages: 3 }, receivedAt: "received", source: "proxy" }
  const response = { type: "llm.response", id: "res", properties: { index: 1, textChars: 9 }, source: "proxy" }
  const rendered = ui.evaluate("renderCaptureEvents(fixture)", { event: request, data: { responseEvent: response } })
  assert.match(rendered, /精简通知，不是模型 API 的完整请求体或响应流/)
  assert(rawSections(rendered).some(value => isDeepStrictEqual(value, request)))
  assert(rawSections(rendered).some(value => isDeepStrictEqual(value, response)))
})

test("synthetic: missing history in a captured request is unknown rather than an empty conversation", () => {
  const ui = createFrontend("codex")
  const rendered = ui.evaluate("renderHistory(fixture)", { index: 1, harness: "codex", source: "native-trace", request: { instructions: "known", previous_response_id: "previous" } })
  assert.match(rendered, /没有提供历史消息数组，不能推断历史为空/)
  assert.match(rendered, /input: 未记录/)
  assert.match(rendered, /更早内容可能由前序响应继承/)
  assert.doesNotMatch(rendered, /input: 0 项/)
})

test("synthetic: a plain answer expands its full mechanism without adding fictional runtime events", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root", prompt: "question" })
  ui.event("session.created", { info: { id: "root", title: "task" } })
  ui.event("llm.request", { index: 17, sessionID: "root", messages: 1, tools: [] })
  ui.event("llm.response", { index: 17, sessionID: "root", textChars: 30, toolCalls: [] })
  ui.event("viz.prompt.returned", { sessionID: "root", result: { info: { finish: "stop" } } })
  ui.event("session.status", { sessionID: "root", status: { type: "idle" } })
  assert.equal(ui.read("execution.entries().length"), 6)
  assert.deepEqual(ui.read("flowEntries().filter(r=>r.type==='mechanism').map(r=>r.phase.id)"),
    ["loop", "decide", "subflow1", "subflow3", "decide2", "exec", "outcome", "loop", "decide"])
  assert.equal(ui.read("execution.coverage().outcome"), undefined)
  ui.evaluate("focusFlowEntry(2)")
  assert.equal(ui.read("selectedNode"), "loop")
  assert.equal(ui.read("mechanismFocus.node"), "loop")
  assert.match(ui.elements.get("executionEvidenceNote").textContent, /没有原生时间戳/)
  assert(ui.read("highlightedMechanism().edges.some(e=>e.from==='server'&&e.to==='loop')"))
  assert.equal(ui.read("highlightedMechanism().edges.some(e=>e.from==='server'&&e.to==='llm')"), false)
  ui.elements.get("executionMode").value = "events"
  ui.evaluate("renderExecution()")
  assert.equal(ui.read("flowEntries().length"), 6)
  assert.deepEqual(ui.read("highlightedMechanism()"), { nodes: [], edges: [] })
})

test("synthetic: matching IDs establish response/tool/input links; names and global neighbors do not", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  ui.event("session.created", { info: { id: "root" } })
  ui.event("llm.request", { index: 1, sessionID: "root", tools: ["read"] })
  ui.event("llm.response", { index: 1, sessionID: "root", toolCalls: ["read"] })
  const part = { id: "part", callID: "read-1", sessionID: "root", type: "tool", tool: "read", state: { status: "running", input: {} } }
  ui.event("message.part.updated", { part })
  ui.event("message.part.updated", { part: { ...part, state: { ...part.state, status: "completed", output: "result" } } })
  ui.event("llm.request", { index: 2, sessionID: "root", tools: [] })
  const packets = [
    { index: 1, sessionID: "root", request: { messages: [] }, response: { toolUses: [{ name: "read", callID: "read-1" }] } },
    { index: 2, sessionID: "root", request: { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "result" }] }] } },
  ]
  ui.evaluate("for(const packet of fixture) relationshipPackets.set(packet.index,HarnessEvidence.packetLinks(packet))", packets)
  const result = ui.read("HarnessEvidence.relation(execution.entries(),execution.entries().at(-1),relationshipPackets)")
  assert.equal(result.source.callID, "read-1")
  assert.equal(result.path.name, "repeat")
  const dispatch = ui.read("HarnessEvidence.relation(execution.entries(),execution.entries().find(r=>r.kind==='tool-running'),relationshipPackets)")
  assert.equal(dispatch.path.name, "dispatchTool")
  ui.evaluate("relationshipPackets.set(1,HarnessEvidence.packetLinks({index:1,sessionID:'root',response:{toolUses:[{name:'read',callID:'different'}]}}))")
  assert.equal(ui.read("HarnessEvidence.relation(execution.entries(),execution.entries().find(r=>r.kind==='tool-running'),relationshipPackets).path"), null)
})

test("synthetic: child model calls belong inside the child subprocess, not the parent sampling node", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  ui.event("session.created", { info: { id: "child", parentID: "root" } })
  ui.event("llm.request", { index: 2, sessionID: "child", tools: [] })
  assert.equal(ui.read("execution.entries().find(r=>r.index===2).node"), "sub")
  assert.equal(ui.read("store.sub.filter(r=>r.kind==='llm').length"), 1)
  assert.equal(ui.read("store.llm ?? null"), null)
  ui.evaluate("focusExecution(execution.entries().findIndex(r=>r.index===2))")
  assert.deepEqual(ui.read("highlightedMechanism()"), { nodes: ["sub"], edges: [] })
  assert.match(ui.elements.get("flowLevel").textContent, /子会话内部/)
})

test("synthetic: extension configuration is distinct from actual catalog/tools/skill-body evidence", () => {
  const ui = createFrontend()
  const inventory = { skills: [{ name: "frontend-design", revision: "fixed" }], mcp: [{ name: "context7", version: "4.3.0" }], plugins: [{ name: "dcp", version: "3.2.0" }] }
  const context = { system: "Available skills: frontend-design", tools: [{ name: "context7_query_docs" }, { name: "compress" }], items: [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "skill-call", content: '<skill_content name="frontend-design">body</skill_content>' }] },
  ] }
  const before = structuredClone(context)
  const rendered = ui.evaluate("renderExtensionLayers(fixture.call, fixture.context)", { call: { extensions: inventory }, context })
  assert.match(rendered, /配置快照不是使用证明/)
  assert.match(rendered, /不单独证明文件已被读取/)
  assert.match(rendered, /正文／参考资料/)
  assert.match(rendered, /context7_query_docs/)
  assert.match(rendered, /可见 compress/)
  assert.match(rendered, /请求中存在技能内容标记/)
  assert.deepEqual(context, before)
  assert.match(ui.evaluate("renderExtensionLayers({},fixture)", context), /不用当前配置反推当时加载内容/)
})

test("synthetic: discovery survives status polls and never labels OpenCode results as Codex discovery", async () => {
  const ui = createFrontend()
  const status = { ocReady: true, extensions: { state: { phase: "ready" },
    opencode: { profile: "synthetic", skills: [{ name: "frontend-design" }], mcp: [{ name: "context7" }], plugins: [{ name: "dcp" }] },
    codex: { profile: "synthetic", skills: [{ name: "frontend-design" }], mcp: [{ name: "context7" }], plugins: [] } } }
  const observed = { harness: "opencode", available: true, skills: [{ name: "frontend-design", description: "synthetic", location: "fixture/SKILL.md" }],
    mcp: { context7: { status: "connected" } }, tools: [{ id: "compress" }] }
  ui.setExtensionResponse(async () => ({ ok: true, json: async () => ({ ...status.extensions, observed }) }))
  ui.evaluate("applyStatus(fixture)", status)
  await ui.evaluate("document.getElementById('extensionCheckBtn').onclick()")
  const info = () => JSON.parse(ui.elements.get("extensionInfo").textContent)
  assert.deepEqual(info().discovery, observed)
  ui.evaluate("applyStatus(fixture)", structuredClone(status))
  assert.deepEqual(info().discovery, observed, "polling must preserve discovery for the same configuration")
  ui.evaluate("harness='codex'; updateModelInfo()")
  assert.equal(info().discovery, undefined)
  await ui.evaluate("document.getElementById('extensionCheckBtn').onclick()")
  assert.equal(info().discovery.harness, "codex")
  assert.equal(info().discovery.command, "npm run extensions:check")
  assert.equal(info().discovery.tools, undefined)
  assert.equal(ui.fetches.length, 1, "Codex instructions must not query the OpenCode discovery endpoint")
  ui.evaluate("harness='opencode'; updateModelInfo()")
  assert.deepEqual(info().discovery, observed)
  status.extensions.opencode.profile = "changed"
  ui.evaluate("applyStatus(fixture)", status)
  assert.equal(info().discovery, undefined, "changed configuration invalidates the old discovery result")
})

test("synthetic: late discovery failures cannot replace another harness's information", async () => {
  const ui = createFrontend()
  const status = { ocReady: true, extensions: { state: { phase: "ready" },
    opencode: { profile: "synthetic", skills: [], mcp: [], plugins: [] },
    codex: { profile: "synthetic", skills: [], mcp: [], plugins: [] } } }
  let reject
  ui.setExtensionResponse(() => new Promise((resolve, fail) => { reject = fail }))
  ui.evaluate("applyStatus(fixture)", status)
  const checking = ui.evaluate("document.getElementById('extensionCheckBtn').onclick()")
  assert.equal(ui.elements.get("extensionCheckBtn").disabled, true)
  ui.evaluate("harness='codex'; updateModelInfo()")
  await ui.evaluate("document.getElementById('extensionCheckBtn').onclick()")
  const before = ui.elements.get("extensionInfo").textContent
  reject(new Error("synthetic discovery failure"))
  await checking
  assert.equal(ui.elements.get("extensionInfo").textContent, before)
  assert.equal(ui.elements.get("extensionCheckBtn").disabled, false)
  ui.evaluate("harness='opencode'; updateModelInfo()")
  assert.match(JSON.parse(ui.elements.get("extensionInfo").textContent).discovery.error, /synthetic discovery failure/)
})

test("synthetic: question interaction is separate from permission and preserves single, multiple and custom answers", () => {
  const ui = createFrontend()
  ui.event("viz.run", { sessionID: "root" })
  const request = { id: "que-one", sessionID: "root", questions: [
    { header: "single", question: "choose", options: [{ label: "A", description: "first" }, { label: "B", description: "second" }] },
    { header: "multi", question: "choose many", multiple: true, custom: false, options: [{ label: "X", description: "x" }, { label: "Y", description: "y" }] },
  ] }
  ui.event("question.asked", request)
  const custom = new Element(); custom.attached = true; ui.elements.set("question-custom-0", custom)
  assert(ui.elements.get("questionModal").classList.contains("show"))
  assert(!ui.elements.get("permModal").classList.contains("show"))
  ui.evaluate("chooseQuestion(0,0,true); chooseQuestion(1,0,true); chooseQuestion(1,1,true)")
  assert.deepEqual(ui.read("collectQuestionAnswers(activeQuestion,questionDrafts.get(activeQuestion.id))"), [["A"], ["X", "Y"]])
  ui.evaluate("questionDrafts.get(activeQuestion.id)[0].custom='自己的答案'")
  assert.deepEqual(ui.read("collectQuestionAnswers(activeQuestion,questionDrafts.get(activeQuestion.id))"), [["自己的答案"], ["X", "Y"]])
  ui.event("question.replied", { requestID: "que-one", sessionID: "root", answers: [["A"], ["X", "Y"]] })
  assert(!ui.elements.get("questionModal").classList.contains("show"))
})
