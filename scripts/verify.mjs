// Opt-in integration verification. Real model calls; only disposable fixtures are edited.
import { spawn, spawnSync } from "node:child_process"
import { readFile, writeFile, mkdir, access } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const smokeOnly = process.argv.includes("--smoke")
const output = path.join(root, ".runtime", "verification", new Date().toISOString().replace(/[:.]/g, "-"))
await mkdir(output, { recursive: true })
const target = path.join(output, "project")
await mkdir(target, { recursive: true })
const marker = "HARNESS_EVIDENCE_" + Date.now()
await writeFile(path.join(target, "evidence-input.txt"), marker + "\n")
await writeFile(path.join(target, "AGENTS.md"), "Use only files in this fixture directory. Never access credentials or user directories.\n")
const base = "http://127.0.0.1:4597"
const results = { checkedAt: new Date().toISOString(), marker, target, checks: [] }
let proc, log = ""
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function api(route, body) {
  const response = await fetch(base + route, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(`${route}: ${response.status} ${JSON.stringify(data)}`)
  return data
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
async function start(translated = false, defaultDemo = false) {
  const config = JSON.parse(await readFile(path.join(root, "config", "settings.json"), "utf8"))
  config.projectPath = defaultDemo ? "examples/demo" : target
  config.codex = { useDefaultModel: !translated, model: translated ? "MiniMax-M3.1-Flash-Preview" : "gpt-6.1-sol" }
  const configPath = path.join(output, translated ? "translated-config.json" : "native-config.json")
  await writeFile(configPath, JSON.stringify(config))
  const data = path.join(output, translated ? "translated" : "native")
  const env = { ...process.env, VIZ_CONFIG_PATH: configPath, VIZ_RUNTIME_DIR: data,
    VIZ_PORT: "4597", OC_PORT: "45341", LLM_PORT: "45342" }
  delete env.VIZ_TARGET_PROJECT
  proc = spawn(process.execPath, [path.join(root, "src", "server.mjs")],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"] })
  proc.stdout.on("data", chunk => { log += chunk.toString() })
  proc.stderr.on("data", chunk => { log += chunk.toString() })
  for (let n = 0; n < 225; n++) {
    if (proc.exitCode !== null) throw new Error("Verification server exited before readiness; inspect server log")
    try {
      const status = await api("/api/status")
      if (status.ocReady) { await delay(600); return status }
    } catch {}
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
  }
  return { harness, filename, rejected: reject, capturedCalls: calls.length, permissionsReplied: replied.size,
    sources: [...new Set(calls.map(call => call.source))], eventCount: run.events.length, configuration: run.configuration,
    terminalEvents: run.events.filter(event => ["codex.turn.completed", "codex.turn.failed", "codex.proc.exit", "session.error"].includes(event.type)).map(event => ({ type: event.type, properties: event.properties })) }
}
try {
  results.status = await start(false, smokeOnly)
  if (smokeOnly) {
    const template = await readFile(path.join(root, "examples", "demo", "README.md"), "utf8")
    assert.equal(await readFile(path.join(results.status.targetProject, "README.md"), "utf8"), template)
    assert.equal(results.status.targetProject, path.join(root, "examples", "demo"))
    const models = (await api("/api/models")).models
    assert.deepEqual(models.map(model => model.value), ["minimax/MiniMax-M3.1-Flash-Preview"])
    for (const asset of ["/vendor/marked.js", "/vendor/purify.js", "/markdown.js"]) {
      const response = await fetch(base + asset)
      assert(response.ok && response.headers.get("content-type").includes("javascript"), "Browser Markdown assets must be available locally")
      assert((await response.text()).length > 100)
    }
    results.checks.push({ name: "Startup, default demo directory and single-model registry (no model requests)", passed: true })
    await stop()
    await delay(500)
    const custom = await start()
    assert.equal(custom.targetProject, target)
    results.checks.push({ name: "projectPath setting selects the requested directory", passed: true })
  } else {
  for (const [name, harness, filename, reject] of [
    ["native Codex context and file modification", "codex", "codex-proof.txt", false],
    ["OpenCode context, file modification and approval", "opencode", "opencode-proof.txt", false],
    ["OpenCode permission rejection", "opencode", "rejected-proof.txt", true],
  ]) {
    try { results.checks.push({ name, passed: true, ...await run(harness, filename, reject) }) }
    catch (err) { results.checks.push({ name, passed: false, error: err.message }) }
  }
  await stop()
  await delay(500)
  if (process.env.MINIMAX_API_KEY) {
    try {
      await start(true)
      results.checks.push({ name: "third-party Codex translation", passed: true, ...await run("codex", "translated-proof.txt") })
    } catch (err) { results.checks.push({ name: "third-party Codex translation", passed: false, error: err.message }) }
  } else results.checks.push({ name: "third-party Codex translation", skipped: "MINIMAX_API_KEY not present" })
  }
} finally {
  await stop()
  await writeFile(path.join(output, "server.log"), log)
  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ output, checks: results.checks.map(({ name, passed, error, capturedCalls, permissionsReplied, sources }) => ({ name, passed, error, capturedCalls, permissionsReplied, sources })) }, null, 2))
  if (results.checks.some(check => check.passed === false)) process.exitCode = 1
}
