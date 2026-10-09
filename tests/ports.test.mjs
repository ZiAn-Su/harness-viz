import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { listenLocal, openCodeRequestedPort, opencodeListeningPort } from "../src/ports.mjs"

function server(t, body) {
  const instance = createServer((_req, res) => res.end(body))
  t.after(() => new Promise(resolve => instance.close(resolve)))
  return instance
}

test("an occupied preferred proxy port binds a new owned listener without touching the occupant", async t => {
  const occupied = server(t, "existing service"), proxy = server(t, "owned proxy")
  const preferred = await listenLocal(occupied)
  const actual = await listenLocal(proxy, { port: preferred })
  assert.notEqual(actual, preferred)
  assert.equal(proxy.address().address, "127.0.0.1")
  assert.equal(await (await fetch(`http://127.0.0.1:${preferred}`)).text(), "existing service")
  assert.equal(await (await fetch(`http://127.0.0.1:${actual}`)).text(), "owned proxy")
})

test("the fixed webpage port reports a conflict instead of silently changing the URL", async t => {
  const occupied = server(t, "existing service"), webpage = server(t, "new webpage")
  const port = await listenLocal(occupied)
  await assert.rejects(listenLocal(webpage, { port, fallback: false }), { code: "EADDRINUSE" })
  assert.equal(webpage.listening, false)
  assert.equal(occupied.listening, true)
})

test("an occupied explicit OpenCode port delegates allocation to its own --port 0 listener", async t => {
  const occupied = server(t, "existing service")
  const port = await listenLocal(occupied)
  assert.equal(await openCodeRequestedPort(port), 0)
  assert.equal(await openCodeRequestedPort(0), 0)
  assert.equal(occupied.listening, true)
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "existing service")
})

test("owned OpenCode port announcements must be complete and match the loopback host", () => {
  const prefix = "opencode server listening on http://127.0.0.1:"
  let output = "startup information\n" + prefix + "4"
  assert.equal(opencodeListeningPort(output), null, "Do not accept a truncated port")
  output += "096"
  assert.equal(opencodeListeningPort(output), null, "Wait for the full line")
  output += "\r\n"
  assert.equal(opencodeListeningPort(output), 4096)
  for (const line of [prefix + "0\n", prefix + "65536\n", prefix + "1234junk\n",
    "unrelated " + prefix + "1234\n", "opencode server listening on http://attacker.invalid:1234\n"]) {
    assert.equal(opencodeListeningPort(line), null)
  }
})
