import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import type { UiMessage } from "@pi-desktop/shared";
import { modelConfigFromPi } from "./model-capabilities.js";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";

// User path: the model writes a visualization fragment through the real Write
// tool wiring, and the next model request carries the check result.

const DIR = "/data/visualizations/sess_check";

function provider(): RuntimeProviderConfig {
  const model = Object.values(DEEPSEEK_MODELS).find((m) => m.id === "deepseek-flash")!;
  return { id: "flash-fixture", name: "Flash", modelId: model.id, baseUrl: model.baseUrl,
    apiKey: "fixture", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: modelConfigFromPi(model) };
}

type Payload = { messages: { role: string; content?: unknown }[] };

async function wire(args: Record<string, unknown>) {
  const requests: Payload[] = [];
  const realFetch = globalThis.fetch;
  let first = true;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const delta = first
      ? { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function",
          function: { name: "Write", arguments: JSON.stringify(args) } }] }
      : { role: "assistant", content: "Done." };
    const finish = first ? "tool_calls" : "stop";
    first = false;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  vi.stubGlobal("fetch", ((_url, init) => realFetch(`http://127.0.0.1:${address.port}`, init)) satisfies typeof fetch);
  return { requests, close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))) };
}

async function writeThrough(args: Record<string, unknown>, hostOk = true) {
  const w = await wire(args);
  const rows: UiMessage[] = [];
  const runtime = new DesktopAgentRuntime({
    sessionId: "sess_check", mode: "agent", provider: provider(), thinkingLevel: "off", history: rows,
    visualizationsDir: DIR,
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      if (method === "session.appendMessage") rows.push((params as { message: UiMessage }).message);
      else if (method === "tools.execute") {
        return (hostOk ? { ok: true, content: "Wrote file" } : { ok: false, content: "EACCES" }) as T;
      } else if (method !== "instructions.forPath") throw new Error(`Unexpected host method: ${method}`);
      return undefined as T;
    } },
    onEvent: () => undefined,
  });
  try {
    rows.push({ id: "u1", role: "user", content: "Chart it", createdAt: new Date().toISOString() });
    await runtime.prompt("Chart it", "u1", "turn-u1");
    const tool = w.requests[1]?.messages.find((m) => m.role === "tool");
    return typeof tool?.content === "string" ? tool.content : JSON.stringify(tool?.content);
  } finally {
    await runtime.dispose();
    vi.unstubAllGlobals();
    await w.close();
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("visualization fragment check in the Write result", () => {
  it("tells the model about a wrong container id", async () => {
    const result = await writeThrough({
      path: `${DIR}/sorts.html`,
      content: `<div id="sb-chart"></div><script>viz.render("sb-bar", { mark: "bar" });</script>`,
    });
    expect(result).toContain("Wrote file");
    expect(result).toContain("Fix them with one Edit, then reply:");
    expect(result).toContain('element id "sb-bar"');
  });

  it("leaves a clean fragment's result unchanged", async () => {
    const result = await writeThrough({
      path: `${DIR}/ok.html`,
      content: `<div id="c"></div><script>viz.render("c", { mark: "bar" });</script>`,
    });
    expect(result).toBe("Wrote file");
  });

  it("does not check files outside the visualization directory or failed writes", async () => {
    const broken = `<script>viz.render("nope", {});</script>`;
    expect(await writeThrough({ path: "/project/page.html", content: broken })).toBe("Wrote file");
    expect(await writeThrough({ path: `${DIR}/x.html`, content: broken }, false)).not.toContain("Visualization check");
  });
});
