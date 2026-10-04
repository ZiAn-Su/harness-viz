import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveCodexLauncher } from "../src/cli.mjs"

test("Windows discovers an official Codex executable without an npm installation", async () => {
  const executable = "C:\\Programs\\Codex\\codex.exe"
  const launcher = await resolveCodexLauncher({ platform: "win32", env: { Path: '"C:\\Programs\\Codex";C:\\Other' },
    fileExists: async file => file === executable })
  assert.deepEqual(launcher, { command: executable, prefix: [] })
})

test("Windows npm installs, including custom prefixes, remain supported", async () => {
  const script = "D:\\npm-global\\node_modules\\@openai\\codex\\bin\\codex.js"
  const launcher = await resolveCodexLauncher({ platform: "win32", execPath: "node.exe", env: { PATH: "D:\\npm-global" },
    fileExists: async file => file === script })
  assert.deepEqual(launcher, { command: "node.exe", prefix: [script] })
})

test("Codex resolution follows PATH order and keeps explicit overrides", async () => {
  const launcher = await resolveCodexLauncher({ platform: "win32", env: { PATH: "C:\\First;C:\\Second" }, fileExists: async file => file.endsWith("codex.exe") })
  assert.equal(launcher.command, "C:\\First\\codex.exe")
  assert.deepEqual(await resolveCodexLauncher({ env: { CODEX_CLI_EXE: "custom-codex.exe" } }), { command: "custom-codex.exe", prefix: [] })
  assert.deepEqual(await resolveCodexLauncher({ execPath: "node", env: { CODEX_CLI_JS: "custom.js" } }), { command: "node", prefix: ["custom.js"] })
})

test("macOS/Linux use Codex on PATH; missing Windows installs get an actionable error", async () => {
  assert.deepEqual(await resolveCodexLauncher({ platform: "linux", env: {} }), { command: "codex", prefix: [] })
  assert.deepEqual(await resolveCodexLauncher({ platform: "darwin", env: {} }), { command: "codex", prefix: [] })
  await assert.rejects(resolveCodexLauncher({ platform: "win32", env: {}, fileExists: async () => false }), /官方文档/)
})
