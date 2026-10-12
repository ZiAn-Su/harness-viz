// Vendor only the pinned public template and license; never model weights.
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
const revision = "eb9eb208eb0d988989d07a6a12d0fdeb5f52574a"
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
for (const [source, target, expected] of [
  ["chat_template.jinja", "glm53-flash.chat_template.jinja", "0c4099f3382d6c92700dfb99725025360966fd73032f0ecf32377c0d9e6309c5"],
  ["LICENSE", "LICENSE.glm53-flash", "30b85b6b9659f2e78aa259f8faf5d920a68dee7c9ced3fa6dba1f19f2bc4fca1"],
]) {
  const response = await fetch(`https://huggingface.co/zai-org/GLM-5.3-Flash/raw/${revision}/${source}`, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${source}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (expected && hash(bytes) !== expected) throw new Error("Source hash mismatch")
  const file = new URL(`../src/templates/${target}`, import.meta.url)
  try { if (!(await readFile(file)).equals(bytes)) throw new Error(`Existing vendored file differs: ${target}`) }
  catch (err) { if (err.code !== "ENOENT") throw err; await writeFile(file, bytes) }
  console.log(`${target}: ${bytes.length} bytes sha256=${hash(bytes)}`)
}
