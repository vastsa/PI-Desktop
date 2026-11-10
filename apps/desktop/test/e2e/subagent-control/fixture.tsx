import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC, parseSubagentControlRequest, type AgentEventEnvelope, type AgentSubagentControlRequest,
  type AgentSubagentControlResponse, type SessionSummary, type SubagentDefinition, type UiMessage } from "@pi-desktop/shared";
import { SessionSubagentsTab } from "../../../src/features/subagents/SessionSubagentsTab";
import { useAppStore } from "../../../src/stores/app-store";
import "../../../src/styles/tokens.css";
import "../../../src/styles/base.css";
import "../../../src/styles/messages.css";
import "../../../src/styles/prose.css";
import "../../../src/styles/ui-kit.css";
import "../../../src/styles/settings.css";
import "../../../src/styles/work-panel.css";
import "../../../src/styles/session-subagents.css";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const t = (key: string, options?: Record<string, unknown>) => {
  if (!i18n.exists(key)) throw new Error(`Unresolved UI label: ${key}`);
  return String(i18n.t(key, options));
};
let phase = "initialization";
function check(value: unknown, message: string) { if (!value) throw new Error(`${message} (${phase})`); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const nextTask = () => new Promise<void>((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
  channel.port2.postMessage(null);
});
const settle = async () => { await nextTask(); await nextTask(); };
async function until(predicate: () => unknown, message: string) {
  phase = message;
  const deadline = performance.now() + 6_000;
  while (!predicate() && performance.now() < deadline) await nextTask();
  check(predicate(), `${message}: ${document.body.textContent?.slice(0, 2_000)}`);
}
const byTestId = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const textButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find((node) => node.textContent?.trim() === label);
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find((node) => node.getAttribute("aria-label") === label);
async function click(node: HTMLButtonElement | undefined | null) {
  check(node && !node.disabled, `Expected enabled button: ${document.body.textContent?.slice(-3_000)}`);
  flushSync(() => node!.click()); await settle();
}
async function edit(node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null, value: string) {
  check(node, "Expected editable field");
  const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
  flushSync(() => node!.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })));
  await settle();
}
let ordinal = 1;
const stamp = () => new Date(Date.UTC(2026, 10, 3, 0, 0, ordinal++)).toISOString();
const sessions: SessionSummary[] = ["session-a", "session-b"].map((id) => ({ id, title: id, mode: "agent",
  providerId: "fixture-provider", modelId: "fixture-model", thinkingLevel: "off", createdAt: stamp(), updatedAt: stamp() }));
const definitions: SubagentDefinition[] = ["explorer", "fixer"].map((name) => ({ name, description: `Fixture ${name}`,
  tools: ["Read", "Skill"], source: "builtin", prompt: "Fixture only" }));
const legacy: UiMessage = { id: "legacy-task", role: "tool", content: "", createdAt: stamp(),
  toolName: "Task", toolCallId: "legacy-call", toolArgs: { agent: "explorer", task: "Legacy task" },
  toolStatus: "success", toolResult: { details: { delegationId: "legacy-id", agent: "explorer", status: "running" } } };
