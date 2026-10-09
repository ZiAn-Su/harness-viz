import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm, access } from "node:fs/promises"
import { preparePinnedCli, resolveNpmLauncher, runCli } from "../src/cli.mjs"

const versions = JSON.parse(await readFile(new URL("../src/versions.json", import.meta.url), "utf8"))
const packages = { codex: "@openai/codex", opencode: "opencode-ai" }

async function fixture(t, harness = "codex") {
  const parent = new URL("../.runtime/tests/", import.meta.url)
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(fileURLToPath(parent), "cli-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const npmEntry = path.join(root, "npm-cli.js")
  await writeFile(npmEntry, "// synthetic installer; never executed\n")
  const calls = []
  let installVersion = versions[harness].version, failure = null
  const createPackage = async (directory, version) => {
    const packageRoot = path.join(directory, "node_modules", packages[harness])
    await mkdir(path.join(packageRoot, "bin"), { recursive: true })
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: packages[harness], version, type: "module" }))
    await writeFile(path.join(packageRoot, "bin", harness === "codex" ? "codex.js" : "opencode.exe"),
      `console.log(process.argv.includes("--version") ? ${JSON.stringify(harness === "codex" ? "codex-cli " + version : version)} : JSON.stringify(process.argv.slice(2)))\n`)
  }
  const options = { harness, version: versions[harness].version, cacheRoot: root,
    env: { ...process.env, npm_execpath: npmEntry, CODEX_CLI_EXE: "global-newer.exe", CODEX_CLI_JS: "global-newer.js" },
    run: async (command, args, opts) => {
      calls.push({ command, args, opts })
      if (args[0] === npmEntry) {
        if (failure) throw failure
        await createPackage(args[args.indexOf("--prefix") + 1], installVersion)
        return { stdout: "" }
      }
      if (harness === "opencode") {
        await access(command)
        const metadata = JSON.parse(await readFile(path.resolve(command, "..", "..", "package.json"), "utf8"))
        return { stdout: metadata.version }
      }
      return runCli(command, args, opts)
    } }
  return { root, calls, options, createPackage,
    get directory() { return path.join(root, harness, options.version) },
    setInstallVersion(value) { installVersion = value },
    fail(error) { failure = error } }
}

test("fixed Codex installs locally, reuses cache without npm and ignores global overrides/PATH", async t => {
  const f = await fixture(t)
  const states = []
  const first = await preparePinnedCli({ ...f.options, onState: state => states.push(state.phase) })
  assert.equal(first.command, process.execPath)
  assert.equal(first.prefix[0], path.join(f.directory, "node_modules", "@openai", "codex", "bin", "codex.js"))
  assert.equal(first.version, "codex-cli " + versions.codex.version)
  const install = f.calls.find(call => call.args.includes("install"))
  assert(install.args.includes("@openai/codex@" + versions.codex.version))
  assert(install.args.includes("--global=false"))
  assert(install.args.includes("--include=optional"))
  assert(install.args.includes("--ignore-scripts=false"))
  assert(!install.opts.shell)
  assert(states.includes("installing"))
  f.fail(new Error("npm must not run for a valid cache"))
  const second = await preparePinnedCli({ ...f.options, env: { PATH: "newer-global-cli", CODEX_CLI_EXE: "newer.exe" } })
  assert.deepEqual(second, first)
  assert.equal(f.calls.filter(call => call.args.includes("install")).length, 1)
})

test("the pinned Node launcher preserves a Chinese prompt and shell metacharacters", async t => {
  const f = await fixture(t)
  const launcher = await preparePinnedCli(f.options)
  const prompt = '中文 空格 "引号" & | < > %PATH% $变量\n第二行'
  const result = await runCli(launcher.command, [...launcher.prefix, "exec", prompt])
  assert.deepEqual(JSON.parse(result.stdout), ["exec", prompt])
})

test("OpenCode resolves only its postinstall binary and disables autoupdate during checks", async t => {
  const f = await fixture(t, "opencode")
  const launcher = await preparePinnedCli(f.options)
  assert.equal(launcher.command, path.join(f.directory, "node_modules", "opencode-ai", "bin", "opencode.exe"))
  assert.deepEqual(launcher.prefix, [])
  assert(f.calls.filter(call => call.args.includes("--version")).every(call => call.opts.env.OPENCODE_DISABLE_AUTOUPDATE === "1" && !call.opts.shell))
})

