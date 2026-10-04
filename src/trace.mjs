import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

// Payload references are untrusted file data, not arbitrary filesystem access.
export async function readTraceEvents(root, cursors) {
  const events = []
  const nextCursors = new Map()
  const bundles = await readdir(root, { withFileTypes: true })
  for (const bundle of bundles) {
    if (!bundle.isDirectory() || !bundle.name.startsWith("trace-")) continue
    const dir = path.join(root, bundle.name)
    let text
    try { text = await readFile(path.join(dir, "trace.jsonl"), "utf8") }
    catch (err) { if (err.code === "ENOENT") continue; throw err }
    const lines = text.split("\n")
    lines.pop() // An unfinished line must be retried after the writer completes it.
    let cursor = cursors.get(bundle.name) ?? 0
    for (; cursor < lines.length; cursor++) {
      if (!lines[cursor].trim()) continue
      const event = JSON.parse(lines[cursor])
      const payloads = {}
      for (const [key, ref] of Object.entries(event.payload ?? {})) {
        if (!ref || typeof ref !== "object" || typeof ref.path !== "string") continue
        const absolute = path.resolve(dir, ref.path)
        const relative = path.relative(dir, absolute)
        if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.startsWith("payloads" + path.sep)) {
          throw new Error("Unsafe trace payload path")
        }
        payloads[key] = JSON.parse(await readFile(absolute, "utf8"))
      }
      events.push({ bundle: bundle.name, event, payloads })
    }
    nextCursors.set(bundle.name, cursor)
  }
  for (const [bundle, cursor] of nextCursors) cursors.set(bundle, cursor)
  return events
}

export function requestTools(request) {
  const r = request?.request ?? request ?? {}
  const embedded = (r.input ?? []).filter(item => item.type === "additional_tools").flatMap(item => item.tools ?? [])
  const specs = Array.isArray(r.tools) ? r.tools : embedded.length ? embedded : null
  const flatten = (tools, prefix = "") => tools.flatMap(tool => tool.type === "namespace"
    ? flatten(tool.tools ?? [], prefix + (tool.name ?? "namespace") + ".")
    : [prefix + (tool.name ?? tool.function?.name ?? tool.type)])
  return { names: specs === null ? null : flatten(specs), location: Array.isArray(r.tools) ? "tools" : embedded.length ? "input.additional_tools" : "not-in-this-payload" }
}

export function summarizeResponse(raw) {
  const items = raw?.output_items ?? []
  const toolItems = items.filter(item => ["function_call", "custom_tool_call", "tool_search_call"].includes(item.type))
  return {
    text: items.filter(item => item.type === "message").flatMap(item => item.content ?? [])
      .filter(block => block.type === "output_text").map(block => block.text ?? "").join(""),
    thinking: items.filter(item => item.type === "reasoning").flatMap(item => item.summary ?? [])
      .map(block => block.text ?? "").join("\n"),
    toolCalls: toolItems.map(item => item.name ?? item.type),
    toolUses: toolItems.map(item => {
      let input = item.input ?? item.arguments ?? null
      if (typeof item.arguments === "string") {
        try { input = JSON.parse(item.arguments) } catch {}
      }
      return { name: item.name ?? item.type, input, callID: item.call_id }
    }),
    stopReason: null,
    usage: raw?.token_usage ?? null,
  }
}
