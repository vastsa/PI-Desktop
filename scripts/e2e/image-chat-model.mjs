import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

// Deterministic raster fixtures, not AI artwork. Only the HTTP provider is mocked.
function png(edited, variant) {
  const width = 480, height = 320;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      const circle = (x - 240) ** 2 + (y - 145) ** 2 < 82 ** 2;
      const floor = y > 250;
      const color = circle ? [245, 169 + variant * 15, 85] : floor ? [40, 56, 66] : edited ? [49, 105 + Math.floor(y / 8), 92] : [42 + Math.floor(y / 12), 70, 119 + variant * 15];
      pixels.set([...color, 255], offset);
    }
  }
  const chunk = (type, data) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length); payload.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

export function imageChatModel() {
  let scenario = "batch", pending, done = false, calls = 0;
  const results = [], imageRequests = [], failures = [];
  const handler = async (req, res) => {
    try {
      if (req.method === "GET" && req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fixture", object: "model" }] }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      if (req.url.includes("/images/")) {
        const edited = req.url.endsWith("/edits");
        if (edited) {
          assert.match(req.headers["content-type"], /multipart\/form-data/);
          assert.ok(raw.includes(Buffer.from("image/png")));
          assert.ok(raw.includes(Buffer.from("89504e470d0a1a0a", "hex")), "edit uploads source PNG");
        }
        imageRequests.push({ edited, bytes: raw.length });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: png(edited, imageRequests.length % 2).toString("base64") }] }));
        return;
      }
      const request = JSON.parse(raw.toString());
      if (pending) {
        const result = request.messages.find((item) => item.role === "tool" && item.tool_call_id === pending.id);
        assert.ok(result, "tool result returns to model");
        if (pending.name === "generate_images") {
          const text = typeof result.content === "string" ? result.content : result.content.map((item) => item.text ?? "").join("");
          const value = JSON.parse(text);
          results.push({ scenario, value });
          done = true;
        }
        pending = undefined;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: `image-chat-${++calls}`, object: "chat.completion.chunk", created: 1, model: request.model };
      const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (!done) {
        const available = request.tools?.some((tool) => tool.function?.name === "generate_images");
        const name = available ? "generate_images" : "tool_search";
        let args = { query: "generate_images" };
        if (available) {
          const source = results.find((result) => result.scenario === "batch")?.value.results?.[0]?.path;
          if (scenario === "edit") assert.ok(source, "generation returns an editable path");
          args = { items: [{ prompt: scenario === "edit" ? "Keep the orange sphere and change the background to green." : "An orange sphere on a blue background.", count: scenario === "batch" ? 2 : 1, ...(scenario === "edit" ? { images: [source] } : {}) }] };
        }
        pending = { id: `image-call-${calls}`, name };
        emit({ role: "assistant", tool_calls: [{ index: 0, id: pending.id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
        emit({}, "tool_calls");
      } else {
        const text = scenario === "batch" ? "已生成两张图片，可在对话中查看。" : scenario === "edit" ? "已将第一张图的背景改为绿色，原图保留。" : "请先到模型设置选择生图模型，再重试。";
        emit({ role: "assistant", content: text }); emit({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    } catch (error) {
      failures.push(String(error));
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  };
  return { handler, results, imageRequests, failures, setScenario(value) { scenario = value; pending = undefined; done = false; } };
}
