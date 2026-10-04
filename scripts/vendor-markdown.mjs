// Pin browser libraries locally so npm start needs no download or installation.
import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "vendor")
await mkdir(root, { recursive: true })
const files = [
  ["marked@18.0.14/lib/marked.umd.js", "marked.js"],
  ["marked@18.0.14/LICENSE", "LICENSE.marked"],
  ["dompurify@3.4.16/dist/purify.min.js", "purify.js"],
  ["dompurify@3.4.16/LICENSE", "LICENSE.DOMPurify"],
]
for (const [source, name] of files) {
  const response = await fetch("https://cdn.jsdelivr.net/npm/" + source)
  if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`)
  await writeFile(path.join(root, name), Buffer.from(await response.arrayBuffer()))
  console.log(name)
}
