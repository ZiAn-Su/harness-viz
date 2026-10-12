// 模板预览：把已捕获的请求 JSON 按所选公开模板拼接成送入 tokenizer 前的文本。
// 模板文件随仓库固定在 src/templates/（URL+revision+sha256 锁定），无需联网。
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
// @huggingface/jinja 0.5.10; MIT license retained in ./vendor/jinja/LICENSE.
import { Template } from "./vendor/jinja/index.js"
import { buildCallRecord } from "./call-record.mjs"

const TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "templates")

/* ───────────── 模板注册表（固定上游版本，不用相近文件冒充） ───────────── */
export const TEMPLATE_REGISTRY = [
  {
    id: "qwen38",
    label: "Qwen3.8",
    model: "Qwen/Qwen3.8-2.4T-A95B",
    engine: "jinja",
    file: "qwen38.chat_template.jinja",
    sourceUrl: "https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B/raw/207bd685a7e3696cfaff12ded7c6a7ea0f88c996/chat_template.jinja",
    revision: "207bd685a7e3696cfaff12ded7c6a7ea0f88c996",
    sha256: "40ce34a5bcbc0231462740761215bc31a83882a8b3a4b6aa1c6e869b95945e4e",
    note: "托管版 Qwen3.8-Max 基于此开放版但有更多功能，此外推无效。",
  },
  {
    id: "glm53",
    label: "GLM5.3",
    model: "zai-org/GLM-5.3",
    engine: "jinja",
    file: "glm53.chat_template.jinja",
    sourceUrl: "https://huggingface.co/zai-org/GLM-5.3/raw/aca966e4e02791568aa6a4ced368624b3d897f42/chat_template.jinja",
    revision: "aca966e4e02791568aa6a4ced368624b3d897f42",
    sha256: "3740abcea51c45830cb3ca562084ad5fb2ef53589376f73332e9886f93ade41c",
    note: "",
  },
  {
    id: "glm53-flash",
    label: "GLM5.3-Flash",
    model: "zai-org/GLM-5.3-Flash",
    engine: "jinja",
    file: "glm53-flash.chat_template.jinja",
    sourceUrl: "https://huggingface.co/zai-org/GLM-5.3-Flash/raw/eb9eb208eb0d988989d07a6a12d0fdeb5f52574a/chat_template.jinja",
    revision: "eb9eb208eb0d988989d07a6a12d0fdeb5f52574a",
    sha256: "0c4099f3382d6c92700dfb99725025360966fd73032f0ecf32377c0d9e6309c5",
    note: "Flash 独立公开模板，包含多模态标记；占位文本不等于图像/视频嵌入或 Ark 服务端模板。",
  },
  {
    id: "kimi-k3",
    label: "Kimi K3",
    model: "moonshotai/Kimi-K3",
    engine: "xtml-kimi",
    file: null, // Kimi K3 没有独立 chat_template.jinja，官方拼接在 encoding_k3.py
    sourceUrl: "https://huggingface.co/moonshotai/Kimi-K3/raw/f831ab66814297da540d832a5235f8e904f29d06/encoding_k3.py",
    revision: "f831ab66814297da540d832a5235f8e904f29d06",
    sha256: null,
    note: "官方用 Python encoding_k3.py 拼接 XTML；此处为逐行等价 JS 移植，已对照官方输出做字节级 golden 测试。",
  },
]

export function listTemplates() {
  return TEMPLATE_REGISTRY.map(({ id, label, model, engine, sourceUrl, revision, note }) =>
    ({ id, label, model, engine, sourceUrl, revision, note }))
}

const templateCache = new Map()

/* 模板文件随仓库 vendored（src/templates/），加载时校验 sha256，无需联网。 */
export async function loadTemplate(entry) {
  if (templateCache.has(entry.id)) return templateCache.get(entry.id)
  const text = await readFile(path.join(TEMPLATE_DIR, entry.file), "utf8")
  const digest = createHash("sha256").update(text, "utf8").digest("hex")
  if (digest !== entry.sha256) throw new Error(`模板文件哈希不匹配（${entry.id}）：src/templates/${entry.file} 与固定版本不一致`)
  const compiled = new Template(text)
  templateCache.set(entry.id, compiled)
  return compiled
}

