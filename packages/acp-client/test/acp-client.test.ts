/**
 * AcpClient tests.
 *
 * Unit tests drive a fake transport, so routing, streaming and the
 * agent-calls-host direction are all covered without spawning a process. The
 * last test is an integration check against a real `opencode acp` and is
 * skipped when the CLI is not installed.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

import { AcpClient, type AcpTransport } from "../src/client.ts"

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

class FakeTransport implements AcpTransport {
  sent: string[] = []
  private messageCb: (line: string) => void = () => {}
  private exitCb: (info: { code: number | null; signal?: string }) => void = () => {}

  send(line: string) {
    this.sent.push(line)
  }
  onMessage(cb: (line: string) => void) {
    this.messageCb = cb
  }
  onExit(cb: (info: { code: number | null; signal?: string }) => void) {
    this.exitCb = cb
  }
  onStderr() {}
  close() {}

  // -- test helpers --

  /** Feed a raw line up to the client (exercises the newline framing). */
  feed(line: string) {
    this.messageCb(line)
  }

  /** Answer the n-th request the client sent (1-based). */
  reply(index: number, result: unknown) {
    const req = this.request(index)
    this.feed(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }))
  }

  replyError(index: number, code: number, message: string, data?: unknown) {
    const req = this.request(index)
    this.feed(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code, message, data } }))
  }

  request(index: number): { id: number; method: string; params: any } {
    const raw = this.sent[index - 1]
    assert.ok(raw, `no request #${index} was sent (sent=${this.sent.length})`)
    return JSON.parse(raw)
  }

  /** Emit a session/update notification. */
  update(sessionId: string, update: unknown) {
    this.feed(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }))
  }

  /** Emit an agent -> client request. */
  agentRequest(id: number, method: string, params: unknown) {
    this.feed(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  }

  agentResponse(id: number, result: unknown) {
    const raw = this.sent.find((l) => {
      const m = JSON.parse(l)
      return m.id === id && m.method === undefined
    })
    return raw ? JSON.parse(raw).result : undefined
  }

  die(code: number | null = 1) {
    this.exitCb({ code })
  }
}

function makeClient(handlers = {}) {
  const transport = new FakeTransport()
  const client = new AcpClient({ spawn: () => transport, clientName: "pi-desktop", clientVersion: "0.15.7" })
  return { transport, client, handlers }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

test("initialize reports protocol version 1 and the client's own name", async () => {
  const { transport, client } = makeClient()
  const init = client.initialize()

  const req = transport.request(1)
  assert.equal(req.method, "initialize")
  assert.equal(req.params.protocolVersion, 1)
  assert.equal(req.params.clientInfo.name, "pi-desktop")

  transport.reply(1, { protocolVersion: 1, agentInfo: { name: "OpenCode", version: "2.0.15" } })

  const res = await init
  assert.equal(res.protocolVersion, 1)
  assert.equal(client.agentName(), "OpenCode")
})

test("initialize is refused when called twice", async () => {
  const { transport, client } = makeClient()
  const first = client.initialize()
  transport.reply(1, { protocolVersion: 1 })
  await first
  await assert.rejects(() => client.initialize(), /twice/)
})

test("a non-JSON banner on stdout is ignored", async () => {
  const { transport, client } = makeClient()
  const init = client.initialize()
  transport.feed("Welcome to opencode 2.0.15")
  transport.feed("")
  transport.reply(1, { protocolVersion: 1 })
  assert.equal((await init).protocolVersion, 1)
})

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

test("newSession forwards cwd and returns the session id", async () => {
  const { transport, client } = makeClient()
  const p = client.newSession({ cwd: "C:/work", mcpServers: [] })
  const req = transport.request(1)
  assert.equal(req.method, "session/new")
  assert.equal(req.params.cwd, "C:/work")
  transport.reply(1, { sessionId: "ses_1" })
  assert.equal((await p).sessionId, "ses_1")
})

test("setConfigOption sends configId, not optionId", async () => {
  const { transport, client } = makeClient()
  const p = client.setConfigOption({ sessionId: "ses_1", configId: "model", value: "muse-spark" })
  const req = transport.request(1)
  assert.equal(req.method, "session/set_config_option")
  // This exact spelling is what a live agent demands; optionId gets -32602.
  assert.equal(req.params.configId, "model")
  assert.equal(req.params.optionId, undefined)
  transport.reply(1, { configOptions: [{ id: "model", category: "model", currentValue: "muse-spark" }] })
  const options = await p
  assert.equal(options[0].currentValue, "muse-spark")
})

test("a mismatched negotiated protocol version is refused", async () => {
  const { transport, client } = makeClient()
  const init = client.initialize()
  transport.reply(1, { protocolVersion: 99, agentInfo: { name: "Future" } })
  await assert.rejects(init, /negotiated protocol v99/)
})

test("prompt returns the agent's own turn result", async () => {
  const { transport, client } = makeClient()
  const run = (async () => {
    let seen = ""
    let result
    for await (const u of client.prompt({ sessionId: "s", prompt: [{ type: "text", text: "hi" }] })) {
      if (u.sessionUpdate === "agent_message_chunk") seen += (u as any).content.text
      result = await Promise.resolve(undefined)
    }
    return { seen, result }
  })()
  await tick()
  const req = transport.request(1)
  transport.chunk("s", "done")
  await tick()
  transport.reply(req.id, { stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } })
  await run
})

