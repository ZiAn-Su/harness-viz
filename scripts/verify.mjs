// Opt-in integration verification; --smoke uses local mock inference only.
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:net"
import { createServer as createHttpServer } from "node:http"
import { readFile, writeFile, mkdir, access, symlink } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"
import { listenLocal } from "../src/ports.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const smokeOnly = process.argv.includes("--smoke")
const output = path.join(root, ".runtime", "verification", new Date().toISOString().replace(/[:.]/g, "-"))
await mkdir(output, { recursive: true })
const target = path.join(output, "project")
await mkdir(target, { recursive: true })
const marker = "HARNESS_EVIDENCE_" + Date.now()
await writeFile(path.join(target, "evidence-input.txt"), marker + "\n")
await writeFile(path.join(target, "AGENTS.md"), "Use only files in this fixture directory. Never access credentials or user directories.\n")
async function freePort() {
  const socket = createServer()
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve) })
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return port
}
const vizPort = await freePort()
const base = `http://127.0.0.1:${vizPort}`
const results = { checkedAt: new Date().toISOString(), marker, target, checks: [] }
const sourceLock = JSON.parse(await readFile(path.join(root, "src", "versions.json"), "utf8"))
let proc, log = ""
let mockServer, mockBase, mockQuestionSent = false
const mockRequests = []
async function startNativeMock() {
  mockServer = createHttpServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString("utf8")
    const body = JSON.parse(raw)
    mockRequests.push({ raw, body, headers: { observedProvider: req.headers["x-harness-provider"] ?? null } })
    if (req.url?.endsWith("/chat/completions")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.end(`data: ${JSON.stringify({ id: "mock-chat-" + mockRequests.length, object: "chat.completion.chunk", model: body.model,
        choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "MOCK_VISIBLE_THINKING", content: "MOCK_EFFORT_FINISHED" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`)
      return
    }
    const isMain = body.tools?.some(t => t.name === "question"), id = "mock-response-" + mockRequests.length
    const call = isMain && !mockQuestionSent
    if (call) mockQuestionSent = true
    const args = JSON.stringify({ questions: [{ header: "Native test", question: "Choose the local mock answer", options: [{ label: "NATIVE_QUESTION_ANSWER", description: "No real model inference" }] }] })
    const item = call ? { id: "mock-item", type: "function_call", call_id: "mock-question-call", name: "question", arguments: args, status: "completed" }
      : { id: "mock-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "NATIVE_MOCK_FINISHED", annotations: [] }] }
    const response = { id, object: "response", status: "completed", model: body.model, output: [item], usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    const event = value => res.write(`data: ${JSON.stringify(value)}\n\n`)
    event({ type: "response.created", response: { ...response, status: "in_progress", output: [], usage: null } })
    event({ type: "response.output_item.added", output_index: 0, item: call ? { ...item, arguments: "", status: "in_progress" } : { ...item, content: [], status: "in_progress" } })
    if (call) {
      event({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: args })
      event({ type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: args })
    }
    else event({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "NATIVE_MOCK_FINISHED" })
    event({ type: "response.output_item.done", output_index: 0, item })
    event({ type: "response.completed", response })
    res.end()
  })
  await new Promise(resolve => mockServer.listen(0, "127.0.0.1", resolve))
  mockBase = `http://127.0.0.1:${mockServer.address().port}/v3`
}
const blockers = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function api(route, body) {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(route === "/api/run" ? 120000 : route === "/api/extensions" ? 90000 : 10000),
    ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) })
  const data = await response.json()
  if (!response.ok) throw new Error(`${route}: ${response.status} ${JSON.stringify(data)}`)
  return data
}
async function verifyMultiTurn(harness, model) {
  const firstMarker = `MULTITURN_FIRST_${harness}_${marker}`, secondMarker = `MULTITURN_SECOND_${harness}_${marker}`
  let previousCalls = [], sessionID, runID, run
  for (const [n, prompt] of [firstMarker, secondMarker, "Third local mock turn"].entries()) {
    const start = mockRequests.length
    await api("/api/run", { harness, model, prompt: prompt + ". Return the local mock answer. Do not call tools or modify files.", ...(n ? { continueSessionID: sessionID } : {}) })
    for (let attempt = 0; attempt < 240; attempt++) { run = await api("/api/last-run?harness=" + harness); if (!run.active) break; await delay(250) }
    assert.equal(run.active, false, `${harness} multi-turn fixture must finish`)
    if (harness === "codex") {
      assert(run.events.some(e => e.type === "codex.turn.completed") && !run.events.some(e => e.type === "codex.turn.failed"), "Native resume must complete")
      const launch = run.events.filter(e => e.type === "codex.proc.start").at(-1)
      assert.equal(launch.properties.args.includes("resume"), n > 0)
      if (n) assert(launch.properties.args.includes(sessionID) && !launch.properties.args.includes("--last"), "Resume must select the exact current thread")
    } else assert(!run.events.filter(e => e.type === "viz.prompt.returned").at(-1)?.properties.result?.info?.error, "Native message continuation must succeed")
    if (!n) { sessionID = run.sessionID; runID = run.runID }
    assert(sessionID)
    assert.equal(run.sessionID, sessionID)
    assert.equal(run.runID, runID)
    assert.equal(run.turnNumber, n + 1)
    assert.equal(run.events.filter(e => e.type === "viz.run").length, n + 1)
    assert.equal(run.preparation.status, "completed", "Preparation must finish on an explicit native receipt, not on a model answer")
    assert(run.preparation.endedAt && run.preparation.durationMs >= 0)
    assert.equal(run.preparation.output.sessionID, sessionID)
    const preparations = run.events.filter(e=>e.type==='viz.preparation')
    assert.equal(new Set(preparations.map(e=>e.properties.execution.id)).size, n + 1)
    if (harness === "opencode") {
      assert.equal(run.preparation.evidence.type, "message.part.updated")
      const receipt = run.events.find(e=>e.id === run.preparation.evidence.id)
      assert.equal(receipt.properties.part.messageID, run.preparation.output.messageID)
    } else assert.equal(run.preparation.evidence.type, "codex.turn.started")
    if (!n) await writeFile(path.join(output, harness + "-preparation-proof.json"), JSON.stringify(run.preparation, null, 2))
    const observed = (await api("/api/llm-calls")).calls.filter(c => c.harness === harness && c.runID === runID)
    for (const old of previousCalls) assert(observed.some(c => c.index === old.index && c.requestRaw === old.requestRaw), "Previous request bytes must remain available")
    assert.equal(new Set(observed.map(c => c.index)).size, observed.length)
    const wire = mockRequests.slice(start).find(m => m.body.model === model.split("/").slice(1).join("/"))
    assert(wire, "This turn must reach the local mock")
    if (n) {
      assert(wire.raw.includes(firstMarker), "Continued native request must contain the first user turn")
      assert(wire.raw.includes(harness === "opencode" ? "MOCK_EFFORT_FINISHED" : "NATIVE_MOCK_FINISHED"), "Continued native request must contain the previous assistant answer")
    }
    if (n === 2) assert(wire.raw.includes(secondMarker), "Third turn must contain both earlier user inputs")
    previousCalls = observed
  }
  await writeFile(path.join(output, harness + "-multiturn-events.json"), JSON.stringify(run, null, 2))
  await writeFile(path.join(output, harness + "-multiturn-calls.json"), JSON.stringify(previousCalls, null, 2))
  const start = mockRequests.length
  await api("/api/run", { harness, model, prompt: "Start a separate local mock conversation. Do not call tools or modify files." })
  for (let attempt = 0; attempt < 240; attempt++) { run = await api("/api/last-run?harness=" + harness); if (!run.active) break; await delay(250) }
  assert.equal(run.active, false)
  assert.notEqual(run.sessionID, sessionID)
  assert.notEqual(run.runID, runID)
  assert.equal(run.turnNumber, 1)
  const wire = mockRequests.slice(start).find(m => m.body.model === model.split("/").slice(1).join("/"))
  assert(wire && !wire.raw.includes(firstMarker) && !wire.raw.includes(secondMarker), "Default new conversation must not reuse the old dialogue")
  results.checks.push({ name: `${harness}: native three-turn continuation retains exact session, context and captured evidence; default starts fresh (local mock)`, passed: true })
}
async function stop() {
  if (!proc || proc.exitCode !== null) return
  proc.send("shutdown")
  await Promise.race([new Promise(resolve => proc.once("close", resolve)), delay(15000)])
  if (proc.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" })
    else proc.kill("SIGKILL")
    throw new Error("Server shutdown timed out; owned process tree was forcibly stopped")
  }
}
async function start(translated = false, defaultDemo = false, { env: extraEnv = {}, failedHarness } = {}) {
  const config = JSON.parse(await readFile(path.join(root, "config", "settings.json"), "utf8"))
  config.projectPath = defaultDemo ? "examples/demo" : target
  // Native configuration fixtures, not model settings in harness-viz.
  const nativeConfig = path.join(output, "native-config-home"), nativeCodex = path.join(output, "native-codex-home")
  if (smokeOnly) {
    await mkdir(path.join(nativeConfig, "opencode"), { recursive: true }); await mkdir(nativeCodex, { recursive: true })
    const nativeFixture = { $schema: "https://opencode.ai/config.json", model: "fixture/glm-5.3-flash", small_model: "fixture/glm-5.3-flash", enabled_providers: ["fixture", "fixture-chat"],
      provider: { fixture: { npm: "@ai-sdk/openai", options: { baseURL: mockBase ?? "http://127.0.0.1:1/v3", apiKey: "no-inference-fixture" }, models: { "glm-5.3-flash": { name: "GLM-5.3-Flash", limit: { context: 1024000, output: 65536 }, reasoning: true, tool_call: true } } } } }
    const demoK3 = JSON.parse(await readFile(path.join(root, "examples", "demo", "opencode.json"), "utf8")).provider["kimi-code-plan-cn"].models["k3-256k"]
    nativeFixture.provider["fixture-chat"] = { npm: "@ai-sdk/openai-compatible", options: { baseURL: mockBase, apiKey: "no-inference-fixture" },
      models: { "k3-256k": { ...demoK3, name: "K3 fixture", reasoning: true, tool_call: true, limit: { context: 262144, output: 32000 }, interleaved: { field: "reasoning_content" } } } }
    await writeFile(path.join(nativeConfig, "opencode", "opencode.json"), JSON.stringify(nativeFixture))
    await writeFile(path.join(nativeCodex, "models.json"), JSON.stringify({ models: [{ slug: "fixture-model", display_name: "Local reasoning fixture", description: "Local mock only",
      default_reasoning_level: "medium", supported_reasoning_levels: ["low", "medium", "high"].map(effort => ({ effort, description: "Local fixture " + effort })),
      shell_type: "shell_command", visibility: "list", supported_in_api: true, priority: 0, support_verbosity: false,
      truncation_policy: { mode: "tokens", limit: 10000 }, context_window: 262144, experimental_supported_tools: [],
      model_messages: { instructions_template: "You are a local verification fixture. Return the mock response. Do not call tools or change files." } }] }))
    await writeFile(path.join(nativeCodex, "config.toml"), `model="fixture-model"\nmodel_provider="fixture"\nmodel_reasoning_effort="medium"\nmodel_catalog_json="./models.json"\n[model_providers.fixture]\nname="Fixture"\nbase_url="${mockBase}"\nwire_api="responses"\nrequires_openai_auth=false\n`)
  }
  const configPath = path.join(output, translated ? "translated-config.json" : "native-config.json")
  await writeFile(configPath, JSON.stringify(config))
  const data = path.join(output, translated ? "translated" : "native")
  const env = { ...process.env, VIZ_CONFIG_PATH: configPath, VIZ_RUNTIME_DIR: data,
    VIZ_PORT: String(vizPort), ...extraEnv }
  if (smokeOnly) {
    env.XDG_CONFIG_HOME = nativeConfig; env.VIZ_CODEX_SOURCE_HOME = nativeCodex
    delete env.OPENCODE_CONFIG; delete env.OPENCODE_CONFIG_CONTENT; delete env.OPENCODE_CONFIG_DIR
  }
  for (const key of ["OC_PORT", "LLM_PORT"]) if (!(key in extraEnv)) delete env[key]
  delete env.VIZ_TARGET_PROJECT
  proc = spawn(process.execPath, [path.join(root, "src", "server.mjs")],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"] })
  proc.stdout.on("data", chunk => { log += chunk.toString() })
  proc.stderr.on("data", chunk => { log += chunk.toString() })
  let observed = false
  for (let n = 0; n < 1125; n++) {
    if (proc.exitCode !== null) throw new Error("Verification server exited before readiness; inspect server log")
    let status
    try { status = await api("/api/status") } catch {}
    if (status) {
      if (!observed) {
        (results.startupSnapshots ??= []).push(status)
        observed = true
        assert((await fetch(base + "/")).ok, "The webpage must be available while CLIs prepare")
      }
      if (failedHarness) {
        const other = failedHarness === "codex" ? "opencode" : "codex"
        if (status.cliStatus[failedHarness].phase === "error" && status.cliStatus[other].available) return status
      } else {
        for (const [h, state] of Object.entries(status.cliStatus)) if (state.phase === "error") throw new Error(`${h}: ${state.error}`)
        if (status.ocReady && status.cliStatus.opencode.available && status.cliStatus.codex.available) { await delay(600); return status }
      }
    }
    await delay(400)
  }
  throw new Error("Verification server readiness timeout")
}
async function run(harness, filename, reject = false) {
  const prompt = `Read evidence-input.txt using a tool. Then create ${filename} containing exactly the marker from that file followed by ;verified. Use the file editing tool. Do not modify any other file. Finally report the marker and what you changed.`
  await api("/api/run", { harness, prompt })
  const replied = new Set()
  let run
  for (let n = 0; n < 600; n++) {
    run = await api("/api/last-run?harness=" + harness)
    for (const event of run.events) {
      if (event.type !== "permission.asked" || replied.has(event.properties.id)) continue
      replied.add(event.properties.id)
      await api("/api/permission", { requestID: event.properties.id, reply: reject ? "reject" : "once" })
    }
    if (run.active === false) break
    await delay(500)
  }
  if (run.active) {
    await api("/api/abort", { harness, sessionID: run.sessionID })
    throw new Error(`${harness}: task timeout (300 seconds)`)
  }
  const calls = (await api("/api/llm-calls")).calls.filter(call => call.harness === harness)
  for (const call of calls) {
    assert.equal(typeof call.requestRaw, "string", "Original request text must be captured")
    assert.deepEqual(JSON.parse(call.requestRaw), call.request)
    if (call.anthropicRequest) assert.deepEqual(JSON.parse(call.upstreamRequestRaw), call.anthropicRequest)
  }
  await writeFile(path.join(output, `${harness}-${filename}-events.json`), JSON.stringify(run, null, 2))
  await writeFile(path.join(output, `${harness}-${filename}-calls.json`), JSON.stringify(calls, null, 2))
  if (reject) {
    assert(replied.size > 0, "A real permission request was required for rejection verification")
    await assert.rejects(access(path.join(target, filename)), { code: "ENOENT" })
  } else {
    if (harness === "codex") {
      assert(run.events.some(event => event.type === "codex.turn.completed"), "Successful turn lifecycle required")
      assert(!run.events.some(event => event.type === "codex.turn.failed"), "Turn must not fail after producing a file")
      const closed = run.events.find(event => event.type === "codex.proc.exit")
      assert(closed?.properties.code === 0 && !closed.properties.aborted, "Normal process exit required")
    } else {
      assert(replied.size > 0, "A real permission request was required for approval verification")
      assert(run.events.some(event => event.type === "session.status" && event.properties.status?.type === "idle"), "Canonical idle status required")
      const returned = run.events.find(event => event.type === "viz.prompt.returned")
      assert(returned && !returned.properties.result?.info?.error, "Prompt result must not contain terminal assistant error")
    }
    assert.equal((await readFile(path.join(target, filename), "utf8")).trim(), marker + ";verified")
    assert(calls.length > 0, "Client request capture must be present")
    const observedTool = run.events.some(event => harness === "codex"
      ? event.type.startsWith("codex.item.") && ["command_execution", "file_change", "mcp_tool_call"].includes(event.properties.item?.type)
      : event.properties.part?.type === "tool")
    assert(observedTool, "Native tool execution events must be present")
    assert(calls.some(call => JSON.stringify(call.request).includes(marker)), "A later request must include the tool-read marker")
    assert(calls.some(call => call.response?.text?.includes(marker)), "Captured response must include marker")
    const linkedFeedback = calls.some((call, index) => (call.response?.toolUses ?? []).some(tool => tool.callID && calls.slice(index + 1).some(later => {
      const request = later.request?.request ?? later.request
      const outputs = harness === "codex" ? (request.input ?? []).filter(item => item.type.endsWith("_call_output"))
        : (request.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "tool_result")
      return outputs.some(item => (item.call_id ?? item.tool_use_id) === tool.callID && JSON.stringify(item).includes(marker))
    })))
    assert(linkedFeedback, "Tool-read marker must be returned to a later request under the same call ID")
    // 模板预览：含工具结果回传的末次请求经固定模板渲染后仍须携带 marker。
    const preview = await api(`/api/template-preview?index=${calls.at(-1).index}&template=qwen38`)
    assert(preview.ok, "Template preview must render a captured request")
    assert(preview.text.includes(marker), "Rendered preview must keep the tool-read marker")
    if (harness === "codex" && calls.at(-1).modelInput?.format === "responses") assert.equal(preview.sourceFormat, "responses", "Preview must identify the captured input format")
    await writeFile(path.join(output, `${harness}-${filename}-preview-qwen38.txt`), preview.text)
  }
  return { harness, filename, rejected: reject, capturedCalls: calls.length, permissionsReplied: replied.size,
    sources: [...new Set(calls.map(call => call.source))], eventCount: run.events.length, configuration: run.configuration,
    terminalEvents: run.events.filter(event => ["codex.turn.completed", "codex.turn.failed", "codex.proc.exit", "session.error"].includes(event.type)).map(event => ({ type: event.type, properties: event.properties })) }
}
// 真实问答任务（不修改文件）：对捕获请求渲染三种固定模板并保存产物。
async function runArticleTask() {
  const prompt = "介绍 unrolling-the-codex-agent-loop 资料：用三点说明这篇 OpenAI 文章讲了什么。不要修改任何文件。"
  await api("/api/run", { harness: "opencode", prompt })
  let run
  for (let n = 0; n < 600; n++) {
    run = await api("/api/last-run?harness=opencode")
    if (run.active === false) break
    await delay(500)
  }
  if (run.active) {
    await api("/api/abort", { harness: "opencode", sessionID: run.sessionID })
    throw new Error("opencode: article task timeout (300 seconds)")
  }
  assert(run.events.some(event => event.type === "session.status" && event.properties.status?.type === "idle"), "Canonical idle status required")
  const calls = (await api("/api/llm-calls")).calls.filter(call => call.harness === "opencode")
  assert(calls.length > 0, "Client request capture must be present")
  const templates = (await api("/api/templates")).templates
    assert.deepEqual(templates.map(t => t.id), ["qwen38", "glm53", "glm53-flash", "kimi-k3"])
  const previews = {}
  for (const t of templates) {
    const result = await api(`/api/template-preview?index=${calls.at(-1).index}&template=${t.id}`)
    assert(result.ok)
    assert(result.text.includes("unrolling-the-codex-agent-loop"), "Rendered preview must contain the task prompt")
    assert.equal(result.sourceFormat, "anthropic")
    previews[t.id] = { chars: result.chars, revision: result.template.revision }
    await writeFile(path.join(output, `template-preview-${t.id}.txt`), result.text)
  }
  assert(previews.qwen38 && previews.glm53 && previews["kimi-k3"])
  return { harness: "opencode", task: "unrolling-the-codex-agent-loop 介绍", capturedCalls: calls.length, previews }
}
try {
  if (smokeOnly) {
    await startNativeMock()
    // Reproduce the reported default-port conflict in the application itself.
    // OpenCode --port 0 prefers 4096 before falling back to an OS-assigned port.
    for (const port of [45322, 45321, 4096]) {
      const blocker = createServer()
      try {
        await listenLocal(blocker, { port, fallback: false })
        blockers.push(blocker)
      } catch (err) {
        if (!["EADDRINUSE", "EACCES"].includes(err.code)) throw err
      }
    }
  }
  results.status = await start(false, smokeOnly)
  if (smokeOnly) {
    for (const h of ["codex", "opencode"]) {
      assert.equal(results.status.versions[h].replace(/^codex-cli\s+/, ""), sourceLock[h].version)
      assert.equal(results.status.cliStatus[h].available, true)
      assert.equal(results.status.cliStatus[h].directory, path.join(results.status.cliDirectory, h, sourceLock[h].version))
    }
    assert.equal(results.status.codexLauncher, path.join(results.status.cliDirectory, "codex", sourceLock.codex.version, "node_modules", "@openai", "codex", "bin", "codex.js"))
    const ocConfig = JSON.parse(await readFile(path.join(output, "native", "opencode-home", "config", "opencode.json"), "utf8"))
    assert.equal(ocConfig.autoupdate, false)
    if (results.status.extensions?.state.requested.enabled) {
      const discovered = await api("/api/extensions")
      await writeFile(path.join(output, "extension-discovery.json"), JSON.stringify(discovered, null, 2))
      assert.equal(discovered.state.phase, "ready")
      assert.equal(discovered.observed.harness, "opencode")
      assert.equal(discovered.observed.available, true)
      assert(Array.isArray(discovered.observed.skills), "OpenCode skills discovery failed: " + JSON.stringify(discovered.observed.skills))
      for (const name of ["frontend-design", "mcp-builder"]) assert(discovered.observed.skills.some(skill => skill.name === name), "OpenCode must discover " + name)
      assert.equal(discovered.observed.mcp.context7.status, "connected")
      assert(Array.isArray(discovered.observed.tools), "OpenCode tools discovery failed: " + JSON.stringify(discovered.observed.tools))
      assert(discovered.observed.tools.some(tool => tool.id === "compress"), "OpenCode must load DCP's compress tool")
      if (results.status.nativeModelConfiguration.tools.question) assert(discovered.observed.tools.some(tool => tool.id === "question"), "question must be registered")
      if (results.status.nativeModelConfiguration.tools.websearch) assert(discovered.observed.tools.some(tool => tool.id === "websearch"), "client websearch must be registered")
      const dcp = JSON.parse(await readFile(path.join(output, "native", "opencode-home", "config", "dcp.json"), "utf8"))
      assert.equal(dcp.autoUpdate, false)
      assert.equal(dcp.compress.permission, "ask")
      assert.equal(dcp.strategies.deduplication.enabled, false)
      assert.equal(dcp.strategies.purgeErrors.enabled, false)
      results.checks.push({ name: "OpenCode discovers pinned skills, connected Context7 MCP and DCP without model requests", passed: true })
    }
    for (const port of [results.status.ports.llm, results.status.ports.opencode]) assert(![45322, 45321, 4096].includes(port))
    assert.equal(ocConfig.provider, undefined, "Observer overlay must not configure providers")
    assert.equal(ocConfig.model, undefined, "Observer overlay must not configure a model")
    assert(blockers.every(blocker => blocker.listening), "Existing listeners must remain untouched")
    results.checks.push({ name: "Default internal port allocation survives occupied 45322/45321/4096; OpenCode uses the actual proxy address", passed: true })
    const template = await readFile(path.join(root, "examples", "demo", "README.md"), "utf8")
    assert.equal(await readFile(path.join(results.status.targetProject, "README.md"), "utf8"), template)
    assert.equal(results.status.targetProject, path.join(root, "examples", "demo"))
    const models = (await api("/api/models")).models
    assert.deepEqual(models.map(model => model.value).sort(), ["fixture-chat/k3-256k", "fixture/glm-5.3-flash"])
    assert.deepEqual(models.find(m => m.value === "fixture-chat/k3-256k").variants.sort(), ["high", "low", "max"])
    const nativeModels = await api("/api/models?harness=codex")
    assert(nativeModels.models.some(m => m.value === "fixture/fixture-model"), "Codex model must come from its native TOML")
    assert.deepEqual(nativeModels.models.find(m => m.value === "fixture/fixture-model").reasoningEfforts, ["low", "medium", "high"])
    for (const asset of ["/vendor/marked.js", "/vendor/purify.js", "/markdown.js", "/flows.js"]) {
      const response = await fetch(base + asset)
      assert(response.ok && response.headers.get("content-type").includes("javascript"), "Browser Markdown assets must be available locally")
      assert((await response.text()).length > 100)
    }
    results.checks.push({ name: "Startup, default demo directory and native model/variant directories (no model requests)", passed: true })
    await api("/api/run", { harness: "opencode", model: "fixture/glm-5.3-flash", prompt: "Local mock transport check: ask the user a question, then finish. Do not execute commands or modify files." })
    let question
    for (let n = 0; n < 120; n++) {
      question = (await api("/api/questions")).questions[0]
      if (question) break
      await delay(250)
    }
    assert(question, "Native question tool must ask through the real API")
    await api("/api/question", { requestID: question.id, action: "reply", answers: [["NATIVE_QUESTION_ANSWER"]] })
    for (let n = 0; n < 120; n++) { if (!(await api("/api/last-run?harness=opencode")).active) break; await delay(250) }
    const nativeCalls = (await api("/api/llm-calls")).calls
    await writeFile(path.join(output, "native-mock-calls.json"), JSON.stringify(nativeCalls, null, 2))
    assert(nativeCalls.some(c => c.protocol === "responses" && c.response?.toolUses?.some(t => t.callID === "mock-question-call")), "Native Responses must be captured without Anthropic translation")
    for (const call of nativeCalls) assert(mockRequests.some(m => m.raw === call.requestRaw), "Upstream body must equal captured native body")
    assert(mockRequests.some(m => m.body.input?.some(i => i.type === "function_call_output" && i.call_id === "mock-question-call" && JSON.stringify(i).includes("NATIVE_QUESTION_ANSWER"))), "Question answer must return under its actual call ID")
    assert(mockRequests.every(m => m.headers.observedProvider === null), "Observer-only transport headers must not leak upstream")
    results.checks.push({ name: "Native OpenCode Responses transport, exact body capture and question reply round-trip (local mock, no real model inference)", passed: true })
    const effortProof = []
    for (const variant of [null, "low", "high", "max"]) {
      await api("/api/run", { harness: "opencode", model: "fixture-chat/k3-256k", ...(variant ? { variant } : {}), prompt: "Local mock effort check. Return the mock answer; do not call tools or modify files." })
      let run
      for (let n = 0; n < 120; n++) { run = await api("/api/last-run?harness=opencode"); if (!run.active) break; await delay(250) }
      assert.equal(run.active, false, "The mock effort task must finish")
      assert.equal(run.configuration.variant, variant)
      const captured = (await api("/api/llm-calls")).calls.find(c => c.model === "k3-256k" && c.protocol === "chat" && c.runID === run.runID)
      assert(captured, "Actual native Chat request must be captured")
      assert.equal(captured.error, null)
      assert.equal(captured.response.text, "MOCK_EFFORT_FINISHED")
      assert(mockRequests.some(m => m.raw === captured.requestRaw), "The native SDK body must reach the mock unchanged")
      const expected = variant ?? "high"
      assert.equal(captured.request.reasoning_effort, expected, "Native model/variant options must become an explicit wire parameter")
      const preview = await api(`/api/template-preview?index=${captured.index}&template=kimi-k3`)
      assert(preview.text.includes(`thinking_effort=${expected}`), "Captured explicit effort must appear in the K3 offline preview")
      const fullPreview = await api(`/api/template-preview?index=${captured.index}&template=kimi-k3&mode=call`)
      assert(fullPreview.text.includes(`thinking_effort=${expected}`) && fullPreview.text.includes("MOCK_EFFORT_FINISHED"), "Full call preview must retain the effort and captured response")
      const stem = "effort-" + (variant ?? "native-high")
      await writeFile(path.join(output, stem + "-call.json"), JSON.stringify(captured, null, 2))
      await writeFile(path.join(output, stem + "-request.json"), captured.requestRaw)
      await writeFile(path.join(output, stem + "-preview.txt"), preview.text)
      await writeFile(path.join(output, stem + "-full-preview.txt"), fullPreview.text)
      effortProof.push({ variant: variant ?? "native-model-options", sentEffort: captured.request.reasoning_effort, previewExplicit: true })
    }
    assert(mockRequests.every(m => m.headers.observedProvider === null), "Observer-only headers must not leak on Chat requests either")
    await writeFile(path.join(output, "explicit-effort-proof.json"), JSON.stringify(effortProof, null, 2))
    results.checks.push({ name: "Native K3 explicit base high and low/high/max variants reach Chat HTTP bodies and K3 previews (local mock)", passed: true })
    const codexEffortProof = []
    for (const reasoningEffort of [null, "low", "high"]) {
      const firstRequest = mockRequests.length
      await api("/api/run", { harness: "codex", model: "fixture/fixture-model", ...(reasoningEffort ? { reasoningEffort } : {}), prompt: "Local mock reasoning effort check. Do not call tools or modify files." })
      let run
      for (let n = 0; n < 240; n++) { run = await api("/api/last-run?harness=codex"); if (!run.active) break; await delay(250) }
      assert.equal(run.active, false, "Native Codex mock task must finish")
      assert(run.events.some(e => e.type === "codex.turn.completed") && !run.events.some(e => e.type === "codex.turn.failed"), "Native Codex task must complete successfully")
      const expected = reasoningEffort ?? "medium"
      const wire = mockRequests.slice(firstRequest).find(m => m.body.model === "fixture-model")
      assert(wire, "The fixed Codex CLI must send to the local mock")
      assert.equal(wire.body.reasoning?.effort, expected)
      const launch = run.events.find(e => e.type === "codex.proc.start")
      assert.equal(launch.properties.args.includes(`model_reasoning_effort=${JSON.stringify(expected)}`), reasoningEffort !== null, "Default adds no command-line override")
      const stem = "codex-effort-" + (reasoningEffort ?? "native-medium")
      await writeFile(path.join(output, stem + "-wire-request.json"), wire.raw)
      await writeFile(path.join(output, stem + "-events.json"), JSON.stringify(run, null, 2))
      codexEffortProof.push({ selected: reasoningEffort ?? "native-model-options", sentEffort: wire.body.reasoning.effort })
    }
    await writeFile(path.join(output, "codex-effort-proof.json"), JSON.stringify(codexEffortProof, null, 2))
    results.checks.push({ name: "Native Codex catalog efforts and default/low/high selection reach Responses HTTP bodies via native config overrides (local mock)", passed: true })
    await verifyMultiTurn("opencode", "fixture-chat/k3-256k")
    await verifyMultiTurn("codex", "fixture/fixture-model")
    await stop()
    await delay(500)
    const globalDir = path.join(output, "newer-global-cli")
    await mkdir(globalDir)
    for (const h of ["codex", "opencode"]) await writeFile(path.join(globalDir, h + (process.platform === "win32" ? ".cmd" : "")),
      process.platform === "win32" ? `@echo ${h === "codex" ? "codex-cli " : ""}9.9.9\r\n` : `#!/bin/sh\necho '${h === "codex" ? "codex-cli " : ""}9.9.9'\n`, { mode: 0o755 })
    const custom = await start(true, false, { env: {
      LLM_PORT: "45322", OC_PORT: "45321",
      PATH: globalDir + path.delimiter + (process.env.PATH ?? process.env.Path ?? ""),
      CODEX_CLI_EXE: "nonexistent-global-newer-codex.exe", CODEX_CLI_JS: "nonexistent-global-newer-codex.js",
    } })
    assert.equal(custom.targetProject, target)
    assert.equal(custom.codexLauncher, results.status.codexLauncher)
    assert.equal(custom.cliStatus.opencode.executable, results.status.cliStatus.opencode.executable)
    assert.notEqual(custom.ports.llm, 45322)
    assert.notEqual(custom.ports.opencode, 45321)
    const codexConfig = await readFile(path.join(output, "translated", "codex-home", "config.toml"), "utf8")
    assert.equal(codexConfig, (await readFile(path.join(output, "native-codex-home", "config.toml"), "utf8")).replace('"./models.json"', JSON.stringify(path.join(output, "native-codex-home", "models.json"))), "Native Codex copy must preserve settings and resolve its catalog relative to the source")
    assert.equal(JSON.parse(await readFile(path.join(output, "translated", "opencode-home", "config", "opencode.json"), "utf8")).provider, undefined)
    results.checks.push({ name: "projectPath, cache reuse, global CLI independence and occupied explicit port fallback with correct Codex/OpenCode config", passed: true })
    await stop()
    await delay(500)
    // Keep a real, already-verified Codex cache; force OpenCode's fresh install
    // to a closed localhost registry. This exercises failure without a model call.
    const failureCache = path.join(output, "failure-cli")
    await mkdir(path.join(failureCache, "codex"), { recursive: true })
    await symlink(custom.cliStatus.codex.directory, path.join(failureCache, "codex", sourceLock.codex.version), process.platform === "win32" ? "junction" : "dir")
    const failed = await start(false, false, { failedHarness: "opencode", env: {
      VIZ_CLI_DIR: failureCache, npm_config_registry: "http://127.0.0.1:1", npm_config_fetch_retries: "0", npm_config_fetch_timeout: "2000",
    } })
    assert.equal(failed.cliStatus.codex.available, true)
    assert.equal(failed.cliStatus.opencode.available, false)
    assert((await fetch(base + "/")).ok)
    const unavailable = await fetch(base + "/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ harness: "opencode", prompt: "must not execute" }) })
    assert.equal(unavailable.status, 503)
    assert.equal((await api("/api/llm-calls")).calls.length, 0)
    assert.equal((await api("/api/last-run?harness=opencode")).events.length, 0)
    results.failureStatus = failed
    results.checks.push({ name: "Webpage survives a failed OpenCode install; Codex remains ready and unavailable tasks return 503", passed: true })
  } else {
  for (const [name, harness, filename, reject] of [
    ["native Codex context and file modification", "codex", "codex-proof.txt", false],
    ["OpenCode context, file modification and approval", "opencode", "opencode-proof.txt", false],
    ["OpenCode permission rejection", "opencode", "rejected-proof.txt", true],
  ]) {
    try { results.checks.push({ name, passed: true, ...await run(harness, filename, reject) }) }
    catch (err) { results.checks.push({ name, passed: false, error: err.message }) }
  }
  try { results.checks.push({ name: "Template preview on a real OpenCode Q&A task", passed: true, ...await runArticleTask() }) }
  catch (err) { results.checks.push({ name: "Template preview on a real OpenCode Q&A task", passed: false, error: err.message }) }
  await stop()
  await delay(500)
  }
} catch (err) {
  results.checks.push({ name: "Verification stopped", passed: false, error: err.message })
  throw err
} finally {
  await stop()
  await Promise.all(blockers.map(blocker => new Promise(resolve => blocker.close(resolve))))
  if (mockServer) { mockServer.closeAllConnections(); await new Promise(resolve => mockServer.close(resolve)) }
  await writeFile(path.join(output, "server.log"), log)
  if (smokeOnly) await writeFile(path.join(output, "mock-upstream-requests.json"), JSON.stringify(mockRequests, null, 2))
  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ output, checks: results.checks.map(({ name, passed, error, capturedCalls, permissionsReplied, sources }) => ({ name, passed, error, capturedCalls, permissionsReplied, sources })) }, null, 2))
  if (results.checks.some(check => check.passed === false)) process.exitCode = 1
}
