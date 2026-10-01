import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  assistantTurnContent, assistantTurnMessages, assistantTurnUsage,
  assistantTurnResponseDuration, assistantTurnResponseOutputTokens,
  assistantTurnResponseOutputIsEstimated, assistantTurnTools,
} = await import("../src/lib/assistant-turns.ts");
const { getAssistantTurnSummary, getAssistantTurnContent, messageContentFacts, reuseReferences } = await import("../src/lib/transcript-summary.ts");
const { projectTurnProcess, visibleProcessSteps } = await import("../src/lib/turn-process.ts");
const { activitySummary, visibleActivityItems } = await import("../src/lib/activity-summary.ts");
const { cachedActivitySummary, cachedVisibleActivityItems, cachedVisibleProcessSteps, activityTimingInputs } = await import("../src/lib/transcript-activity-summary.ts");
const { collectDelegationStatuses, collectDelegationTimings, delegationTimingBounds } = await import("../src/lib/subagent-topology.ts");
const { reconcileRenderBlocks, TRANSCRIPT_RENDER_BLOCK_SIZE } = await import("../src/features/chat/transcript/render-blocks.ts");

const message = (id, content, extra = {}) => ({
  id, role: "assistant", content, createdAt: "2026-09-17T00:00:00.000Z", ...extra,
});
const entry = (messages) => ({ kind: "assistant-turn", id: "turn", parts: messages.map((message) => ({ kind: "message", message })) });

test("tail text updates do not read historical assistant content", () => {
  let reads = 0;
  const old = Array.from({ length: 1024 }, (_, index) => ({
    ...message(`old-${index}`, ""),
    get content() { reads += 1; return `progress ${index}`; },
  }));
  const first = entry([...old, message("tail", "a", { status: "streaming" })]);
  getAssistantTurnSummary(first);
  reads = 0;
  const second = { ...first, parts: [...first.parts.slice(0, -1), { kind: "message", message: message("tail", "ab", { status: "streaming" }) }] };
  assert.equal(getAssistantTurnSummary(second).hasContent, true);
  assert.equal(reads, 0);
  assert.equal(getAssistantTurnContent(second), [...old.map((_, index) => `progress ${index}`), "ab"].join("\n\n"));
  assert.equal(reads, 0, "copy uses cached per-message text");
});

test("cached turn aggregates and process topology match legacy helpers", () => {
  const fixtures = [
    [],
    [message("blank", " \n ")],
    [message("partial", " Part ", { status: "aborted" })],
    [message("a", " A ", { modelId: "model-a", usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7, cacheReadTokens: 0 }, responseDurationMs: 1200 }),
      message("b", " B ", { responseOutputTokens: 8, responseDurationMs: 400 }),
      message("c", " C ", { usage: { inputTokens: 8, outputTokens: 0, totalTokens: 8, cacheWriteTokens: 2, reasoningTokens: 6 }, responseOutputTokens: 9, responseDurationMs: -1 })],
    [message("a", " text ", { responseDurationMs: Infinity, responseOutputTokens: NaN }),
      message("error", "", { error: { code: "INTERNAL", message: "failed" } })],
  ];
  for (const messages of fixtures) {
    const turn = entry(messages);
    const summary = getAssistantTurnSummary(turn);
    assert.equal(getAssistantTurnSummary(turn), summary);
    assert.equal(getAssistantTurnSummary({ ...turn }), summary);
    assert.deepEqual(summary.messages, assistantTurnMessages(turn));
    assert.deepEqual(summary.tools, assistantTurnTools(turn));
    assert.deepEqual(summary.usage, assistantTurnUsage(turn));
    assert.equal(summary.responseDurationMs, assistantTurnResponseDuration(turn));
    assert.equal(summary.responseOutputTokens, assistantTurnResponseOutputTokens(turn));
    assert.equal(summary.responseOutputEstimated, assistantTurnResponseOutputIsEstimated(turn));
    assert.equal(summary.actionMessage, [...messages].reverse().find((m) => m.content.trim()));
    assert.equal(summary.metaMessage, [...messages].reverse().find((m) => m.modelId || m.usage || m.responseDurationMs || m.responseOutputTokens));
    assert.equal(summary.latestUsageMessage, [...messages].reverse().find((m) => m.usage));
    assert.equal(summary.hasError, messages.some((m) => Boolean(m.error)));
    assert.equal(summary.streaming, messages.some((m) => m.status === "streaming"));
    assert.deepEqual({ process: summary.process, responses: summary.responses }, projectTurnProcess(turn));
    assert.equal(getAssistantTurnContent(turn), assistantTurnContent(turn));
  }
});

