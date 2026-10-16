import { test } from "node:test"
import assert from "node:assert/strict"
import { startPreparation } from "../src/preparation.mjs"

test("OpenCode preparation finishes only for the exact submitted message's persisted text part", () => {
  const snapshots = []
  const tracker = startPreparation({ harness: "opencode", runID: "run", turnNumber: 1, input: { prompt: "task" } }, p => snapshots.push(p))
  tracker.step("session", "创建会话"); tracker.done("session", { sessionID: "root" })
  tracker.session("root", "msg-own"); tracker.step("native", "保存输入")
  const native = (messageID, sessionID = "root") => ({ id: "native-part", type: "message.part.updated", receivedAt: new Date().toISOString(), properties: { part: { type: "text", id: "part", sessionID, messageID, text: "task" } } })
  tracker.observe(native("msg-old")); tracker.observe(native("msg-own", "child"))
  assert.equal(tracker.record.status, "running")
  tracker.observe(native("msg-own"))
  assert.equal(tracker.record.status, "completed")
  assert(tracker.record.durationMs >= 0)
  assert.equal(tracker.record.evidence.id, "native-part")
  assert.equal(tracker.record.steps.at(-1).status, "completed")
  tracker.observe(native("msg-own")); tracker.fail(new Error("later model failure"))
  assert.equal(tracker.record.status, "completed", "Later generation is outside the preparation boundary")
  assert.equal(new Set(snapshots.map(s=>s.id)).size, 1)
  assert.equal(snapshots[0].status, "running", "Published snapshots must not be mutated by later updates")
})

test("Codex preparation records the native thread and ends at turn start", () => {
  const tracker = startPreparation({ harness: "codex", runID: "run", turnNumber: 2, input: { continuing: true } }, () => {})
  tracker.step("native", "恢复线程")
  tracker.observe({ type: "codex.turn.started", runID: "run", conversationTurn: 1, properties: {} })
  assert.equal(tracker.record.status, "running", "An older user turn cannot complete the new preparation")
  tracker.observe({ type: "codex.thread.started", properties: { thread_id: "thread" } })
  assert.equal(tracker.record.status, "running")
  tracker.observe({ id: "turn-start", type: "codex.turn.started", receivedAt: new Date().toISOString(), properties: {} })
  assert.equal(tracker.record.status, "completed")
  assert.equal(tracker.record.output.sessionID, "thread")
  assert.equal(tracker.record.nodeID, "c-server")
})

test("Failures, interruption and missing confirmation are distinct preparation outcomes", () => {
  for (const state of ["failed", "cancelled", "unconfirmed"]) {
    const tracker = startPreparation({ harness: "opencode", runID: "run", turnNumber: 1, input: {} }, () => {})
    tracker.step("session", "创建会话")
    if (state === "failed") tracker.fail(new Error("native session creation failed"))
    if (state === "cancelled") tracker.cancel()
    if (state === "unconfirmed") tracker.unconfirmed()
    assert.equal(tracker.record.status, state)
    assert.equal(tracker.record.steps[0].status, state)
    assert.equal(tracker.record.endedAt == null, state === "unconfirmed")
    assert.equal(tracker.record.durationMs == null, state === "unconfirmed")
  }
})
