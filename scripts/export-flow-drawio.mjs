// Export the same validated teaching graphs as editable native draw.io XML.
import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { loadFlowModel, validateFlowGraph } from "./flow-model.mjs"

const flows = await loadFlowModel()
const escape = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "&#xa;")
const pages = []
for (const [harness, graph] of Object.entries(flows.graphs)) {
  validateFlowGraph(graph, flows.size)
  const environment = graph.nodes.find(n => n.shape === "environment")
  const containers = new Map([...graph.regions, environment].map(n => [n.id, n]))
  const nodes = new Map(graph.nodes.map(n => [n.id, n]))
  const cellID = id => id ? harness + "-" + id : "1"
  const cells = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>']
  const vertex = (n, value, style) => {
    const parent = containers.get(n.parent)
    const x = n.x - (parent?.x ?? 0), y = n.y - (parent?.y ?? 0)
    cells.push(`<mxCell id="${cellID(n.id)}" value="${escape(value)}" style="${style}" vertex="1" parent="${cellID(n.parent)}"><mxGeometry x="${x}" y="${y}" width="${n.width}" height="${n.height}" as="geometry"/></mxCell>`)
  }
  const regionStyle = "rounded=1;dashed=1;dashPattern=7 5;container=1;pointerEvents=0;collapsible=0;whiteSpace=wrap;html=1;verticalAlign=top;align=left;spacingTop=4;spacingLeft=12;fontSize=12;fontColor=#287c86;strokeColor=#4b9fa8;fillColor=none;"
  for (const region of graph.regions) vertex(region, region.title, regionStyle)
  vertex(environment, environment.title + "\n" + environment.detail, "swimlane;startSize=34;container=1;pointerEvents=0;collapsible=0;html=1;fontSize=12;fillColor=#edf2f7;strokeColor=#8393a8;")
  const styles = {
    terminal: "ellipse;perimeter=ellipsePerimeter;",
    process: "rounded=1;arcSize=12;",
    decision: "rhombus;perimeter=rhombusPerimeter;",
    subprocess: "shape=process;",
  }
  for (const n of graph.nodes.filter(n => n.shape !== "environment"))
    vertex(n, n.title + (n.detail ? "\n" + n.detail : ""), styles[n.shape] + "whiteSpace=wrap;html=1;fontSize=15;fontColor=#25364a;strokeColor=#738397;fillColor=#f4f7fb;")
  const ancestors = n => {
    const result = []
    let id = n.parent
    while (id) { result.push(id); id = containers.get(id)?.parent }
    return [...result, null]
  }
  for (const [index, e] of graph.edges.entries()) {
    const source = nodes.get(e.from), target = nodes.get(e.to)
    const targetParents = ancestors(target)
    const parentID = ancestors(source).find(id => targetParents.includes(id))
    const parent = containers.get(parentID)
    const points = [...e.path.matchAll(/[ML](\d+),(\d+)/g)].map(m => ({ x: Number(m[1]), y: Number(m[2]) }))
    const first = points[0], last = points.at(-1)
    const exitX = (first.x - source.x) / source.width, exitY = (first.y - source.y) / source.height
    const entryX = (last.x - target.x) / target.width, entryY = (last.y - target.y) / target.height
    const color = e.kind === "loop" ? "#2b9ba5" : e.kind === "child" ? "#9271bc" : e.kind === "exit" ? "#c25962" : "#7b8898"
    const route = points.slice(1, -1).map(p => `<mxPoint x="${p.x - (parent?.x ?? 0)}" y="${p.y - (parent?.y ?? 0)}"/>`).join("")
    cells.push(`<mxCell id="${harness}-edge-${index}" value="${escape(e.label)}" style="edgeStyle=segmentEdgeStyle;rounded=0;html=1;endArrow=classic;endFill=1;jumpStyle=arc;jumpSize=6;strokeColor=${color};fontSize=11;exitX=${exitX};exitY=${exitY};entryX=${entryX};entryY=${entryY};exitPerimeter=0;entryPerimeter=0;" edge="1" source="${cellID(e.from)}" target="${cellID(e.to)}" parent="${cellID(parentID)}"><mxGeometry relative="1" as="geometry">${route ? `<Array as="points">${route}</Array>` : ""}</mxGeometry></mxCell>`)
  }
  cells.push(`<mxCell id="${harness}-legend" value="${escape("椭圆：入口/返回   矩形：处理   菱形：有标签的二向/多向结果   双边矩形：子流程\n虚线边界：主循环   实线区域：环境与权限   红线：已声明的终止异常")}" style="text;html=1;whiteSpace=wrap;align=left;fontSize=12;fontColor=#64748b;" vertex="1" parent="1"><mxGeometry x="20" y="1074" width="660" height="42" as="geometry"/></mxCell>`)
  pages.push(`<diagram id="${harness}" name="${graph.name}"><mxGraphModel adaptiveColors="auto" grid="1" gridSize="8" page="1" pageWidth="700" pageHeight="1120"><root>${cells.join("\n")}</root></mxGraphModel></diagram>`)
}
const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="app.diagrams.net" pages="2">\n' + pages.join("\n") + "\n</mxfile>\n"
const target = new URL("../docs/assets/coding-agent-flows.drawio", import.meta.url)
if (process.argv.includes("--check")) assert.equal(await readFile(target, "utf8"), xml, "draw.io source must match the page model")
else await writeFile(target, xml, "utf8")
console.log(process.argv.includes("--check") ? "Editable draw.io source matches both teaching diagrams" : "Generated docs/assets/coding-agent-flows.drawio")