/* ───────────── Python 风格 JSON 序列化（对齐 json.dumps） ───────────── */
// json.dumps(ensure_ascii=False) 默认分隔符：", " / ": "
function pyJsonSpaced(value) {
  if (value === null) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") return pyNumber(value)
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return "[" + value.map(pyJsonSpaced).join(", ") + "]"
  return "{" + Object.entries(value).map(([k, v]) => JSON.stringify(k) + ": " + pyJsonSpaced(v)).join(", ") + "}"
}
// json.dumps(separators=(",",":")) 紧凑形式；JS JSON.stringify 行为一致（非 ASCII 不转义）
const pyJsonCompact = value => JSON.stringify(value)
// Python repr 数字与 JS 的差异主要在整数浮点（100.0 → "100"）。无法从 JS number 恢复。
function pyNumber(value) {
  return String(value)
}

/* ───────────── Kimi K3 XTML（encoding_k3.py 固定版本的等价移植） ───────────── */
// Derived from Moonshot AI's encoder; upstream license: ./templates/LICENSE.kimi-k3.
const OPEN = "<|open|>", CLOSE = "<|close|>", SEP = "<|sep|>", EOM = "<|end_of_msg|>"
const VALID_THINKING_EFFORTS = new Set(["low", "high", "max"])

const escapeAttr = value => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")
const openTag = (tag, attrs = []) =>
  OPEN + tag + attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("") + SEP
const closeTag = tag => CLOSE + tag + SEP

function xtmlType(value) {
  if (typeof value === "boolean") return "boolean"
  if (value === null) return "null"
  if (typeof value === "number") return "number"
  if (typeof value === "string") return "string"
  if (Array.isArray(value)) return "array"
  return "object"
}
const xtmlValue = value => typeof value === "string" ? value : pyJsonSpaced(value)

function deepSortDict(obj) {
  if (Array.isArray(obj)) return obj.map(deepSortDict)
  if (obj && typeof obj === "object")
    return Object.fromEntries(Object.keys(obj).sort().map(k => [k, deepSortDict(obj[k])]))
  return obj
}

/* 单层 JSON object 解析：非字符串值保留原始字面量文本（1e2 仍是 1e2）。 */
function parseArgumentsObject(s) {
  let idx = 0
  const skipWs = () => { while (idx < s.length && " \t\n\r".includes(s[idx])) idx++ }
  const fail = message => { throw new Error(message) }
  const rawDecode = () => {
    const start = idx
    const c = s[idx]
    if (c === '"') {
      idx++
      let out = ""
      while (idx < s.length) {
        const ch = s[idx++]
        if (ch === '"') return [out, s.slice(start, idx)]
        if (ch === "\\") {
          const esc = s[idx++]
          if (esc === "u") { out += String.fromCharCode(parseInt(s.slice(idx, idx + 4), 16)); idx += 4 }
          else out += { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[esc] ?? fail("bad escape")
        } else out += ch
      }
      fail("unterminated string")
    }
    if (c === "{") { // 嵌套对象：找到配平结束，保留原文
      let depth = 0, inStr = false, esc = false
      for (; idx < s.length; idx++) {
        const ch = s[idx]
        if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue }
        if (ch === '"') inStr = true
        else if (ch === "{") depth++
        else if (ch === "}") { depth--; if (depth === 0) { idx++; return [JSON.parse(s.slice(start, idx)), s.slice(start, idx)] } }
      }
      fail("unterminated object")
    }
    if (c === "[") {
      let depth = 0, inStr = false, esc = false
      for (; idx < s.length; idx++) {
        const ch = s[idx]
        if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue }
        if (ch === '"') inStr = true
        else if (ch === "[") depth++
        else if (ch === "]") { depth--; if (depth === 0) { idx++; return [JSON.parse(s.slice(start, idx)), s.slice(start, idx)] } }
      }
      fail("unterminated array")
    }
    const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|^true|^false|^null/.exec(s.slice(idx))
    if (!m) fail("invalid JSON value")
    idx += m[0].length
    return [JSON.parse(m[0]), m[0]]
  }
  skipWs()
  if (s[idx++] !== "{") fail("JSON arguments must be an object")
  skipWs()
  const parsed = []
  if (idx >= s.length) fail("Unexpected end of JSON object")
  if (s[idx] === "}") return parsed
  while (true) {
    skipWs()
    const [key] = rawDecode()
    if (typeof key !== "string") fail("JSON object key must be a string")
    skipWs()
    if (s[idx++] !== ":") fail("Expects ':' after key")
    skipWs()
    const valueStart = idx
    const [value, raw] = rawDecode()
    parsed.push([key, xtmlType(value), typeof value === "string" ? value : s.slice(valueStart, idx)])
    skipWs()
    const c = s[idx++]
    skipWs()
    if (c === "}") break
    if (c !== ",") fail("Expect '}' or ','")
  }
  return parsed
}

