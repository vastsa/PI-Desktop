import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { vi } from "vitest";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import type { UiMessage } from "@pi-desktop/shared";
import { modelConfigFromPi } from "../model-capabilities.js";
import { DesktopAgentRuntime, type PluginToolDef, type RuntimeProviderConfig } from "../runtime.js";

export function flashProvider(): RuntimeProviderConfig {
  const model = Object.values(DEEPSEEK_MODELS).find((model) => model.id === "deepseek-flash")!;
  return { id: "flash-fixture", name: "Flash", modelId: model.id, baseUrl: model.baseUrl,
    apiKey: "fixture", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: modelConfigFromPi(model) };
}
export const pluginTools: PluginToolDef[] = ["plugin_alpha", "plugin_beta"].map((name) => ({
  name, description: `${name} synthetic probe`, parameters: { type: "object", properties: {}, required: [] }, risk: "low",
}));
export type Payload = { tools: { function: { name: string } }[]; messages: { role: string; content?: unknown }[] };
type Call = { name: string; args?: Record<string, unknown> };
export async function wireFixture(calls: Call[]) {
  const requests: Payload[] = [];
  const fetch = globalThis.fetch;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const call = calls.shift();
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(),
      type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }] }
      : { role: "assistant", content: "Done." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  vi.stubGlobal("fetch", ((_url, init) => fetch(`http://127.0.0.1:${address.port}`, init)) satisfies typeof fetch);
  return { requests, close: async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}
export function runtimeFixture(history: UiMessage[] = [], tools = pluginTools, provider = flashProvider(), denied = false) {
  const rows = structuredClone(history);
  const executed: string[] = [];
  const errors: unknown[] = [];
  const runtime = new DesktopAgentRuntime({
    sessionId: "fixed-tools", mode: "agent", provider, thinkingLevel: "off", history: rows, pluginTools: tools,
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "session.appendMessage") rows.push((params as { message: UiMessage }).message);
      else if (method === "tools.execute") {
        executed.push((params as { toolName: string }).toolName);
        return denied ? { ok: false, denied: true, content: "Permission denied" } as T
          : { ok: true, content: "Synthetic success" } as T;
      } else throw new Error(`Unexpected host method: ${method}`);
      return undefined as T;
    } },
    onEvent: ({ event }) => {
      if (event.type === "error") errors.push(event.error);
      if (event.type === "tool_start") rows.push({ id: event.toolCallId, role: "tool", content: "",
        toolCallId: event.toolCallId, toolName: event.toolName, toolArgs: event.args, createdAt: new Date().toISOString() });
      if (event.type === "tool_end") {
        const row = rows.find((row) => row.id === event.toolCallId)!;
        row.toolResult = event.result; row.isError = event.isError; row.toolStatus = event.isError ? "error" : "success";
      }
      if (event.type === "message_end") {
        const index = rows.findIndex((row) => row.id === event.message.id);
        if (index < 0) rows.push(event.message); else rows[index] = event.message;
      }
    },
  });
  return { runtime, rows, executed, errors, prompt: async (id = "user-1") => {
    rows.push({ id, role: "user", content: "Run the synthetic probes", createdAt: new Date().toISOString() });
    await runtime.prompt("Run the synthetic probes", id, `turn-${id}`);
  } };
}