test("same-id replacements and deferred older snapshots never share mutable facts", () => {
  const first = entry([message("same", "before", { status: "streaming" })]);
  const second = entry([message("same", "after", { status: "complete", responseOutputTokens: 10 })]);
  assert.equal(messageContentFacts(first.parts[0].message).trimmedContent, "before");
  assert.equal(getAssistantTurnContent(first), "before");
  assert.equal(getAssistantTurnContent(second), "after");
  assert.equal(getAssistantTurnSummary(second).streaming, false);
  assert.equal(getAssistantTurnSummary(first).streaming, true);
  assert.equal(getAssistantTurnContent(first), "before");
});

test("giant group summary/visibility updates never reread historical tool payloads or thinking content", () => {
  let reads = 0;
  const old = Array.from({ length: 1024 }, (_, index) => index % 2 ? {
    kind: "thinking", message: { ...message(`think-${index}`, "", { thinking: "reasoning", status: "streaming" }),
      get content() { reads += 1; return ""; } },
  } : {
    kind: "tool", message: { ...message(`tool-${index}`, "", { role: "tool", toolName: "Bash", toolStatus: "success" }),
      get content() { reads += 1; return ""; },
      get toolResult() { reads += 1; return { details: { exitCode: 0 } }; } },
  });
  const first = [...old, { kind: "thinking", message: message("tail", "", { thinking: "a", status: "streaming" }) }];
  cachedActivitySummary(first);
  cachedVisibleActivityItems(first, true, true);
  cachedVisibleProcessSteps([{ kind: "activity", items: first }], true, true);
  reads = 0;
  const second = [...old, { kind: "thinking", message: message("tail", "", { thinking: "ab", status: "streaming" }) }];
  assert.equal(cachedActivitySummary(second).tools, 512);
  assert.equal(cachedVisibleActivityItems(second, true, true).length, 1025);
  assert.equal(cachedVisibleProcessSteps([{ kind: "activity", items: second }], true, true), 1025);
  assert.equal(reads, 0);
});

test("activity summary and compact visibility preserve error, search and thinking semantics", () => {
  const items = [
    { kind: "tool", message: message("bash", "", { toolName: "Bash", toolResult: { details: { exitCode: 1 } } }) },
    { kind: "tool", message: message("denied", "", { toolName: "Read", toolStatus: "denied" }) },
    { kind: "thinking", message: message("think", "", { thinking: "reason", status: "streaming" }) },
    { kind: "thinking", message: message("answer", "answer", { thinking: "reason", status: "streaming" }) },
    { kind: "hostedSearch", message: message("search", ""), round: { id: "r", status: "failed" } },
  ];
  for (const subset of [[], items, items.slice(0, 1), items.slice(2, 4), items.slice(4)]) {
    assert.deepEqual(cachedActivitySummary(subset), activitySummary(subset));
    for (const compact of [false, true]) for (const active of [false, true]) {
      assert.deepEqual(cachedVisibleActivityItems(subset, compact, active), visibleActivityItems(subset, compact, active));
      const parts = [{ kind: "activity", items: subset }, { kind: "message", message: message("progress", "progress") }];
      assert.equal(cachedVisibleProcessSteps(parts, compact, active), visibleProcessSteps(parts, compact ? "compact" : "detailed", active));
    }
  }
});

