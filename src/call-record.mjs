// A call record is an analysis envelope, never a replacement for requestRaw.
export function buildCallRecord(call, events = []) {
  const ids = new Set((call.response?.toolUses ?? []).map(t => t.callID).filter(Boolean))
  const toolEvidence = events.filter(event => {
    if ((event.harness ?? "opencode") !== (call.harness ?? "opencode")) return false
    if (!call.runID || event.runID !== call.runID) return false
    const p = event.properties ?? {}, part = p.part, raw = p.event?.payload
    const session = p.sessionID ?? part?.sessionID ?? raw?.thread_id
    const id = part?.callID ?? raw?.tool_call_id
    return !!call.sessionID && session === call.sessionID && ids.has(id)
  })
  const finals = new Map()
  for (const event of toolEvidence) {
    const part = event.properties?.part
    if (part?.type === "tool" && ["completed", "error"].includes(part.state?.status)) finals.set(part.callID, part)
  }
  const toolResults = (call.response?.toolUses ?? []).flatMap(tool => {
    const part = finals.get(tool.callID)
    if (!part) return []
    const content = part.state.status === "completed" ? part.state.output : part.state.error
    if (typeof content !== "string") return []
    return [{ role: "tool", tool_call_id: tool.callID, name: tool.name, content, isError: part.state.status === "error" }]
  })
  const state = !call.response ? "pending" : call.error || call.response.terminal === false ? "partial-or-error" : "captured"
  return { kind: "harness-viz-call-record", schemaVersion: 1,
    evidence: "客户端本次调用记录：实际请求、已捕获响应与按调用 ID 关联的工具事件；不是原始请求体或服务端内部 trace。",
    index: call.index, harness: call.harness, source: call.source, model: call.model, runID: call.runID, sessionID: call.sessionID,
    providerID: call.providerID ?? null, protocol: call.protocol ?? null, path: call.path ?? null, upstreamOrigin: call.upstreamOrigin ?? null,
    startedAt: call.startedAt, endedAt: call.endedAt ?? null, httpStatus: call.httpStatus ?? null, error: call.error ?? null,
    request: { body: call.anthropicRequest ?? call.request, raw: call.anthropicRequest ? call.upstreamRequestRaw ?? null : call.requestRaw ?? null },
    ...(call.anthropicRequest ? { clientRequestBeforeTranslation: { body: call.request, raw: call.requestRaw ?? null } } : {}),
    response: { state, parsed: call.response ?? null, raw: call.rawResponse ?? null, responseData: call.responseData ?? null },
    extensions: call.extensions ?? null, toolEvidence, toolResults,
    missingToolResults: [...ids].filter(id => !finals.has(id)) }
}
