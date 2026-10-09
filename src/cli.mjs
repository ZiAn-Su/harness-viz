import path from "node:path"
import { access, readFile, writeFile, mkdir, mkdtemp, rename, rm, open, stat } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execute = promisify(execFile)
const PACKAGES = { opencode: "opencode-ai", codex: "@openai/codex" }
const INSTALL_TIMEOUT = 300_000

async function exists(file) {
  try { await access(file); return true } catch { return false }
}

export function runCli(command, args, { onProcess, ...options } = {}) {
  const pending = execute(command, args, { windowsHide: true, ...options })
  onProcess?.(pending.child)
  return pending
}

// Run npm's JS entry directly: Windows .cmd shims require a shell, which would
// also reinterpret paths containing spaces or shell metacharacters.
export async function resolveNpmLauncher({ env = process.env, platform = process.platform,
  execPath = process.execPath, fileExists = exists } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix
  const directories = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":")
    .filter(Boolean).map(dir => dir.replace(/^"|"$/g, ""))
  const candidates = [env.npm_execpath, ...[paths.dirname(execPath), ...directories].flatMap(dir => [
    paths.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
    paths.resolve(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    paths.resolve(dir, "..", "share", "nodejs", "npm", "bin", "npm-cli.js"),
  ])]
  for (const entry of candidates) {
    if (entry && await fileExists(entry)) return { command: execPath, prefix: [entry] }
  }
  throw new Error("未找到 npm 安装器。请安装包含 npm 的 Node.js 22+，然后重新运行 npm start。")
}

function launcherFor(harness, directory, execPath) {
  const root = path.join(directory, "node_modules", PACKAGES[harness])
  // The official OpenCode postinstall uses this filename on every platform.
  return harness === "opencode"
    ? { command: path.join(root, "bin", "opencode.exe"), prefix: [] }
    : { command: execPath, prefix: [path.join(root, "bin", "codex.js")] }
}

async function validate(harness, directory, version, execPath, run, env, onProcess) {
  const metadata = JSON.parse(await readFile(path.join(directory, "node_modules", PACKAGES[harness], "package.json"), "utf8"))
  if (metadata.name !== PACKAGES[harness] || metadata.version !== version) throw new Error("缓存包版本不符")
  const launcher = launcherFor(harness, directory, execPath)
  const result = await run(launcher.command, [...launcher.prefix, "--version"], {
    env: { ...env, OPENCODE_DISABLE_AUTOUPDATE: "1" }, timeout: 30_000, onProcess,
  })
  const actual = result.stdout.trim()
  if (actual.replace(/^codex-cli\s+/, "") !== version) throw new Error(`CLI ${actual || "未知版本"} 与固定版本 ${version} 不符`)
  return { ...launcher, version: actual, directory }
}

// Serialize installers across server processes. Dead owners are recoverable;
// an interrupted download never becomes a usable cache (publication is atomic).
async function acquireLock(file, onState) {
  const deadline = Date.now() + INSTALL_TIMEOUT + 60_000
  for (;;) {
    try {
      const handle = await open(file, "wx")
      try { await handle.writeFile(JSON.stringify({ pid: process.pid })) } finally { await handle.close() }
      return
    } catch (err) {
      if (err.code !== "EEXIST") throw err
    }
    let stale = false
    try {
      const { pid } = JSON.parse(await readFile(file, "utf8"))
      try { process.kill(pid, 0) } catch (err) { stale = err.code === "ESRCH" }
    } catch (err) {
      if (err.code === "ENOENT") continue
      // Allow the owner time to write a newly acquired lock.
      try { stale = Date.now() - (await stat(file)).mtimeMs > 30_000 } catch { continue }
    }
    if (stale) { await rm(file, { force: true }); continue }
    if (Date.now() >= deadline) throw new Error("等待另一进程安装 CLI 超时；请停止该进程后重试。")
    onState({ phase: "waiting", message: "等待另一进程准备固定 CLI…" })
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

export async function preparePinnedCli({ harness, version, cacheRoot, env = process.env,
  execPath = process.execPath, run = runCli, onState = () => {}, onProcess } = {}) {
  if (!PACKAGES[harness] || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("无效的固定 CLI 版本")
  const parent = path.join(cacheRoot, harness)
  const directory = path.join(parent, version)
  const check = dir => validate(harness, dir, version, execPath, run, env, onProcess)
  onState({ phase: "checking", message: `核验 ${harness} ${version} 缓存…` })
  try { return await check(directory) } catch {}
  await mkdir(parent, { recursive: true })
  const lock = path.join(parent, `${version}.install.lock`)
  await acquireLock(lock, onState)
  let staging
  try {
    try { return await check(directory) } catch {}
    const npm = await resolveNpmLauncher({ env, execPath })
    staging = await mkdtemp(path.join(parent, `${version}.install-`))
    await writeFile(path.join(staging, "package.json"), JSON.stringify({ name: `harness-viz-${harness}-cli`, private: true }))
    onState({ phase: "installing", message: `首次使用或缓存需修复，正在安装 ${PACKAGES[harness]}@${version}…` })
    await run(npm.command, [...npm.prefix, "install", "--global=false", "--prefix", staging, "--save-exact",
      "--include=optional", "--ignore-scripts=false", "--no-audit", "--no-fund", "--loglevel=error",
      `${PACKAGES[harness]}@${version}`], {
      cwd: staging, env, timeout: INSTALL_TIMEOUT, maxBuffer: 16 * 1024 * 1024, onProcess,
    })
    onState({ phase: "checking", message: `核验已安装的 ${harness} ${version}…` })
    await check(staging)
    await rm(directory, { recursive: true, force: true })
    await rename(staging, directory)
    staging = null
    return await check(directory)
  } catch (err) {
    const detail = String(err.stderr?.trim() || err.message || err).slice(-2000)
    throw new Error(`${harness} ${version} 准备失败：${detail}。检查 npm 网络／代理与缓存目录写入权限，然后重启 npm start。`, { cause: err })
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true })
    await rm(lock, { force: true })
  }
}