const parent: UiMessage = { id: "parent-answer", role: "assistant", content: "PARENT-CONTEXT-SENTINEL", createdAt: stamp(), status: "complete" };
const histories: Record<string, UiMessage[]> = { "session-a": [parent, legacy], "session-b": [] };
const commands: AgentSubagentControlRequest[] = [];
const stops: string[] = [];
const unexpected: string[] = [];
const checks: string[] = [];
let catalog = deferred<{ subagents: SubagentDefinition[] }>();
let catalogCalls = 0;
let pending: ReturnType<typeof deferred<AgentSubagentControlResponse>> | undefined;
let failNext = false;
const operations = new Map<string, AgentSubagentControlResponse>();
function publishEvent(sessionId: string, event: AgentEventEnvelope["event"]) {
  flushSync(() => useAppStore.getState().handleAgentEvent({ sessionId, ts: Date.now(), event }));
}
function publishRow(sessionId: string, message: UiMessage) {
  publishEvent(sessionId, { type: "message_end", message });
}
function delegationSnapshot(row: UiMessage) {
  return row.subagentControl ?? (row.toolResult as {
    details?: { delegationId: string; agent: string; status: string };
  } | undefined)?.details;
}
function accept(request: AgentSubagentControlRequest): AgentSubagentControlResponse {
  const prior = operations.get(request.operationId);
  if (prior) return { ...prior, delivery: "recorded" };
  const rows = histories[request.sessionId];
  const previous = request.action === "message" ? rows.find((row) => delegationSnapshot(row)?.delegationId === request.delegationId) : undefined;
  const active = previous && delegationSnapshot(previous)?.status === "running";
  const rootId = `user-subagent-${request.operationId}`;
  const delegationId = request.action === "start" || !active ? `delegate-${operations.size + 1}` : request.delegationId;
  const agent = request.action === "start" ? request.agent : (previous && delegationSnapshot(previous)?.agent) ?? "explorer";
  const message: UiMessage = { id: rootId, role: "user", content: request.action === "start" ? request.task : request.content,
    createdAt: stamp(), status: "complete", parentToolCallId: active ? previous.toolCallId ?? previous.id : rootId, agentName: agent,
    subagentControl: { operationId: request.operationId, requestHash: "a".repeat(64),
      action: active ? "message" : "start", delegationId, agent, status: "running",
      modelId: "fixture-model", ...(!active && request.action === "message" ? { resume: request.delegationId } : {}) } };
  rows.push(message);
  const response: AgentSubagentControlResponse = { accepted: true, operationId: request.operationId, delegationId,
    messageId: rootId, delivery: active ? "queued" : "started" };
  operations.set(request.operationId, response);
  if (!active) publishEvent(request.sessionId, { type: "turn_start" });
  publishRow(request.sessionId, message);
  return response;
}
Object.defineProperty(window, "piDesktop", { value: {
  platform: "win32", on() { return () => {}; },
  async invoke(method: string, payload: unknown) {
    if (method === IPC.invoke.subagentCatalog) { catalogCalls++; return { ok: true, data: await catalog.promise }; }
    if (method === IPC.invoke.sessionGet) {
      const request = payload as { id: string; messageLimit: number; contentLimit: number; messageAround?: string };
      check(request.messageLimit === 256 && [512, 8_000].includes(request.contentLimit), "Unbounded history read");
      const rows = histories[request.id] ?? [];
      return { ok: true, data: { session: { ...sessions.find((session) => session.id === request.id),
        messages: [...rows], messageCount: rows.length, messageStart: 0, messageEnd: rows.length,
        hasMoreBefore: false, hasMoreAfter: false } } };
    }
    if (method === IPC.invoke.agentSubagentControl) {
      const request = parseSubagentControlRequest(payload); commands.push(request);
      if (failNext) { failNext = false; throw new Error("Fixture uncertain delivery"); }
      if (pending) { const held = pending; pending = undefined; return { ok: true, data: await held.promise }; }
      return { ok: true, data: accept(request) };
    }
    if (method === IPC.invoke.agentStopSubagents) {
      const request = payload as { sessionId: string; delegationIds: string[] };
      check(request.sessionId === useAppStore.getState().activeSessionId, "Stop escaped session");
      stops.push(...request.delegationIds);
      histories[request.sessionId] = histories[request.sessionId].map((row) => {
        const snapshot = delegationSnapshot(row);
        if (!snapshot || !request.delegationIds.includes(snapshot.delegationId) || row.subagentControl?.action === "message") return row;
        const stopped: UiMessage = row.subagentControl
          ? { ...row, subagentControl: { ...row.subagentControl, status: "stopped" } }
          : { ...row, toolResult: { details: { ...snapshot, status: "stopped" } } };
        publishRow(request.sessionId, stopped);
        return stopped;
      });
      return { ok: true, data: { stopped: request.delegationIds, pending: [], notFound: [] } };
    }
    unexpected.push(method); throw new Error(`Unexpected IPC: ${method}`);
  },
} });
useAppStore.setState({ ready: true, sessions, activeSessionId: "session-a", messages: [...histories["session-a"]],
  providers: [{ id: "fixture-provider", name: "Fixture Provider", vendorKey: "custom", enabled: true,
    authKind: "none", hasSecret: false, models: [{ id: "fixture-model", availableForSubagents: true },
      { id: "alternate-fixture-model", availableForSubagents: true }, { id: "not-enabled-model" }], defaultModelId: "fixture-model",
    api: "openai-completions", baseUrl: "http://127.0.0.1:1", createdAt: stamp(), updatedAt: stamp() }],
  runningSessions: { "session-a": true }, pluginViews: [], workspace: null, projectMeta: {} });
