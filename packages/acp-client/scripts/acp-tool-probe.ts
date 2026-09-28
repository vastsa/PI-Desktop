/**
 * What does an external agent actually ask of the host when it edits a file?
 *
 * The first probe only sent a one-line prompt and no permission request ever
 * arrived, so we never learned which of the two possible shapes this agent uses:
 *
 *   A) the agent does the edit itself and never mentions it, or
 *   B) the agent asks the client to read/write through the ACP callbacks.
 *
 * The answer decides the whole design. Under A there is nothing to bridge and
 * the real question becomes what the host is willing to allow. Under B the host
 * needs a filesystem route and a permission round trip.
 *
 * This probe counts callback hits and then checks the working directory, so both
 * outcomes are visible instead of guessed at.
 */

import { spawn } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AcpClient, spawnAcpProcess } from "../src/index.ts"
import type { AcpRequestPermissionParams } from "../src/types.ts"

const sandbox = mkdtempSync(join(tmpdir(), "acp-toolprobe-"))
const hits = { read: 0, write: 0, permission: 0, terminal: 0 }
const detail = []

const client = new AcpClient({
  spawn: () => spawnAcpProcess("opencode", ["acp"], sandbox),
  clientName: "pi-desktop-probe",
  clientVersion: "0.0.0",
  capabilities: { readTextFile: true, writeTextFile: true, terminal: true },
  onStderr: (c) => process.stderr.write(`[agent] ${c}`),
})

client.setHandlers({
  readTextFile: (p) => {
    hits.read++
    detail.push(`read ${p.path}`)
    return { content: existsSync(p.path) ? readFileSync(p.path, "utf8") : "" }
  },
  writeTextFile: (p) => {
    hits.write++
    detail.push(`write ${p.path} (${p.content.length} bytes)`)
  },
  requestPermission: (p: AcpRequestPermissionParams) => {
    hits.permission++
    detail.push(`permission ${p.toolCall.title ?? p.toolCall.toolCallId}`)
    const allow = p.options.find((o) => o.kind?.startsWith("allow")) ?? p.options[0]
    return allow
      ? { outcome: { outcome: "selected" as const, optionId: allow.optionId } }
      : { outcome: { outcome: "cancelled" as const } }
  },
})

let toolUpdates = 0
const toolNames = new Set()
client.onSessionUpdate((n) => {
  if (n.update.sessionUpdate === "tool_call") {
    toolUpdates++
    toolNames.add((n.update as { title?: string }).title ?? "?")
  }
})

async function main() {
  await client.initialize()
  const session = await client.newSession({ cwd: sandbox, mcpServers: [] })
  await client.setConfigOption({
    sessionId: session.sessionId,
    configId: "model",
    value: "opencode/muse-spark-1.3-contributor-free",
  })

  const prompt = [
    { type: "text", text: "Create a file named probe.txt in the current working directory whose content is exactly OK, then read it back to confirm." },
  ]

  let answer = ""
  for await (const u of client.prompt({ sessionId: session.sessionId, prompt })) {
    if (u.sessionUpdate === "agent_message_chunk") {
      answer += (u.content as { text?: string })?.text ?? ""
    }
  }

  console.log(`sandbox        : ${sandbox}`)
  console.log(`tool calls     : ${toolUpdates} ${[...toolNames].join(", ")}`)
  console.log(`host callbacks : read=${hits.read} write=${hits.write} permission=${hits.permission}`)
  if (detail.length) console.log(`detail         : ${detail.slice(0, 8).join(" | ")}`)
  console.log(`answer         : ${JSON.stringify(answer.slice(0, 200))}`)

  const files = readdirSync(sandbox)
  console.log(`files in cwd   : ${JSON.stringify(files)}`)
  if (files.includes("probe.txt")) {
    console.log(`probe.txt      : ${JSON.stringify(readFileSync(join(sandbox, "probe.txt"), "utf8"))}`)
  }

  console.log("")
  if (hits.read + hits.write + hits.permission > 0) {
    console.log("SHAPE: B — the agent delegates to the host; a filesystem route and a permission round trip are needed.")
  } else if (toolUpdates > 0) {
    console.log("SHAPE: A — the agent used its own tools and never asked the host. No bridge to build; the question becomes what the host will allow.")
  } else {
    console.log("SHAPE: unclear — the agent did neither. Needs a closer look at the turn.")
  }
}

main()
  .then(() => {
    client.close()
    rmSync(sandbox, { recursive: true, force: true })
    process.exit(0)
  })
  .catch((e) => {
    console.log("PROBE FAILED:", e instanceof Error ? e.message : String(e))
    client.close()
    rmSync(sandbox, { recursive: true, force: true })
    process.exit(1)
  })
