// Browser QA replays recorded real runs; it does not issue new model requests.
import { createServer } from "node:http"
import { spawn, spawnSync } from "node:child_process"
import { readFile, writeFile, mkdir, access } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"
import { withModelInputs } from "../src/trace.mjs"
import { listTemplates, renderTemplatePreview } from "../src/template-preview.mjs"

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
  if (["/vendor/marked.js", "/vendor/purify.js", "/markdown.js", "/flows.js"].includes(url.pathname)) {
    res.setHeader("Content-Type", "text/javascript;charset=utf-8")
    res.end(await readFile(path.join(root, "public", url.pathname.slice(1))))
    return
  }
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
  if (url.pathname === "/api/template-preview" && req.method === "GET") {
    const index = Number(url.searchParams.get("index"))
    const call = withModelInputs(calls).find(item => item.index === index)
    res.setHeader("Content-Type", "application/json")
    if (!call) { res.statusCode = 404; res.end(JSON.stringify({ error: "not found" })); return }
    try {
      const result = await renderTemplatePreview({ modelInput: call.modelInput, templateId: url.searchParams.get("template") })
      res.end(JSON.stringify({ ok: true, index, ...result }))
    } catch (err) { res.statusCode = 502; res.end(JSON.stringify({ error: String(err?.message ?? err) })) }
    return
  }
  const data = url.pathname === "/api/status" ? results.status
    : url.pathname === "/api/last-run" ? replaying ? { events: [] } : runs[url.searchParams.get("harness")]
    : url.pathname === "/api/llm-calls" ? { calls: withModelInputs(calls) }
    : url.pathname === "/api/templates" ? { templates: listTemplates() }
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
const downloads = path.join(evidence, "downloads-" + Date.now())
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
async function verifyDownload(call) {
  await evaluate(`document.querySelector('[data-request-index="${call.index}"] button[onclick="downloadInput(${call.index},false)"]').click()`)
  let downloaded
  for (let n = 0; n < 100; n++) {
    try { downloaded = await readFile(path.join(downloads, `model-request-${call.index}.raw.json`), "utf8"); break } catch {}
    await delay(100)
  }
  const payload = call.anthropicRequest ?? call.request
  const original = call.anthropicRequest ? call.upstreamRequestRaw : call.requestRaw
  assert.equal(downloaded, original ?? JSON.stringify(payload, null, 2))
  assert.deepEqual(JSON.parse(downloaded), payload)
  await evaluate(`document.querySelector('[data-request-index="${call.index}"] button[onclick="downloadInput(${call.index},true)"]').click()`)
  let formatted
  for (let n = 0; n < 100; n++) {
    try { formatted = await readFile(path.join(downloads, `model-request-${call.index}.json`), "utf8"); break } catch {}
    await delay(100)
  }
  assert.deepEqual(JSON.parse(formatted), payload)
  assert.ok(formatted.includes("\n  "))
}
async function verifyFlowDocs(harness) {
  const container = harness === "codex" ? "flowCodex" : "flowOpencode"
  const nodes = await evaluate(`[...document.querySelectorAll('#${container} [data-node]')].map(node => node.dataset.node)`)
  assert(await evaluate(`(() => { const graph = document.querySelector('#${container}'); const zone = graph.querySelector('.zone-label').getBoundingClientRect(); const sub = graph.querySelector('[data-shape="subprocess"]${harness === "opencode" ? '[data-node="sub"]' : ''}').getBoundingClientRect(); return zone.bottom <= sub.top })()`), `${harness}: environment heading must not overlap a tool node`)
  assert(await evaluate(`(() => { const svg = document.querySelector('#${container} svg'); const canvas = svg.viewBox.baseVal; return [...svg.querySelectorAll('.lbl')].every(label => { const box = label.getBBox(); return box.x >= 0 && box.y >= 0 && box.x + box.width <= canvas.width && box.y + box.height <= canvas.height }) })()`), `${harness}: branch labels must remain inside the canvas`)
  await evaluate('document.querySelector("[data-tab=doc]").click()')
  for (const node of nodes) {
    await evaluate(`selectNode(${JSON.stringify(node)})`)
    assert(await evaluate(`document.querySelector("#nodePanel h3")?.textContent === "这一步做什么" && document.querySelector("#nodePanel .lesson-example") && [...document.querySelectorAll("#nodePanel a")].length > 0 && [...document.querySelectorAll("#nodePanel a")].every(link => link.href.includes(SOURCE_PINS[${JSON.stringify(harness)}].commit))`), `${node}: learner explanation and fixed source links must be accessible`)
    assert(await evaluate(`(() => { const doc = document.querySelector("#nodePanel .doc").cloneNode(true); doc.querySelectorAll("details").forEach(d => d.remove()); return !/build_prompt|needs_follow_up|stopWhen|base instructions|\\bbadge\\b|\\bHTTP\\b|\\bWS\\b|\\bturn\\b|\\bassistant\\b/.test(doc.textContent) && !document.querySelector("#nodePanel details").open })()`), `${node}: implementation terms must stay in collapsed details`)
  }
  await evaluate(`selectNode(${JSON.stringify(harness === "codex" ? "c-context" : "loop")})`)
  await screenshot(harness + "-lesson")
  await evaluate(`document.querySelector("[data-tab=records]").click(); selectNode(${JSON.stringify(harness === "codex" ? "c-llm" : "llm")})`)
  checks.push(`${harness}: all ${nodes.length} visible nodes open their explanation and pinned source links`)
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
  const resetPreferences = await command("Page.addScriptToEvaluateOnNewDocument", { source: 'localStorage.removeItem("harness-viz.views.desktop"); localStorage.removeItem("harness-viz.views.mobile")' })
  await command("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await command("Page.navigate", { url: "http://127.0.0.1:4598" })
  await wait('document.querySelector("[data-h=codex]")?.classList.contains("on")')
  await command("Page.removeScriptToEvaluateOnNewDocument", { identifier: resetPreferences.identifier })
  assert.equal(await evaluate("document.title"), "Coding Agent 实时可视化")
  assert(await evaluate('document.querySelector("#composer").hidden && !document.querySelector("#evidenceBanner")'))
  assert(await evaluate('document.querySelector("main").getBoundingClientRect().height > innerHeight - 90'))
  const capturedBefore = await evaluate('document.querySelector("#llmBadge").textContent')
  await evaluate('document.querySelector("#toggle-flow").click(); document.querySelector("#toggle-details").click()')
  await delay(150)
  assert(await evaluate('document.querySelector("#colTx").getBoundingClientRect().width > innerWidth * .9'))
  await evaluate('document.querySelector("#toggle-transcript").click()')
  assert(await evaluate('[...document.querySelectorAll(".workspace-panel")].every(panel => panel.hidden)'))
  await evaluate('document.querySelector("#toggle-input").click(); document.querySelector("#prompt").value = "保留的草稿"')
  assert(await evaluate('document.querySelector("#prompt").getBoundingClientRect().height <= 40'))
  await evaluate('document.querySelector("#toggle-input").click(); document.querySelector("#toggle-input").click()')
  assert.equal(await evaluate('document.querySelector("#prompt").value'), "保留的草稿")
  await evaluate('document.querySelector("#toggle-input").click(); document.querySelector("#toggle-transcript").click()')
  assert.equal(await evaluate('document.querySelector("#llmBadge").textContent'), capturedBefore)
  await command("Page.reload")
  await wait('document.querySelector("[data-h=codex]")?.classList.contains("on")')
  assert(await evaluate('document.querySelector("#colFlow").hidden && document.querySelector("#colLlm").hidden && !document.querySelector("#colTx").hidden'))
  await evaluate('document.querySelector("#toggle-flow").click(); document.querySelector("#toggle-details").click()')
  checks.push("Header controls, single-line hidden composer, independent panels, reflow and persisted preferences")
  await mkdir(downloads, { recursive: true })
  await command("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads })
  await evaluate('document.querySelector("[data-h=opencode]").click()')
  await wait(`document.querySelector("#llmBadge")?.textContent === "捕获请求: ${calls.filter(call => call.harness === "opencode").length}"`)
  const originalPrompt = runs.opencode.events.find(event => event.type === "viz.run").properties.prompt
  assert.equal(await evaluate(`document.querySelectorAll("#transcript .user").length`), 1)
  assert(await evaluate(`[...document.querySelectorAll("#transcript .assistant .body")].every(body => body.dataset.rawText !== ${JSON.stringify(originalPrompt)})`))
  checks.push("OpenCode user-message events are not mislabelled as assistant")
  await verifyFlowDocs("opencode")
  await evaluate('document.querySelector("#fn-llm").click(); document.querySelector("#nodePanel .rec .hd").click()')
  await wait('document.querySelector("#nodePanel")?.textContent.includes("下载原文")')
  assert(await evaluate('document.querySelector("#nodePanel .model-input")?.textContent.includes("请求输入")'))
  assert(await evaluate('document.querySelector("#nodePanel .input-message[open]")?.textContent.includes("system")'))
  assert(await evaluate('document.querySelector("#nodePanel").textContent.includes("messages")'))
  await verifyDownload(calls.find(call => call.harness === "opencode"))
  checks.push("OpenCode browser download equals the captured forwarded API body")
  // 模板预览：真实捕获的请求 JSON 经固定模板本地渲染，逐模板验证并下载。
  const previewCall = calls.find(call => call.harness === "opencode")
  await wait(`document.querySelector('.template-preview[data-preview-index="${previewCall.index}"] select.template-select option[value="qwen38"]') != null`)
  const previewSignatures = { qwen38: "<|im_start|>", "glm53": "[gMASK]<sop>", "kimi-k3": "<|open|>message" }
  for (const [templateId, signature] of Object.entries(previewSignatures)) {
    await evaluate(`(() => { const sel = document.querySelector('.template-preview[data-preview-index="${previewCall.index}"] select.template-select'); sel.value = ${JSON.stringify(templateId)}; renderTemplate(${previewCall.index}, sel) })()`)
    await wait(`document.querySelector('.template-preview[data-preview-index="${previewCall.index}"] .template-output')?.textContent.includes(${JSON.stringify(signature)})`)
    assert(await evaluate(`document.querySelector('.template-preview[data-preview-index="${previewCall.index}"] .template-output').textContent.includes(${JSON.stringify(originalPrompt.slice(0, 12))})`), "rendered preview must contain the task prompt")
  }
  await evaluate(`document.querySelector('.template-preview[data-preview-index="${previewCall.index}"] .download-rendered').click()`)
  let renderedDownload
  for (let n = 0; n < 100; n++) {
    try { renderedDownload = await readFile(path.join(downloads, `model-request-${previewCall.index}.rendered-kimi-k3.txt`), "utf8"); break } catch {}
    await delay(100)
  }
  assert(renderedDownload?.includes("<|open|>message"), "downloaded rendered text must match the selected template output")
  assert(renderedDownload.includes(originalPrompt.slice(0, 12)), "downloaded rendered text must contain the task prompt")
  assert.equal(renderedDownload, await evaluate(`document.querySelector('.template-preview[data-preview-index="${previewCall.index}"] .template-output').textContent`), "download must preserve the complete rendered text")
  assert(await evaluate(`(() => { const details = document.querySelector('.template-preview[data-preview-index="${previewCall.index}"] .template-details'); return !details.open && details.getBoundingClientRect().height <= details.querySelector("summary").getBoundingClientRect().height + 2 })()`), "metadata must be folded by default")
  checks.push("Template preview renders the captured request through pinned Qwen3.8/GLM5.3/Kimi K3 templates and downloads")
  await evaluate(`document.querySelector('.template-preview[data-preview-index="${previewCall.index}"] .template-output').scrollIntoView({ block: "center" })`)
  await delay(200)
  await screenshot("opencode-desktop")
  checks.push("OpenCode real-event replay and full request panel")
  await evaluate('document.querySelector("[data-h=codex]").click()')
  await wait(`document.querySelector("#llmBadge")?.textContent === "捕获请求: ${calls.filter(call => call.harness === "codex").length}"`)
  await verifyFlowDocs("codex")
  assert(await evaluate('!document.querySelector("#fn-c-loop, #fn-c-precompact, #fn-c-history, #fn-c-perm") && document.querySelector("#fn-c-sandbox").dataset.shape === "environment" && document.querySelector("#fn-c-sub").dataset.shape === "subprocess" && document.querySelector("#fn-c-compact-next").dataset.shape === "decision"'), "teaching view must show per-handler permissions and the actual post-compaction branch")
  assert(await evaluate('store["c-sandbox"]?.some(record => record.data.sandbox === "workspace-write" && record.data.approvalPolicy === "never")'), "real launch configuration must be available at the sandbox node")
  await evaluate('document.querySelector("#nodePanel .rec .hd").click()')
  await wait('document.querySelector("#nodePanel")?.textContent.includes("下载原文")')
  assert(await evaluate('document.querySelector("#nodePanel").textContent.includes("native-trace")'))
  assert(await evaluate('document.querySelector("#nodePanel .input-message[open]")?.querySelector("summary").textContent.includes("developer")'))
  const reconstructed = withModelInputs(calls).find(call => call.harness === "codex" && call.modelInput.kind === "reconstructed")
  assert(reconstructed, "Actual native data must include a response-chain continuation")
  await evaluate(`const targetRecord = store["c-llm"].find(record => record.kind === "llm" && record.data.index === ${reconstructed.index}); document.querySelectorAll("#nodePanel .rec .hd")[store["c-llm"].indexOf(targetRecord)].click()`)
  await wait('document.querySelector("#nodePanel")?.textContent.includes("重建上下文（分析结果，非原始请求）")')
  assert.deepEqual(JSON.parse(await evaluate(`requestCache[${reconstructed.index}]`)), reconstructed.request)
  await verifyDownload(reconstructed)
  checks.push("Readable original request and byte-preserving browser download; rebuilt context stays separate")
  // 已捕获的 Codex Responses 请求按所选模板组装，实际字段转换折叠显示。
  await wait(`document.querySelector('.template-preview[data-preview-index="${reconstructed.index}"] select.template-select option[value="qwen38"]') != null`)
  await evaluate(`(() => { const sel = document.querySelector('.template-preview[data-preview-index="${reconstructed.index}"] select.template-select'); sel.value = "qwen38"; renderTemplate(${reconstructed.index}, sel) })()`)
  await wait(`document.querySelector('.template-preview[data-preview-index="${reconstructed.index}"] .template-output')?.textContent.includes("<|im_start|>")`)
  assert(await evaluate(`(() => { const details = document.querySelector('.template-preview[data-preview-index="${reconstructed.index}"] .template-details'); return !details.open && details.getBoundingClientRect().height <= details.querySelector("summary").getBoundingClientRect().height + 2 })()`), "conversion details must not crowd the rendered result")
  await evaluate(`document.querySelector('.template-preview[data-preview-index="${reconstructed.index}"] .template-details summary').click()`)
  assert(await evaluate(`document.querySelector('.template-preview[data-preview-index="${reconstructed.index}"] .template-meta').textContent.includes("responses")`), "details must identify the known source format")
  assert(await evaluate(`(() => { const text = document.querySelector('.template-preview[data-preview-index="${reconstructed.index}"] .template-warnings').textContent; const notes = text ? text.split("\\n") : []; return new Set(notes).size === notes.length && !text.includes("服务端决定") })()`), "actual conversion notes must be deduplicated")
  await evaluate(`document.querySelector('.template-preview[data-preview-index="${reconstructed.index}"] .template-details summary').click(); document.querySelector('.template-preview[data-preview-index="${reconstructed.index}"]').scrollIntoView({ block: "center" })`)
  await delay(200)
  checks.push("Known Codex Responses input renders with compact controls and folded, deduplicated conversion details")
  await screenshot("codex-template-preview")
  await screenshot("codex-desktop")
  checks.push("Codex native-trace replay, source labeling and full request panel")
  const markdown = '# Markdown 排版\n\n支持 **重点**、`行内代码` 和 [源码链接](https://github.com/openai/codex)。\n\n## 请求生命周期\n\n1. 组织上下文\n2. 执行工具\n3. 反馈结果\n\n> 工具结果进入下一次请求。\n\n| 阶段 | 内容 |\n| --- | --- |\n| 输入 | 指令与历史 |\n| 工具 | 文件与命令 |\n\n```js\nconst result = await runTool();\n```\n\n- [x] 完成读取\n- [ ] 等待修改'
  await evaluate('document.querySelector("#toggle-flow").click(); document.querySelector("#toggle-details").click(); document.querySelector("#transcript").innerHTML = ""')
  await evaluate(`appendText("qa-markdown", ${JSON.stringify(markdown)}, "text", false); bubbles["qa-markdown"].parentElement.querySelector(".who").textContent = "Markdown 排版测试"`)
  await wait('document.querySelector("#transcript .markdown table") != null')
  assert(await evaluate('document.querySelector("#transcript .markdown h1") && document.querySelector("#transcript .markdown strong") && document.querySelector("#transcript .markdown ol") && document.querySelector("#transcript .markdown blockquote") && document.querySelector("#transcript .markdown pre code.language-js")'))
  const attack = '<img src=x onerror="window.__mdAttack=1"><script>window.__mdAttack=2</script><svg onload="window.__mdAttack=3"></svg><a href="javascript:window.__mdAttack=4" onclick="window.__mdAttack=5">bad</a><style>body{display:none}</style>'
  await evaluate(`appendText("qa-unsafe", ${JSON.stringify(attack)}, "text", false)`)
  await delay(100)
  assert(await evaluate('!window.__mdAttack && !document.querySelector("#transcript script, #transcript img, #transcript svg, #transcript style, #transcript [onclick], #transcript [onerror], #transcript a[href^=javascript]")'))
  await evaluate('bubbles["qa-unsafe"].parentElement.remove()')
  await screenshot("markdown-desktop")
  checks.push("Real GFM rendering and DOMPurify script/event/unsafe-URL sanitation")
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
    await evaluate('setView("flow", true); setView("details", true); setView("input", true); document.querySelector("[data-tab=records]").click()')
    const prompt = runs.codex.events.find(event => event.type === "viz.run").properties.prompt
    await evaluate(`document.querySelector("#prompt").value = ${JSON.stringify(prompt)}`)
    const frames = path.join(evidence, "recording-frames-" + Date.now())
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
      await delay(3200)
      await evaluate(`const requestRecord = store["c-llm"].find(record => record.kind === "llm" && record.data.index === ${reconstructed.index}); document.querySelectorAll("#nodePanel .rec .hd")[store["c-llm"].indexOf(requestRecord)].click()`)
      await delay(3200)
      await evaluate('document.querySelector("#fn-c-llm").click(); document.querySelector("[data-tab=doc]").click()')
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
