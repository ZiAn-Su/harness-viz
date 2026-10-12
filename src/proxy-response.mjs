// Preserve the original SSE separately; this module only derives a UI summary.
export function summarizeProxyResponse(raw, protocol) {
  const result = { text: "", thinking: "", toolCalls: [], toolUses: [], stopReason: null, usage: null, terminal: false, streamError: null, responseData: null }
  if (protocol === "responses") {
    let final = null
    const items = new Map()
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue
      let event
      try { event = JSON.parse(line.slice(5)) } catch { continue }
      if (event.type === "response.output_item.added" || event.type === "response.output_item.done") items.set(event.item?.id ?? event.output_index, event.item)
      if (event.type === "response.output_text.delta") result.text += event.delta ?? ""
      if (["response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(event.type)) result.thinking += event.delta ?? ""
      if (["response.completed", "response.failed", "response.incomplete"].includes(event.type)) { final = event.response; result.terminal = true; if (event.type !== "response.completed") result.streamError = event.response?.error?.message ?? event.type }
      if (event.type === "error") result.streamError = event.message ?? event.error?.message ?? "Responses SSE error"
    }
    if (!final) { try { const value = JSON.parse(raw); if (value.output) { final = value; result.terminal = true } } catch {} }
    if (final) {
      result.responseData = final
      result.usage = final.usage ?? null
      const text = (final.output ?? []).filter(item => item.type === "message").flatMap(item => item.content ?? []).filter(item => item.type === "output_text").map(item => item.text ?? "").join("")
      if (text) result.text = text
      if (!result.thinking) result.thinking = (final.output ?? []).filter(item => item.type === "reasoning").flatMap(item => [...(item.summary ?? []), ...(item.content ?? [])]).map(block => block.text ?? "").join("\n")
    }
    const output = final?.output ?? [...items.values()]
    for (const item of output) if (["function_call", "custom_tool_call"].includes(item?.type)) {
      let input = item.arguments ?? item.input
      try { if (item.arguments) input = JSON.parse(item.arguments) } catch {}
      result.toolUses.push({ name: item.name, callID: item.call_id, input })
    }
    result.toolCalls = result.toolUses.map(t => t.name)
    result.stopReason = final?.status ?? null
    return result
  }
  const calls = new Map()
  const consume = event => {
    if (event.error) result.streamError = event.error.message ?? "Chat API error"
    if (event.usage) result.usage = event.usage
    const choice = (event.choices ?? []).find(c => c.index === 0) ?? event.choices?.[0]
    const delta = choice?.delta ?? choice?.message ?? {}
    result.text += typeof delta.content === "string" ? delta.content : ""
    result.thinking += delta.reasoning_content ?? delta.reasoning ?? ""
    for (const tool of delta.tool_calls ?? []) {
      const n = tool.index ?? tool.id, old = calls.get(n) ?? { name: "", callID: null, args: "" }
      if (tool.id) old.callID = tool.id
      old.name += tool.function?.name ?? ""
      old.args += tool.function?.arguments ?? ""
      calls.set(n, old)
    }
    if (choice?.finish_reason) result.stopReason = choice.finish_reason
  }
  for (const line of raw.split("\n")) if (line.startsWith("data:")) {
    if (line.slice(5).trim() === "[DONE]") { result.terminal = true; continue }
    try { consume(JSON.parse(line.slice(5))) } catch {}
  }
  if (!raw.includes("data:")) { try { consume(JSON.parse(raw)); result.terminal = true } catch {} }
  result.toolUses = [...calls.values()].map(call => { let input = call.args; try { input = JSON.parse(call.args) } catch {}; return { name: call.name, callID: call.callID, input } })
  result.toolCalls = result.toolUses.map(t => t.name)
  return result
}
