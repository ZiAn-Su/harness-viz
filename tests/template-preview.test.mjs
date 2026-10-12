import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Template } from "../src/vendor/jinja/index.js"
import { anthropicToChat, responsesToChat, renderKimiXtml, renderTemplatePreview, listTemplates, loadTemplate, TEMPLATE_REGISTRY } from "../src/template-preview.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const fixtures = path.join(root, "tests", "fixtures", "template-preview")
const vendoredTemplates = path.join(root, "src", "templates")

const meta = JSON.parse(await readFile(path.join(fixtures, "meta.json"), "utf8"))
const caseNames = ["basic", "tool-cycle", "tool-cycle-reversed"]
const load = async name => JSON.parse(await readFile(path.join(fixtures, `chat-${name}.json`), "utf8"))
const golden = (tid, name) => readFile(path.join(fixtures, "rendered", `${tid}-${name}.txt`), "utf8")

async function jinjaRender(tid, fixture) {
  const file = tid === "qwen38" ? "qwen38.chat_template.jinja" : tid === "glm53-flash" ? "glm53-flash.chat_template.jinja" : "glm53.chat_template.jinja"
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
  test(`golden: glm53-flash ${name} is text/tool compatible with the verified GLM golden`, async () => {
    assert.equal(await jinjaRender("glm53-flash", await load(name)), await golden("glm53", name))
  })
}