/* 返回 [triples, rawJsonBlock]，与 normalize_tool_arguments 一致。 */
function normalizeToolArguments(args) {
  if (args === null || args === undefined) return [[], null]
  if (typeof args === "object" && !Array.isArray(args))
    return [Object.entries(args).map(([k, v]) => [String(k), xtmlType(v), xtmlValue(v)]), null]
  if (typeof args === "string") {
    if (args === "") return [[], null]
    try { return [parseArgumentsObject(args), null] }
    catch { return [[], args] }
  }
  throw new TypeError("Kimi K3 tool call arguments must be a dict or a JSON object string.")
}

function normalizeKimiMessage(message) {
  if (!message || typeof message !== "object") return message
  const normalized = { ...message }
  if (normalized.tools != null) normalized.tools = deepSortDict(normalized.tools)
  if (!normalized.tool_calls?.length) return normalized
  normalized.tool_calls = normalized.tool_calls.map(call => {
    if (!call || typeof call !== "object") return call
    const tc = { ...call }
    const target = tc.function && typeof tc.function === "object" ? (tc.function = { ...tc.function }) : tc
    const [args, jsonBlock] = normalizeToolArguments(target.arguments)
    target.arguments = args
    if (jsonBlock === null) delete target._xtml_json_block
    else target._xtml_json_block = jsonBlock
    return tc
  })
  return normalized
}

function toolCallIdIndex(toolCalls) {
  const index = new Map()
  if (!Array.isArray(toolCalls)) return index
  let position = 0
  for (const call of toolCalls) {
    position++
    if (!call || typeof call !== "object" || call.id == null) continue
    const key = String(call.id)
    if (index.has(key)) continue
    const name = call.function && typeof call.function === "object" ? call.function.name : call.name
    index.set(key, [position, name])
  }
  return index
}

/* 乱序 tool 结果按 tool_call_id 排回调用顺序；无法完整匹配的一段保持原样。 */
function normalizeXtmlToolResultMessages(messages) {
  if (!Array.isArray(messages)) return messages
  const output = []
  let currentIndex = new Map()
  let i = 0
  while (i < messages.length) {
    const message = messages[i]
    if (message?.role === "assistant") {
      currentIndex = message.tool_calls ? toolCallIdIndex(message.tool_calls) : new Map()
      output.push(message); i++; continue
    }
    if (message?.role !== "tool") { output.push(message); i++; continue }
    const run = []
    let unresolved = false, offset = 0
    while (i < messages.length && messages[i]?.role === "tool") {
      const toolMessage = messages[i]
      const callId = toolMessage.tool_call_id ?? toolMessage.id
      const matched = callId != null ? currentIndex.get(String(callId)) : undefined
      if (matched === undefined) { unresolved = true; run.push([null, offset, toolMessage, null]) }
      else run.push([matched[0], offset, toolMessage, matched[1]])
      offset++; i++
    }
    if (unresolved) { for (const item of run) output.push(item[2]); continue }
    run.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
    for (const [, , toolMessage, name] of run) {
      if (name == null) { output.push(toolMessage); continue }
      const resolved = { ...toolMessage, tool: name }
      if ("name" in resolved) resolved.name = name
      output.push(resolved)
    }
  }
  return output
}

function renderContentSegments(content) {
  if (typeof content === "string") return content
  if (content == null) return ""
  let out = ""
  for (const part of content) {
    if (part?.type === "image" || part?.type === "image_url") out += "<|kimi_image_placeholder|>"
    else out += String(part?.text ?? "")
  }
  return out
}

