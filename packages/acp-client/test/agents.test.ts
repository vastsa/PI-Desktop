/**
 * Agent catalogue, validation, and the streaming edge cases that the desktop
 * wiring will lean on: cancellation, concurrent sessions, and a slow consumer.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AcpClient, type AcpTransport } from "../src/client.ts"
import { KNOWN_ACP_AGENTS, findKnownAcpAgent, validateAcpAgent } from "../src/agents.ts"

const WIN_ENV = {
  PATH: "",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
} as NodeJS.ProcessEnv

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

test("the bundled opencode definition launches without a shell", () => {
  withBinDir((dir) => {
    writeFileSync(join(dir, "opencode.exe"), "")
    const v = validateAcpAgent({ command: "opencode", args: ["acp"] }, { ...WIN_ENV, PATH: dir }, "win32")
    assert.equal(v.ok, true)
    assert.deepEqual(v.warnings, [])
    assert.equal(v.resolution?.viaShell, false)
  })
})

test("an empty command is a blocking error, not a warning", () => {
  const v = validateAcpAgent({ command: "   ", args: ["acp"] }, WIN_ENV, "win32")
  assert.equal(v.ok, false)
  assert.match(v.errors[0], /required/i)
})

test("a command with a line break is rejected outright", () => {
  const v = validateAcpAgent({ command: "opencode\r\nwhoami", args: [] }, WIN_ENV, "win32")
  assert.equal(v.ok, false)
  assert.match(v.errors[0], /line break/i)
})

test("shell metacharacters only warn, and only where a shell could exist", () => {
  const win = validateAcpAgent({ command: "opencode", args: ["acp&calc"] }, WIN_ENV, "win32")
  assert.equal(win.ok, true)
  assert.equal(win.warnings.length, 1)
  assert.match(win.warnings[0], /metacharacters/i)

  const posix = validateAcpAgent({ command: "opencode", args: ["acp&calc"] }, {}, "linux")
  assert.deepEqual(posix.warnings, [])
})

test("a command missing from PATH warns that a shell would be used", () => {
  withBinDir((dir) => {
    const v = validateAcpAgent({ command: "not-installed", args: ["acp"] }, { ...WIN_ENV, PATH: dir }, "win32")
    assert.equal(v.ok, true)
    assert.match(v.warnings[0], /not found on PATH|through the shell/i)
  })
})

test("the catalogue is addressable by id", () => {
  assert.ok(KNOWN_ACP_AGENTS.length > 0)
  const oc = findKnownAcpAgent("opencode")
  assert.equal(oc?.command, "opencode")
  assert.deepEqual(oc?.args, ["acp"])
  assert.equal(findKnownAcpAgent("nope"), undefined)
})

// ---------------------------------------------------------------------------
// streaming edge cases
// ---------------------------------------------------------------------------

class FakeTransport implements AcpTransport {
  sent: string[] = []
  private messageCb: (line: string) => void = () => {}
  onMessage(cb: (line: string) => void) {
    this.messageCb = cb
  }
  onExit() {}
  onStderr() {}
  close() {}
  send(line: string) {
    this.sent.push(line)
  }
  feed(line: string) {
    this.messageCb(line)
  }
  lastRequest() {
    return JSON.parse(this.sent[this.sent.length - 1])
  }
  requests() {
    return this.sent.map((l) => JSON.parse(l))
  }
  update(sessionId: string, update: unknown) {
    this.feed(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }))
  }
  reply(id: number, result: unknown) {
    this.feed(JSON.stringify({ jsonrpc: "2.0", id, result }))
  }
  chunk(sessionId: string, text: string) {
    this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } })
  }
}

function makeClient() {
  const transport = new FakeTransport()
  const client = new AcpClient({ spawn: () => transport })
  return { transport, client }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

function withBinDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "acp-agents-"))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("two sessions can be prompted at once without crossing updates", async () => {
  const { transport, client } = makeClient()

  const collect = async (sessionId: string) => {
    const out: string[] = []
    for await (const u of client.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] })) {
      if (u.sessionUpdate === "agent_message_chunk") out.push((u as any).content.text)
    }
    return out.join("")
  }

  const a = collect("ses_A")
  const b = collect("ses_B")
  await tick()

  const [reqA, reqB] = transport.requests()
  transport.chunk("ses_B", "BBB")
  transport.chunk("ses_A", "AAA")
  transport.reply(reqB.id, { stopReason: "end_turn" })
  transport.reply(reqA.id, { stopReason: "end_turn" })

  assert.equal(await a, "AAA")
  assert.equal(await b, "BBB")
})

test("a slow consumer still receives every chunk in order", async () => {
  const { transport, client } = makeClient()
  const seen: string[] = []

  const run = (async () => {
    for await (const u of client.prompt({ sessionId: "s", prompt: [{ type: "text", text: "go" }] })) {
      if (u.sessionUpdate === "agent_message_chunk") {
        seen.push((u as any).content.text)
        await new Promise((r) => setTimeout(r, 5)) // the consumer is deliberately slow
      }
    }
  })()

  await tick()
  const req = transport.lastRequest()
  for (const piece of ["1", "2", "3", "4"]) transport.chunk("s", piece)
  await tick()
  transport.reply(req.id, { stopReason: "end_turn" })

  await run
  assert.deepEqual(seen, ["1", "2", "3", "4"])
})

test("cancelOnEarlyExit sends session/cancel when the consumer walks away", async () => {
  const transport = new FakeTransport()
  const client = new AcpClient({ spawn: () => transport, cancelOnEarlyExit: true })
  const init = client.initialize()
  transport.reply(1, { protocolVersion: 1 })
  await init

  for await (const _ of client.prompt({ sessionId: "s", prompt: [{ type: "text", text: "go" }] })) {
    void _
    break
  }
  await tick()

  const cancel = transport.requests().find((r) => r.method === "session/cancel")
  assert.ok(cancel, "expected session/cancel after an early exit")
  assert.equal(cancel.params.sessionId, "s")
})

test("without cancelOnEarlyExit an abandoned turn is left alone", async () => {
  const { transport, client } = makeClient()
  for await (const _ of client.prompt({ sessionId: "s", prompt: [{ type: "text", text: "go" }] })) {
    void _
    break
  }
  await tick()
  assert.equal(transport.requests().some((r) => r.method === "session/cancel"), false)
})

test("currentModel reads options the agent already sent, without a request", async () => {
  const { transport, client } = makeClient()
  const init = client.initialize()
  const before = transport.sent.length
  transport.reply(1, { protocolVersion: 1 })
  await init

  const options = [
    { id: "mode", category: "mode", currentValue: "build" },
    { id: "model", category: "model", currentValue: "opencode/muse-spark-1.3-contributor-free" },
  ]
  assert.equal(AcpClient.currentModel(options), "opencode/muse-spark-1.3-contributor-free")
  assert.equal(AcpClient.currentModel(undefined), undefined)
  // Reading must not put anything on the wire.
  assert.equal(transport.sent.length, before + 1) // only the initialize reply
})

test("cancel is a normal request, not a special case", async () => {
  const { transport, client } = makeClient()
  const run = (async () => {
    for await (const _ of client.prompt({ sessionId: "s", prompt: [{ type: "text", text: "go" }] })) void _
  })()
  await tick()

  const pending = client.cancel("s")
  const cancelReq = transport.lastRequest()
  assert.equal(cancelReq.method, "session/cancel")
  assert.equal(cancelReq.params.sessionId, "s")
  transport.reply(cancelReq.id, {})

  // The turn the client is waiting on still has to end on its own.
  const promptReq = transport.requests()[0]
  transport.reply(promptReq.id, { stopReason: "cancelled" })

  await pending
  await run
})

test("an agent that dies mid-turn surfaces as a failure, not a hang", async () => {
  const { transport, client } = makeClient()
  let exitCb: (info: { code: number | null; signal?: string }) => void = () => {}
  const t = transport as unknown as { onExit: unknown }
  // Re-wire onExit for this case.
  const client2 = new AcpClient({
    spawn: () => ({
      send: (l: string) => transport.sent.push(l),
      onMessage: (cb: (l: string) => void) => {
        ;(transport as any).messageCb = cb
      },
      onExit: (cb: (i: { code: number | null }) => void) => {
        exitCb = cb
      },
      onStderr: () => {},
      close: () => {},
    }),
  })
  const init = client2.initialize()
  transport.reply(1, { protocolVersion: 1 })
  await init

  const run = (async () => {
    for await (const _ of client2.prompt({ sessionId: "s", prompt: [{ type: "text", text: "go" }] })) void _
  })()
  await tick()

  exitCb({ code: 137 })
  await assert.rejects(run, /exited/)
  void t
})