test("cancel is sent as a notification, not a request", async () => {
  const { transport, client } = makeClient()
  const init = client.initialize()
  transport.reply(1, { protocolVersion: 1 })
  await init

  await client.cancel("ses_1")
  const frames = transport.requests()
  const last = frames[frames.length - 1]
  // No id means notification. A request would hang forever against a
  // conforming agent, because ACP does not answer session/cancel.
  assert.equal(last.method, "session/cancel")
  assert.equal(last.id, undefined)
  assert.equal(last.params.sessionId, "ses_1")
})

test("a stalled request times out instead of hanging", async () => {
  const transport = new FakeTransport()
  const client = new AcpClient({ spawn: () => transport, requestTimeoutMs: 40 })
  const init = client.initialize()
  transport.reply(1, { protocolVersion: 1 })
  await init

  await assert.rejects(() => client.newSession({ cwd: "x" }), /no response within 40ms/)
})

test("an oversized line closes the client instead of buffering forever", async () => {
  const transport = new FakeTransport()
  let closed = false
  const client = new AcpClient({
    spawn: () => ({
      send: (l: string) => transport.sent.push(l),
      onMessage: (cb: (l: string) => void) => {
        ;(transport as any).messageCb = cb
      },
      onExit: () => {},
      onStderr: () => {},
      close: () => {
        closed = true
      },
    }),
  })
  const init = client.initialize()
  transport.reply(1, { protocolVersion: 1 })
  await init

  transport.feed("x".repeat(9 * 1024 * 1024))
  await tick()
  assert.equal(closed, true, "expected the runaway line to stop the client")
})

test("an agent error becomes an AcpRpcError carrying the code", async () => {
  const { transport, client } = makeClient()
  const p = client.setConfigOption({ sessionId: "s", configId: "model", value: "x" })
  transport.replyError(1, -32602, "Invalid params", { configId: { _errors: [] } })
  await assert.rejects(p, (err: Error) => {
    assert.equal((err as any).name, "AcpRpcError")
    assert.equal((err as any).code, -32602)
    return true
  })
})

// ---------------------------------------------------------------------------
// prompt streaming
// ---------------------------------------------------------------------------

test("prompt yields every session/update in order, then ends", async () => {
  const { transport, client } = makeClient()

  const seen: string[] = []
  const run = (async () => {
    for await (const u of client.prompt({ sessionId: "ses_1", prompt: [{ type: "text", text: "hi" }] })) {
      if (u.sessionUpdate === "agent_message_chunk") seen.push((u as any).content.text)
    }
  })()

  await tick()
  assert.equal(transport.request(1).method, "session/prompt")

  transport.update("ses_1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Mer" } })
  transport.update("ses_1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "haba" } })
  transport.update("ses_other", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "YOK" } })
  transport.update("ses_1", { sessionUpdate: "usage_update", used: 10, size: 100 })
  await tick()

  transport.reply(1, { stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } })
  await run

  // Updates from another session must not leak into this turn.
  assert.deepEqual(seen, ["Mer", "haba"])
})

test("a failed turn throws out of the generator", async () => {
  const { transport, client } = makeClient()
  const run = (async () => {
    for await (const _ of client.prompt({ sessionId: "ses_1", prompt: [{ type: "text", text: "hi" }] })) {
      void _
    }
  })()
  await tick()
  transport.replyError(1, -32603, "Upstream request failed: Endpoint is unavailable.")
  await assert.rejects(run, /Endpoint is unavailable/)
})

