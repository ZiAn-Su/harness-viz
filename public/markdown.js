/* Marked 18.0.14 + DOMPurify 3.4.16. Browser-only, offline Markdown rendering. */
(() => {
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character])
  const parser = new marked.Marked({ gfm: true, breaks: true, async: false })
  parser.use({ renderer: {
    checkbox({ checked }) { return `<span class="md-check" role="img" aria-label="${checked ? "已完成" : "未完成"}">${checked ? "☑" : "☐"}</span> ` },
    image({ text }) { return escape(text) },
  } })
  DOMPurify.addHook("afterSanitizeAttributes", node => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank")
      node.setAttribute("rel", "noopener noreferrer")
    }
  })
  const policy = {
    ALLOWED_TAGS: ["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "em", "del", "s", "code", "pre", "blockquote", "table", "thead", "tbody", "tr", "th", "td", "a", "hr", "span", "kbd", "details", "summary"],
    ALLOWED_ATTR: ["href", "title", "class", "start", "align", "role", "aria-label"],
    ALLOW_DATA_ATTR: false,
  }
  window.renderMarkdown = source => DOMPurify.sanitize(parser.parse(String(source ?? "")), policy)
})()