const root = createRoot(document.getElementById("root")!);
flushSync(() => root.render(<div style={{ display: "flex", height: "100vh", width: 400 }}><SessionSubagentsTab /></div>));
const createText = () => document.querySelector<HTMLTextAreaElement>('[data-testid="subagent-create-form"] textarea');
const messageText = () => document.querySelector<HTMLTextAreaElement>('[data-testid="subagent-message-form"] textarea');
function activate(id: string) { flushSync(() => useAppStore.setState({ activeSessionId: id, messages: [...(histories[id] ?? [])] })); }
Object.assign(window, { subagentControlProbe: async () => {
  try {
    await until(() => document.querySelector(".session-subagents-list"), "Directory did not mount");
    check(byTestId("subagent-create"), "A user cannot create a subagent from the directory");
    await click(byTestId("subagent-create"));
    check(document.querySelector('[data-testid="subagent-create-form"]'), "Creation form missing");
    await until(() => catalogCalls === 1, "Definition catalog was not requested");
    check(textButton(t("panel.sessionSubagents.control.start"))?.disabled, "Loading catalog enabled start");
    catalog.reject(new Error("Fixture catalog failure"));
    await until(() => document.querySelector('[role="alert"]'), "Catalog failure hidden");
    catalog = deferred(); catalog.resolve({ subagents: [] });
    await click(textButton(t("panel.sessionSubagents.retry")));
    await until(() => document.body.textContent?.includes(t("panel.sessionSubagents.control.noAgents")), "Empty catalog missing");
    catalog = deferred(); catalog.resolve({ subagents: definitions });
    await click(textButton(t("panel.sessionSubagents.retry")));
    await until(() => document.querySelectorAll("select option").length >= 2, "Catalog retry failed");
    await edit(document.querySelector("select"), "fixer");
    await click(button(t("panel.sessionSubagents.control.model")));
    await click(textButton("fixture-model"));
    await edit(createText(), "Inspect USER-TASK-SENTINEL");
    check(!textButton(t("panel.sessionSubagents.control.start"))?.disabled, "Valid creation cannot submit");
    checks.push("catalog loading, failure/retry/empty, definition and configured model selection");

    failNext = true;
    await click(textButton(t("panel.sessionSubagents.control.start")));
    await until(() => document.body.textContent?.includes("Fixture uncertain delivery"), "Send failure hidden");
    check(createText()?.value === "Inspect USER-TASK-SENTINEL", "Failed creation lost draft");
    const retry = deferred<AgentSubagentControlResponse>(); pending = retry;
    await click(textButton(t("panel.sessionSubagents.retry")));
    const submitted = commands[commands.length - 1];
    check(commands.length === 2 && submitted.operationId === commands[0].operationId, "Retry changed operation identity");
    check(submitted.action === "start" && submitted.agent === "fixer" && submitted.model === "Fixture Provider/fixture-model", "UI supplied wrong declared launch choices");
    textButton(t("panel.sessionSubagents.control.start"))?.click();
    check(commands.length === 2, "Duplicate click submitted a second operation");
    await edit(createText(), "New edit while creation is pending");
    retry.resolve(accept(submitted));
    await until(() => messageText(), "Accepted creation did not open its real detail");
    check(histories["session-a"].filter((row) => row.subagentControl?.action === "start").length === 1, "Retry created two roots");
    check(histories["session-a"][0] === parent && parent.content === "PARENT-CONTEXT-SENTINEL", "Control modified parent context");
    checks.push("uncertain failure retains draft and operation ID; duplicate prevention; real accepted root");

    const directionHint = () => document.querySelector(".subagent-transcript-composer .session-subagents-control-description")?.textContent;
    check(directionHint() === t("panel.sessionSubagents.control.safeSteering"), "Running child does not explain safe steering");
    const modelPicker = () => document.querySelector<HTMLButtonElement>(".subagent-transcript-model-picker button, button.subagent-transcript-model-picker");
    await click(modelPicker());
    check(!textButton("not-enabled-model"), "Child model picker offered an unauthorized binding");
    await click(textButton("alternate-fixture-model"));
    check(modelPicker()?.textContent?.includes("alternate-fixture-model"), "Selected child model is not displayed");
    check(directionHint() === t("panel.sessionSubagents.control.modelNextMessage"), "Explicit model choice incorrectly promises immediate steering");
    await edit(messageText(), "Change direction: USER-MESSAGE-SENTINEL");
    await click(textButton(t("panel.sessionSubagents.control.send")));
    await until(() => [...document.querySelectorAll('.message-row.user')].some((node) => node.textContent?.includes("USER-MESSAGE-SENTINEL")), "Direct message is not displayed as a user row");
    check(messageText()?.value === "", "Acknowledged message did not clear matching draft");
    check(document.body.textContent?.includes(t("panel.sessionSubagents.control.queued")), "Queued delivery feedback missing");
    checks.push("live child direction is a queued, attributed user message, not a parent prompt");
    const switched = commands[commands.length - 1];
    check(switched.action === "message" && switched.model === "Fixture Provider/alternate-fixture-model", "Selected model did not cross the user-message boundary");
    check(modelPicker()?.textContent?.includes("alternate-fixture-model"), "Acknowledged send discarded the selected model");

    await click(button(t("chat.stopSubagentNamed", { name: "fixer" })));
    await until(() => textButton(t("panel.sessionSubagents.control.continue")), "Stopped delegate cannot continue");
    check(directionHint() === t("panel.sessionSubagents.control.modelNextMessage"), "Stopped child still advertises in-run steering");
    await edit(messageText(), "Continue USER-RESUME-SENTINEL");
    await click(textButton(t("panel.sessionSubagents.control.continue")));
    await until(() => [...document.querySelectorAll('.message-row.user')].some((node) => node.textContent?.includes("USER-RESUME-SENTINEL")), "Continued chain did not display the new message");
    await until(() => textButton(t("panel.sessionSubagents.control.send")) &&
      document.querySelector(".session-subagents-header")?.textContent?.includes(t("chat.subagentStatus.running")),
      "Continued chain still shows stopped");
    const resumed = histories["session-a"].findLast((row) => row.subagentControl?.action === "start");
    check(resumed && stops.length === 1 && commands[commands.length - 1].action === "message", "Continue did not reuse message control");
    const reply: UiMessage = { id: "resumed-reply", role: "assistant", content: "RESUMED-REPLY-SENTINEL",
      createdAt: stamp(), status: "complete", parentToolCallId: resumed!.id, agentName: "fixer" };
    histories["session-a"].push(reply); publishRow("session-a", reply);
    await until(() => document.querySelector('[data-message-id="resumed-reply"]')?.textContent?.includes("RESUMED-REPLY-SENTINEL"),
      "Continued child reply was not displayed");
    checks.push("cooperative stop and terminal continuation preserve the existing chain and transcript");

    const held = deferred<AgentSubagentControlResponse>(); pending = held;
    await edit(messageText(), "Acknowledged older draft");
    await click(textButton(t("panel.sessionSubagents.control.send")));
    const older = commands[commands.length - 1];
    await edit(messageText(), "Do not erase this newer draft");
    held.resolve(accept(older)); await settle();
    check(messageText()?.value === "Do not erase this newer draft", "Old response erased a newer edit");
    await click(button(t("panel.sessionSubagents.back")));
    await click(byTestId("subagent-create"));
    check(createText()?.value === "New edit while creation is pending", "Successful creation erased a later creation edit");
    const panel = document.querySelector<HTMLElement>(".session-subagents")!;
    check(panel.scrollWidth <= panel.clientWidth + 1, "Control form overflows compact panel");
    checks.push("revision-owned clearing and creation/detail draft retention with compact layout");

    await click(byTestId("subagent-create"));
    await click(button(String(i18n.t("panel.sessionSubagents.view", { name: "Continue USER-RESUME-SENTINEL" }))));
    const stale = deferred<AgentSubagentControlResponse>(); pending = stale;
    await edit(messageText(), "Session A pending request");
    await click(textButton(t("panel.sessionSubagents.control.send")));
    const staleRequest = commands[commands.length - 1];
    activate("session-b"); await settle();
    await click(byTestId("subagent-create"));
    await edit(createText(), "Session B unsent draft");
    stale.resolve(accept(staleRequest)); await settle();
    check(createText()?.value === "Session B unsent draft" && !document.body.textContent?.includes("Session A pending request"), "Late response crossed sessions");
    activate("session-a"); await settle();
    await click(button(t("panel.sessionSubagents.back")));
    await click(byTestId("subagent-create"));
    check(createText()?.value === "New edit while creation is pending", "Session switching lost creation draft");
    checks.push("session-scoped drafts and stale delivery isolation");

    await click(byTestId("subagent-create"));
    await click(button(t("panel.sessionSubagents.view", { name: "Legacy task" })));
    await click(button(t("chat.stopSubagentNamed", { name: "explorer" })));
    await until(() => textButton(t("panel.sessionSubagents.control.continue")), "Stopped Task child cannot continue");
    await edit(messageText(), "Continue TASK-RESUME-SENTINEL");
    await click(textButton(t("panel.sessionSubagents.control.continue")));
    await until(() => textButton(t("panel.sessionSubagents.control.send")) &&
      document.querySelector(".session-subagents-header")?.textContent?.includes(t("chat.subagentStatus.running")),
      "Continued Task child still shows stopped");
    check([...document.querySelectorAll('.message-row.user')].some((node) => node.textContent?.includes("TASK-RESUME-SENTINEL")),
      "Continued Task child lost the appended message");
    const taskResume = histories["session-a"].findLast((row) => row.subagentControl?.action === "start");
    check(taskResume?.subagentControl?.resume === "legacy-id", "Continue did not target the stopped Task child");
    const taskReply: UiMessage = { id: "task-resumed-reply", role: "assistant", content: "TASK-RESUMED-REPLY-SENTINEL",
      createdAt: stamp(), status: "complete", parentToolCallId: taskResume!.id, agentName: "explorer" };
    histories["session-a"].push(taskReply); publishRow("session-a", taskReply);
    await until(() => document.querySelector('[data-message-id="task-resumed-reply"]')?.textContent?.includes("TASK-RESUMED-REPLY-SENTINEL"),
      "Continued Task child reply was not displayed");
    await click(button(t("panel.sessionSubagents.back")));
    check(document.querySelectorAll(".session-subagent-entry").length === 2, "Continuation split the existing Task chain");
    checks.push("provider-created Task child stops and continues as one live chain with visible user input and reply");

    check(taskResume?.subagentControl, "Missing resumable child snapshot");
    const interrupted: UiMessage = { ...taskResume!, subagentControl: { ...taskResume!.subagentControl!, status: "interrupted" } };
    histories["session-a"] = histories["session-a"].map(row => row.id === interrupted.id ? interrupted : row);
    publishRow("session-a", interrupted);
    await click(button(t("panel.sessionSubagents.view", { name: "Continue TASK-RESUME-SENTINEL" })));
    await until(() => textButton(t("panel.sessionSubagents.control.continue")), "Interrupted child cannot continue");
    await edit(messageText(), "Continue AFTER-RESTART-SENTINEL");
    await click(textButton(t("panel.sessionSubagents.control.continue")));
    await until(() => textButton(t("panel.sessionSubagents.control.send")), "Interrupted child did not become active");
    const restartCommand = commands.at(-1);
    check(restartCommand?.action === "message" &&
      restartCommand.delegationId === interrupted.subagentControl?.delegationId,
      "Restart continuation must address the existing child");
    check(document.querySelector('[data-message-id="task-resumed-reply"]')?.textContent?.includes("TASK-RESUMED-REPLY-SENTINEL"),
      "Restart continuation lost the previous child result");
    await click(button(t("panel.sessionSubagents.back")));
    check(document.querySelectorAll(".session-subagent-entry").length === 2, "Restart continuation split the child chain");
    checks.push("interrupted child accepts explicit continuation without losing prior results or splitting its chain");

    const original: UiMessage = { id: "failed-resume-root", role: "tool", content: "", createdAt: stamp(),
      toolName: "Task", toolCallId: "failed-resume-root", toolStatus: "success",
      toolArgs: { agent: "explorer", task: "Completed legacy child" },
      toolResult: { details: { delegationId: "retained-id", status: "completed", modelId: "fixture-model" } } };
    const rejected: UiMessage = { id: "failed-resume-call", role: "tool", content: "", createdAt: stamp(),
      toolName: "Task", toolCallId: "failed-resume-call", toolStatus: "error", isError: true,
      toolArgs: { agent: "explorer", task: "Rejected continuation", resume: "retained-id" },
      toolResult: { details: { error: "Recorded model unavailable" } } };
    histories["session-b"] = [original, rejected];
    activate("session-b"); await settle();
    await click(button(t("panel.sessionSubagents.view", { name: "Completed legacy child" })));
    check(modelPicker()?.textContent?.includes("fixture-model"), "Rejected resume cleared the original model");
    await edit(messageText(), "Continue after a rejected Task attempt");
    await click(textButton(t("panel.sessionSubagents.control.continue")));
    const afterRejected = commands.at(-1);
    check(afterRejected?.action === "message" && afterRejected.delegationId === "retained-id",
      "Rejected Task replaced the original continuation identity");
    checks.push("rejected Task resume preserves the original model and usable child identity");

    const denied: SessionSummary[] = [
      { ...sessions[0], id: "remote:fixture", source: "remote" },
      { ...sessions[0], id: "native-pi:fixture", source: "pi-native" },
      { ...sessions[0], id: "plan:fixture", mode: "plan" },
      { ...sessions[0], id: "readonly:fixture", capabilities: { canPrompt: false, canUseLocalTools: false } },
    ];
    flushSync(() => useAppStore.setState({ sessions: [...sessions, ...denied] }));
    const count = commands.length;
    for (const session of denied) {
      activate(session.id); await settle();
      check(!byTestId("subagent-create"), `Forbidden control visible: ${session.id}`);
    }
    check(commands.length === count, "Unsupported session dispatched a command");
    checks.push("remote, native, mode and capability affordances cannot dispatch");
    for (const [locale, resource] of Object.entries(catalogs)) {
      for (const key of ["new", "start", "send", "continue", "queued", "sendFailed"]) {
        check(typeof flattenCatalog(resource)[`panel.sessionSubagents.control.${key}`] === "string", `Missing ${locale}/${key}`);
      }
    }
    check(unexpected.length === 0, `Unexpected IPC: ${unexpected.join(", ")}`);
    checks.push("localized control labels and no implicit execution or credential IPC");
    return { passed: true, checks, commands: commands.length, unexpected: unexpected.length };
  } finally { flushSync(() => root.unmount()); }
} });
