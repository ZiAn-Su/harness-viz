import { test } from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import { readFile } from "node:fs/promises"

const markedSource = await readFile(new URL("../public/vendor/marked.js", import.meta.url), "utf8")
const renderer = await readFile(new URL("../public/markdown.js", import.meta.url), "utf8")
const sanitized = []
const context = vm.createContext({ console, DOMPurify: {
  addHook() {},
  sanitize(html, policy) { sanitized.push({ html, policy }); return html },
} })
context.window = context
vm.runInContext(markedSource, context)
vm.runInContext(renderer, context)
const render = text => { context.text = text; return vm.runInContext("renderMarkdown(text)", context) }

// Node validates the actual parser and renderer wiring; Chromium tests the real sanitizer.
test("real GFM parser renders headings, emphasis, tables, lists, quote and fenced code", () => {
  const output = render('# 标题\n\n**重点** 和 `inline`\n\n1. 第一\n2. 第二\n\n> 引用\n\n| 阶段 | 状态 |\n| --- | --- |\n| 工具 | 完成 |\n\n```js\nconst x = "<script>";\n```')
  for (const tag of ["h1", "strong", "ol", "blockquote", "table", "thead", "tbody", "pre", "code"]) assert.match(output, new RegExp(`<${tag}[ >]`))
  assert.match(output, /language-js/)
  assert.match(output, /&lt;script&gt;/)
  assert.equal(sanitized.at(-1).html, output)
  assert(!sanitized.at(-1).policy.ALLOWED_TAGS.includes("script"))
  assert(!sanitized.at(-1).policy.ALLOWED_ATTR.includes("onclick"))
})

test("task lists are read-only; image Markdown does not start external image requests", () => {
  const output = render('- [x] 已完成\n- [ ] 待执行\n\n![截图](https://example.com/tracking.png)')
  assert.match(output, /☑/)
  assert.match(output, /☐/)
  assert.match(output, /截图/)
  assert.doesNotMatch(output, /<input|<img/)
})
