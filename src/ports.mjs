import { createServer } from "node:net"

// Port 0 lets the OS bind an available port without a check/close/bind race.
// An explicitly preferred internal port may fall back when occupied/reserved.
export async function listenLocal(server, { port = 0, host = "127.0.0.1", fallback = true } = {}) {
  const bind = port => new Promise((resolve, reject) => {
    const failed = err => { server.removeListener("listening", ready); reject(err) }
    const ready = () => { server.removeListener("error", failed); resolve(server.address().port) }
    server.once("error", failed)
    server.once("listening", ready)
    server.listen(port, host)
  })
  try { return await bind(port) } catch (err) {
    if (!port || !fallback || !["EADDRINUSE", "EACCES"].includes(err.code)) throw err
    return bind(0)
  }
}

// Only needed for explicit OC_PORT overrides; normal OpenCode startup uses its
// own --port 0 listener and reports the actual address through owned stdout.
export async function openCodeRequestedPort(port, host = "127.0.0.1") {
  if (!port) return 0
  const probe = createServer()
  const selected = await listenLocal(probe, { port, host })
  await new Promise(resolve => probe.close(resolve))
  return selected === port ? port : 0
}

export function opencodeListeningPort(output, host = "127.0.0.1") {
  const prefix = `opencode server listening on http://${host}:`
  for (const line of output.split("\n").slice(0, -1)) {
    const trimmed = line.replace(/\r$/, "")
    if (!trimmed.startsWith(prefix)) continue
    const value = trimmed.slice(prefix.length)
    if (!/^\d+$/.test(value)) continue
    const port = Number(value)
    if (port > 0 && port <= 65535) return port
  }
  return null
}
