/**
 * ACP smoke run — the smallest thing that proves an external agent is usable.
 *
 *   node --test-style run:
 *   node scripts/acp-smoke.ts                       # defaults to opencode + muse-spark free
 *   node scripts/acp-smoke.ts claude                # a different agent
 *   node scripts/acp-smoke.ts opencode C:/work      # a different project directory
 *
 * It walks the same path the desktop app will: spawn the agent, initialize,
 * open a session, pick a model, prompt it, and print what came back. The
 * permission handler auto-approves so a tool-using turn can finish.
 */

import { AcpClient, spawnAcpProcess, resolveAcpExecutable } from "../src/index.ts"
import type { AcpRequestPermissionParams, AcpSessionUpdate } from "../src/types.ts"

const AGENT = process.argv[2] ?? "opencode"
const CWD = process.argv[3] ?? process.cwd()
const ARGS = AGENT === "opencode" ? ["acp"] : ["acp"]
const WANT_MODEL = process.env.ACP_MODEL ?? "opencode/muse-spark-1.3-contributor-free"

function say(...parts: unknown[]) {
  console.log(...parts)
}

const resolved = resolveAcpExecutable(AGENT)
say(`agent     : ${AGENT} -> ${resolved.command}`)
say(`           (viaShell=${resolved.viaShell}, source=${resolved.source})`)
say(`cwd       : ${CWD}`)
say("")

const client = new AcpClient({
  spawn: () => spawnAcpProcess(AGENT, ARGS, CWD),
  clientName: "pi-desktop-acp-smoke",
  clientVersion: "0.15.7",
  capabilities: { readTextFile: true, writeTextFile: true },
  onStderr: (c) => process.stderr.write(`[agent] ${c}`),
})

let approved = 0
client.setHandlers({
  requestPermission: (p: AcpRequestPermissionParams) => {
    const allow = p.options.find((o) => o.kind?.startsWith("allow"))
    approved++
    say(`  [permission] ${p.toolCall.title ?? p.toolCall.toolCallId} -> ${allow?.name ?? "cancelled"}`)
    return allow
      ? { outcome: { outcome: "selected" as const, optionId: allow.optionId } }
      : { outcome: { outcome: "cancelled" as const } }
  },
  writeTextFile: (p) => {
    say(`  [write] ${p.path} (${p.content.length} bytes) — not actually written by the smoke run`)
  },
  readTextFile: (p) => ({ content: `// smoke run has no filesystem bridge for ${p.path}\n` }),
})

async function main() {
  const init = await client.initialize()
  say(`connected : ${init.agentInfo?.name ?? "?"} ${init.agentInfo?.version ?? ""} (protocol v${init.protocolVersion})`)

  const session = await client.newSession({ cwd: CWD, mcpServers: [] })
  say(`session   : ${session.sessionId}`)

  const modelOption = session.configOptions?.find((o) => o.category === "model")
  const options = modelOption?.options ?? []
  say(`models    : ${options.length} advertised`)
  if (modelOption?.currentValue) say(`default   : ${modelOption.currentValue}`)

  const free = options.find((o) => o.value === WANT_MODEL)
  if (free) {
    const after = await client.setConfigOption({ sessionId: session.sessionId, configId: "model", value: free.value })
    const now = after.find((o) => o.category === "model")?.currentValue
    say(`switched  : ${now}`)
  } else {
    say(`note      : ${WANT_MODEL} is not offered by this agent; staying on the default`)
  }

  say("\n--- turn ---")
  const started = Date.now()
  let answer = ""
  for await (const update of client.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Reply with exactly: SMOKE-OK" }],
  })) {
    handle(update, (t) => (answer += t))
  }

  say(`elapsed   : ${Date.now() - started}ms`)
  say(`approved  : ${approved} permission request(s)`)
  say(`answer    : ${JSON.stringify(answer)}`)
  say(answer.includes("SMOKE-OK") ? "\nSMOKE RESULT: OK" : "\nSMOKE RESULT: unexpected answer")
}

function handle(update: AcpSessionUpdate, append: (t: string) => void) {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      append((update.content as { text?: string })?.text ?? "")
      break
    case "agent_thought_chunk":
      say(`  [thought] ${((update.content as { text?: string })?.text ?? "").slice(0, 120)}`)
      break
    case "tool_call":
    case "tool_call_update":
      say(`  [tool:${update.sessionUpdate === "tool_call" ? "new" : "update"}] ${update.title ?? ""} ${update.status ?? ""}`)
      break
    case "plan":
      say(`  [plan] ${update.entries?.length} step(s)`)
      break
    case "usage_update":
      if (update.used) say(`  [usage] ${update.used}/${update.size} tokens`)
      break
    case "available_commands_update":
      say(`  [commands] ${update.availableCommands?.length} available`)
      break
    default:
      break
  }
}

main()
  .then(() => client.close())
  .catch((err) => {
    say(`\nSMOKE RESULT: FAILED — ${err instanceof Error ? err.message : String(err)}`)
    client.close()
    process.exitCode = 1
  })