test("a stale/wrong-version cache is repaired, but a wrong downloaded version is never published", async t => {
  const f = await fixture(t)
  await f.createPackage(f.directory, "9.9.9")
  const launcher = await preparePinnedCli(f.options)
  assert.equal(launcher.version, "codex-cli " + versions.codex.version)
  await rm(f.directory, { recursive: true })
  f.setInstallVersion("9.9.9")
  await assert.rejects(preparePinnedCli(f.options), /缓存包版本不符/)
  await assert.rejects(access(f.directory), { code: "ENOENT" })
  assert.deepEqual(await readdir(path.join(f.root, "codex")), [])
})

test("a corrupted launcher is reinstalled even if package metadata still matches", async t => {
  const f = await fixture(t)
  await f.createPackage(f.directory, f.options.version)
  await writeFile(path.join(f.directory, "node_modules", "@openai", "codex", "bin", "codex.js"), 'console.log("codex-cli 9.9.9")')
  const launcher = await preparePinnedCli(f.options)
  assert.equal(launcher.version, "codex-cli " + f.options.version)
  assert.equal(f.calls.filter(call => call.args.includes("install")).length, 1)
})

test("failed installs clean their staging/lock and can be retried", async t => {
  const f = await fixture(t)
  f.fail(new Error("synthetic offline registry"))
  await assert.rejects(preparePinnedCli(f.options), /synthetic offline registry.*重启 npm start/)
  assert.deepEqual(await readdir(path.join(f.root, "codex")), [])
  f.fail(null)
  assert.equal((await preparePinnedCli(f.options)).version, "codex-cli " + f.options.version)
})

test("concurrent preparation publishes only one installation", async t => {
  const f = await fixture(t)
  const [a, b] = await Promise.all([preparePinnedCli(f.options), preparePinnedCli(f.options)])
  assert.deepEqual(a, b)
  assert.equal(f.calls.filter(call => call.args.includes("install")).length, 1)
  assert.deepEqual(await readdir(path.join(f.root, "codex")), [f.options.version])
})

test("an installer lock left by an exited process is recovered on restart", async t => {
  const f = await fixture(t)
  let pid
  await runCli(process.execPath, ["-e", ""], { onProcess: proc => { pid = proc.pid } })
  await mkdir(path.join(f.root, "codex"))
  await writeFile(path.join(f.root, "codex", `${f.options.version}.install.lock`), JSON.stringify({ pid }))
  const launcher = await preparePinnedCli(f.options)
  assert.equal(launcher.version, "codex-cli " + f.options.version)
  assert.deepEqual(await readdir(path.join(f.root, "codex")), [f.options.version])
})

test("npm resolution supports Windows distribution/custom prefixes without executing .cmd", async () => {
  const entry = "D:\\npm prefix\\node_modules\\npm\\bin\\npm-cli.js"
  const launcher = await resolveNpmLauncher({ platform: "win32", execPath: "C:\\Node JS\\node.exe",
    env: { Path: '"D:\\npm prefix"' }, fileExists: async file => file === entry })
  assert.deepEqual(launcher, { command: "C:\\Node JS\\node.exe", prefix: [entry] })
  await assert.rejects(resolveNpmLauncher({ env: {}, fileExists: async () => false }), /包含 npm 的 Node.js/)
})

test("npm resolution supports Unix lib/share locations and npm's own entrypoint", async () => {
  for (const entry of ["/usr/lib/node_modules/npm/bin/npm-cli.js", "/usr/share/nodejs/npm/bin/npm-cli.js"]) {
    const launcher = await resolveNpmLauncher({ platform: "linux", execPath: "/usr/bin/node", env: {}, fileExists: async file => file === entry })
    assert.deepEqual(launcher, { command: "/usr/bin/node", prefix: [entry] })
  }
  assert.deepEqual(await resolveNpmLauncher({ execPath: "node", env: { npm_execpath: "custom-npm.js" }, fileExists: async () => true }),
    { command: "node", prefix: ["custom-npm.js"] })
})
