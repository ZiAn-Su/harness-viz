import path from "node:path"
import { access } from "node:fs/promises"

async function exists(file) {
  try { await access(file); return true } catch { return false }
}

export async function resolveCodexLauncher({ env = process.env, platform = process.platform,
  execPath = process.execPath, fileExists = exists } = {}) {
  if (env.CODEX_CLI_EXE) return { command: env.CODEX_CLI_EXE, prefix: [] }
  if (env.CODEX_CLI_JS) return { command: execPath, prefix: [env.CODEX_CLI_JS] }
  if (platform !== "win32") return { command: "codex", prefix: [] }

  const directories = (env.PATH ?? env.Path ?? "").split(";").filter(Boolean).map(dir => dir.replace(/^"|"$/g, ""))
  for (const directory of directories) {
    const executable = path.win32.join(directory, "codex.exe")
    if (await fileExists(executable)) return { command: executable, prefix: [] }
    // npm's Windows shims need a JS entrypoint to preserve prompt arguments without a shell.
    const launcher = path.win32.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js")
    if (await fileExists(launcher)) return { command: execPath, prefix: [launcher] }
  }
  throw new Error("未找到 Codex。请按官方文档安装，并确认终端能运行 codex --version。")
}