const internalSystem = (type, body) =>
  openTag("message", [["role", "system"], ["type", type]]) + body.trim() + closeTag("message") + EOM

function renderAssistantKimi(message, thinking) {
  let out = ""
  if (thinking) {
    const reasoning = message.reasoning_content || message.reasoning
    out += openTag("think")
    if (reasoning != null && String(reasoning) !== "") out += String(reasoning)
    out += closeTag("think")
  }
  out += openTag("response") + renderContentSegments(message.content) + closeTag("response")
  const toolCalls = message.tool_calls
  if (toolCalls?.length) {
    out += openTag("tools")
    let index = 0
    for (const call of toolCalls) {
      index++
      const fn = call.function ?? call
      out += openTag("call", [["tool", fn.name], ["index", index]])
      const jsonBlock = fn._xtml_json_block
      if (jsonBlock != null) out += openTag("json", [["type", "object"]]) + jsonBlock + closeTag("json")
      else for (const [key, type, text] of fn.arguments ?? [])
        out += openTag("argument", [["key", key], ["type", type]]) + String(text) + closeTag("argument")
      out += closeTag("call")
    }
    out += closeTag("tools")
  }
  return out
}

function renderToolDeclare(tools, dynamic = false) {
  const body = dynamic
    ? "## New Tools Available\nThe system dynamically extends the toolset via lazy-loading.\nYou have access to all existing and extended tools.\nHere are the specs for the extended tools.\n\n```json\n" + pyJsonCompact(tools) + "\n```"
    : "# Tools\nHere are the available tools, described in JSONSchema.\n\n```json\n" + pyJsonCompact(tools) + "\n```"
  return openTag("message", [["role", "system"], ["type", "tool-declare"]]) + body + closeTag("message") + EOM
}

export function renderKimiXtml({ messages, tools = null, addGenerationPrompt = true, thinking = true,
  thinkingEffort = null, toolChoice = null, responseFormat = null, responseSchema = null }) {
  responseSchema = deepSortDict(responseSchema)
  let msgs = normalizeXtmlToolResultMessages(messages).map(normalizeKimiMessage)
  const sortedTools = deepSortDict(tools)
  let out = ""
  if (sortedTools?.length) out += renderToolDeclare(sortedTools)
  if (thinking && thinkingEffort != null) {
    if (!VALID_THINKING_EFFORTS.has(thinkingEffort)) throw new Error(`Unsupported thinking_effort=${thinkingEffort}`)
    out += internalSystem("thinking-effort",
      "`thinking_effort` guides on how much to think in your thinking channel (not including the response channel), supported values include `low`, `medium`, `high`, and `max`.\n" +
      `Now the system is invoked with \`thinking_effort=${thinkingEffort}\`.`)
  }
  let toolCalls = null, toolIndex = 0
  for (const message of msgs) {
    const role = message?.role
    if (role === "user") {
      const attrs = [["role", "user"]]
      if (message.name) attrs.push(["name", message.name])
      out += openTag("message", attrs) + renderContentSegments(message.content) + closeTag("message") + EOM
    } else if (role === "system" && message.tools) {
      out += renderToolDeclare(message.tools, true)
    } else if (role === "system") {
      const attrs = [["role", "system"]]
      if (message.name) attrs.push(["name", message.name])
      out += openTag("message", attrs) + renderContentSegments(message.content) + closeTag("message") + EOM
    } else if (role === "tool") {
      toolIndex++
      let toolName = message.tool ?? message.name
      if (toolName == null && toolCalls && toolIndex <= toolCalls.length) {
        const fn = toolCalls[toolIndex - 1].function ?? toolCalls[toolIndex - 1]
        toolName = fn.name
      }
      if (toolName == null) throw new Error("Kimi K3 tool messages need a resolvable tool name.")
      out += openTag("message", [["role", "tool"], ["tool", toolName], ["index", toolIndex]]) +
        renderContentSegments(message.content) + closeTag("message") + EOM
    } else if (role === "assistant") {
      toolCalls = message.tool_calls
      toolIndex = 0
      const attrs = [["role", "assistant"]]
      if (message.name) attrs.push(["name", message.name])
      out += openTag("message", attrs) + renderAssistantKimi(message, thinking) + closeTag("message") + EOM
    } else throw new Error(`Unknown message role ${role}`)
  }
  if (toolChoice === "required") out += internalSystem("tool-choice", "The system is invoked with `tool_choice=required`.\nYou MUST call tools in the next message.")
  else if (toolChoice === "none") out += internalSystem("tool-choice", "The system is invoked with `tool_choice=none`.\nYou MUST NOT call any tools in the next message.")
  const rfType = responseFormat && typeof responseFormat === "object" ? (responseFormat.type ?? responseFormat) : responseFormat
  if (rfType === "json_object") out += internalSystem("response-format", "The system is invoked with `response_format=json_object`.\nYour response must be raw JSON data without markdown code blocks (```json) or any additional formatting.")
  else if (rfType === "json_schema") out += internalSystem("response-format", "The system is invoked with `response_format=json_schema`.\nYour response must be raw JSON data without markdown code blocks (```json) or any additional formatting.\nThe JSON data must match the following schema:\n```json\n" + pyJsonCompact(responseSchema) + "\n```")
  if (addGenerationPrompt) out += openTag("message", [["role", "assistant"]]) + openTag(thinking ? "think" : "response")
  return out
}

