import path from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { readFile, writeFile, mkdir, mkdtemp, rm, rename, access, cp } from "node:fs/promises"
import { acquireLock, resolveNpmLauncher, runCli } from "./cli.mjs"

export const EXTENSION_LOCK = JSON.parse(await readFile(new URL("./extensions-lock.json", import.meta.url), "utf8"))
export const DCP_CONFIG = {
  enabled: true, autoUpdate: false, debug: false, pruneNotification: "detailed", pruneNotificationType: "chat",
  manualMode: { enabled: false, automaticStrategies: false },
  experimental: { allowSubAgents: false, customPrompts: false },
  compress: { permission: "ask", showCompression: true, protectUserMessages: true,
    minContextLimit: "100%", maxContextLimit: "100%", iterationNudgeThreshold: 1000000, nudgeFrequency: 1000000 },
  strategies: { deduplication: { enabled: false }, purgeErrors: { enabled: false } },
}

export function extensionSelection(config, lock = EXTENSION_LOCK) {
  if (config?.enabled !== undefined && typeof config.enabled !== "boolean") throw new Error("extensions.enabled 必须是布尔值")
  if (!config?.enabled) return { enabled: false, skills: [], mcp: [], opencodePlugins: [] }
  const pick = (key, registry) => {
    const values = config[key] ?? Object.keys(registry)
    if (!Array.isArray(values) || values.some(name => !Object.hasOwn(registry, name))) throw new Error(`extensions.${key} 包含未知扩展`)
    return [...new Set(values)].sort()
  }
  return { enabled: true, skills: pick("skills", lock.skills), mcp: pick("mcp", lock.mcp), opencodePlugins: pick("opencodePlugins", lock.plugins) }
}

export function gitBlobHash(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
}

function requestedPackages(selection, lock) {
  const packages = {}
  for (const name of selection.mcp) {
    const item = lock.mcp[name]
    packages[item.package] = item.version
  }
  for (const name of selection.opencodePlugins) {
    const item = lock.plugins[name]
    packages[item.package] = item.version
    Object.assign(packages, item.dependencies)
  }
  return packages
}

export async function prepareExtensions({ config, cacheRoot, env = process.env, run = runCli, fetchImpl = fetch,
  onState = () => {}, onProcess, lock = EXTENSION_LOCK } = {}) {
  const selection = extensionSelection(config, lock)
  if (!selection.enabled) return { selection, directory: null, skills: [], mcp: [], plugins: [] }
  const profile = createHash("sha256").update(JSON.stringify({ selection, lock })).digest("hex").slice(0, 16)
  const directory = path.join(cacheRoot, profile), packages = requestedPackages(selection, lock)
  async function validate(root) {
    for (const name of selection.skills) for (const [file, hash] of Object.entries(lock.skills[name].files)) {
      if (gitBlobHash(await readFile(path.join(root, "skills", name, file))) !== hash) throw new Error(`${name}/${file} 内容与来源锁不符`)
    }
    for (const [name, version] of Object.entries(packages)) {
      const metadata = JSON.parse(await readFile(path.join(root, "node_modules", name, "package.json"), "utf8"))
      if (metadata.name !== name || metadata.version !== version) throw new Error(`${name} 扩展版本不符`)
    }
    for (const item of [...selection.mcp.map(name => lock.mcp[name]), ...selection.opencodePlugins.map(name => lock.plugins[name])])
      await access(path.join(root, "node_modules", item.package, item.entry))
  }
  onState({ phase: "checking", message: "核验技能、MCP 与插件专用缓存…" })
  let valid = false
  try { await validate(directory); valid = true } catch {}
  if (!valid) {
    await mkdir(cacheRoot, { recursive: true })
    const installLock = path.join(cacheRoot, `${profile}.install.lock`)
    await acquireLock(installLock, onState)
    let staging
    try {
      try { await validate(directory); valid = true } catch {}
      if (!valid) {
        staging = await mkdtemp(path.join(cacheRoot, `${profile}.install-`))
        await writeFile(path.join(staging, "package.json"), JSON.stringify({ name: "harness-viz-prompt-extensions", private: true }))
        onState({ phase: "installing", message: "下载固定来源技能并安装少量扩展…" })
        for (const name of selection.skills) for (const [file, hash] of Object.entries(lock.skills[name].files)) {
          const item = lock.skills[name]
          const response = await fetchImpl(`https://raw.githubusercontent.com/${item.repository}/${item.revision}/skills/${name}/${file}`, { signal: AbortSignal.timeout(30000) })
          if (!response.ok) throw new Error(`技能下载 HTTP ${response.status}: ${name}/${file}`)
          const bytes = Buffer.from(await response.arrayBuffer())
          if (bytes.length > 1024 * 1024 || gitBlobHash(bytes) !== hash) throw new Error(`技能校验失败: ${name}/${file}`)
          const target = path.join(staging, "skills", name, file)
          await mkdir(path.dirname(target), { recursive: true })
          await writeFile(target, bytes)
        }
        if (Object.keys(packages).length) {
          const npm = await resolveNpmLauncher({ env })
          await run(npm.command, [...npm.prefix, "install", "--global=false", "--prefix", staging, "--save-exact", "--include=optional",
            "--no-audit", "--no-fund", "--loglevel=error", ...Object.entries(packages).map(([name, version]) => `${name}@${version}`)],
          { cwd: staging, env, timeout: 300000, maxBuffer: 16 * 1024 * 1024, onProcess })
        }
        await validate(staging)
        await rm(directory, { recursive: true, force: true })
        await rename(staging, directory)
        staging = null
      }
    } catch (err) {
      throw new Error(`扩展准备失败：${String(err.stderr?.trim() || err.message).slice(-2000)}`, { cause: err })
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true })
      await rm(installLock, { force: true })
    }
  }
  const skills = selection.skills.map(name => ({ name, ...lock.skills[name],
    directory: path.join(directory, "skills", name), location: path.join(directory, "skills", name, "SKILL.md"), harnesses: ["opencode", "codex"] }))
  const mcp = selection.mcp.map(name => ({ name, ...lock.mcp[name], command: process.execPath,
    args: [path.join(directory, "node_modules", lock.mcp[name].package, lock.mcp[name].entry)], harnesses: ["opencode", "codex"] }))
  const plugins = selection.opencodePlugins.map(name => ({ name, ...lock.plugins[name],
    location: pathToFileURL(path.join(directory, "node_modules", lock.plugins[name].package, lock.plugins[name].entry)).href,
    harnesses: ["opencode"] }))
  onState({ phase: "ready", message: "固定来源扩展已安装并核验" })
  return { selection, profile, directory, skills, mcp, plugins }
}

