import { test } from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import { readFile } from "node:fs/promises"

const source = await readFile(new URL("../public/execution-records.js", import.meta.url), "utf8")
const adapter = vm.runInNewContext(source + ";HarnessExecutions")
const event = (type, properties = {}, receivedAt = "2026-10-16T00:00:01.000Z") => ({ type, properties, receivedAt, harness: "opencode", runID: "run" })
const record = (data, firstEvent, lastEvent = firstEvent, kind = "json") => ({ seq: 1, kind, data, firstEvent, event: lastEvent, source: "opencode-sse" })

test("tool executions retain native args/results/times; feedback does not invent a zero-duration write", () => {
  const part = { type: "tool", tool: "read", callID: "call", sessionID: "root", state: {
    status: "completed", input: { path: "README.md" }, output: "ORIGINAL_CONTENT", time: { start: 1000, end: 1600 } } }
  const rec = record(part, event("message.part.updated"))
  const before = structuredClone(rec)
  const tool = adapter.fromRecord(rec, "tool")
  assert.equal(tool.status, "completed")
  assert.equal(tool.durationMs, 600)
  assert.equal(tool.input.参数.path, "README.md")
  assert.equal(tool.output.输出, "ORIGINAL_CONTENT")
  const feedback = adapter.fromRecord(rec, "exec")
  assert.equal(feedback.startedAt, null)
  assert.equal(feedback.durationMs, null)
  assert(feedback.endedAt)
  assert.deepEqual(rec, before)
})

test("Codex item receipt times never become fabricated native execution times", () => {
  const first = event("codex.item.started"), last = event("codex.item.completed", {}, "2026-10-16T00:00:05.000Z")
  const result = adapter.fromRecord(record({ type: "command_execution", id: "item_1", command: "example", status: "completed", exit_code: 0, aggregated_output: "ACTUAL_OUTPUT" }, first, last), "c-tool")
  assert.equal(result.status, "completed")
  assert.equal(result.startedAt, null)
  assert.equal(result.durationMs, null)
  assert.equal(result.observations.firstReceivedAt, first.receivedAt)
  assert.equal(result.observations.lastReceivedAt, last.receivedAt)
  assert.equal(result.output.退出码, 0)
})

test("model cancellation remains cancellation with its partial response and original request", () => {
  const rec = record({ index: 7, requestSummary: { model: "fixture" } }, event("llm.request"), event("llm.response"), "llm")
  const call = { model: "fixture", source: "native-trace", startedAt: 1000, endedAt: 1400, request: { reasoning: { effort: "low" } },
    response: { text: "PARTIAL", usage: null }, error: "consumer stopped", trace: { terminal: { payload: { type: "inference_cancelled" } } } }
  const before = structuredClone(call)
  const result = adapter.fromRecord(rec, "c-llm", call)
  assert.equal(result.status, "cancelled")
  assert.equal(result.durationMs, 400)
  assert.equal(result.output.文字, "PARTIAL")
  assert.equal(result.input.请求参数.reasoning.effort, "low")
  assert.deepEqual(call, before)
})

test("permission records use one ask/reply interaction and mark tool execution as a separate fact", () => {
  const ask = event("permission.asked", { id: "permission", permission: "edit", patterns: ["file"], sessionID: "root" })
  const reply = event("permission.replied", { requestID: "permission", reply: "reject", sessionID: "root" }, "2026-10-16T00:00:02.500Z")
  const result = adapter.fromRecord(record(reply.properties, ask, reply), "sandbox")
  assert.equal(result.status, "cancelled")
  assert.equal(result.durationMs, 1500)
  assert.equal(result.input.权限, "edit")
  assert.equal(result.output.用户答复, "reject")
  assert(result.timing.includes("不表示工具已经执行"))
})

test("completion-only reports keep start and duration unknown", () => {
  const native = event("session.compacted", { sessionID: "root" })
  const result = adapter.fromRecord(record(native.properties, native), "subflow2")
  assert.equal(result.status, "completed")
  assert.equal(result.startedAt, null)
  assert.equal(result.durationMs, null)
  assert.equal(result.endedAt, native.receivedAt)
})