/* ───────────── 捕获格式 → Chat Completions 风格消息（有损转换，逐条标注） ───────────── */
// vLLM 风格：arguments JSON 字符串解析成对象后再交给模板；保留原始字符串供 Kimi 用。
function normalizeCallArguments(raw, warnings) {
  if (raw == null) return { arguments: {}, argumentsRaw: null }
  if (typeof raw === "object") return { arguments: raw, argumentsRaw: null }
  try { return { arguments: JSON.parse(raw), argumentsRaw: raw } }
  catch { warnings.push("tool_call arguments 不是合法 JSON，已按原始字符串传递"); return { arguments: raw, argumentsRaw: raw } }
}

export function anthropicToChat(input) {
  const warnings = []
  const messages = []
  const system = input.system
  if (typeof system === "string" && system) messages.push({ role: "system", content: system })
  else if (Array.isArray(system)) {
    const text = system.map(block => block?.text ?? "").filter(Boolean).join("\n")
    if (text) messages.push({ role: "system", content: text })
  }
  for (const message of input.messages ?? []) {
    if (message.role === "user") {
      if (typeof message.content === "string") { messages.push({ role: "user", content: message.content }); continue }
      const texts = []
      for (const block of message.content ?? []) {
        if (block.type === "text") texts.push(block.text ?? "")
        else if (block.type === "tool_result") {
          const content = typeof block.content === "string" ? block.content
            : Array.isArray(block.content) ? block.content.map(part => part?.text ?? "").join("") : pyJsonSpaced(block.content)
          messages.push({ role: "tool", tool_call_id: block.tool_use_id, content })
        } else if (block.type === "image") warnings.push("图片输入已省略（模板预览仅处理文本）")
        else warnings.push(`未识别的 user 内容块 ${block.type}，已省略`)
      }
      const text = texts.join("\n")
      if (text) messages.push({ role: "user", content: text })
    } else if (message.role === "assistant") {
      const chat = { role: "assistant", content: "" }
      const texts = []
      for (const block of (typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [])) {
        if (block.type === "text") texts.push(block.text ?? "")
        else if (block.type === "thinking") chat.reasoning_content = (chat.reasoning_content ?? "") + (block.thinking ?? "")
        else if (block.type === "redacted_thinking") warnings.push("redacted_thinking 内容不可得，已省略")
        else if (block.type === "tool_use") {
          const { arguments: args, argumentsRaw } = normalizeCallArguments(block.input != null ? JSON.stringify(block.input) : null, warnings)
          chat.tool_calls = chat.tool_calls ?? []
          chat.tool_calls.push({ id: block.id, type: "function", function: { name: block.name, arguments: args, arguments_raw: argumentsRaw } })
        }
      }
      chat.content = texts.join("\n")
      messages.push(chat)
    }
  }
  const tools = (input.tools ?? []).map(tool => ({
    type: "function",
    function: { name: tool.name, description: tool.description ?? "", parameters: tool.input_schema ?? {} },
  }))
  return { messages, tools: tools.length ? tools : null, warnings: [...new Set(warnings)] }
}

