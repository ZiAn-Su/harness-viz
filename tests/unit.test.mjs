import { test } from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readTraceEvents, summarizeResponse, requestTools } from "../src/trace.mjs"

const server = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8")
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8")
const translatorStart = server.indexOf("function responsesToAnthropic(")
const translatorSource = server.slice(translatorStart, server.indexOf("\n/**", translatorStart))
const translate = vm.runInNewContext(`(${translatorSource})`)
const parserStart = server.indexOf("function parseAnthropicSSE(")
const parserSource = server.slice(parserStart, server.indexOf("\n/*", parserStart))
const parse = vm.runInNewContext(`(${parserSource})`)

test("frontend script parses; SVG dimensions and IDs are consistent", () => {
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1])
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])
  assert.equal(ids.length, new Set(ids).size)
  assert.equal((html.match(/viewBox="0 0 700 1070"/g) ?? []).length, 2)
})

test("translator preserves function call/result identity but is explicitly lossy", () => {
  const result = translate({ model: "fixture", instructions: "base", reasoning: { effort: "high" }, parallel_tool_calls: false,
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "developer-marker" }] },
      { type: "reasoning", encrypted_content: "opaque-marker" },
      { type: "message", role: "user", content: [{ type: "input_image", image_url: "image-marker" }] },
      { type: "function_call", name: "read", call_id: "call-1", arguments: '{"path":"fixture"}' },
      { type: "function_call_output", call_id: "call-1", output: "result-marker" },
    ], tools: [{ type: "web_search" }, { type: "custom", name: "patch", format: { type: "grammar" } }],
  }, new Set())
  assert.equal(result.messages[0].role, "user")
  assert.equal(result.system, "base")
  assert(!JSON.stringify(result).includes("opaque-marker"))
  assert(!JSON.stringify(result).includes("image-marker"))
  assert.equal(result.messages[0].content[1].text, "[input_image]")
  assert.equal(result.tools.length, 1)
  assert.equal(result.tools[0].input_schema.properties.input.type, "string")
  assert.equal(result.max_tokens, 16384)
  assert.equal(result.parallel_tool_calls, undefined)
  const blocks = result.messages.flatMap(message => message.content)
  assert.equal(blocks.find(block => block.type === "tool_use").id, "call-1")
  assert.equal(blocks.find(block => block.type === "tool_result").tool_use_id, "call-1")
})

test("Anthropic capture keeps initial tool input, call ID and usage", () => {
  const raw = [
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-2", name: "read", input: { path: "fixture" } } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("")
  const parsed = JSON.parse(JSON.stringify(parse(raw)))
  assert.deepEqual(parsed.toolUses, [{ name: "read", input: { path: "fixture" }, callID: "call-2" }])
  assert.deepEqual(parsed.usage, { input_tokens: 10, output_tokens: 3 })
})

test("native response summaries preserve raw item IDs and do not invent stop_reason", () => {
  const raw = { output_items: [
    { type: "message", content: [{ type: "output_text", text: "observed" }] },
    { type: "reasoning", summary: [{ text: "summary" }], encrypted_content: "opaque" },
    { type: "function_call", name: "shell", call_id: "call-3", arguments: "invalid-json" },
  ], token_usage: { input_tokens: 11 } }
  assert.deepEqual(summarizeResponse(raw), { text: "observed", thinking: "summary", toolCalls: ["shell"],
    toolUses: [{ name: "shell", input: "invalid-json", callID: "call-3" }], stopReason: null, usage: { input_tokens: 11 } })
  assert.equal(raw.output_items[1].encrypted_content, "opaque")
})

test("Responses Lite tool definitions and omitted continuation definitions differ", () => {
  assert.deepEqual(requestTools({ input: [{ type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "read" }] }] }] }),
    { names: ["functions.read"], location: "input.additional_tools" })
  assert.deepEqual(requestTools({ previous_response_id: "response-1", input: [] }), { names: null, location: "not-in-this-payload" })
  assert.deepEqual(requestTools({ tools: [] }), { names: [], location: "tools" })
})

test("trace cursor commits are atomic across bundles after an unreadable payload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-trace-atomic-"))
  try {
    const cursors = new Map()
    for (const name of ["trace-a", "trace-b"]) {
      await mkdir(path.join(root, name, "payloads"), { recursive: true })
      await writeFile(path.join(root, name, "trace.jsonl"), JSON.stringify({ seq: 1, payload: { request_payload: { path: "payloads/request.json" } } }) + "\n")
    }
    await writeFile(path.join(root, "trace-a", "payloads", "request.json"), "{}")
    await assert.rejects(readTraceEvents(root, cursors), { code: "ENOENT" })
    assert.equal(cursors.size, 0)
    await writeFile(path.join(root, "trace-b", "payloads", "request.json"), "{}")
    assert.equal((await readTraceEvents(root, cursors)).length, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("native trace reader waits for complete lines, deduplicates, and reads exact payload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-trace-test-"))
  try {
    const bundle = path.join(root, "trace-fixture")
    await mkdir(path.join(bundle, "payloads"), { recursive: true })
    const request = { model: "fixture", input: [{ type: "message", content: [{ text: "context-marker" }] }] }
    await writeFile(path.join(bundle, "payloads", "request.json"), JSON.stringify(request))
    const event = { seq: 1, payload: { type: "inference_started", request_payload: { path: "payloads/request.json" } } }
    const log = path.join(bundle, "trace.jsonl"), cursors = new Map()
    await writeFile(log, JSON.stringify(event))
    assert.deepEqual(await readTraceEvents(root, cursors), [])
    await writeFile(log, JSON.stringify(event) + "\n")
    const items = await readTraceEvents(root, cursors)
    assert.deepEqual(items[0].payloads.request_payload, request)
    assert.deepEqual(items[0].event, event)
    assert.deepEqual(await readTraceEvents(root, cursors), [])
    await writeFile(log, JSON.stringify(event) + '\n{"seq":2,"payload":{"request_payload":{"path":"../../secret"}}}\n')
    await assert.rejects(readTraceEvents(root, cursors), /Unsafe trace payload path/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
