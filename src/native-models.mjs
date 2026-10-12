import path from "node:path"
import os from "node:os"
import { spawn, spawnSync } from "node:child_process"
import { mkdir, readFile, writeFile, readdir, cp, rm } from "node:fs/promises"
import { runCli } from "./cli.mjs"

export function stdioRpc(command, args, { cwd, env, onProcess } = {}) {
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
  onProcess?.(child)
  const pending = new Map(), decoder = new TextDecoder()
  let sequence = 0, buffer = ""
  const fail = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }; pending.clear() }
  child.on("error", () => fail(new Error("无法启动原生配置发现进程")))
  child.on("exit", code => fail(new Error(`原生配置发现进程退出: ${code}`)))
  child.stderr.on("data", () => {}) // Native diagnostics can contain user configuration; do not log them.
  const send = value => child.stdin.write(JSON.stringify(value) + "\n")
  child.stdout.on("data", chunk => {
    buffer += decoder.decode(chunk, { stream: true })
    let n
    while ((n = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, n); buffer = buffer.slice(n + 1)
      let message
      try { message = JSON.parse(line) } catch { continue }
      const item = pending.get(message.id)
      if (item) {
        pending.delete(message.id); clearTimeout(item.timer)
        message.error ? item.reject(new Error(`原生发现 ${item.method} 失败（code ${message.error.code}）`)) : item.resolve(message.result)
      } else if (message.id != null && message.method) send({ id: message.id, error: { code: -32601, message: "Discovery does not perform inference" } })
    }
  })
  return {
    notify(method, params = {}) { send({ method, params }) },
    request(method, params = {}) {
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`原生发现超时: ${method}`)) }, 60000)
        pending.set(id, { method, resolve, reject, timer }); send({ id, method, params })
      })
    },
    close() {
      fail(new Error("Discovery closed"))
      if (child.pid && child.exitCode === null) {
        if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
        else child.kill()
      }
    },
  }
}

export async function copyNativeCodexHome(home, source = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")) {
  await mkdir(home, { recursive: true })
  for (const name of ["config.toml", "auth.json"]) {
    try { const bytes = await readFile(path.join(source, name)); await writeFile(path.join(home, name), name === "config.toml" ? nativeConfigSnapshot(bytes.toString("utf8"), source) : bytes) }
    catch (err) { if (err.code !== "ENOENT") throw err; if (name === "config.toml") await writeFile(path.join(home, name), ""); else await rm(path.join(home, name), { force: true }) }
  }
  let entries = []
  try { entries = await readdir(source, { withFileTypes: true }) } catch (err) { if (err.code !== "ENOENT") throw err }
  for (const item of entries) if (item.isFile() && item.name.endsWith(".config.toml")) await writeFile(path.join(home, item.name), nativeConfigSnapshot(await readFile(path.join(source, item.name), "utf8"), source))
  for (const name of ["agents", "rules"]) {
    try { await cp(path.join(source, name), path.join(home, name), { recursive: true }) } catch (err) { if (err.code !== "ENOENT") throw err }
  }
  return { sourceHome: source, configFile: path.join(source, "config.toml") }
}

export function nativeConfigSnapshot(text, sourceDirectory) {
  // Native path-valued options are resolved against their source, not the private snapshot.
  return text.replace(/^(\s*(?:model_catalog_json|config_file|instructions_file|log_dir|sqlite_home)\s*=\s*)("(?:\\.|[^"\\])*"|'[^']*')/gm, (match, prefix, literal) => {
    let value
    try { value = literal[0] === "'" ? literal.slice(1, -1) : JSON.parse(literal) } catch { return match }
    if (!value || path.isAbsolute(value) || value.startsWith("~")) return match
    return prefix + JSON.stringify(path.resolve(sourceDirectory, value))
  })
}

