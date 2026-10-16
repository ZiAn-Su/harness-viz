import { randomUUID } from "node:crypto"

// Observe the task-entry work we actually perform, plus explicit native receipt.
// This does not reconstruct hidden initialization functions from state snapshots.
export function startPreparation({ harness, runID, turnNumber, input, startedAt = Date.now(), initialSteps = [] }, emit) {
  const record = { id: randomUUID(), nodeID: harness === "codex" ? "c-server" : "server", harness, runID, turnNumber,
    status: "running", startedAt: new Date(startedAt).toISOString(), endedAt: null, durationMs: null,
    input, steps: structuredClone(initialSteps), output: {}, error: null,
    boundary: harness === "opencode" ? "任务入口准备 → 本条用户消息保存事件" : "任务入口准备 → 原生本轮启动事件" }
  const publish = () => emit(structuredClone(record))
  function step(id, label, details = {}) {
    if (record.status !== "running") return
    record.steps.push({ id, label, status: "running", startedAt: new Date().toISOString(), endedAt: null, details })
    publish()
  }
  function done(id, details = {}) {
    if (record.status !== "running") return
    const item = record.steps.find(item => item.id === id)
    if (!item || item.status !== "running") return
    item.status = "completed"; item.endedAt = new Date().toISOString(); Object.assign(item.details, details)
    publish()
  }
  function finish(status, output = {}, error = null, evidence = null) {
    if (record.status !== "running") return
    record.status = status; Object.assign(record.output, output); record.error = error
    record.evidence = evidence
    if (status !== "unconfirmed") {
      record.endedAt = evidence?.receivedAt ?? new Date().toISOString()
      record.durationMs = Math.max(0, Date.parse(record.endedAt) - Date.parse(record.startedAt))
    }
    for (const item of record.steps) if (item.status === "running") {
      item.status = status === "completed" ? "completed" : status
      item.endedAt = record.endedAt
    }
    publish()
  }
  function session(sessionID, messageID = null) {
    Object.assign(record.output, { sessionID, messageID }); publish()
  }
  function observe(event) {
    if (record.status !== "running") return
    if (event.runID && event.runID !== record.runID) return
    if (event.conversationTurn != null && event.conversationTurn !== record.turnNumber) return
    const p = event.properties ?? {}, part = p.part
    if (harness === "opencode" && event.type === "message.part.updated" && part?.type === "text"
      && part.sessionID === record.output.sessionID && part.messageID === record.output.messageID) {
      finish("completed", { confirmation: "本条用户消息已保存到原生会话", userMessagePartID: part.id }, null,
        { id: event.id ?? null, type: event.type, receivedAt: event.receivedAt })
    }
    if (harness === "codex" && event.type === "codex.thread.started") session(p.thread_id)
    if (harness === "codex" && event.type === "codex.turn.started") {
      finish("completed", { confirmation: "原生客户端已开始处理本轮用户输入" }, null,
        { id: event.id ?? null, type: event.type, receivedAt: event.receivedAt })
    }
  }
  publish()
  return { record, step, done, session, observe,
    fail: error => finish("failed", {}, String(error?.message ?? error)),
    cancel: () => finish("cancelled", {}, "用户在准备完成前中断任务"),
    unconfirmed: () => finish("unconfirmed", { confirmation: "未收到原生接收确认，准备结束时间未采集" }) }
}
