import { test } from "node:test"
import assert from "node:assert/strict"
import { summarizeProxyResponse } from "../src/proxy-response.mjs"
import { withModelInputs } from "../src/trace.mjs"
const sse = values => values.map(v => "data: " + (typeof v === "string" ? v : JSON.stringify(v)) + "\n\n").join("")

test("native Responses summary and request chain preserve actual item/call IDs and final response", () => {
  const response = { id: "response-one", status: "completed", output: [{ id: "item-one", type: "function_call", call_id: "call-one", name: "read", arguments: '{"path":"file"}' }], usage: { input_tokens: 20 } }
  const parsed = summarizeProxyResponse(sse([{ type: "response.completed", response }]), "responses")
  assert.deepEqual(parsed.responseData, response)
  assert.equal(parsed.toolUses[0].callID, "call-one")
  const calls = withModelInputs([
    { index: 1, harness: "opencode", protocol: "responses", runID: "run", sessionID: "session", request: { instructions: "known", input: [{ type: "message", role: "user", content: [] }] }, responseData: response },
    { index: 2, harness: "opencode", protocol: "responses", runID: "run", sessionID: "session", request: { previous_response_id: "response-one", input: [{ type: "function_call_output", call_id: "call-one", output: "result" }] } },
  ])
  assert.equal(calls[1].modelInput.kind, "reconstructed")
  assert.equal(calls[1].modelInput.items[1].call_id, "call-one")
})

test("Chat SSE joins actual argument fragments, keeps usage and does not invent a terminal on premature EOF", () => {
  const raw = sse([
    { choices: [{ index: 0, delta: { reasoning_content: "visible", tool_calls: [{ index: 0, id: "call", function: { name: "read", arguments: '{"path":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 4 } },
  ])
  assert.equal(summarizeProxyResponse(raw, "chat").terminal, false)
  const parsed = summarizeProxyResponse(raw + "data: [DONE]\n\n", "chat")
  assert.equal(parsed.terminal, true)
  assert.equal(parsed.thinking, "visible")
  assert.deepEqual(parsed.toolUses, [{ name: "read", callID: "call", input: { path: "a" } }])
  assert.deepEqual(parsed.usage, { prompt_tokens: 10, completion_tokens: 4 })
})
