import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Template } from "../src/vendor/jinja/index.js"
import { anthropicToChat, responsesToChat, renderKimiXtml, renderTemplatePreview, listTemplates } from "../src/template-preview.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const fixtures = path.join(root, "tests", "fixtures", "template-preview")
const vendoredTemplates = path.join(root, "src", "templates")

const meta = JSON.parse(await readFile(path.join(fixtures, "meta.json"), "utf8"))
const caseNames = ["basic", "tool-cycle", "tool-cycle-reversed"]
const load = async name => JSON.parse(await readFile(path.join(fixtures, `chat-${name}.json`), "utf8"))
const golden = (tid, name) => readFile(path.join(fixtures, "rendered", `${tid}-${name}.txt`), "utf8")

async function jinjaRender(tid, fixture) {
  const file = tid === "qwen38" ? "qwen38.chat_template.jinja" : "glm53.chat_template.jinja"
  const source = await readFile(path.join(vendoredTemplates, file), "utf8")
  const messages = fixture.messages.map(message => ({
    ...message,
    tool_calls: message.tool_calls?.map(call => ({ ...call, function: { name: call.function.name, arguments: call.function.arguments } })),
  }))
  return new Template(source).render({ messages, tools: fixture.tools, add_generation_prompt: true })
}

function kimiRender(fixture) {
  const messages = fixture.messages.map(message => ({
    ...message,
    tool_calls: message.tool_calls?.map(call => ({
      ...call,
      function: { name: call.function.name, arguments: call.function.arguments_raw ?? call.function.arguments },
    })),
  }))
  return renderKimiXtml({ messages, tools: fixture.tools, addGenerationPrompt: true })
}

for (const name of caseNames) {
  test(`golden: kimi-k3 ${name} matches pinned encoding_k3.py output`, async () => {
    assert.equal(kimiRender(await load(name)), await golden("kimi-k3", name))
  })
  for (const tid of ["qwen38", "glm53"]) {
    test(`golden: ${tid} ${name} matches pinned jinja render`, async () => {
      assert.equal(await jinjaRender(tid, await load(name)), await golden(tid, name))
    })
  }
}

test("registry exposes three pinned templates", () => {
  const templates = listTemplates()
  assert.deepEqual(templates.map(t => t.id), ["qwen38", "glm53", "kimi-k3"])
  for (const t of templates) {
    assert.match(t.sourceUrl, /^https:\/\/huggingface\.co\//)
    assert.match(t.revision, /^[0-9a-f]{40}$/)
  }
})

test("fixture provenance is recorded", () => {
  for (const tid of ["qwen38", "glm53", "kimi-k3"]) {
    assert.match(meta.sources[tid].url, /^https:\/\/huggingface\.co\//)
    assert.match(meta.sources[tid].sha256, /^[0-9a-f]{64}$/)
  }
})

test("anthropicToChat maps system/thinking/tool_use/tool_result", () => {
  const { messages, tools, warnings } = anthropicToChat({
    system: "SYS",
    messages: [
      { role: "user", content: [{ type: "text", text: "问" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "想" },
        { type: "text", text: "答" },
        { type: "tool_use", id: "t1", name: "read", input: { filePath: "a.md" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "结果" }] },
        { type: "text", text: "继续" },
      ] },
    ],
    tools: [{ name: "read", description: "d", input_schema: { type: "object" } }],
  })
  assert.deepEqual(warnings, [])
  assert.deepEqual(messages.map(m => m.role), ["system", "user", "assistant", "tool", "user"])
  assert.equal(messages[2].reasoning_content, "想")
  assert.equal(messages[2].tool_calls[0].function.name, "read")
  assert.deepEqual(messages[2].tool_calls[0].function.arguments, { filePath: "a.md" })
  assert.equal(messages[3].tool_call_id, "t1")
  assert.equal(messages[3].content, "结果")
  assert.equal(tools[0].function.parameters.type, "object")
})

test("responsesToChat maps instructions/function_call/output with warnings", () => {
  const { messages, tools, warnings } = responsesToChat({
    instructions: "INS",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "问" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "想" }] },
      { type: "function_call", call_id: "c1", name: "read", arguments: "{\"filePath\":\"a.md\"}" },
      { type: "function_call_output", call_id: "c1", output: "结果" },
      { type: "reasoning", encrypted_content: "opaque" },
    ],
    tools: [{ type: "function", name: "read", description: "d", parameters: { type: "object" } }, { type: "web_search" }],
  })
  assert.equal(warnings.length, 2, "only actual skipped content is reported")
  assert(warnings.some(w => w.includes("encrypted_content")))
  assert(warnings.some(w => w.includes("web_search")))
  assert.deepEqual(messages.map(m => m.role), ["system", "user", "assistant", "tool"])
  assert.equal(messages[2].reasoning_content, "想")
  assert.equal(messages[2].tool_calls[0].function.arguments_raw, "{\"filePath\":\"a.md\"}")
  assert.deepEqual(messages[2].tool_calls[0].function.arguments, { filePath: "a.md" })
  assert.equal(messages[3].content, "结果")
  assert.equal(tools.length, 1)
})

test("responsesToChat keeps raw argument literal for Kimi (1e2 stays 1e2)", () => {
  const { messages } = responsesToChat({
    input: [{ type: "function_call", call_id: "c1", name: "f", arguments: "{\"n\":1e2}" }],
  })
  assert.equal(messages[0].tool_calls[0].function.arguments_raw, "{\"n\":1e2}")
})

for (const templateId of ["qwen38", "glm53", "kimi-k3"]) {
  test(`known Responses request renders through ${templateId} without modifying the captured content`, async () => {
    const markers = ["DEV_A", "DEV_B", "DEV_C", "DEV_D", "USER_KNOWN_TASK", "TOOL_RESULT_TEXT", "READ_DESCRIPTION"]
    const modelInput = {
      format: "responses", kind: "captured", complete: true, system: null,
      items: [
        ...markers.slice(0, 4).map(text => ({ type: "message", role: "developer", content: [{ type: "input_text", text }] })),
        { type: "message", role: "user", content: [{ type: "input_text", text: markers[4] }] },
        { type: "function_call", call_id: "read-1", name: "read", arguments: "{\"path\":\"notes.md\"}" },
        { type: "function_call_output", call_id: "read-1", output: markers[5] },
      ],
      tools: [{ type: "function", name: "read", description: markers[6], parameters: { type: "object", properties: { path: { type: "string" } } } }],
    }
    const original = structuredClone(modelInput)
    const result = await renderTemplatePreview({ modelInput, templateId })
    for (const marker of markers) assert(result.text.includes(marker), `${marker} must survive the selected template`)
    assert.equal(result.sourceFormat, "responses")
    assert.deepEqual(result.warnings, ["前导 developer/system 已合并为一条 system。"], "repeated conversions are reported once")
    assert.deepEqual(modelInput, original, "preview must not modify captured data")
  })
}

test("kimi renderer keeps raw literal via arguments_raw", () => {
  const text = renderKimiXtml({
    messages: [
      { role: "user", content: "u" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{\"n\":1e2}" } }] },
    ],
  })
  assert(text.includes('key="n" type="number"'), "argument tag expected")
  assert(text.includes("1e2"), "raw literal must be preserved")
})