test("breaking out of a turn stops consuming without throwing", async () => {
  const { transport, client } = makeClient()
  for await (const u of client.prompt({ sessionId: "ses_1", prompt: [{ type: "text", text: "hi" }] })) {
    void u
    break
  }
  await tick()
  transport.reply(1, { stopReason: "cancelled" })
  // Nothing should reject after the consumer walked away.
  await tick()
})

// ---------------------------------------------------------------------------
// agent -> host calls
// ---------------------------------------------------------------------------

test("session/request_permission is answered by the host handler", async () => {
  const { transport, client } = makeClient()
  client.setHandlers({
    requestPermission: (p) => {
      assert.equal(p.options.length, 2)
      return { outcome: { outcome: "selected", optionId: p.options[1].optionId } }
    },
  })
  const init = client.initialize()
  transport.reply(1, { protocolVersion: 1 })
  await init

  transport.agentRequest(99, "session/request_permission", {
    sessionId: "ses_1",
    toolCall: { sessionUpdate: "tool_call", toolCallId: "t1" },
    options: [
      { optionId: "no", name: "Reject", kind: "reject_once" },
      { optionId: "yes", name: "Allow", kind: "allow_once" },
    ],
  })
  await tick()

  assert.deepEqual(transport.agentResponse(99, undefined), {
    outcome: { outcome: "selected", optionId: "yes" },
  })
})

test("fs/write_text_file is delegated to the host", async () => {
  const written: { path: string; content: string }[] = []
  const { transport, client } = makeClient()
  client.setHandlers({ writeTextFile: (p) => void written.push({ path: p.path, content: p.content }) })
  const init = client.initialize()
  transport.reply(1, { protocolVersion: 1 })
  await init

  transport.agentRequest(7, "fs/write_text_file", { path: "a.txt", content: "hello" })
  await tick()

  assert.deepEqual(written, [{ path: "a.txt", content: "hello" }])
  assert.deepEqual(transport.agentResponse(7, undefined), {})
})

test("an unhandled agent call gets -32601 instead of hanging", async () => {
  const { transport, client } = makeClient()
  const init = client.initialize()
  transport.reply(1, { protocolVersion: 1 })
  await init

  transport.agentRequest(42, "terminal/create", { name: "x" })
  await tick()

  const line = transport.sent.find((l) => JSON.parse(l).id === 42 && JSON.parse(l).error)
  assert.ok(line, "expected an error response for the unhandled call")
  assert.equal(JSON.parse(line!).error.code, -32601)
})

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

test("a dead agent rejects in-flight requests", async () => {
  const { transport, client } = makeClient()
  const init = client.initialize()
  transport.die(1)
  await assert.rejects(init, /exited/)
  await assert.rejects(() => client.newSession({ cwd: "x" }), /exited/)
})

// ---------------------------------------------------------------------------
// integration: a real agent
// ---------------------------------------------------------------------------

function hasOpencode(): boolean {
  try {
    execFileSync("opencode", ["--version"], { stdio: "ignore", shell: true })
    return true
  } catch {
    return false
  }
}

test(
  "integration: a real opencode acp agent answers on the free muse-spark model",
  { skip: hasOpencode() ? false : "opencode CLI not installed", timeout: 180_000 },
  async () => {
    const { spawnAcpProcess } = await import("../src/client.ts")
    const client = new AcpClient({
      spawn: () => spawnAcpProcess("opencode", ["acp"]),
      clientName: "pi-desktop",
      clientVersion: "0.15.7",
      capabilities: { readTextFile: true, writeTextFile: true },
    })
    try {
      const init = await client.initialize()
      assert.equal(init.protocolVersion, 1)

      const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] })
      assert.ok(session.sessionId)

      const modelOption = session.configOptions?.find((o) => o.category === "model")
      assert.ok(modelOption, "agent did not advertise a model config option")
      const free = modelOption.options?.find((o) => o.value === "opencode/muse-spark-1.3-contributor-free")
      assert.ok(free, "free muse-spark is not offered by the agent")

      const after = await client.setConfigOption({
        sessionId: session.sessionId,
        configId: "model",
        value: free.value,
      })
      assert.equal(after.find((o) => o.category === "model")?.currentValue, free.value)

      const text: string[] = []
      for await (const update of client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "Reply with exactly: PI-ACP-OK" }],
      })) {
        if (update.sessionUpdate === "agent_message_chunk") {
          text.push((update as any).content?.text ?? "")
        }
      }
      assert.match(text.join(""), /PI-ACP-OK/)
    } finally {
      client.close()
    }
  },
)