export function responsesToChat(input) {
  const warnings = []
  const messages = []
  if (typeof input.instructions === "string" && input.instructions) messages.push({ role: "system", content: input.instructions })
  let seenNonSystem = messages.length > 0
  let pendingReasoning = []
  const flushReasoning = () => {
    if (!pendingReasoning.length) return null
    const text = pendingReasoning.join("\n")
    pendingReasoning = []
    return text
  }
  for (const item of input.input ?? input.items ?? []) {
    if (item.type === "additional_tools") continue
    if (item.type === "message") {
      let role = item.role === "assistant" ? "assistant" : item.role === "developer" || item.role === "system" ? "system" : "user"
      const leadingSystem = messages.length && !seenNonSystem && messages[0].role === "system" ? messages[0] : null
      if (role === "system" && leadingSystem) {
        role = "system-merged"
        warnings.push("前导 developer/system 已合并为一条 system。")
      } else if (role === "system" && seenNonSystem) {
        role = "user"
        warnings.push("后续 developer/system 已映射为 user。")
      }
      const text = (item.content ?? []).map(c => typeof c === "string" ? c
        : c.type === "input_text" || c.type === "output_text" ? c.text ?? ""
        : (warnings.push(`内容类型 ${c.type} 已省略`), "")).filter(Boolean).join("\n")
      if (role === "system-merged") { leadingSystem.content += "\n\n" + text; continue }
      if (role !== "system") seenNonSystem = true
      if (role === "assistant") {
        const chat = { role, content: text }
        const reasoning = flushReasoning()
        if (reasoning) chat.reasoning_content = reasoning
        messages.push(chat)
      } else { flushReasoning(); messages.push({ role, content: text }) }
    } else if (item.type === "reasoning") {
      const summary = [...(item.summary ?? []), ...(item.content ?? []).filter(block => ["reasoning_text", "text"].includes(block.type))].map(block => block.text ?? "").filter(Boolean).join("\n")
      if (summary) pendingReasoning.push(summary)
      else if (item.encrypted_content) warnings.push("reasoning 为加密内容（encrypted_content），无法还原，已省略")
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      const { arguments: args, argumentsRaw } = item.type === "function_call"
        ? normalizeCallArguments(item.arguments ?? "{}", warnings)
        : { arguments: { input: item.input ?? "" }, argumentsRaw: null }
      const chat = { role: "assistant", content: "", tool_calls: [{ id: item.call_id, type: "function", function: { name: item.name, arguments: args, arguments_raw: argumentsRaw } }] }
      const reasoning = flushReasoning()
      if (reasoning) chat.reasoning_content = reasoning
      messages.push(chat)
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      flushReasoning()
      let output = item.output
      if (output && typeof output === "object") output = output.content ?? pyJsonSpaced(output)
      messages.push({ role: "tool", tool_call_id: item.call_id, content: typeof output === "string" ? output : pyJsonSpaced(output) })
    } else if (item.type === "compaction") {
      warnings.push("compaction 项为加密内容，无法还原，已省略")
      flushReasoning()
    } else warnings.push(`未识别的 input 项 ${item.type}，已省略`)
  }
  flushReasoning()
  const embedded = (input.input ?? []).filter(item => item.type === "additional_tools").flatMap(item => item.tools ?? [])
  const specs = Array.isArray(input.tools) ? input.tools : embedded
  const flatten = (tools, prefix = "") => tools.flatMap(tool => tool.type === "namespace"
    ? flatten(tool.tools ?? [], prefix + (tool.name ?? "namespace") + ".") : [tool])
  const tools = flatten(specs).flatMap(tool => {
    if (tool.type === "function") return [{ type: "function", function: { name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? {} } }]
    if (tool.type === "custom") { warnings.push(`custom 工具 ${tool.name} 已映射为 function（空 parameters）。`); return [{ type: "function", function: { name: tool.name, description: tool.description ?? "", parameters: {} } }] }
    warnings.push(`非 function 工具 ${tool.type ?? tool.name} 已省略`)
    return []
  })
  return { messages, tools: tools.length ? tools : null, warnings: [...new Set(warnings)] }
}

