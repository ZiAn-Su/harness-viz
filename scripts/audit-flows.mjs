// Verify diagram/documentation coverage and source anchors against pinned checkouts.
// Requires ../opencode and ../codex; does not run CLIs or call models.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import { loadFlowModel, validateFlowGraph } from "./flow-model.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const html = await readFile(path.join(root, "public", "index.html"), "utf8")
const locks = JSON.parse(await readFile(path.join(root, "src", "versions.json"), "utf8"))
const flows = await loadFlowModel()
const names = html.slice(html.indexOf("const NAMES ="), html.indexOf("const nodeNames ="))
const docs = html.slice(html.indexOf("const SOURCE_PINS ="), html.indexOf("/* ═══════════ 连接 & 控制"))
const data = vm.runInNewContext(names + docs + "; ({names:NAMES, docs:DOCS, pins:SOURCE_PINS})", {
  escapeHtml: value => String(value),
  HarnessFlows: flows,
}, { timeout: 1000 })
const diagram = flows.render("opencode") + flows.render("codex")
const nodes = [...diagram.matchAll(/data-node="([^"]+)"/g)].map(match => match[1])
assert.equal(nodes.length, new Set(nodes).size, "diagram node IDs must be unique")
assert.equal((diagram.match(/viewBox="0 0 700 1070"/g) ?? []).length, 2)
const results = []
for (const harness of ["opencode", "codex"]) {
  const pin = data.pins[harness]
  const checkout = path.resolve(root, "..", harness)
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim()
  assert.equal(commit, locks[harness].commit, `${harness} checkout must match versions.json`)
  assert.equal(pin.commit, commit, `${harness} UI source pin must match the checkout`)
  assert.equal(pin.tag, locks[harness].tag)
  const visible = nodes.filter(id => harness === "codex" ? id.startsWith("c-") : !id.startsWith("c-"))
  const geometry = validateFlowGraph(flows.graphs[harness], flows.size)
  assert.deepEqual(Object.keys(data.names[harness]).sort(), [...visible].sort(), `${harness}: names must match visible nodes`)
  assert.deepEqual(Object.keys(data.docs[harness]).sort(), [...visible].sort(), `${harness}: each node needs one explanation`)
  const sourceFiles = new Map()
  let anchors = 0
  for (const [node, explanation] of Object.entries(data.docs[harness])) {
    const links = [...explanation.matchAll(/href="(https:\/\/github\.com\/[^\"]+)"/g)]
    assert(links.length > 0, `${node} needs a source anchor`)
    for (const [, link] of links) {
      const url = new URL(link)
      const prefix = `/${pin.repo}/blob/${commit}/`
      assert(url.pathname.startsWith(prefix), `${node}: source links must use the fixed commit`)
      const file = url.pathname.slice(prefix.length)
      assert(file.startsWith(pin.root), `${node}: unexpected source root`)
      if (!sourceFiles.has(file)) sourceFiles.set(file, (await readFile(path.join(checkout, file), "utf8")).split(/\r?\n/))
      const range = /^#L(\d+)(?:-L(\d+))?$/.exec(url.hash)
      assert(range, `${node}: source link must include line numbers`)
      const first = Number(range[1]), last = Number(range[2] ?? range[1])
      assert(first > 0 && last >= first && last <= sourceFiles.get(file).length, `${node}: invalid source range ${file}${url.hash}`)
      assert(sourceFiles.get(file).slice(first - 1, last).join("").trim(), `${node}: source range must not be empty`)
      anchors++
    }
  }
  results.push({ harness, version: locks[harness].version, commit, ...geometry, sourceFiles: sourceFiles.size, anchors })
}
console.log(JSON.stringify({ checks: "node coverage, fixed source anchors, shapes, declared normal/exception branches, nesting, orthogonal ports and unobstructed node connections", scope: "Source-link validity and structural checks; semantic conditions are reviewed in docs/flow-audit.md, not proved by this script or synthetic events.", results }, null, 2))
