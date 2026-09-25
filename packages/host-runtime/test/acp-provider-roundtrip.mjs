/**
 * host-core round-trip check for the ACP provider config.
 *
 * Writes a provider carrying an ACP agent, reads the list back, then clears the
 * agent with an explicit `null` and reads again. This exercises the Rust side
 * end to end â€” `config_with_acp` on the way in, `config_acp` on the way out â€”
 * which is what the settings dialog depends on. Without it, a form that looks
 * correct could silently save nothing.
 *
 * Usage: node packages/host-runtime/test/acp-provider-roundtrip.mjs [dataDir]
 */

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, "..", "..", "..")
const exe = process.platform === "win32" ? ".exe" : ""
const binary = join(repo, "target", "debug", `pi-desktop-host-core${exe}`)

// A throwaway data dir: this test must never touch a real profile.
const dataDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "pi-acp-rt-"))

const child = spawn(binary, [], {
  cwd: repo,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PI_DESKTOP_DATA_DIR: dataDir },
})

let buf = ""
let nextId = 1
const pending = new Map()
const notifications = []

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
      continue
    }
    if (m.id !== undefined && m.method === undefined) {
      const entry = pending.get(m.id)
      if (entry) {
        pending.delete(m.id)
        entry(m)
      }
    } else {
      notifications.push(m)
    }
  }
})
child.stderr.setEncoding("utf8")
child.stderr.on("data", (d) => process.stderr.write(`[host] ${d}`))

const call = (method, params, timeoutMs = 30_000) =>
  new Promise((res) => {
    const id = nextId++
    pending.set(id, res)
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    setTimeout(() => {
      if (pending.delete(id)) res({ error: { message: `timeout on ${method}` } })
    }, timeoutMs)
  })

const problems = []
const check = (ok, what) => {
  if (!ok) problems.push(what)
}

async function main() {
  // Every other RPC is refused until the handshake completes.
  const handshake = await call("app.handshake", { protocolVersion: 11 })
  check(Boolean(handshake.result), `handshake failed: ${JSON.stringify(handshake.error ?? {})}`)
  if (!handshake.result) {
    finish()
    return
  }
  console.log(`handshake ok (protocol ${handshake.result.protocolVersion ?? "?"})`)

  const acp = { command: "opencode", args: ["acp"], modelId: "opencode/muse-spark-1.3-contributor-free" }

  const created = await call("providers.create", {
    name: "ACP smoke",
    type: "custom",
    protocol: "openai_compatible",
    authKind: "none",
    acp,
  })
  const createdProvider = created.result?.provider
  check(Boolean(createdProvider?.id), `create failed: ${JSON.stringify(created.error ?? created.result)}`)
  if (!createdProvider?.id) {
    finish()
    return
  }
  console.log(`created: ${createdProvider.id}`)

  const list = await call("providers.list", { includeDisabled: true })
  const stored = list.result?.providers?.find((p) => p.id === createdProvider.id)
  check(Boolean(stored), "provider missing from providers.list")
  console.log(`read back acp: ${JSON.stringify(stored?.acp)}`)
  check(stored?.acp?.command === "opencode", "command did not round-trip")
  check(Array.isArray(stored?.acp?.args) && stored.acp.args[0] === "acp", "args did not round-trip")
  check(
    stored?.acp?.modelId === "opencode/muse-spark-1.3-contributor-free",
    "modelId did not round-trip",
  )

  // A partial update that omits `acp` must leave the agent alone.
  const renamed = await call("providers.update", { id: createdProvider.id, name: "ACP smoke renamed" })
  check(Boolean(renamed.result), "rename failed")
  const afterRename = renamed.result?.provider ?? stored
  check(
    afterRename?.acp?.command === "opencode",
    "an update that omitted acp cleared the agent",
  )

  // Removing the agent is an empty command. Serde maps a JSON `null` to "absent",
  // so the host translates the dialog's `null` into this before it gets here.
  const cleared = await call("providers.update", {
    id: createdProvider.id,
    acp: { command: "", args: [] },
  })
  const afterClear = cleared.result?.provider
  console.log(`after clear acp: ${JSON.stringify(afterClear?.acp)}`)
  check(
    !afterClear?.acp,
    "an explicit null did not clear the stored agent",
  )

  // A blank command stores no agent rather than an unusable one, and does not
  // fail the write.
  const blank = await call("providers.create", {
    name: "ACP blank",
    type: "custom",
    protocol: "openai_compatible",
    authKind: "none",
    acp: { command: "   ", args: ["acp"] },
  })
  check(Boolean(blank.result), `a blank command failed the write: ${JSON.stringify(blank.error ?? {})}`)
  check(!blank.result?.provider?.acp, "a blank command was stored as an agent")

  finish()
}

function finish() {
  child.kill()
  if (!process.argv[2]) {
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {}
  }
  console.log("")
  if (problems.length === 0) {
    console.log("PROVIDER ROUNDTRIP RESULT: OK")
  } else {
    console.log("PROVIDER ROUNDTRIP RESULT: FAILED")
    for (const p of problems) console.log(`  - ${p}`)
  }
  process.exit(problems.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error("unexpected", e)
  child.kill()
  process.exit(1)
})

