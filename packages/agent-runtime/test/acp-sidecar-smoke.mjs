/**
 * Sidecar integration check: drive the real sidecar the way Electron main
 * does — NDJSON JSON-RPC on stdio — and confirm that an ACP-backed session
 * actually reaches `opencode acp` and comes back as normalized desktop events.
 *
 * This is the first test that exercises the whole new chain at once:
 *
 *   agent.prompt (with `acp`)
 *     -> sidecar dispatch -> AcpSessionRuntime
 *     -> AcpClient -> `opencode acp`
 *     -> AcpEventTranslator -> AgentEventEnvelope notifications
 *
 * It needs the bundled sidecar (`pnpm -C packages/agent-runtime bundle`).
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
// test/ -> agent-runtime/ -> packages/ -> repo root
const repo = resolve(here, "..", "..", "..")
const sidecar = join(repo, "packages", "agent-runtime", "dist-bundle", "sidecar.js")

if (!existsSync(sidecar)) {
  console.error(`sidecar bundle missing: ${sidecar}`)
  console.error("run: pnpm -C packages/agent-runtime bundle")
  process.exit(2)
}

const SESSION = "sess_it_1"
const TURN = "turn_it_1"
const PROMPT = process.argv[2] ?? "Reply with exactly: SIDECAR-ACP-OK"

const child = spawn(process.execPath, [sidecar], {
  cwd: repo,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PI_BUNDLED_NODE: "true" },
})

let buf = ""
const events = []
const logs = []
let nextId = 1
const pending = new Map()

child.stdout.setEncoding("utf8")
child.stdout.on("data", (chunk) => {
  buf += chunk
  for (;;) {
    const i = buf.indexOf("\n")
    if (i === -1) return
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let m
    try {
      m = JSON.parse(line)
    } catch {
      logs.push(line)
      continue
    }
    if (m.method === "agent.event") events.push(m.params)
    else if (m.id !== undefined && m.method === undefined) {
      const entry = pending.get(m.id)
      if (entry) {
        pending.delete(m.id)
        entry(m)
      }
    } else {
      logs.push(JSON.stringify(m))
    }
  }
})
child.stderr.setEncoding("utf8")
child.stderr.on("data", (d) => process.stderr.write(`[sidecar] ${d}`))

const call = (method, params, timeoutMs = 180_000) =>
  new Promise((res) => {
    const id = nextId++
    pending.set(id, res)
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    setTimeout(() => {
      if (pending.delete(id)) res({ error: { message: `timeout on ${method}` } })
    }, timeoutMs)
  })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const health = await call("sidecar.health", {}, 30_000)
  console.log(`sidecar health: ${JSON.stringify(health.result ?? health.error)}`)

  const accepted = await call("agent.prompt", {
    sessionId: SESSION,
    content: PROMPT,
    turnId: TURN,
    acp: {
      command: "opencode",
      args: ["acp"],
      cwd: repo,
      modelId: "opencode/muse-spark-1.3-contributor-free",
    },
  })
  console.log(`prompt accepted: ${JSON.stringify(accepted.result ?? accepted.error)}`)

  // The turn runs in the background; the sidecar answers before it finishes.
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (events.some((e) => e.event?.type === "agent_end")) break
    await wait(500)
  }
  await wait(500)

  const types = events.map((e) => e.event.type)
  console.log(`\nevents (${events.length}): ${types.join(", ")}`)

  const text = events
    .filter((e) => e.event.type === "message_end")
    .map((e) => e.event.message?.content ?? "")
    .join("")
  console.log(`answer: ${JSON.stringify(text)}`)

  const problems = []
  if (!accepted.result?.accepted) problems.push("prompt was not accepted")
  if (!events.length) problems.push("no agent events arrived")
  if (!types.includes("message_start")) problems.push("no message_start")
  if (!types.includes("message_end")) problems.push("no message_end")
  if (!types.includes("agent_end")) problems.push("no agent_end (turn never closed)")
  if (!types.includes("turn_end")) problems.push("no turn_end")
  if (!text.trim()) problems.push("assistant message is empty")
  if (!text.includes("SIDECAR-ACP-OK")) problems.push("assistant did not echo the expected token")
  // The ACP session id must never leak into the host envelope.
  if (events.some((e) => e.sessionId !== SESSION)) problems.push("an envelope carried a foreign sessionId")
  if (events.some((e) => e.turnId !== TURN)) problems.push("an envelope carried a foreign turnId")

  console.log("")
  if (problems.length === 0) {
    console.log("SIDECAR ACP RESULT: OK")
  } else {
    console.log("SIDECAR ACP RESULT: FAILED")
    for (const p of problems) console.log(`  - ${p}`)
    if (logs.length) console.log(`sidecar said: ${logs.slice(0, 6).join(" | ")}`)
  }

  await call("agent.disposeSession", { sessionId: SESSION }, 20_000).catch(() => undefined)
  child.kill()
  process.exit(problems.length === 0 ? 0 : 1)
}

main()