export function chatToChat(input) {
  const warnings = [], messages = []
  for (const item of input.messages ?? []) {
    const message = { ...item }
    if (message.role === "developer") { message.role = "system"; warnings.push("Chat developer 已映射为 system。") }
    if (message.role === "system" && messages.length && messages.every(m => m.role === "system")) { messages[0].content += "\n\n" + (message.content ?? ""); continue }
    if (message.role === "system" && messages.length) { message.role = "user"; warnings.push("Chat 后续 system 已映射为 user。") }
    if (message.tool_calls) message.tool_calls = message.tool_calls.map(tool => {
      const parsed = normalizeCallArguments(tool.function?.arguments ?? "{}", warnings)
      return { ...tool, function: { ...tool.function, arguments: parsed.arguments, arguments_raw: parsed.argumentsRaw } }
    })
    messages.push(message)
  }
  return { messages, tools: input.tools ?? null, warnings }
}

/* ───────────── 顶层：对一次捕获调用渲染模板预览 ───────────── */
function requestReasoningEffort(request) {
  for (const [field, value] of [["reasoning_effort", request?.reasoning_effort], ["reasoning.effort", request?.reasoning?.effort],
    ["output_config.effort", request?.output_config?.effort], ["thinking_effort", request?.thinking_effort],
    ["chat_template_kwargs.reasoning_effort", request?.chat_template_kwargs?.reasoning_effort]]) {
    if (value != null) return { field, value }
  }
  return null
}

function jinjaApiOptions(entry, request, warnings) {
  const captured = requestReasoningEffort(request)
  const supported = entry.id === "qwen38" ? ["low", "medium", "xhigh"] : ["low", "high", "max"]
  const defaultEffort = entry.id === "qwen38" ? "xhigh" : "max"
  if (captured && !supported.includes(captured.value)) {
    throw new Error(`${entry.label} 公开模板不支持原请求 ${captured.field}=${JSON.stringify(captured.value)}；支持 ${supported.join(" / ")}。未自动替换为 ${defaultEffort}，请使用兼容模板。`)
  }
  if (entry.id === "qwen38" && (request?.thinking?.type === "disabled" || request?.enable_thinking === false || request?.chat_template_kwargs?.enable_thinking === false)) {
    throw new Error("Qwen3.8 公开模板不支持关闭思考，未将原请求改成开启思考。")
  }
  if (captured) {
    warnings.push(`已将原请求 ${captured.field}=${captured.value} 传入 ${entry.label} 公开模板的 reasoning_effort；同名档位不保证跨模型语义等价。`)
    return { reasoning_effort: captured.value }
  }
  warnings.push(`原请求未显式记录思考强度；${entry.label} 预览使用公开模板默认 ${defaultEffort}，不代表实际请求的思考强度。`)
  return {}
}

function kimiApiOptions(request, warnings) {
  const effort = requestReasoningEffort(request)?.value
  const thinkingEffort = effort == null ? null : VALID_THINKING_EFFORTS.has(effort) ? effort : null
  if (effort != null && thinkingEffort == null) warnings.push(`原请求思考参数 ${effort} 不在该公开K3编码器的low/high/max范围内，未猜测映射。`)
  const choice = request?.tool_choice
  const toolChoice = typeof choice === "string" ? choice : choice?.type === "any" ? "required" : choice?.type
  if (toolChoice && !["auto", "required", "none"].includes(toolChoice)) warnings.push("原请求选择了特定工具；该公开XTML编码器没有对应控制片段，原JSON仍完整保留。")
  const responseFormat = request?.response_format ?? request?.text?.format ?? null
  const responseSchema = request?.response_schema ?? responseFormat?.json_schema?.schema ?? responseFormat?.schema ?? responseFormat?.json_schema ?? null
  const thinking = request?.thinking?.type !== "disabled"
  if (!thinking) warnings.push("原请求关闭思考；Kimi Code可能路由到不同模型，此处仅是所选K3编码器的非思考模式预览。")
  return { thinking, thinkingEffort, toolChoice, responseFormat, responseSchema }
}