test("registry exposes four separately pinned templates", () => {
  const templates = listTemplates()
  assert.deepEqual(templates.map(t => t.id), ["qwen38", "glm53", "glm53-flash", "kimi-k3"])
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
    assert.equal(result.warnings.filter(w => w === "前导 developer/system 已合并为一条 system。").length, 1, "repeated conversions are reported once")
    if (templateId !== "kimi-k3") assert(result.warnings.some(w => w.includes("公开模板默认") && w.includes("不代表实际请求")))
    else assert.deepEqual(result.warnings, ["前导 developer/system 已合并为一条 system。"])
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

test("K3 preview preserves explicit API effort/tool choice/response format outside the chat history", async () => {
  const modelInput = { format: "chat", kind: "captured", complete: true, items: [{ role: "user", content: "known task" }], tools: [] }
  const call = { request: { reasoning_effort: "low", tool_choice: "required", response_format: { type: "json_schema", json_schema: { schema: { z: 1, a: { y: true, b: "value" } } } } } }
  const before = structuredClone(call)
  const preview = await renderTemplatePreview({ modelInput, templateId: "kimi-k3", call })
  assert(preview.text.includes('type="thinking-effort"'))
  assert(preview.text.includes("thinking_effort=low"))
  assert(preview.text.includes('type="tool-choice"'))
  assert(preview.text.includes('type="response-format"'))
  assert(preview.text.includes('{"a":{"b":"value","y":true},"z":1}'))
  assert.deepEqual(call, before)
  const unset = await renderTemplatePreview({ modelInput, templateId: "kimi-k3" })
  assert(!unset.text.includes('type="thinking-effort"'), "unknown service defaults are not injected as explicit parameters")
})

test("K3 unknown effort is not guessed and legacy reasoning fallback follows the official encoder", async () => {
  const text = renderKimiXtml({ messages: [{ role: "assistant", content: "", reasoning_content: "", reasoning: "legacy visible" }], addGenerationPrompt: false })
  assert(text.includes("legacy visible"))
  const result = await renderTemplatePreview({ modelInput: { format: "chat", complete: true, items: [{ role: "user", content: "known" }] }, templateId: "kimi-k3", call: { request: { reasoning_effort: "unknown" } } })
  assert(result.warnings.some(w => w.includes("未猜测映射")))
  assert(!result.text.includes('type="thinking-effort"'))
})

test("Qwen preview forwards captured compatible efforts across API formats and both export scopes", async () => {
  const modelInput = { format: "chat", kind: "captured", complete: true, items: [{ role: "user", content: "known task" }], tools: [] }
  for (const effort of ["low", "medium", "xhigh"]) for (const mode of ["request", "call"]) {
    for (const request of [{ reasoning_effort: effort }, { reasoning: { effort } }, { output_config: { effort } }, { thinking_effort: effort }, { chat_template_kwargs: { reasoning_effort: effort } }]) {
      const call = { request, response: { terminal: true, text: "OBSERVED_ANSWER" } }
      const before = structuredClone(call)
      const result = await renderTemplatePreview({ modelInput, templateId: "qwen38", mode, call })
      if (effort === "medium") assert(!result.text.includes("Reasoning effort is set to"), "Official medium mode inserts no extra effort instruction")
      else assert(result.text.includes(`Reasoning effort is set to ${effort}.`))
      if (effort !== "xhigh") assert(!result.text.includes("Reasoning effort is set to xhigh."))
      assert(result.warnings.some(w => w.includes(`=${effort} 传入`)))
      assert.equal(result.text.includes("OBSERVED_ANSWER"), mode === "call")
      assert.deepEqual(call, before)
    }
  }
})

test("K3 high remains high and Qwen rejects incompatible high instead of silently inserting xhigh", async () => {
  const modelInput = { format: "chat", kind: "captured", complete: true, items: [{ role: "user", content: "known task" }], tools: [] }
  const call = { request: { reasoning_effort: "high" }, response: { terminal: true, text: "answer" } }
  for (const mode of ["request", "call"]) {
    const kimi = await renderTemplatePreview({ modelInput, templateId: "kimi-k3", call, mode })
    assert(kimi.text.includes("thinking_effort=high"))
    await assert.rejects(renderTemplatePreview({ modelInput, templateId: "qwen38", call, mode }), /不支持原请求 reasoning_effort="high".*low \/ medium \/ xhigh.*未自动替换/)
  }
  for (const effort of ["max", "unknown", ""]) await assert.rejects(renderTemplatePreview({ modelInput, templateId: "qwen38", call: { request: { reasoning_effort: effort } } }), /不支持原请求/)
  const source = { request: { reasoning: { effort: "high" } }, anthropicRequest: { reasoning_effort: "low" } }
  assert((await renderTemplatePreview({ modelInput, templateId: "qwen38", call: source })).text.includes("Reasoning effort is set to low."), "Translated captures use the actual upstream request")
})

test("GLM previews forward captured efforts and reject values that their Jinja would otherwise turn into max", async () => {
  const modelInput = { format: "chat", kind: "captured", complete: true, items: [{ role: "user", content: "task" }], tools: [] }
  for (const templateId of ["glm53", "glm53-flash"]) {
    for (const effort of ["low", "high", "max"]) {
      const result = await renderTemplatePreview({ modelInput, templateId, call: { request: { reasoning_effort: effort } } })
      assert(result.text.includes("Reasoning Effort: " + effort[0].toUpperCase() + effort.slice(1)))
    }
    await assert.rejects(renderTemplatePreview({ modelInput, templateId, call: { request: { reasoning: { effort: "medium" } } } }), /不支持原请求/)
  }
})

test("Qwen default is labelled as a template default and explicitly disabled thinking is not ignored", async () => {
  const modelInput = { format: "chat", kind: "captured", complete: true, items: [{ role: "user", content: "task" }], tools: [] }
  const result = await renderTemplatePreview({ modelInput, templateId: "qwen38", call: { request: {} } })
  assert(result.text.includes("Reasoning effort is set to xhigh."))
  assert(result.warnings.some(w => w.includes("公开模板默认 xhigh") && w.includes("不代表实际请求")))
  for (const request of [{ thinking: { type: "disabled" } }, { enable_thinking: false }, { chat_template_kwargs: { enable_thinking: false } }]) {
    await assert.rejects(renderTemplatePreview({ modelInput, templateId: "qwen38", call: { request } }), /不支持关闭思考/)
  }
})

test("Flash is separately pinned and emits its own multimodal placeholder sequence", async () => {
  const entry = TEMPLATE_REGISTRY.find(t => t.id === "glm53-flash")
  const template = await loadTemplate(entry)
  const text = template.render({ messages: [{ role: "user", content: [{ type: "text", text: "describe" }, { type: "image_url", image_url: { url: "fixture" } }] }], add_generation_prompt: true })
  assert(text.includes("<|begin_of_image|><|image|><|end_of_image|>"))
  assert.notEqual(entry.sha256, TEMPLATE_REGISTRY.find(t => t.id === "glm53").sha256)
})

for (const templateId of ["qwen38", "glm53", "glm53-flash", "kimi-k3"]) {
  test(`call preview ${templateId} appends this response and matched feedback without modifying the request`, async () => {
    const input = { format: "anthropic", kind: "captured", complete: true, system: "known", items: [{ role: "user", content: "task" }], tools: [] }
    const call = { harness: "opencode", runID: "r", sessionID: "s", response: { terminal: true, text: "CURRENT_ANSWER", thinking: "CURRENT_THINKING",
      toolUses: [{ name: "read", callID: "id", input: { filePath: "a" } }] } }
    const events = [{ harness: "opencode", runID: "r", properties: { part: { type: "tool", sessionID: "s", callID: "id", state: { status: "completed", output: "CURRENT_RESULT" } } } }]
    const before = structuredClone(input)
    const request = await renderTemplatePreview({ modelInput: input, templateId })
    const full = await renderTemplatePreview({ modelInput: input, templateId, mode: "call", call, events })
    assert.equal(request.mode, "request")
    assert(!request.text.includes("CURRENT_ANSWER"))
    for (const marker of ["CURRENT_ANSWER", "CURRENT_THINKING", "CURRENT_RESULT"]) assert(full.text.includes(marker), marker)
    assert.equal(full.mode, "call")
    assert(full.evidence.includes("不是实际请求"))
    assert.deepEqual(input, before)
    await assert.rejects(renderTemplatePreview({ modelInput: input, templateId, mode: "call" }), /尚未捕获/)
  })
}
