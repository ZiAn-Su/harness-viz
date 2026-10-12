import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { prepareExtensions } from "../src/extensions.mjs"

const config = JSON.parse(await readFile(new URL("../config/settings.json", import.meta.url), "utf8"))
const bundle = await prepareExtensions({ config: config.extensions, cacheRoot: fileURLToPath(new URL("../.runtime/extensions", import.meta.url)),
  onState: state => console.log(state.message) })
console.log(JSON.stringify({ directory: bundle.directory, skills: bundle.skills.map(s => ({ name: s.name, revision: s.revision })),
  mcp: bundle.mcp.map(s => ({ name: s.name, version: s.version })), plugins: bundle.plugins.map(s => ({ name: s.name, version: s.version })) }, null, 2))
