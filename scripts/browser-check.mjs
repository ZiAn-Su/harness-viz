// Browser QA replays recorded real runs; it does not issue new model requests.
import { createServer } from "node:http"
import { spawn, spawnSync } from "node:child_process"
import { readFile, writeFile, mkdir, access } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
if (!process.argv[2]) throw new Error("Usage: node browser-check.mjs <verification-directory>")
const evidence = path.resolve(process.argv[2])
const results = JSON.parse(await readFile(path.join(evidence, "results.json"), "utf8"))
const runs = {}, calls = []
const recordDemo = process.argv.includes("--record")
let replaying = false
const replayEvents = { codex: [], opencode: [] }, subscribers = new Set(), replayTimers = new Set()
for (const [h, filename] of [["codex", "codex-proof.txt"], ["opencode", "opencode-proof.txt"]]) {
  runs[h] = JSON.parse(await readFile(path.join(evidence, `${h}-${filename}-events.json`), "utf8"))
  calls.push(...JSON.parse(await readFile(path.join(evidence, `${h}-${filename}-calls.json`), "utf8")))
}
const html = await readFile(path.join(root, "public", "index.html"))
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1")
  if (url.pathname === "/") { res.setHeader("Content-Type", "text/html;charset=utf-8"); res.end(html); return }
  if (url.pathname === "/api/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.write('data: {"type":"viz.connected","source":"viz","properties":{}}\n\n')
    subscribers.add(res)
    req.on("close", () => subscribers.delete(res))
    return
  }
  if (replaying && req.method === "POST" && url.pathname === "/api/run") {
    let body = ""
    for await (const chunk of req) body += chunk
    const { harness } = JSON.parse(body)
    const run = runs[harness]
    replayEvents[harness] = []
    const publish = index => {
      const event = run.events[index]
      replayEvents[harness].push(event)
      for (const client of subscribers) client.write(`data: ${JSON.stringify(event)}\n\n`)
      if (index + 1 < run.events.length) {
        const timer = setTimeout(() => { replayTimers.delete(timer); publish(index + 1) }, 170)
        replayTimers.add(timer)
      }
    }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ sessionID: run.sessionID, harness }))
    publish(0)
    return
  }
  const data = url.pathname === "/api/status" ? results.status
    : url.pathname === "/api/last-run" ? replaying ? { events: [] } : runs[url.searchParams.get("harness")]
    : url.pathname === "/api/llm-calls" ? { calls }
    : url.pathname === "/api/models" ? { models: [{ value: results.status.ocModel, label: results.status.ocModel.split("/").pop() }] } : { error: "QA replay: read-only" }
  res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data))
})
await new Promise(resolve => server.listen(4598, "127.0.0.1", resolve))
const profile = path.join(evidence, "browser-profile")
await mkdir(profile, { recursive: true })
let executable = process.env.VIZ_BROWSER
if (!executable) for (const candidate of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]) {
  try { await access(candidate); executable = candidate; break } catch {}
}
if (!executable) throw new Error("Set VIZ_BROWSER to an installed Chromium-based browser")
const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9227", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let ws, sequence = 0
const pending = new Map(), errors = [], checks = []
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function wait(expression) {
  for (let n = 0; n < 250; n++) { if (await evaluate(expression)) return; await delay(100) }
  throw new Error("Browser condition timed out: " + expression)
}
async function screenshot(name) {
  const { data } = await command("Page.captureScreenshot", { format: "png" })
  await writeFile(path.join(evidence, name + ".png"), Buffer.from(data, "base64"))
}
try {
  let page
  for (let n = 0; n < 100; n++) {
    try { page = (await (await fetch("http://127.0.0.1:9227/json/list")).json()).find(item => item.type === "page"); if (page) break } catch {}
    await delay(100)
  }
  assert(page, "Chromium debugger page required")
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = message => {
    const data = JSON.parse(message.data)
    if (data.id && pending.has(data.id)) {
      const handler = pending.get(data.id); pending.delete(data.id)
      if (data.error) handler.reject(new Error(JSON.stringify(data.error))); else handler.resolve(data.result)
    } else if (data.method === "Runtime.exceptionThrown") errors.push(data.params.exceptionDetails)
    else if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") errors.push(data.params.args)
  }
  await command("Runtime.enable"); await command("Page.enable")
  await command("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await command("Page.navigate", { url: "http://127.0.0.1:4598" })
  await wait('document.querySelector("[data-h=codex]")?.classList.contains("on")')
  await evaluate('document.querySelector("[data-h=opencode]").click()')
  await wait(`document.querySelector("#llmBadge")?.textContent === "捕获请求: ${calls.filter(call => call.harness === "opencode").length}"`)
  await evaluate('document.querySelector("#fn-llm").click(); document.querySelector("#nodePanel .rec .hd").click()')
  await wait('document.querySelector("#nodePanel")?.textContent.includes("原始请求 JSON（完整")')
  assert(await evaluate('document.querySelector("#nodePanel").textContent.includes("messages")'))
  await screenshot("opencode-desktop")
  checks.push("OpenCode real-event replay and full request panel")
  await evaluate('document.querySelector("[data-h=codex]").click()')
  await wait(`document.querySelector("#llmBadge")?.textContent === "捕获请求: ${calls.filter(call => call.harness === "codex").length}"`)
  await evaluate('document.querySelector("#nodePanel .rec .hd").click()')
  await wait('document.querySelector("#nodePanel")?.textContent.includes("原始请求 JSON（完整")')
  assert(await evaluate('document.querySelector("#nodePanel").textContent.includes("native-trace")'))
  await screenshot("codex-desktop")
  checks.push("Codex native-trace replay, source labeling and full request panel")
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await delay(300)
  assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Mobile horizontal overflow")
  await screenshot("codex-mobile")
  checks.push("390px mobile layout without page horizontal overflow")
  assert.equal(errors.length, 0, "Browser JS errors")
  if (recordDemo) {
    // Record actual UI operations over an accelerated replay, not a new model run.
    replaying = true
    await command("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    await command("Page.reload")
    await wait('document.querySelector("[data-h=codex]")?.classList.contains("on")')
    const prompt = runs.codex.events.find(event => event.type === "viz.run").properties.prompt
    await evaluate(`document.querySelector("#prompt").value = ${JSON.stringify(prompt)}`)
    const frames = path.join(evidence, "recording-frames")
    const assets = path.join(root, "docs", "assets")
    await mkdir(frames, { recursive: true }); await mkdir(assets, { recursive: true })
    let frame = 0, capturing = false, pendingCapture = Promise.resolve()
    const capture = () => {
      if (capturing) return
      capturing = true
      pendingCapture = (async () => {
        const { data } = await command("Page.captureScreenshot", { format: "png" })
        await writeFile(path.join(frames, String(frame++).padStart(5, "0") + ".png"), Buffer.from(data, "base64"))
      })().finally(() => { capturing = false })
    }
    capture()
    const timer = setInterval(capture, 250)
    try {
      await delay(900)
      await evaluate('document.querySelector("#runBtn").click()')
      await wait('document.querySelector("#runBadge")?.textContent.includes("已结束")')
      await evaluate('document.querySelector("#fn-c-tool").click(); document.querySelector("#nodePanel .rec .hd")?.click()')
      await delay(1800)
      await evaluate('document.querySelector("#fn-c-llm").click(); document.querySelector("#nodePanel .rec .hd")?.click()')
      await delay(2200)
      await evaluate('document.querySelector("#fn-c-history").click(); document.querySelector("[data-tab=doc]").click()')
      await delay(1800)
    } finally { clearInterval(timer); await pendingCapture }
    const ffmpeg = process.env.VIZ_FFMPEG ?? "ffmpeg"
    const input = path.join(frames, "%05d.png")
    const encode = args => {
      const result = spawnSync(ffmpeg, args, { stdio: "pipe", timeout: 120000 })
      if (result.status !== 0) throw new Error("Demo encoding failed: " + (result.stderr?.toString().slice(-1500) ?? result.error?.message))
    }
    encode(["-y", "-loglevel", "error", "-framerate", "4", "-i", input, "-c:v", "libvpx-vp9", "-crf", "38", "-b:v", "0", "-an", path.join(assets, "demo.webm")])
    encode(["-y", "-loglevel", "error", "-framerate", "4", "-i", input, "-filter_complex", "[0:v]scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer", "-loop", "0", path.join(assets, "demo.gif")])
    checks.push("Public demo: actual UI with accelerated real-record replay")
  }
  assert.equal(errors.length, 0, "Browser JS errors after recording")
  console.log(JSON.stringify({ evidence, checks, errors }, null, 2))
} finally {
  for (const timer of replayTimers) clearTimeout(timer)
  ws?.close(); browser.kill(); server.closeAllConnections(); server.close()
  await writeFile(path.join(evidence, "browser-results.json"), JSON.stringify({ checks, errors }, null, 2))
}
