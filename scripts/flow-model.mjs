import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"

export async function loadFlowModel() {
  const source = await readFile(new URL("../public/flows.js", import.meta.url), "utf8")
  const context = vm.createContext({})
  new vm.Script(source, { filename: "flows.js" }).runInContext(context, { timeout: 1000 })
  return context.HarnessFlows
}

export function validateFlowGraph(graph, size) {
  const nodes = new Map(graph.nodes.map(n => [n.id, n]))
  assert.equal(nodes.size, graph.nodes.length, "node IDs must be unique")
  const containers = new Map([...graph.regions, ...graph.nodes.filter(n => n.shape === "environment")].map(n => [n.id, n]))
  const controls = graph.nodes.filter(n => n.shape !== "environment")
  for (const n of graph.nodes) {
    assert(n.x >= 0 && n.y >= 0 && n.x + n.width <= size.width && n.y + n.height <= size.height, `${n.id}: outside canvas`)
    if (n.shape !== "environment") assert.equal(n.height, 64)
    assert(["terminal", "process", "decision", "subprocess", "environment"].includes(n.shape), `${n.id}: unknown shape`)
    if (n.parent) {
      const p = containers.get(n.parent)
      assert(p, `${n.id}: parent missing`)
      assert(n.x >= p.x && n.y >= p.y && n.x + n.width <= p.x + p.width && n.y + n.height <= p.y + p.height, `${n.id}: outside its region`)
    } else assert.equal(n.shape === "terminal" || n.id.endsWith("server"), true, `${n.id}: loop work must be inside the loop`)
  }
  for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
    const a = controls[i], b = controls[j]
    assert(!(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height), `${a.id}/${b.id}: nodes overlap`)
  }
  const outgoing = new Map()
  const onBoundary = (p, n) => n.shape === "decision"
    ? Math.abs(Math.abs(p[0] - (n.x + n.width / 2)) / (n.width / 2) + Math.abs(p[1] - (n.y + n.height / 2)) / (n.height / 2) - 1) < .001
    : ((p[0] === n.x || p[0] === n.x + n.width) && p[1] >= n.y && p[1] <= n.y + n.height)
      || ((p[1] === n.y || p[1] === n.y + n.height) && p[0] >= n.x && p[0] <= n.x + n.width)
  for (const e of graph.edges) {
    assert(nodes.has(e.from) && nodes.has(e.to), `${e.from}->${e.to}: endpoint missing`)
    assert(["normal", "loop", "child", "exit"].includes(e.kind), `${e.from}->${e.to}: unknown connector kind`)
    if (e.kind === "exit") {
      assert(nodes.get(e.from).exceptions?.includes(e.label), `${e.from}: exceptional exit must be explicitly declared`)
      assert.equal(nodes.get(e.to).shape, "terminal", `${e.from}: exceptional exit must return to a terminal`)
    }
    const points = [...e.path.matchAll(/[ML](-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map(m => [Number(m[1]), Number(m[2])])
    assert(points.length >= 2)
    assert(onBoundary(points[0], nodes.get(e.from)), `${e.from}: start port is not on the shape boundary`)
    assert(onBoundary(points.at(-1), nodes.get(e.to)), `${e.to}: end port is not on the shape boundary`)
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i]
      assert(a[0] === b[0] || a[1] === b[1], `${e.from}->${e.to}: non-orthogonal connector`)
      for (const n of controls.filter(n => n.id !== e.from && n.id !== e.to)) {
        const cuts = a[0] === b[0]
          ? a[0] > n.x && a[0] < n.x + n.width && Math.max(a[1], b[1]) > n.y && Math.min(a[1], b[1]) < n.y + n.height
          : a[1] > n.y && a[1] < n.y + n.height && Math.max(a[0], b[0]) > n.x && Math.min(a[0], b[0]) < n.x + n.width
        assert(!cuts, `${e.from}->${e.to}: connector crosses ${n.id}`)
      }
    }
    const list = outgoing.get(e.from) ?? []
    list.push(e); outgoing.set(e.from, list)
  }
  for (const n of controls) {
    const edges = outgoing.get(n.id) ?? []
    if (n.shape === "decision") {
      const branches = n.branches ?? 2
      assert(Number.isInteger(branches) && branches >= 2, `${n.id}: invalid branch count`)
      assert.equal(edges.length, branches, `${n.id}: decisions need all declared branches`)
      assert(edges.every(e => e.label), `${n.id}: branches must be labelled`)
      assert.equal(new Set(edges.map(e => e.label)).size, branches)
      const inputPorts = graph.edges.filter(e => e.to === n.id).map(e => [...e.path.matchAll(/[ML](-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].at(-1)).map(m => `${m[1]},${m[2]}`)
      const outputPorts = edges.map(e => e.path.match(/^M(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)).map(m => `${m[1]},${m[2]}`)
      assert.equal(new Set(outputPorts).size, edges.length, `${n.id}: decision branches must use separate exit ports`)
      assert(outputPorts.every(port => !inputPorts.includes(port)), `${n.id}: exit must not reuse the incoming port`)
    } else {
      assert.equal(edges.filter(e => e.kind !== "exit").length, n.id.endsWith("done") ? 0 : 1, `${n.id}: processing nodes must not hide a normal result decision`)
      assert.deepEqual(edges.filter(e => e.kind === "exit").map(e => e.label).sort(), [...(n.exceptions ?? [])].sort(), `${n.id}: declared exception exits must be drawn`)
    }
  }
  const reachable = new Set(), queue = [controls.find(n => n.id.endsWith("ui")).id]
  while (queue.length) {
    const id = queue.shift()
    if (reachable.has(id)) continue
    reachable.add(id)
    for (const e of outgoing.get(id) ?? []) queue.push(e.to)
  }
  assert(controls.every(n => reachable.has(n.id)), "all control-flow nodes must be reachable")
  return { nodes: graph.nodes.length, edges: graph.edges.length, decisions: controls.filter(n => n.shape === "decision").length }
}
