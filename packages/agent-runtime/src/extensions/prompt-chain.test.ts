import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DesktopAgentRuntime } from "../runtime.js";
import { clearTrustedExtensionCache } from "./runner.js";

it.each([
  { names: ["A", "B"] },
  { names: ["A", "B", "C"] },
])("sends $names prompt additions in order without accumulating across turns", async ({ names }) => {
  const root = mkdtempSync(join(tmpdir(), "pi-prompt-chain-"));
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Ready." }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n");
  });
  let runtime: DesktopAgentRuntime | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const extensions = names.map((name) => {
      const entry = join(root, `${name}.ts`);
      writeFileSync(entry, `export default function (pi) {
        pi.on("before_agent_start", (event) => ({
          systemPrompt: event.systemPrompt + "\\n\\nMARKER-${name}"
        }));
      }`);
      return { id: name, entry, label: name, root, source: "plugin" as const };
    });
    runtime = new DesktopAgentRuntime({
      host: {
        call: async (method) => { throw new Error(`Unexpected host call: ${method}`); },
        onNotification: () => () => {},
      },
      sessionId: "prompt-chain-fixture",
      projectPath: root,
      mode: "agent",
      thinkingLevel: "off",
      compactionSettings: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
      provider: {
        id: "fixture", name: "Fixture", apiKey: "", authKind: "none",
        baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: "fixture",
        supportsReasoning: false, supportedThinkingLevels: ["off"],
      },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      trustedExtensions: extensions,
      onEvent: () => {},
    });
    await runtime.loadTrustedExtensions();
    await runtime.prompt("First turn.");
    await runtime.prompt("Second turn.");
    expect(requests).toHaveLength(2);
    const prompts = requests.map((request) => request.messages
      .filter((message) => message.role === "system" || message.role === "developer")
      .map((message) => message.content).join("\n"));
    expect(prompts[0]).toContain(names.map((name) => `MARKER-${name}`).join("\n\n"));
    expect(prompts[1]).toBe(prompts[0]);
    for (const name of names) expect(prompts[1].split(`MARKER-${name}`)).toHaveLength(2);
  } finally {
    await runtime?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearTrustedExtensionCache();
    rmSync(root, { recursive: true, force: true });
  }
});
