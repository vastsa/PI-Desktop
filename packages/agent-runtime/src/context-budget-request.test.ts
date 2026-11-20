import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { genericModelConfig } from "./model-capabilities.js";
import { DesktopAgentRuntime } from "./runtime.js";

const toolName = "plugin_demo_probe";
const marker = "<context_budget>";
type RequestBody = {
  messages: { role: string; content?: unknown; tool_call_id?: string }[];
  tools: unknown;
};

it.each([
  { supportsMidConvoSystemMessages: false, reminderRole: "user" },
  { supportsMidConvoSystemMessages: true, reminderRole: "system" },
])("preserves the Chat Completions prefix with a $reminderRole context budget reminder", async ({
  supportsMidConvoSystemMessages, reminderRole,
}) => {
  const requests: RequestBody[] = [];
  const paths: (string | undefined)[] = [];
  const server = createServer(async (request, response) => {
    paths.push(request.url);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const first = requests.length === 1;
    const delta = first
      ? { role: "assistant", tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: toolName, arguments: "{}" } }] }
      : { role: "assistant", content: "Done." };
    const event = {
      id: `chunk-${requests.length}`, object: "chat.completion.chunk", model: "fixture", created: 1,
      choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }],
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an IPv4 listener");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const host = { call: vi.fn(async (method: string, _params?: unknown) => {
    if (method === "tools.execute") return { ok: true, content: { content: [{ type: "text", text: "probe ok" }], details: {} } };
    if (method === "project.instructions.resolve") return { entries: [] };
    if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false };
    return undefined;
  }) };
  const runtime = new DesktopAgentRuntime({
    sessionId: "context-budget-wire", mode: "agent", thinkingLevel: "off",
    provider: {
      id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "", authKind: "none", baseUrl,
      supportsReasoning: false, supportedThinkingLevels: ["off"],
      ...(supportsMidConvoSystemMessages ? { modelConfig: {
        ...genericModelConfig("fixture", baseUrl), source: "pi",
        compat: { supportsMidConvoSystemMessages },
        transcriptBinding: { modelId: "fixture", api: "openai-completions", baseUrl },
      } } : {}),
    },
    host: host as never,
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    pluginTools: [{ name: toolName, description: "Probe", parameters: {} }],
    onEvent: vi.fn(),
  });
  vi.spyOn(runtime as any, "contextBudget").mockReturnValue({
    tokens: 213_000, hardLimit: 244_000, requestHeadroom: 18_144, keepRecentTokens: 8_000,
  });
  try {
    await runtime.prompt("Run the probe and report the result.", "user-1", "turn-1");

    expect(paths).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
    const [before, after] = requests;
    expect(JSON.stringify(before.messages)).not.toContain(marker);
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(after.tools).toEqual(before.tools);
    expect(after.messages.slice(-2)).toEqual([
      expect.objectContaining({ role: "tool", tool_call_id: "call_fixture" }),
      expect.objectContaining({ role: reminderRole, content: expect.stringContaining("About 31,000 tokens") }),
    ]);
    expect(after.messages.filter((message) => typeof message.content === "string" && message.content.includes(marker))).toHaveLength(1);
    const persisted = host.call.mock.calls.flatMap(([method, params]) => {
      const row = (params as { message?: { role: string; modelSystem?: { messageJson: string } } })?.message;
      return method === "session.appendMessage" && row?.modelSystem?.messageJson.includes(marker) ? [row] : [];
    });
    expect(persisted).toEqual([expect.objectContaining({ role: "system" })]);
  } finally {
    try {
      await runtime.dispose();
    } finally {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    }
  }
});