export async function renderTemplatePreview({ modelInput, templateId, mode = "request", call, events = [] }) {
  if (!["request", "call"].includes(mode)) throw new Error("未知预览范围")
  const entry = TEMPLATE_REGISTRY.find(item => item.id === templateId)
  if (!entry) throw new Error(`未知模板: ${templateId}`)
  const converted = modelInput.format === "chat" ? chatToChat({ messages: modelInput.items, tools: modelInput.tools }) : modelInput.format === "anthropic"
    ? anthropicToChat({ system: modelInput.system, messages: modelInput.items, tools: modelInput.tools })
    : responsesToChat({ instructions: modelInput.system, input: modelInput.items, tools: modelInput.tools })
  const warnings = [...converted.warnings]
  let responseState = null
  if (mode === "call") {
    if (!call?.response) throw new Error("本次响应尚未捕获，请在响应到达后生成含响应版本")
    const record = buildCallRecord(call, events)
    responseState = record.response.state
    if (responseState !== "captured") warnings.push("响应不完整或包含错误：仅展示已捕获部分，不补造未收到的内容。")
    const output = call.rawResponse?.output_items ?? call.responseData?.output
    if (modelInput.format === "responses" && output) {
      const extra = responsesToChat({ input: output })
      converted.messages.push(...extra.messages)
      warnings.push(...extra.warnings)
    } else {
      const message = { role: "assistant", content: call.response.text ?? "" }
      if (call.response.thinking) message.reasoning_content = call.response.thinking
      const tools = call.response.toolUses ?? []
      if (tools.length) message.tool_calls = tools.map(tool => {
        const raw = typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input ?? {})
        const normalized = normalizeCallArguments(raw, warnings)
        return { id: tool.callID, type: "function", function: { name: tool.name, arguments: normalized.arguments, arguments_raw: normalized.argumentsRaw } }
      })
      converted.messages.push(message)
    }
    converted.messages.push(...record.toolResults)
    if (record.missingToolResults.length) warnings.push(`本次调用有 ${record.missingToolResults.length} 项工具反馈未捕获或未建立明确关联；不从后续请求猜补。`)
    warnings.push("含响应版本是请求＋本次输出／明确关联工具反馈的离线组装，不是当时发给模型的请求。")
  }
  if (!modelInput.complete) warnings.push("上下文链不完整（缺少前序响应），预览仅基于可见部分。")
  const request = call?.anthropicRequest ?? call?.request?.request ?? call?.request ?? {}
  let text
  if (entry.engine === "jinja") {
    const template = await loadTemplate(entry)
    // vLLM 会把 arguments JSON 字符串解析成对象；Kimi 专用字段不进入 Jinja 模板。
    const messages = converted.messages.map(message => ({
      ...message,
      tool_calls: message.tool_calls?.map(call => ({ ...call, function: { name: call.function.name, arguments: call.function.arguments } })),
    }))
    const options = jinjaApiOptions(entry, request, warnings)
    try {
      text = template.render({ messages, tools: converted.tools, add_generation_prompt: mode === "request", ...options })
    } catch (err) {
      throw new Error(`模板渲染失败（${entry.id}）: ${err.message}`)
    }
  } else {
    const messages = converted.messages.map(message => ({
      ...message,
      tool_calls: message.tool_calls?.map(call => ({
        ...call,
        function: { name: call.function.name, arguments: call.function.arguments_raw ?? call.function.arguments },
      })),
    }))
    text = renderKimiXtml({ messages, tools: converted.tools, addGenerationPrompt: mode === "request", ...kimiApiOptions(request, warnings) })
  }
  return {
    template: listTemplates().find(item => item.id === entry.id),
    sourceFormat: modelInput.format,
    contextKind: modelInput.kind,
    complete: modelInput.complete,
    warnings: [...new Set(warnings)], mode, responseState,
    evidence: mode === "request" ? `使用 ${entry.label} 固定版本模板拼接已捕获请求（不含本次响应）。`
      : `使用 ${entry.label} 固定版本模板拼接请求＋本次已捕获响应／关联工具反馈；不是实际请求，响应状态：${responseState}。`,
    chars: text.length,
    text,
  }
}
