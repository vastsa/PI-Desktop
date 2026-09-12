// Deterministic OpenAI-compatible Chat Completions stub for the trusted
// extensions E2E run. Streams SSE. Behaviour keyed on the latest user text:
//   "add"  -> tool call fx_add {a:20,b:22}; after a tool result -> "Sum is <r>."
//   "bash" -> tool call Bash {command:"echo hi"}; after a tool result -> "Bash said: <r>"
// Every request is appended to REQUEST_LOG as JSON for assertions.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const port = Number(process.env.STUB_PORT || 47123);
const log = process.env.REQUEST_LOG || "/tmp/pi-ext-e2e/requests.jsonl";

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") {
      return typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join("");
    }
  }
  return "";
}

function lastToolResult(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool") return messages[i];
    if (messages[i].role === "user") return undefined;
  }
  return undefined;
}

function sse(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

let counter = 0;
createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (!req.url.endsWith("/chat/completions")) {
      res.writeHead(404); res.end("{}"); return;
    }
    const payload = JSON.parse(body || "{}");
    appendFileSync(log, JSON.stringify({ headers: req.headers, payload }) + "\n");
    const id = `chatcmpl-${++counter}`;
    const base = { id, object: "chat.completion.chunk", created: 1, model: payload.model };
    const toolResult = lastToolResult(payload.messages);
    const user = lastUserText(payload.messages).toLowerCase();
    const text = (t) => [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: t }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    const call = (name, args) => [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${counter}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    const toolNamesNow = new Set((payload.tools ?? []).map((t) => t.function?.name));
    if (toolResult && user.includes("add") && toolNamesNow.has("fx_add") && !/42|\(replaced\)/.test(JSON.stringify(toolResult.content))) {
      return sse(res, call("fx_add", { a: 20, b: 22 }));
    }
    if (toolResult) {
      const content = typeof toolResult.content === "string" ? toolResult.content : JSON.stringify(toolResult.content);
      if (user.includes("bash")) return sse(res, text(`Bash said: ${content.slice(0, 200)}`));
      return sse(res, text(`Sum is ${content.slice(0, 200)}.`));
    }
    const toolNames = new Set((payload.tools ?? []).map((t) => t.function?.name));
    if (user.includes("bash")) return sse(res, call("Bash", { command: "echo hi" }));
    if (user.includes("add")) {
      // Extension tools are deferred like plugin tools: activate through ToolSearch first.
      if (!toolNames.has("fx_add") && toolNames.has("ToolSearch")) return sse(res, call("ToolSearch", { query: "fx_add" }));
      return sse(res, call("fx_add", { a: 20, b: 22 }));
    }
    return sse(res, text("Hello from the stub."));
  });
}).listen(port, "127.0.0.1", () => console.log(`stub listening on ${port}`));