test("native compaction requests use explicit request identity and native timestamps", () => {
  const start = event("codex.trace", { event: { wall_time_unix_ms: 1000, payload: { type: "compaction_request_started", compaction_request_id: "compact-call", thread_id: "thread", model: "fixture" } }, payloads: { request_payload: { input: ["OLD_HISTORY"] } } })
  const end = event("codex.trace", { event: { wall_time_unix_ms: 1500, payload: { type: "compaction_request_completed", compaction_request_id: "compact-call" } }, payloads: { response_payload: { summary: "NEW_SUMMARY" } } })
  const result = adapter.fromRecord(record(end.properties, start, end, "compaction-request"), "c-context")
  assert.equal(result.status, "completed")
  assert.equal(result.durationMs, 500)
  assert.equal(result.input.请求内容.input[0], "OLD_HISTORY")
  assert.equal(result.output.返回内容.summary, "NEW_SUMMARY")
  assert(result.timing.includes("不归入特定压缩分支"))
})

test("readable model detail distinguishes real user text from tool feedback encoded as user and exposes the response directly", () => {
  const request = { model: "fixture", messages: [
    { role: "user", content: [{ type: "text", text: "ACTUAL_USER_GOAL" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "read", name: "read", input: { filePath: "settings.conf" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "read", content: "NOT_A_NEW_USER_GOAL" }] },
  ] }
  const call = { request, startedAt: 1000, endedAt: 1500, response: { text: "ACTUAL_MODEL_ANSWER", toolUses: [], usage: { input_tokens: 100, output_tokens: 20 } } }
  const before = structuredClone(call)
  const result = adapter.describe(adapter.fromRecord(record({ index: 1 }, event("llm.request"), undefined, "llm"), "llm", call))
  assert.equal(result.input.find(([label])=>label === "最近用户文本")[1], "ACTUAL_USER_GOAL")
  assert.equal(result.result.find(([label])=>label === "回答正文")[1], "ACTUAL_MODEL_ANSWER")
  assert.equal(result.result.find(([label])=>label === "输出 token")[1], 20)
  assert.deepEqual(call, before)
})

test("history summary follows requirement/progress responsibilities and omits tool payloads and the later response", () => {
  const call = { request: { messages: [
    { role: "user", content: "检查登录模块" },
    { role: "assistant", content: [{ type: "text", text: "先确认现有登录实现。" }, { type: "tool_use", id: "read", name: "read", input: { filePath: "src/login.ts", SECRET_OTHER_PARAMETER: "NOT_FOR_HISTORY" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "read", content: "HUGE_RETURNED_FILE_CONTENT" }] },
  ] }, response: { text: "FUTURE_RESPONSE_MUST_NOT_APPEAR" } }
  const before = structuredClone(call), result = adapter.historySummary(call)
  assert.equal(result.requirement, "检查登录模块")
  assert(result.progress.includes("先确认现有登录实现") && result.progress.includes("读取文件 · login.ts"))
  assert(result.feedback.includes("已收到") && result.feedback.includes("login.ts"))
  for (const forbidden of ["NOT_FOR_HISTORY", "HUGE_RETURNED_FILE_CONTENT", "FUTURE_RESPONSE_MUST_NOT_APPEAR"]) assert(!JSON.stringify(result).includes(forbidden))
  assert.deepEqual(call, before)
})

test("incremental history uses only a complete explicit response chain; unknown or partial state stays omitted", () => {
  const items = [{ role: "user", content: "已关联的用户要求" }, { type: "function_call", name: "read", call_id: "call", arguments: '{"path":"config.json"}' }, { type: "function_call_output", call_id: "call", output: "RAW_RESULT_NOT_SHOWN" }]
  const call = { request: { previous_response_id: "response", input: [items[2]] }, modelInput: { kind: "reconstructed", complete: true, items } }
  let result = adapter.historySummary(call)
  assert.equal(result.requirement, "已关联的用户要求")
  assert(result.rebuilt && result.feedback.includes("config.json"))
  result = adapter.historySummary({ ...call, modelInput: { kind: "partial", complete: false, items } })
  assert.equal(result.requirement, "")
  assert.equal(result.progress, "")
  assert.equal(result.feedback, "")
  assert.equal(result.rebuilt, false)
})
