// Verify mechanism correspondence against persisted real events; no CLI/model calls.
import { readFile } from "node:fs/promises"
import vm from "node:vm"
import assert from "node:assert/strict"
import { loadFlowModel, validateFlowGraph } from "./flow-model.mjs"

if (!process.argv[2]) throw new Error("Usage: node scripts/audit-runtime-routes.mjs <run-id>")
const flows = await loadFlowModel()
validateFlowGraph(flows.graphs.opencode, flows.size)
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8")
const start = html.indexOf("const HarnessEvidence ="), end = html.indexOf('\nfor (const h of ["opencode", "codex"])', start)
assert(start >= 0 && end > start)
const evidence = vm.runInNewContext(html.slice(start, end) + "; HarnessEvidence", { HarnessFlows: flows }, { timeout: 1000 })
const raw = await readFile(new URL("../.runtime/events.jsonl", import.meta.url), "utf8")
const lines = raw.split(/\r?\n/)
lines.pop() // A currently-being-written final line is not a committed JSONL record.
const events = lines.filter(Boolean).map(line => JSON.parse(line)).filter(event => event.runID === process.argv[2] && event.harness === "opencode")
// Admission now precedes asynchronous session creation. Only explicit native /
// preparation identity is accepted; do not guess the root from model-call order.
const root = events.find(event => event.type === "viz.run" && event.properties.sessionID)?.properties.sessionID
  ?? events.find(event => event.type === "viz.preparation" && event.properties.execution?.output?.sessionID)?.properties.execution.output.sessionID
  ?? events.find(event => event.type === "session.created" && event.properties.info?.id && !event.properties.info.parentID)?.properties.info.id
assert(root && events.length, "Recorded run must contain a task with a root session")
const parents = new Map(), timeline = evidence.createTimeline()
for (const event of events) {
  const p = event.properties ?? {}
  if (p.info?.parentID && p.info?.id) parents.set(p.info.id, p.info.parentID)
  if (p.parentSessionID && p.sessionID) parents.set(p.sessionID, p.parentSessionID)
  const session = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID ?? p.info?.id ?? null
  let owner = session, child = false
  const seen = new Set()
  while (owner && owner !== root && !seen.has(owner)) { seen.add(owner); owner = parents.get(owner); child = true }
  if (session && owner !== root) continue
  timeline.feed(event, { child, scope: child ? "子会话" : "主会话" })
}
const rows = timeline.entries()
const requests = rows.filter(row => row.kind === "model-request")
const report = { runID: process.argv[2], capturedEvents: events.length, keyRecords: rows.length,
  parentRequests: requests.filter(row => !row.child).map(row => row.index), childRequests: requests.filter(row => row.child).map(row => row.index),
  routes: rows.filter(row => ["model-request", "returned"].includes(row.kind)).map(row => {
    const relation = evidence.relation(rows, row)
    return { request: row.index ?? null, event: row.kind, child: row.child, route: relation.path?.nodes ?? null,
      evidence: relation.path ? "source mechanism; not native branch trace" : "unconfirmed" }
  }) }
if (requests.length === 1 && !requests[0].child) {
  assert.deepEqual(Array.from(evidence.relation(rows, requests[0]).path.nodes), ["server", "loop", "decide", "subflow1", "subflow3", "llm"])
  const returned = rows.find(row => row.kind === "returned")
  const response = rows.find(row => row.kind === "model-response")
  if (returned?.finish === "stop" && !returned.error && response?.toolCalls?.length === 0 && !response.error) assert.deepEqual(Array.from(evidence.relation(rows, returned).path.nodes), ["llm", "decide2", "exec", "outcome", "loop", "decide", "done"])
}
console.log(JSON.stringify(report, null, 2))