export async function discoverCodexModels(launcher, home, cwd, onProcess) {
  const client = stdioRpc(launcher.command, [...launcher.prefix, "app-server"], { cwd, env: { ...process.env, CODEX_HOME: home }, onProcess })
  try {
    await client.request("initialize", { clientInfo: { name: "harness-viz", title: "Native model discovery", version: "0.1.0" }, capabilities: { experimentalApi: true } })
    client.notify("initialized")
    const { config } = await client.request("config/read", { includeLayers: false, cwd })
    const listedModels = []
    try {
      let cursor = null
      do {
        const listed = await client.request("model/list", { limit: 100, includeHidden: false, cursor })
        listedModels.push(...(listed.data ?? []))
        cursor = listed.nextCursor ?? null
      } while (cursor && listedModels.length < 1000)
    } catch (err) { if ((config.model_provider ?? "openai") === "openai") throw err }
    return codexModelCatalog(config, listedModels)
  } finally { client.close() }
}

export function codexModelCatalog(config, listedModels) {
  const provider = config.model_provider ?? "openai", models = []
  const add = (model, providerID, profile, label, isDefault = false) => {
    if (typeof model !== "string" || !model) return
    const value = profile ? `profile:${profile}` : `${providerID}/${model}`
    if (models.some(item => item.value === value)) return
    const native = providerID === provider ? listedModels.find(item => item.model === model) : null
    const reasoningEfforts = [...new Set((native?.supportedReasoningEfforts ?? []).map(item => item.reasoningEffort).filter(effort => typeof effort === "string" && effort))]
    const configuredEffort = (profile ? config.profiles?.[profile]?.model_reasoning_effort : null) ?? config.model_reasoning_effort ?? native?.defaultReasoningEffort
    models.push({ value, model, providerID, profile: profile ?? null, label: label ?? `${providerID} / ${model}`, isDefault,
      reasoningEfforts, defaultReasoningEffort: reasoningEfforts.includes(configuredEffort) ? configuredEffort : null })
  }
  if (config.model) add(config.model, provider, null, null, true)
  for (const [name, item] of Object.entries(config.profiles ?? {})) if (item.model ?? config.model) add(item.model ?? config.model, item.model_provider ?? provider, name, `${name} · ${item.model ?? config.model}`)
  if (provider === "openai") for (const item of listedModels) add(item.model, provider, null, `OpenAI / ${item.displayName ?? item.model}`, !config.model && item.isDefault)
  return { models, defaultModel: models.find(m => m.isDefault)?.value ?? models[0]?.value ?? null,
    provider, nativeMcpNames: Object.keys(config.mcp_servers ?? {}), approvalPolicy: config.approval_policy ?? null, sandbox: config.sandbox_mode ?? null }
}

export async function nativeOpenCodePaths(launcher, cwd) {
  const result = await runCli(launcher.command, [...launcher.prefix, "debug", "paths"], { cwd, env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" }, timeout: 30000 })
  return Object.fromEntries(result.stdout.split(/\r?\n/).flatMap(line => { const m = /^(home|data|config|cache|state)\s+(.+)$/.exec(line); return m ? [[m[1], m[2].trim()]] : [] }))
}

export async function nativeOpenCodeProviderIDs(launcher, cwd, env) {
  const result = await runCli(launcher.command, [...launcher.prefix, "models"], { cwd, env, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
  return [...new Set(result.stdout.split(/\r?\n/).flatMap(line => /^[^\s/]+\/\S+$/.test(line.trim()) ? [line.trim().split("/")[0]] : []))]
}

export function opencodeModelCatalog(providers, configuredDefault) {
  const models = providers.flatMap(provider => Object.values(provider.models ?? {}).map(model => ({ value: `${provider.id}/${model.id}`,
    providerID: provider.id, model: model.id, label: `${provider.name ?? provider.id} / ${model.name ?? model.id}`,
    variants: Object.keys(model.variants ?? {}).filter(name => model.variants[name]?.disabled !== true),
    capture: ["@ai-sdk/anthropic", "@ai-sdk/openai", "@ai-sdk/openai-compatible"].includes(model.api?.npm) ? "http-proxy" : "native-events-only" })))
  return { models, defaultModel: models.some(m => m.value === configuredDefault) ? configuredDefault : models[0]?.value ?? null }
}