export function opencodeExtensions(bundle) {
  return { skills: { paths: bundle.skills.map(item => item.directory) },
    mcp: Object.fromEntries(bundle.mcp.map(item => [item.name, { type: "local", command: [item.command, ...item.args], enabled: true, timeout: 30000 }])),
    plugin: bundle.plugins.map(item => item.location) }
}

export function codexExtensions(bundle) {
  return bundle.mcp.map(item => `\n[mcp_servers.${item.name}]\ncommand = ${JSON.stringify(item.command)}\nargs = ${JSON.stringify(item.args)}\nenabled = true\nstartup_timeout_sec = 30\ntool_timeout_sec = 60\n${item.name === "context7" ? 'env_vars = ["CONTEXT7_API_KEY"]\n' : ""}`).join("")
}

export async function installCodexSkills(bundle, home) {
  for (const name of Object.keys(EXTENSION_LOCK.skills)) {
    const target = path.join(home, "skills", name), marker = path.join(target, ".harness-viz-source.json")
    let existing = false
    try { await access(target); existing = true } catch {}
    if (existing) {
      try { await readFile(marker) } catch { throw new Error(`专用 Codex 技能目录已有非托管内容：${target}`) }
      await rm(target, { recursive: true, force: true })
    }
    const skill = bundle.skills.find(item => item.name === name)
    if (!skill) continue
    await mkdir(path.dirname(target), { recursive: true })
    await cp(skill.directory, target, { recursive: true })
    await writeFile(marker, JSON.stringify({ repository: skill.repository, revision: skill.revision }))
  }
}

export function extensionInventory(bundle, harness, codexHome) {
  return { profile: bundle.profile ?? null, skills: bundle.skills.filter(item => item.harnesses.includes(harness)).map(({ name, repository, revision, location }) =>
    ({ name, repository, revision, location: harness === "codex" && codexHome ? path.join(codexHome, "skills", name, "SKILL.md") : location })),
    mcp: bundle.mcp.filter(item => item.harnesses.includes(harness)).map(({ name, package: pkg, version }) => ({ name, package: pkg, version })),
    plugins: bundle.plugins.filter(item => item.harnesses.includes(harness)).map(({ name, package: pkg, version, repository }) => ({ name, package: pkg, version, repository })) }
}
