import { test } from "node:test"
import assert from "node:assert/strict"
import { buildCallRecord } from "../src/call-record.mjs"

test("call record keeps the exact request and response and only explicitly associated tool evidence", () => {
  const raw = '{"n":1e2,"system":"known"}'
  const call = { index: 1, harness: "opencode", source: "proxy", runID: "run", sessionID: "root", request: JSON.parse(raw), requestRaw: raw,
    response: { terminal: true, text: "answer", thinking: "visible", toolUses: [{ name: "read", callID: "same", input: { filePath: "a" } }] }, rawResponse: "actual SSE" }
  const event = (runID, sessionID, status) => ({ harness: "opencode", runID, type: "message.part.updated", properties: { part: {
    type: "tool", tool: "read", callID: "same", sessionID, state: { status, output: "exact result" } } } })
  const before = structuredClone(call)
  const record = buildCallRecord(call, [event("run", "root", "running"), event("other", "root", "completed"), event("run", "child", "completed"), event("run", "root", "completed")])
  assert.equal(record.request.raw, raw)
  assert.equal(record.response.raw, "actual SSE")
  assert.equal(record.response.state, "captured")
  assert.equal(record.toolEvidence.length, 2)
  assert.equal(record.toolResults[0].content, "exact result")
  assert.deepEqual(record.missingToolResults, [])
  assert.deepEqual(call, before)
})

test("pending and partial responses stay labelled, and translated originals remain separate", () => {
  const pending = buildCallRecord({ index: 2, request: { input: [] }, requestRaw: "client", anthropicRequest: { messages: [] }, upstreamRequestRaw: "upstream" })
  assert.equal(pending.response.state, "pending")
  assert.equal(pending.request.raw, "upstream")
  assert.equal(pending.clientRequestBeforeTranslation.raw, "client")
  assert.equal(buildCallRecord({ response: { text: "partial", terminal: false } }).response.state, "partial-or-error")
})
