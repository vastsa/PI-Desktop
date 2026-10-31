// Local provider -> production Runtime/pi -> real Host -> temporary files.
// A response barrier proves concurrent dispatch, not filesystem-body overlap.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { link, symlink, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopAgentRuntime } from "../packages/agent-runtime/dist/runtime.js";
import { SubagentRun } from "../packages/agent-runtime/dist/subagent.js";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { createSession, configureSession, beginTurn, endTurn } from "./e2e/session.mjs";

const scratch = await mkdtemp(join(tmpdir(), "pi-parallel-read-"));
const workspace = join(scratch, "workspace");
await mkdir(workspace);
await writeFile(join(workspace, "a.txt"), "alpha-marker\n");
await writeFile(join(workspace, "b.txt"), "beta-marker\n");
await writeFile(join(workspace, "c.txt"), "gamma-marker\n");
await writeFile(join(workspace, "d.txt"), "delta-marker\n");
const readCalls = [
  { id: "read-a", name: "Read", arguments: { path: "a.txt" } },
  { id: "read-b", name: "Read", arguments: { path: "b.txt" } },
  { id: "glob", name: "Glob", arguments: { pattern: "*.txt" } },
  { id: "grep", name: "Grep", arguments: { pattern: "alpha-marker", path: "." } },
];
/** Each scenario answers a request with tool calls, or `undefined` for the final text. */
let respond = body => body.messages.some(message => message.role === "tool") ? undefined : readCalls;
const requests = [];
const server = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = (value, finish = null) => res.write(`data: ${JSON.stringify({
      id: `fixture-${requests.length}`, object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta: value, finish_reason: finish }],
    })}\n\n`);
    const calls = respond(body);
    if (calls) {
      delta({ role: "assistant", tool_calls: calls.map((call, index) => ({
        index, id: call.id, type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })) });
      delta({}, "tool_calls");
    } else {
      delta({ role: "assistant", content: "batch-complete" });
      delta({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const host = new Host(resolveHostBinary(), join(scratch, "data"));
let runtime, turnId;
const events = [];
const returnedReads = [];
let releaseReads;
let barrier = new Promise(resolve => { releaseReads = resolve; });
let barrierTimeout = setTimeout(releaseReads, 10_000);
/** Host dispatch timeline and results of every tools.execute, by call id. */
const dispatch = [];
const hostResults = new Map();
/** Calls whose Host response waits until all of them have been dispatched. */
let gated = new Set();
let gatedEntered = new Set();
let releaseGate = () => {};
let gate = Promise.resolve();
function holdUntilAllEnter(ids) {
  gated = new Set(ids);
  gatedEntered = new Set();
  gate = new Promise(resolve => { releaseGate = resolve; });
  const timer = setTimeout(releaseGate, 10_000);
  return () => clearTimeout(timer);
}
const toolMessages = request => request.messages.filter(message => message.role === "tool");
async function runTurn(session, prompt) {
  turnId = await beginTurn(host, session.id);
  const before = requests.length;
  await runtime.prompt(prompt, `fixture-user-${before}`, turnId);
  await endTurn(host, turnId);
  turnId = undefined;
  return requests.slice(before);
}
try {
  await host.start(PROTOCOL_VERSION);
  const session = await createSession(host, workspace, "Parallel reads");
  await configureSession(host, session, "agent", "auto");
  turnId = await beginTurn(host, session.id);
  const call = host.call.bind(host);
  host.call = async (method, args, timeout) => {
    if (method !== "tools.execute") return call(method, args, timeout);
    dispatch.push(`${args.toolCallId}:start`);
    const result = await call(method, args, timeout);
    dispatch.push(`${args.toolCallId}:end`);
    hostResults.set(args.toolCallId, result);
    if (["read-a", "read-b"].includes(args.toolCallId)) {
      returnedReads.push(args.toolCallId);
      if (returnedReads.length === 2) releaseReads();
      await barrier;
      assert.equal(returnedReads.length, 2, "second Read never dispatched before the first response was released");
    }
    if (gated.has(args.toolCallId)) {
      gatedEntered.add(args.toolCallId);
      if (gatedEntered.size === gated.size) releaseGate();
      await gate;
      assert.equal(gatedEntered.size, gated.size, `${[...gated].join(", ")} did not all dispatch before the first response was released`);
    }
    return result;
  };
  runtime = new DesktopAgentRuntime({
    host, sessionId: session.id, turnId, mode: "agent", projectPath: workspace,
    provider: {
      id: "fixture", name: "Local fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      modelId: "fixture", apiKey: "", authKind: "none", apiStyle: "chat_completions",
      supportsReasoning: false, supportedThinkingLevels: ["off"],
    },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    thinkingLevel: "off", onEvent: envelope => events.push(envelope.event),
  });
  await runtime.prompt("Read and search the fixture files.", "fixture-user", turnId);
  assert.equal(requests.length, 2);
  assert.deepEqual(returnedReads.slice().sort(), ["read-a", "read-b"]);
  const results = toolMessages(requests[1]);
  assert.deepEqual(results.map(message => message.tool_call_id), readCalls.map(call => call.id));
  assert.match(JSON.stringify(results[0].content), /alpha-marker/);
  assert.match(JSON.stringify(results[1].content), /beta-marker/);
  assert.match(JSON.stringify(results[2].content), /a\.txt/);
  assert.match(JSON.stringify(results[3].content), /alpha-marker/);
  assert.equal(events.some(event => event.type === "error"), false);
  // Exercise the real delegate loop with the parent's scoped Host tool bridge.
  returnedReads.length = 0;
  clearTimeout(barrierTimeout);
  barrier = new Promise(resolve => { releaseReads = resolve; });
  barrierTimeout = setTimeout(releaseReads, 10_000);
  const definition = { name: "reader", description: "Read", tools: ["Read", "Glob", "Grep"], prompt: "Read", source: "builtin" };
  const names = new Set(definition.tools);
  const tools = [...runtime.toolCatalog.values()].filter(tool => names.has(tool.name));
  let child;
  const apply = instructions => child.setSystemPrompt(`Child rules: ${JSON.stringify(instructions)}`);
  const parentPrompt = runtime.agent.state.systemPrompt;
  // The same delegate hooks the runtime installs for a Task run.
  child = new SubagentRun({
    definition, sessionId: session.id, turnId, parentToolCallId: "fixture-task",
    task: "Read and search the fixture files.", provider: runtime.provider,
    thinkingLevel: "off", systemPrompt: "Read the fixture files.",
    tools: runtime.scopeDelegateTools(tools, definition, "fixture-delegate", apply),
    beforeToolCall: async context => {
      await runtime.preparePathToolCall(context, apply, names);
      await runtime.registerBatchCall(context, names);
      return undefined;
    },
    onTurnEnd: message => runtime.batchPlanner.settleBatch(message),
    onEvent: envelope => events.push(envelope.event),
  });
  const report = await child.run();
  assert.equal(report.status, "completed");
  assert.deepEqual(returnedReads.slice().sort(), ["read-a", "read-b"]);
  assert.equal(requests.length, 4);
  assert.deepEqual(toolMessages(requests[3]).map(message => message.tool_call_id), readCalls.map(call => call.id));
  assert.equal(runtime.agent.state.systemPrompt, parentPrompt);
  await endTurn(host, turnId);
  turnId = undefined;
  releaseReads();
  clearTimeout(barrierTimeout);

  // [Read a, Write b, Read c]: no claim conflicts, so all three reach Host
  // before any response is released, and results keep source order.
  const mixed = [
    { id: "mixed-read-a", name: "Read", arguments: { path: "a.txt" } },
    { id: "mixed-write-b", name: "Write", arguments: { path: "b.txt", content: "written-marker\n" } },
    { id: "mixed-read-c", name: "Read", arguments: { path: "c.txt" } },
  ];
  respond = body => toolMessages(body).some(m => m.tool_call_id === "mixed-read-a") ? undefined : mixed;
  let stopGate = holdUntilAllEnter(mixed.map(call => call.id));
  const mixedRequests = await runTurn(session, "Read a, write b, read c.");
  stopGate();
  assert.deepEqual([...gatedEntered].sort(), mixed.map(call => call.id).sort());
  assert.equal(await readFile(join(workspace, "b.txt"), "utf8"), "written-marker\n");
  const mixedResults = toolMessages(mixedRequests.at(-1)).filter(message => message.tool_call_id.startsWith("mixed-"));
  assert.deepEqual(mixedResults.map(message => message.tool_call_id), mixed.map(call => call.id));
  assert.match(JSON.stringify(mixedResults[0].content), /alpha-marker/);
  assert.match(JSON.stringify(mixedResults[2].content), /gamma-marker/);
  gated = new Set();

  // Both RPCs may be submitted together; Host now owns the actual body order.
  // The native RPC regression separately gates/reverses arrivals to prove it.
  // Edit still uses a real previous-step tag and must succeed.
  let tag;
  respond = body => {
    const results = toolMessages(body);
    if (!results.some(m => m.tool_call_id === "tag-read")) {
      return [{ id: "tag-read", name: "Read", arguments: { path: "a.txt" } }];
    }
    if (!results.some(m => m.tool_call_id === "order-edit")) {
      tag = /\[a\.txt#([0-9A-Fa-f]{4})\]/.exec(JSON.stringify(results.find(m => m.tool_call_id === "tag-read").content))?.[1];
      assert.ok(tag, "the fixture Read returned no hashline tag");
      return [
        { id: "order-read", name: "Read", arguments: { path: "a.txt" } },
        { id: "order-edit", name: "Edit", arguments: { path: "a.txt", tag, ops: "PUT >$:\n+edited-marker" } },
      ];
    }
    return undefined;
  };
  dispatch.length = 0;
  await runTurn(session, "Read a, then edit it.");
  assert.ok(dispatch.includes("order-read:end") && dispatch.includes("order-edit:end"));
  assert.equal(hostResults.get("order-edit")?.ok, true, `Edit failed: ${JSON.stringify(hostResults.get("order-edit"))}`);
  assert.match(await readFile(join(workspace, "a.txt"), "utf8"), /alpha-marker\n[\s\S]*edited-marker/);

  // Real differently named aliases through production parent Runtime/pi/Host.
  // They are intentionally not represented by a basename or local realpath key.
  await link(join(workspace,"a.txt"),join(workspace,"hard-alias.txt"));
  const aliases = ["hard-alias.txt"];
  try {
    await symlink(join(workspace,"a.txt"),join(workspace,"symbolic-alias.txt"),"file");
    aliases.push("symbolic-alias.txt");
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    console.log("SKIP file symlink E2E: OS does not grant symlink creation; hard-link cases still run");
  }
  for (const alias of aliases) for (const writeFirst of [false,true]) {
    const before = await readFile(join(workspace,"a.txt"),"utf8");
    const after = `alias-written-${alias}-${writeFirst}\n`;
    const readId = `alias-read-${alias}-${writeFirst}`, writeId = `alias-write-${alias}-${writeFirst}`;
    const pair = [
      {id:readId,name:"Read",arguments:{path:alias}},
      {id:writeId,name:"Write",arguments:{path:"a.txt",content:after}},
    ];
    if(writeFirst) pair.reverse();
    respond = body => toolMessages(body).some(m=>m.tool_call_id===writeId) ? undefined : pair;
    const round = await runTurn(session,"Run the alias file batch in source order.");
    assert.equal(hostResults.get(writeId)?.ok,true,JSON.stringify(hostResults.get(writeId)));
    const readResult = toolMessages(round.at(-1)).find(m=>m.tool_call_id===readId);
    const readText = JSON.parse(readResult.content).content;
    for (const line of (writeFirst ? after : before).trim().split(/\r?\n/)) {
      assert.ok(readText.includes(line),JSON.stringify(readResult));
    }
    assert.equal(await readFile(join(workspace,alias),"utf8"),after);
    assert.deepEqual(toolMessages(round.at(-1)).filter(m=>[readId,writeId].includes(m.tool_call_id)).map(m=>m.tool_call_id),pair.map(c=>c.id));
    // Repeat through the real delegate loop and the runtime's scoped catalog.
    const childAfter = `child-${after}`;
    const childPair = pair.map(call => call.name === "Write"
      ? { ...call, arguments: { ...call.arguments, content: childAfter } } : call);
    respond = body => toolMessages(body).some(m=>m.tool_call_id===writeId) ? undefined : childPair;
    const childStart = requests.length;
    const writer = { name:"alias-writer",description:"Read and write aliases",tools:["Read","Write"],prompt:"Run the batch",source:"builtin" };
    const writerNames = new Set(writer.tools);
    const writerTools = [...runtime.toolCatalog.values()].filter(tool=>writerNames.has(tool.name));
    let writerRun;
    const childInstructions = instructions => writerRun.setSystemPrompt(`Child rules: ${JSON.stringify(instructions)}`);
    writerRun = new SubagentRun({ definition:writer,sessionId:session.id,task:"Run the file batch.",
      provider:runtime.provider,thinkingLevel:"off",systemPrompt:"Run the file batch.",
      tools:runtime.scopeDelegateTools(writerTools,writer,"alias-child",childInstructions),
      beforeToolCall:async context=>{
        await runtime.preparePathToolCall(context,childInstructions,writerNames);
        await runtime.registerBatchCall(context,writerNames);
      },
      onTurnEnd:message=>runtime.batchPlanner.settleBatch(message),onEvent:envelope=>events.push(envelope.event),
    });
    assert.equal((await writerRun.run()).status,"completed");
    await runtime.batchPlanner.drain();
    const childRead = toolMessages(requests.slice(childStart).at(-1)).find(m=>m.tool_call_id===readId);
    assert.ok(JSON.parse(childRead.content).content.includes((writeFirst ? childAfter : after).trim()),JSON.stringify(childRead));
    assert.equal(await readFile(join(workspace,alias),"utf8"),childAfter);
  }

  // Two same-batch Writes to different files each leave a review snapshot;
  // rolling both back restores both files.
  const writes = [
    { id: "rollback-write-c", name: "Write", arguments: { path: "c.txt", content: "overwritten-c\n" } },
    { id: "rollback-write-d", name: "Write", arguments: { path: "d.txt", content: "overwritten-d\n" } },
  ];
  respond = body => toolMessages(body).some(m => m.tool_call_id === "rollback-write-c") ? undefined : writes;
  await runTurn(session, "Overwrite c and d.");
  assert.equal(await readFile(join(workspace, "c.txt"), "utf8"), "overwritten-c\n");
  assert.equal(await readFile(join(workspace, "d.txt"), "utf8"), "overwritten-d\n");
  for (const { id } of writes) {
    const snapshotId = hostResults.get(id)?.content?.review?.snapshotId;
    assert.ok(snapshotId, `${id} left no review snapshot`);
    const outcome = await host.call("review.rollback", { sessionId: session.id, snapshotId });
    assert.equal(outcome.status ?? outcome.outcome?.status, "rolledBack", JSON.stringify(outcome));
  }
  assert.equal(await readFile(join(workspace, "c.txt"), "utf8"), "gamma-marker\n");
  assert.equal(await readFile(join(workspace, "d.txt"), "utf8"), "delta-marker\n");

  // Ask mode: both same-batch Writes wait for approval at the same time;
  // denying one does not affect the other.
  await configureSession(host, session, "agent", "ask");
  const asks = [
    { id: "ask-write-e", name: "Write", arguments: { path: "e.txt", content: "denied\n" } },
    { id: "ask-write-f", name: "Write", arguments: { path: "f.txt", content: "approved\n" } },
  ];
  respond = body => toolMessages(body).some(m => m.tool_call_id === "ask-write-e") ? undefined : asks;
  const asked = runTurn(session, "Write e and f.");
  const permissionFor = id => host.notifications.find(n => n.method === "permissions.request" && n.params?.toolCallId === id);
  for (let attempt = 0; attempt < 200 && !asks.every(({ id }) => permissionFor(id)); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(asks.every(({ id }) => permissionFor(id)), "both Writes should await approval together");
  await host.call("permissions.resolve", { requestId: permissionFor("ask-write-e").params.requestId, decision: "deny" });
  await host.call("permissions.resolve", { requestId: permissionFor("ask-write-f").params.requestId, decision: "allow-once" });
  const askRequests = await asked;
  assert.equal(existsSync(join(workspace, "e.txt")), false);
  assert.equal(await readFile(join(workspace, "f.txt"), "utf8"), "approved\n");
  const askResults = toolMessages(askRequests.at(-1)).filter(message => message.tool_call_id.startsWith("ask-"));
  assert.deepEqual(askResults.map(message => message.tool_call_id), asks.map(call => call.id));
  assert.equal(hostResults.get("ask-write-e")?.ok, false);
  assert.equal(hostResults.get("ask-write-f")?.ok, true);
  assert.equal(events.some(event => event.type === "error"), false);
  console.log("PASS parallel-file E2E: parent/delegate Runtime/pi with real Host, concurrent dispatch, source-order results, alias Read/Write both orders, real-tag Edit, two-Write rollback, concurrent ask-mode approvals");
} finally {
  releaseReads();
  releaseGate();
  clearTimeout(barrierTimeout);
  await runtime?.dispose();
  if (turnId) await endTurn(host, turnId, "error");
  await host.stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
