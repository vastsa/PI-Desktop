// Deterministic OpenAI-compatible Chat Completions stub for the UI slots E2E.
// The latest user prompt names the scenario:
//   "lab: probe <mode>" -> activate the lab's tool through ToolSearch when it
//                          is deferred, call it with that mode, then answer
//   "lab: chart <kind>" -> answer with a `lab.ui-slots:chart` fence whose
//                          first line is <kind> (`crash`, `tall`)
//   "lab: gate"         -> call the built-in Bash tool, which a session in
//                          Ask mode holds for the user's approval, then answer
// The first probe answer also carries a normal chart, so one turn fills every
// transcript slot.
import { createServer } from "node:http";

export const PROBE_TOOL = "plugin_lab_ui_slots_lab_probe";

const CHART = "```lab.ui-slots:chart\nalpha,3\nbeta,5\n```";

const ANSWERS = {
  ok: `Probe answered.\n\n${CHART}\n`,
  fail: "The probe failed on request.",
  crash: "The probe answered; its card crashes on request.",
  slow: "The slow probe answered.",
};

function textOf(content) {
  return typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
}

/** The latest user prompt and the tools called since it. */
function turnState(messages) {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  const called = messages
    .slice(lastUser + 1)
    .flatMap((message) => message.tool_calls ?? [])
    .map((call) => call.function?.name);
  return { prompt: textOf(messages[lastUser]?.content).trim().toLowerCase(), called: new Set(called) };
}

function reply(payload) {
  const { prompt, called } = turnState(payload.messages ?? []);
  const tools = new Set((payload.tools ?? []).map((tool) => tool.function?.name));
  const probe = /lab: probe (ok|fail|crash|slow)/.exec(prompt)?.[1];
  if (probe) {
    if (called.has(PROBE_TOOL)) return { text: ANSWERS[probe] };
    if (tools.has(PROBE_TOOL)) return { call: PROBE_TOOL, args: { mode: probe, text: probe } };
    if (tools.has("ToolSearch") && !called.has("ToolSearch")) {
      return { call: "ToolSearch", args: { query: PROBE_TOOL } };
    }
    return { text: "lab_probe is not available to this turn." };
  }
  const chart = /lab: chart (crash|tall)/.exec(prompt)?.[1];
  if (chart) return { text: `A ${chart} chart:\n\n\`\`\`lab.ui-slots:chart\n${chart}\nalpha,1\n\`\`\`\n` };
  if (prompt.includes("lab: gate")) {
    if (called.has("Bash")) return { text: "The gate was answered." };
    if (tools.has("Bash")) return { call: "Bash", args: { command: "touch lab-gate.txt" } };
    return { text: "Bash is not available to this turn." };
  }
  return { text: "Hello from the UI slots stub." };
}

/** Starts the stub on a loopback port; resolves with its port and a closer. */
export async function startStubModel() {
  let counter = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!req.url.endsWith("/chat/completions")) {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      const payload = JSON.parse(body || "{}");
      const id = `chatcmpl-${++counter}`;
      const base = { id, object: "chat.completion.chunk", created: 1, model: payload.model };
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      const answer = reply(payload);
      const delta = answer.call
        ? {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: `call_${counter}`,
              type: "function",
              function: { name: answer.call, arguments: JSON.stringify(answer.args) },
            }],
          }
        : { role: "assistant", content: answer.text };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const chunk of [
        { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: answer.call ? "tool_calls" : "stop" }], usage },
      ]) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
