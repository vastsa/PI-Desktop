#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { functionResult, providerConfig, startProvider } from "./e2e/hosted-search-provider.mjs";
import { fixtureHost, OfflineSidecar } from "./e2e/hosted-search-sidecar.mjs";

const [bundle] = process.argv.slice(2);
assert.ok(bundle, "Usage: node scripts/e2e-responses-tool-strictness.mjs <built sidecar.js>");
const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "responses-tool-strictness-"));
console.log(`Loopback evidence directory: ${dir}`);

const update = { id: "fixture-task", schedule: { hour: 9, minute: 0, weekday: 0, weekdays: [0, 2] } };
const priorReply = "The existing weekly task is fixture-task.";
const hostReply = "FIXTURE_SCHEDULE_UPDATED";
const finalReply = "The task now runs at 09:00 on Monday and Wednesday.";
const provider = await startProvider(dir, (body, requests) => {
  const previous = requests.length === 1;
  assert.equal(body.model, previous ? "previous-model" : "custom-responses-model");
  if (previous) return { text: priorReply };
  assert.ok(body.input.some((item) => item.role === "assistant" &&
    item.content?.some((part) => part.text === priorReply)), "The switched model must receive the preceding assistant turn");
  if (requests.length === 2) {
    return { tool: { name: "ToolSearch", args: { query: "ScheduledTaskUpdate" } } };
  }
  assert.match(functionResult(body, "ToolSearch"), /Activated on-demand tools: ScheduledTaskUpdate/);
  const tool = body.tools.find((item) => item.type === "function" && item.name === "ScheduledTaskUpdate");
  assert.equal(tool?.strict, false, "ScheduledTaskUpdate must declare strict=false");
  assert.equal(tool.parameters.properties.schedule.properties.weekdays.uniqueItems, true);
  if (requests.length === 3) return { tool: { name: "ScheduledTaskUpdate", args: update } };
  assert.equal(requests.length, 4, "Exactly one provider continuation must follow the tool result");
  assert.match(functionResult(body, "ScheduledTaskUpdate"), new RegExp(hostReply));
  return { text: finalReply };
});

const history = [];
const fixture = fixtureHost({ history });
let executions = 0;
const host = (method, params) => {
  if (method !== "tools.execute") return fixture(method, params);
  assert.equal(params.toolName, "ScheduledTaskUpdate");
  assert.deepEqual(params.args, update);
  executions++;
  return { ok: true, content: hostReply };
};

let sidecar;
try {
  sidecar = await OfflineSidecar.start(resolve(bundle), join(dir, "runtime"), host, 15_000);
  const config = {
    sessionId: "responses-strictness", mode: "agent", thinkingLevel: "off", infiniteProviderRetry: false,
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    scratchDir: dir, projectPath: dir, pluginTools: [], pluginSkills: [], trustedExtensions: [],
  };
  const previous = providerConfig(provider.baseUrl, "previous-model");
  previous.modelConfig.compat = { supportsStrictMode: true };
  await sidecar.prompt({ ...config, provider: previous }, "Which weekly task can I update?");
  assert.ok([...sidecar.messages.values()].some((message) => message.content === priorReply));
  // Electron normally persists the user and assistant rows outside the sidecar.
  for (const message of sidecar.messages.values()) {
    if (!history.some((entry) => entry.id === message.id)) history.push(message);
  }
  history.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  await sidecar.prompt({ ...config, provider: providerConfig(provider.baseUrl, "custom-responses-model") },
    "Move that weekly task to 09:00 on Monday and Wednesday.");
  assert.equal(executions, 1);
  provider.check();
  assert.equal(provider.requests.length, 4);
  assert.ok([...sidecar.messages.values()].some((message) => message.content === finalReply));
  console.log("PASS scheduled update after a Responses model switch (4 HTTP requests, 1 Host tool call)");
} catch (error) {
  provider.check();
  throw error;
} finally {
  try { await sidecar?.stop(); }
  finally { await provider.close(); }
}
