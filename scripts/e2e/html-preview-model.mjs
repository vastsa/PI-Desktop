// Only the provider boundary is synthetic; the app executes the real tool.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

export async function startHtmlPreviewModel() {
  let path, pending, completed = false, calls = 0;
  const failures = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url.endsWith("/models")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "html-fixture", object: "model" }] }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString());
      if (pending) {
        const result = request.messages.find(message =>
          message.role === "tool" && message.tool_call_id === pending.id);
        assert.ok(result, "the real tool returns its result to the provider");
        if (pending.name === "BrowserPreview") {
          const content = typeof result.content === "string" ? result.content
            : result.content.map(part => part.text ?? "").join("");
          assert.match(content, /Opened a new Browser tab/);
          completed = true;
        }
        pending = undefined;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "html-" + ++calls, object: "chat.completion.chunk", created: 1, model: request.model };
      const emit = (delta, finish_reason = null) => res.write("data: " + JSON.stringify({
        ...base, choices: [{ index: 0, delta, finish_reason }],
      }) + "\n\n");
      if (completed) {
        emit({ role: "assistant", content: "HTML preview tool completed." });
        emit({}, "stop");
      } else {
        const available = request.tools?.some(tool => tool.function?.name === "BrowserPreview");
        const name = available ? "BrowserPreview" : "ToolSearch";
        assert.ok(request.tools?.some(tool => tool.function?.name === name), name + " is available");
        pending = { id: "html-tool-" + calls, name };
        emit({ role: "assistant", tool_calls: [{ index: 0, id: pending.id, type: "function",
          function: { name, arguments: JSON.stringify(available ? { path } : { query: "BrowserPreview" }) },
        }] });
        emit({}, "tool_calls");
      }
      res.end("data: [DONE]\n\n");
    } catch (error) {
      failures.push(String(error));
      if (!res.headersSent) res.writeHead(400);
      res.end("HTML fixture failed");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
    failures,
    preview(file) { path = file; pending = undefined; completed = false; },
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
