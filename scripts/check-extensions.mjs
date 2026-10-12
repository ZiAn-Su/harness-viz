// Read-only discovery checks; never submit a turn or invoke a model.
import { spawn, spawnSync } from "node:child_process"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import assert from "node:assert/strict"
import { prepareExtensions, installCodexSkills } from "../src/extensions.mjs"
import { preparePinnedCli } from "../src/cli.mjs"
import { copyNativeCodexHome } from "../src/native-models.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const config = JSON.parse(await readFile(path.join(root, "config", "settings.json"), "utf8"))
const lock = JSON.parse(await readFile(path.join(root, "src", "versions.json"), "utf8"))
const output = path.join(root, ".runtime", "verification", new Date().toISOString().replace(/[:.]/g, "-") + "-extensions")
await mkdir(output, { recursive: true })
const bundle = await prepareExtensions({ config: config.extensions, cacheRoot: path.join(root, ".runtime", "extensions"), onState: state => console.log(state.message) })

function rpc(command, args, env) {
  const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
  const pending = new Map()
  let sequence = 0, buffer = "", diagnostics = ""
  const fail = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }; pending.clear() }
  child.on("error", fail)
  child.on("exit", code => fail(new Error(`Discovery process exited: ${code}; ${diagnostics.slice(-1000)}`)))
  child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4000) })
  const decoder = new TextDecoder()
  const send = object => child.stdin.write(JSON.stringify(object) + "\n")
  child.stdout.on("data", chunk => {
    buffer += decoder.decode(chunk, { stream: true })
    let position
    while ((position = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, position); buffer = buffer.slice(position + 1)
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (pending.has(message.id)) {
        const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer)
        message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result)
      } else if (message.id != null && message.method) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Verification does not provide model inference" } })
      }
    }
  })
  return {
    notify(method, params = {}) { send({ jsonrpc: "2.0", method, params }) },
    request(method, params) {
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Discovery timed out: ${method}; ${diagnostics.slice(-1000)}`)) }, 60000)
        pending.set(id, { resolve, reject, timer }); send({ jsonrpc: "2.0", id, method, params })
      })
    },
    close() {
      fail(new Error("Discovery finished"))
      if (child.pid && child.exitCode === null) {
        if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
        else child.kill()
      }
    },
  }
}

const results = { checkedAt: new Date().toISOString(), output, modelCalls: 0, checks: [] }
for (const server of bundle.mcp) {
  const client = rpc(server.command, server.args, process.env)
  try {
    const initialized = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "harness-viz-discovery", version: "0.1.0" } })
    client.notify("notifications/initialized")
    const listed = await client.request("tools/list", {})
    const names = listed.tools.map(tool => tool.name).sort()
    assert.deepEqual(names, ["query-docs", "resolve-library-id"])
    await writeFile(path.join(output, `${server.name}-discovery.json`), JSON.stringify({ initialized, tools: listed.tools }, null, 2))
    results.checks.push({ name: `${server.name} MCP initialize/tools.list`, passed: true, tools: names, instructions: initialized.instructions ?? null })
  } finally { client.close() }
}

const home = path.join(output, "codex-home")
await mkdir(home)
await copyNativeCodexHome(home)
await installCodexSkills(bundle, home)
const launcher = await preparePinnedCli({ harness: "codex", version: lock.codex.version, cacheRoot: path.join(root, ".runtime", "cli") })
const codex = rpc(launcher.command, [...launcher.prefix, "app-server"], { ...process.env, CODEX_HOME: home })
try {
  await codex.request("initialize", { clientInfo: { name: "harness-viz-discovery", title: "Read-only skills check", version: "0.1.0" }, capabilities: { experimentalApi: true } })
  codex.notify("initialized")
  const listed = await codex.request("skills/list", { cwds: [path.resolve(root, config.projectPath)], forceReload: true })
  const skills = listed.data.flatMap(item => item.skills)
  for (const skill of bundle.skills) assert(skills.some(item => item.name === skill.name && item.enabled !== false), `Codex must discover ${skill.name}`)
  await writeFile(path.join(output, "codex-skills-discovery.json"), JSON.stringify(listed, null, 2))
  results.checks.push({ name: "Codex native skills.list discovers installed skills", passed: true,
    selected: bundle.skills.map(skill => skill.name), builtin: skills.filter(skill => skill.scope === "system").map(skill => skill.name) })
} finally { codex.close() }
await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
