import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"

// Execute the audit's identity selection, not a duplicate of that logic.
const audit = await readFile(new URL("../scripts/audit-runtime-routes.mjs", import.meta.url), "utf8")
const start = audit.indexOf("const root = events.")
const end = audit.indexOf("\nassert(root", start)
assert(start >= 0 && end > start)
const selection = new vm.Script(audit.slice(start, end) + "\nroot")
const rootOf = events => selection.runInNewContext({ events }, { timeout: 1000 })

test("runtime audit accepts root identity confirmed after asynchronous admission", () => {
  assert.equal(rootOf([
    { type: "viz.run", properties: { sessionID: null } },
    { type: "viz.preparation", properties: { execution: { output: {} } } },
    { type: "session.created", properties: { info: { id: "child", parentID: "root" } } },
    { type: "viz.preparation", properties: { execution: { output: { sessionID: "root" } } } },
  ]), "root")
})

test("runtime audit uses a native root creation record and preserves legacy admission IDs", () => {
  const native = [
    { type: "session.created", properties: { info: { id: "child", parentID: "root" } } },
    { type: "session.created", properties: { info: { id: "root" } } },
  ]
  assert.equal(rootOf(native), "root")
  assert.equal(rootOf([{ type: "viz.run", properties: { sessionID: "legacy-root" } }, ...native]), "legacy-root")
})

test("runtime audit does not infer root identity from a model request or child creation", () => {
  assert.equal(rootOf([
    { type: "viz.run", properties: { sessionID: null } },
    { type: "llm.request", properties: { sessionID: "guessed-root" } },
    { type: "session.created", properties: { info: { id: "child", parentID: "guessed-root" } } },
  ]), undefined)
})