test("text and delegate-child changes keep tool inputs stable; cross-part TaskWait status/timing updates still propagate", () => {
  const task = { kind: "tool", message: message("task", "", { role: "tool", toolName: "Task", toolResult: { details: { delegationId: "d", status: "running", startedAt: 1000 } } }) };
  const wait = { kind: "tool", message: message("wait", "", { role: "tool", toolName: "TaskWait", toolResult: { details: { delegations: [{ delegationId: "d", status: "running", startedAt: 1000 }] } } }) };
  const first = { kind: "assistant-turn", id: "turn", parts: [
    { kind: "activity", items: [task] }, { kind: "message", message: message("progress", "wait") },
    { kind: "activity", items: [wait] },
  ] };
  const tools = getAssistantTurnSummary(first).tools;
  const textChanged = { ...first, parts: [first.parts[0], { kind: "message", message: message("progress", "waiting") }, first.parts[2]] };
  assert.equal(reuseReferences(tools, getAssistantTurnSummary(textChanged).tools), tools);
  const childChanged = { ...first, parts: [{ kind: "activity", items: [{ ...task, delegate: { items: [{ kind: "answer", message: message("child", "answer") }] } }] }, ...first.parts.slice(1)] };
  assert.equal(reuseReferences(tools, getAssistantTurnSummary(childChanged).tools), tools);
  const settledWait = { ...wait, message: { ...wait.message, toolResult: { details: { delegations: [{ delegationId: "d", status: "failed", startedAt: 1000, completedAt: 6000 }] } } } };
  const settled = { ...first, parts: [...first.parts.slice(0, -1), { kind: "activity", items: [settledWait] }] };
  assert.notEqual(reuseReferences(tools, getAssistantTurnSummary(settled).tools), tools);
  const inputs = getAssistantTurnSummary(settled).toolItems;
  const statuses = collectDelegationStatuses(inputs, { turnLive: true });
  const timings = collectDelegationTimings(inputs);
  assert.equal(statuses.get("d"), "failed");
  assert.deepEqual(delegationTimingBounds([task], timings), { startedAt: 1000, completedAt: 6000 });
  assert.deepEqual(cachedActivitySummary([task], statuses), activitySummary([task], statuses));
  assert.equal(cachedActivitySummary([task], statuses).issues, 1);
  assert.equal(collectDelegationStatuses(getAssistantTurnSummary(first).toolItems, { turnLive: false }).get("d"), "aborted");
});

test("cached activity timing exactly preserves invalid timestamps and fallback durations", () => {
  const sets = [[], [message("a", "")], [message("bad", "", { createdAt: "invalid", toolDurationMs: 300 })],
    [message("epoch", "", { createdAt: "1970-01-01T00:00:00Z", toolDurationMs: -300 }), message("a", "", { toolCompletedAt: "2026-09-17T00:00:02Z" })]];
  for (const messages of sets) {
    const inputs = activityTimingInputs(messages.map((message) => ({ kind: "tool", message })));
    for (const startedAt of [1000, Date.parse("2026-09-17T00:00:00Z")]) {
      const legacy = Math.max(startedAt, ...messages.map((m) => Date.parse(m.toolCompletedAt || "") || (Date.parse(m.createdAt) || startedAt) + (m.toolDurationMs || 0)));
      assert.equal(Math.max(startedAt, inputs.recordedEnd, startedAt + inputs.missingStartDuration), legacy);
    }
  }
});


test("memo boundaries check scalar changes before identity and skip stable child scans", async () => {
  const { createServer } = await import("vite");
  const { fileURLToPath } = await import("node:url");
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { AssistantTurn, TranscriptHistory, TranscriptTail } = await server.ssrLoadModule("/src/features/chat/transcript/AssistantTurn.tsx");
    const { ActivityGroup, activityItemsEqual } = await server.ssrLoadModule("/src/features/chat/transcript/ActivityGroup.tsx");
    const noScan = (items) => new Proxy(items, { get(target, key, receiver) {
      if (key === "every" || key === "some") throw new Error("stable input was scanned");
      return Reflect.get(target, key, receiver);
    } });
    const stableInputs = noScan([message("stable", "text")]);
    assert.equal(reuseReferences(stableInputs, stableInputs), stableInputs);
    const item = { kind: "tool", message: message("tool", "", { toolName: "Read" }) };
    const part = { kind: "activity", items: noScan([item]) };
    const turn = { kind: "assistant-turn", id: "turn", anchorId: "anchor", parts: noScan([part]) };
    const props = { entry: turn, isActive: true };
    assert.equal(AssistantTurn.compare(props, { ...props }), true);
    assert.equal(AssistantTurn.compare(props, { ...props, isActive: false }), false);
    assert.equal(AssistantTurn.compare(props, { ...props, runtimeActivity: { phase: "starting", since: 0 } }), false);
    assert.equal(AssistantTurn.compare(props, { ...props, entry: { ...turn, anchorId: "new" } }), false);
    assert.equal(AssistantTurn.compare(props, { ...props, entry: { ...turn } }), true);
    assert.equal(AssistantTurn.compare({ ...props, entry: { ...turn, parts: [part] } }, { ...props, entry: { ...turn, parts: [part] } }), true);
    const history = { entries: noScan([turn]), isRunning: true };
    assert.equal(TranscriptHistory.compare(history, { ...history }), true);
    assert.equal(TranscriptHistory.compare(history, { ...history, isRunning: false }), false);
    const tail = { ...props, isRunning: true };
    assert.equal(TranscriptTail.compare(tail, { ...tail }), true);
    assert.equal(TranscriptTail.compare(tail, { ...tail, isRunning: false }), false);
    const group = { items: part.items, isActive: true, isLast: true };
    assert.equal(ActivityGroup.compare(group, { ...group }), true);
    assert.equal(ActivityGroup.compare(group, { ...group, isActive: false }), false);
    assert.equal(ActivityGroup.compare(group, { ...group, isLast: false }), false);
    assert.equal(ActivityGroup.compare(group, { ...group, endedAt: "now" }), false);
    const opaque = new Proxy(item, { get() { throw new Error("stable item was inspected"); } });
    assert.equal(activityItemsEqual(opaque, opaque), true);
    const taskItems = [{ ...item, message: { ...item.message, toolName: "Task" } }];
    const taskGroup = { ...group, items: taskItems, turnDelegationStatuses: new Map([["d", "running"]]) };
    assert.equal(ActivityGroup.compare(taskGroup, { ...taskGroup, turnDelegationStatuses: new Map([["d", "completed"]]) }), false);
    assert.equal(ActivityGroup.compare(taskGroup, { ...taskGroup, turnDelegationTimings: new Map([["d", { completedAt: 6000 }]]) }), false);
  } finally {
    await server.close();
  }
});

