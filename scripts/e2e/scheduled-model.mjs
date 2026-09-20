import assert from "node:assert/strict";

// This fixture drives real Agent tool calls. It replaces only the model service.
export function scheduledModelFixture() {
  let scenario = null;
  let step = 0;
  let taskId;
  let pending;
  let calls = 0;
  const results = [];
  const scenarios = {
    create: ["ScheduledTaskCreate", "ScheduledTaskList"],
    read: ["ScheduledTaskList"],
    update: ["ScheduledTaskList", "ScheduledTaskUpdate", "ScheduledTaskList"],
    delete: ["ScheduledTaskList", "ScheduledTaskDelete", "ScheduledTaskList"],
  };
  const handler = async (req, res) => {
    try {
      let body = "";
      for await (const part of req) body += part;
      const request = JSON.parse(body);
      calls++;
      if (pending) {
        const message = request.messages.find((item) => item.role === "tool" && item.tool_call_id === pending.id);
        assert.ok(message, `model receives ${pending.name} result`);
        const text = typeof message.content === "string" ? message.content : message.content.map((item) => item.text ?? "").join("");
        if (pending.name !== "ToolSearch") {
          const value = JSON.parse(text);
          assert.equal(value.error, undefined, text);
          if (pending.name === "ScheduledTaskCreate") taskId = value.task.id;
          results.push({ scenario, name: pending.name, value });
          step++;
        }
        pending = undefined;
      }
      const base = { id: `scheduled-fixture-${calls}`, object: "chat.completion.chunk", created: 1, model: request.model };
      const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const wanted = scenario ? scenarios[scenario][step] : undefined;
      if (wanted) {
        let name = wanted;
        let args = {};
        if (!(request.tools ?? []).some((tool) => tool.function?.name === wanted)) {
          name = "ToolSearch";
          assert.ok((request.tools ?? []).some((tool) => tool.function?.name === name), "ToolSearch is exposed");
          args = { query: wanted };
        } else if (name === "ScheduledTaskCreate") {
          args = { title: "AI managed task", prompt: "Summarize the project", cadence: "daily", enabled: false, schedule: { hour: 14, minute: 0, weekday: 0 } };
        } else if (name === "ScheduledTaskUpdate") {
          assert.ok(taskId);
          args = { id: taskId, schedule: { hour: 15, minute: 30, weekday: 0 } };
        } else if (name === "ScheduledTaskDelete") {
          assert.ok(taskId);
          args = { id: taskId };
        }
        const id = `scheduled-call-${calls}`;
        pending = { id, name };
        emit({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
        emit({}, "tool_calls");
      } else {
        emit({ role: "assistant", content: scenario ? `SCHEDULE_AI_${scenario.toUpperCase()}_OK` : "Scheduled review complete." });
        emit({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  };
  return {
    handler,
    get calls() { return calls; },
    get results() { return results; },
    get taskId() { return taskId; },
    setScenario(value) { assert.ok(scenarios[value]); scenario = value; step = 0; pending = undefined; },
  };
}
