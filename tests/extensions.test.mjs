import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises"
import { prepareExtensions, extensionSelection, gitBlobHash, opencodeExtensions, codexExtensions, installCodexSkills } from "../src/extensions.mjs"

async function fixture(t) {
  const parent = fileURLToPath(new URL("../.runtime/tests/", import.meta.url))
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "extensions-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test("disabled extension selection does not download or install anything", async t => {
  const root = await fixture(t)
  const bundle = await prepareExtensions({ config: { enabled: false }, cacheRoot: root,
    fetchImpl: () => assert.fail("Unexpected download"), run: () => assert.fail("Unexpected install") })
  assert.deepEqual(bundle.skills, [])
  assert.deepEqual(bundle.mcp, [])
  assert.deepEqual(await readdir(root), [])
  assert.throws(() => extensionSelection({ enabled: true, skills: ["unknown"] }), /未知扩展/)
})

test("pinned skill cache verifies source bytes, reuses offline and repairs corruption", async t => {
  const root = await fixture(t), bytes = Buffer.from("---\nname: demo\ndescription: synthetic\n---\n# Body\n")
  const lock = { skills: { demo: { repository: "fixture/skills", revision: "0".repeat(40), files: { "SKILL.md": gitBlobHash(bytes) } } }, mcp: {}, plugins: {} }
  let downloads = 0
  const options = { config: { enabled: true }, cacheRoot: root, lock, fetchImpl: async url => {
    downloads++; assert.match(url, /fixture\/skills\/0{40}\/skills\/demo\/SKILL.md$/)
    return { ok: true, arrayBuffer: async () => bytes }
  } }
  const first = await prepareExtensions(options)
  const second = await prepareExtensions({ ...options, fetchImpl: () => assert.fail("Valid cache must work offline") })
  assert.equal(first.directory, second.directory)
  assert.equal(downloads, 1)
  await writeFile(first.skills[0].location, "corrupt")
  await prepareExtensions(options)
  assert.equal(downloads, 2)
  assert.equal(await readFile(first.skills[0].location, "utf8"), bytes.toString())
})

test("unverified downloaded skills are never published as an installed cache", async t => {
  const root = await fixture(t)
  const lock = { skills: { demo: { repository: "fixture/skills", revision: "0".repeat(40), files: { "SKILL.md": "0".repeat(40) } } }, mcp: {}, plugins: {} }
  await assert.rejects(prepareExtensions({ config: { enabled: true }, cacheRoot: root, lock,
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from("wrong") }) }), /技能校验失败/)
  assert.deepEqual(await readdir(root), [])
})

test("OpenCode and Codex launchers preserve paths with spaces and keep plugins OpenCode-only", () => {
  const bundle = { skills: [{ directory: "C:\\Skill Cache\\frontend-design" }], mcp: [{ name: "context7", command: "C:\\Node JS\\node.exe", args: ["C:\\MCP Cache\\server.js"] }], plugins: [{ location: "file:///C:/Plugin%20Cache/index.js" }] }
  const oc = opencodeExtensions(bundle)
  assert.deepEqual(oc.mcp.context7.command, ["C:\\Node JS\\node.exe", "C:\\MCP Cache\\server.js"])
  assert.deepEqual(oc.skills.paths, ["C:\\Skill Cache\\frontend-design"])
  assert.deepEqual(oc.plugin, ["file:///C:/Plugin%20Cache/index.js"])
  const cx = codexExtensions(bundle)
  assert(cx.includes(JSON.stringify("C:\\Node JS\\node.exe")))
  assert(cx.includes(JSON.stringify(["C:\\MCP Cache\\server.js"])))
  assert.doesNotMatch(cx, /Plugin|dcp/)
})

test("managed Codex skills leave builtin skills alone and refuse to overwrite unmanaged folders", async t => {
  const root = await fixture(t), source = path.join(root, "source"), home = path.join(root, "home")
  await mkdir(source)
  await writeFile(path.join(source, "SKILL.md"), "synthetic skill")
  await mkdir(path.join(home, "skills", ".system"), { recursive: true })
  await writeFile(path.join(home, "skills", ".system", "marker"), "builtin")
  const bundle = { skills: [{ name: "frontend-design", directory: source, repository: "fixture", revision: "0".repeat(40) }] }
  await installCodexSkills(bundle, home)
  assert.equal(await readFile(path.join(home, "skills", "frontend-design", "SKILL.md"), "utf8"), "synthetic skill")
  await installCodexSkills({ skills: [] }, home)
  assert.equal(await readFile(path.join(home, "skills", ".system", "marker"), "utf8"), "builtin")
  await mkdir(path.join(home, "skills", "frontend-design"))
  await writeFile(path.join(home, "skills", "frontend-design", "SKILL.md"), "user file")
  await assert.rejects(installCodexSkills(bundle, home), /非托管内容/)
  assert.equal(await readFile(path.join(home, "skills", "frontend-design", "SKILL.md"), "utf8"), "user file")
})