const keyOf = (item) => item.id;
test("giant turn/group blocks reconstruct at most one bounded tail block", () => {
  const items = Array.from({ length: 10784 }, (_, index) => ({ id: `row-${index}` }));
  const first = reconcileRenderBlocks(undefined, items, keyOf);
  const replacement = { id: items.at(-1).id };
  const second = reconcileRenderBlocks(first, [...items.slice(0, -1), replacement], keyOf);
  assert.equal(second.length, first.length);
  assert.deepEqual(second.map((b) => b.key), first.map((b) => b.key));
  const changed = second.filter((block, index) => block !== first[index]);
  assert.equal(changed.length, 1);
  assert.ok(changed[0].items.length <= TRANSCRIPT_RENDER_BLOCK_SIZE);
  assert.equal(reconcileRenderBlocks(second, [...items.slice(0, -1), replacement], keyOf), second);
});

test("ordering corrections never reuse a render-block key for disjoint segments", () => {
  const items = Array.from({ length: 128 }, (_, index) => ({ id: `r${index}` }));
  const first = reconcileRenderBlocks(undefined, items, keyOf);
  const reordered = [items[1], items[64], items[0], ...items.slice(2, 64), ...items.slice(65)];
  const second = reconcileRenderBlocks(first, reordered, keyOf);
  assert.deepEqual(second.flatMap((block) => block.items), reordered);
  assert.equal(new Set(second.map((block) => block.key)).size, second.length);
  assert.ok(second.every((block) => block.items.length <= TRANSCRIPT_RENDER_BLOCK_SIZE));
  assert.equal(reconcileRenderBlocks(second, reordered.slice(), keyOf), second);
});

test("prepend, same-id replacements, delete and append preserve existing block identities and ordering", () => {
  const items = Array.from({ length: 192 }, (_, index) => ({ id: `row-${index}` }));
  const first = reconcileRenderBlocks(undefined, items, keyOf);
  const prefix = [{ id: "prefix-a" }, { id: "prefix-b" }];
  const prepended = reconcileRenderBlocks(first, [...prefix, ...items], keyOf);
  assert.deepEqual(prepended.slice(1), first);
  first.forEach((block, index) => assert.equal(prepended[index + 1], block));
  const append = { id: "new-tail" };
  const appended = reconcileRenderBlocks(prepended, [...prefix, ...items, append], keyOf);
  prepended.forEach((block, index) => assert.equal(appended[index], block));
  const changed = [items[0], { id: items[1].id }, ...items.slice(2)];
  const replaced = reconcileRenderBlocks(first, changed, keyOf);
  assert.equal(replaced[0].key, first[0].key);
  assert.equal(replaced[1], first[1]);
  const removed = reconcileRenderBlocks(first, items.slice(1), keyOf);
  assert.equal(removed[0].key, first[0].key);
  assert.equal(removed[1], first[1]);
  for (const [blocks, expected] of [[prepended, [...prefix, ...items]], [appended, [...prefix, ...items, append]], [replaced, changed], [removed, items.slice(1)]]) {
    assert.deepEqual(blocks.flatMap((block) => block.items), expected);
    assert.equal(new Set(blocks.map((block) => block.key)).size, blocks.length);
    assert.ok(blocks.every((block) => block.items.length <= TRANSCRIPT_RENDER_BLOCK_SIZE));
  }
});
