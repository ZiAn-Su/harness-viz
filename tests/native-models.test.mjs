import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { copyNativeCodexHome, opencodeModelCatalog, codexModelCatalog, nativeConfigSnapshot } from "../src/native-models.mjs"

test("native OpenCode catalog honours configured defaults and does not expose credentials or provider options", () => {
  const catalog = opencodeModelCatalog([{ id: "ark", name: "Ark", key: "fixture-secret", options: { apiKey: "fixture-secret", baseURL: "https://example.invalid" }, models: {
    "glm-5.3-flash": { id: "glm-5.3-flash", name: "Flash", api: { npm: "@ai-sdk/openai" } },
    local: { id: "local", name: "Local", api: { npm: "other-sdk" } },
  } }], "ark/glm-5.3-flash")
  assert.equal(catalog.defaultModel, "ark/glm-5.3-flash")
  assert.equal(catalog.models.length, 2)
  assert.equal(catalog.models[1].capture, "native-events-only")
  assert(!JSON.stringify(catalog).includes("fixture-secret"))
  assert(!JSON.stringify(catalog).includes("example.invalid"))
  assert.deepEqual(opencodeModelCatalog([], null), { models: [], defaultModel: null })
})

test("native OpenCode variants expose only usable names, never their parameter values", () => {
  const { models } = opencodeModelCatalog([{ id: "fixture", models: {
    k3: { id: "k3", options: { reasoningEffort: "private-base-value" }, variants: {
      low: { reasoningEffort: "private-low-value" }, high: { reasoningEffort: "private-high-value" },
      max: { reasoningEffort: "private-max-value" }, medium: { disabled: true },
    } }, plain: { id: "plain" },
  } }])
  assert.deepEqual(models[0].variants, ["low", "high", "max"])
  assert.deepEqual(models[1].variants, [])
  assert(!JSON.stringify(models).includes("private-"))
})

test("Codex effort choices and defaults come from its native model catalog and profile configuration", () => {
  const config = { model: "fixture-model", model_provider: "fixture", model_reasoning_effort: "high", profiles: {
    review: { model_reasoning_effort: "low" }, unknown: { model: "not-in-native-catalog" },
    another: { model_provider: "different-provider" },
  }, model_providers: { fixture: { env_key: "PRIVATE_ENV_NAME", base_url: "https://private.invalid" } } }
  const catalog = codexModelCatalog(config, [{ model: "fixture-model", defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"].map(reasoningEffort => ({ reasoningEffort, description: "native description" })) }, { model: "other-native-model" }])
  assert.equal(catalog.models.length, 4, "Third-party providers must not acquire unrelated official models")
  assert.deepEqual(catalog.models[0].reasoningEfforts, ["low", "medium", "high"])
  assert.equal(catalog.models[0].defaultReasoningEffort, "high")
  assert.equal(catalog.models[1].defaultReasoningEffort, "low")
  assert.deepEqual(catalog.models[2].reasoningEfforts, [])
  assert.deepEqual(catalog.models[3].reasoningEfforts, [])
  assert(!JSON.stringify(catalog).includes("PRIVATE_ENV_NAME") && !JSON.stringify(catalog).includes("private.invalid"))
})

test("Codex runtime copy preserves native model/provider/profile fields and leaves source files unchanged", async t => {
  const parent = fileURLToPath(new URL("../.runtime/tests/", import.meta.url)); await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "native-config-")); t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, "source"), home = path.join(root, "runtime")
  await mkdir(source)
  const content = 'model="glm-5.3-flash"\nmodel_provider="ark"\n[model_providers.ark]\nbase_url="https://example.invalid/api/coding/v3"\nwire_api="responses"\n[profiles.review]\nmodel="configured-review"\n'
  await writeFile(path.join(source, "config.toml"), content)
  await writeFile(path.join(source, "auth.json"), '{"fixture":"auth"}')
  await copyNativeCodexHome(home, source)
  assert.equal(await readFile(path.join(home, "config.toml"), "utf8"), content)
  assert.equal(await readFile(path.join(source, "config.toml"), "utf8"), content)
  await rm(path.join(source, "auth.json"))
  await copyNativeCodexHome(home, source)
  await assert.rejects(readFile(path.join(home, "auth.json")), { code: "ENOENT" })
})

test("native config snapshot only resolves native file paths, never model identifiers or provider URLs", () => {
  const text = 'model="glm-5.3-flash"\nmodel_catalog_json="./models.json"\n[model_providers.ark]\nbase_url="https://example.invalid/v3"\n'
  const snapshot = nativeConfigSnapshot(text, path.resolve("source-native-home"))
  assert(snapshot.includes('model="glm-5.3-flash"'))
  assert(snapshot.includes('base_url="https://example.invalid/v3"'))
  assert(snapshot.includes(JSON.stringify(path.resolve("source-native-home", "models.json"))))
})
