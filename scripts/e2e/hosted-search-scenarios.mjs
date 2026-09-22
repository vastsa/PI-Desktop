import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OfflineSidecar, fixtureHost } from "./hosted-search-sidecar.mjs";
import { assertReplay, functionResult, providerConfig, SEARCH_ITEM, startProvider } from "./hosted-search-provider.mjs";

function parameters(baseUrl, dir, sessionId) {
  return {
    sessionId, mode: "agent", thinkingLevel: "off", infiniteProviderRetry: false,
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    provider: providerConfig(baseUrl), scratchDir: dir, projectPath: dir,
    pluginTools: [], pluginSkills: [], trustedExtensions: [],
  };
}

function assertText(sidecar, text) {
  assert.ok([...sidecar.messages.values()].some((message) => message.role === "assistant" && message.content === text),
    `missing completed assistant message: ${text}`);
}

function assertSearch(sidecar) {
  const message = [...sidecar.messages.values()].find((entry) => entry.hostedSearch);
  assert.ok(message, "search must reach the persisted UiMessage shape");
  assert.equal(message.hostedSearch.status, "completed");
  assert.equal(message.usage?.inputTokens, 1000, "provider usage must reach the real runtime before continuation");
  const replay = message.hostedSearch.replay;
  assert.ok(replay?.some((block) => block.phase === "web_search_call" && block.blockId === SEARCH_ITEM.id));
  const block = replay.find((entry) => entry.blockId === SEARCH_ITEM.id);
  assert.equal(Object.hasOwn(block, "name"), false, "the fixture must exercise a genuinely nameless search block");
  assert.deepEqual(block.wire, SEARCH_ITEM);
  assert.ok(sidecar.events.some(({ event }) => event.type === "message_update" && event.message?.hostedSearch),
    "search activity must stream through the real agent loop");
}

function assertTool(body, name) {
  assert.ok(body.tools.some((tool) => tool.type === "function" && tool.name === name), `${name} must be advertised`);
}

// Each scenario owns a fresh process and fixture server. A red case cannot
// poison later cases; all failures retain their own transport evidence.
async function scenario(bundle, root, name, timeoutMs, handler, run) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const provider = await startProvider(dir, handler);
  const children = [];
  const start = async (suffix = "runtime", host = fixtureHost()) => {
    const child = await OfflineSidecar.start(bundle, join(dir, suffix), host, timeoutMs);
    children.push(child);
    return child;
  };
  try {
    await run({ provider, start, dir });
    provider.check();
    for (const child of children) if (!child.stopping) child.check();
    return { name, passed: true, requests: provider.requests.length };
  } catch (error) {
    try { provider.check(); } catch (providerError) { error = providerError; }
    return { name, passed: false, requests: provider.requests.length, error: error.stack ?? String(error) };
  } finally {
    try { await Promise.all(children.map((child) => child.stop())); }
    finally { await provider.close(); }
  }
}

export async function runScenarios(bundle, root, timeoutMs, report) {
  const results = [];
  const run = async (...args) => {
    const result = await scenario(bundle, root, args[0], timeoutMs, ...args.slice(1));
    results.push(result);
    report(result);
  };

  await run("search-next-prompt", (body, requests) => {
    if (requests.length === 1) return { search: true, text: "SEARCH_FINISHED" };
    assert.equal(requests.length, 2, "unexpected retry/extra parent request");
    assertReplay(body);
    assert.match(JSON.stringify(body.input), /NEW_USER_PROMPT/);
    return { text: "FOLLOWUP_FINISHED" };
  }, async ({ provider, start, dir }) => {
    const sidecar = await start();
    const params = parameters(provider.baseUrl, dir, "next-prompt");
    await sidecar.prompt(params, "Search the offline fixture.");
    assertSearch(sidecar);
    assertText(sidecar, "SEARCH_FINISHED");
    await sidecar.prompt(params, "NEW_USER_PROMPT: use the previous search.");
    assertText(sidecar, "FOLLOWUP_FINISHED");
    assert.equal(provider.requests.length, 2);
    assert.equal(sidecar.hostCalls.filter((call) => call.method === "session.get").length, 1,
      "same-config next prompt must reuse the live runtime, not restore history");
  });

  for (const instructions of [false, true]) {
    await run(instructions ? "search-read-instruction-change" : "search-read", (body, requests) => {
      if (requests.length === 1) {
        assertTool(body, "Read");
        assert.doesNotMatch(JSON.stringify(body.input), /OFFLINE_NESTED_RULE/);
        return { search: true, tool: { name: "Read", args: { path: "nested/fixture.txt" } } };
      }
      assert.equal(requests.length, 2, "Read continuation must not retry");
      assertReplay(body);
      assert.match(functionResult(body, "Read"), /OFFLINE_READ_RESULT/);
      if (instructions) assert.match(JSON.stringify(body.input), /OFFLINE_NESTED_RULE/,
        "path instruction resolution must actually change the next provider request");
      return { text: "READ_CONTINUED" };
    }, async ({ provider, start, dir }) => {
      const sidecar = await start("runtime", fixtureHost({ instructions }));
      await sidecar.prompt(parameters(provider.baseUrl, dir, "read"), "Search, then read nested/fixture.txt and continue.");
      assertSearch(sidecar);
      assertText(sidecar, "READ_CONTINUED");
      assert.equal(provider.requests.length, 2);
      assert.equal(sidecar.hostCalls.filter((call) => call.method === "tools.execute").length, 1);
      assert.equal(sidecar.hostCalls.filter((call) => call.method === "project.instructions.resolve").length, 1);
    });
  }

  let parentRequests = 0;
  let delegateRequests = 0;
  await run("search-task-delegation", (body) => {
    if (body.model === "offline-explorer") {
      delegateRequests++;
      assert.equal(delegateRequests, 1);
      assert.match(JSON.stringify(body.input), /OFFLINE_DELEGATE_BRIEF/);
      assertTool(body, "Read");
      assert.equal(body.tools.some((tool) => tool.name === "Task"), false, "delegate must use its own tool scope");
      return { text: "EXPLORER_REAL_RUNTIME_REPORT" };
    }
    assert.equal(body.model, "offline-parent");
    parentRequests++;
    if (parentRequests === 1) {
      assertTool(body, "Task");
      return {
        search: true,
        tool: { name: "Task", args: { agent: "explorer", task: "OFFLINE_DELEGATE_BRIEF: report the fixture finding.", description: "Offline fixture exploration" } },
      };
    }
    assertReplay(body);
    if (parentRequests === 2) {
      assertTool(body, "TaskWait");
      const result = functionResult(body, "Task");
      const id = result.match(/Delegation (\S+) started:/)?.[1];
      assert.ok(id, `Task must start a real delegate: ${result}`);
      return { tool: { name: "TaskWait", args: { delegationIds: [id], timeoutSeconds: 5 } } };
    }
    assert.equal(parentRequests, 3, "parent should converge without retry or duplicate idle-resume");
    assert.match(functionResult(body, "TaskWait"), /EXPLORER_REAL_RUNTIME_REPORT/);
    return { text: "PARENT_DELEGATION_CONVERGED" };
  }, async ({ provider, start, dir }) => {
    const sidecar = await start();
    const params = parameters(provider.baseUrl, dir, "task");
    params.subagents = [{
      name: "explorer", description: "Inspect the offline fixture", tools: ["Read"],
      prompt: "You are the offline explorer. Return the fixture report.", source: "builtin",
      model: { providerId: "offline-provider", modelId: "offline-explorer" },
      thinkingLevel: "off", permission: "inherit", idleTimeoutSeconds: 10, maxDurationSeconds: 15,
    }];
    params.subagentProviders = { "offline-provider/offline-explorer": providerConfig(provider.baseUrl, "offline-explorer") };
    await sidecar.prompt(params, "Search, delegate to explorer, wait for its result and synthesize.");
    assertSearch(sidecar);
    assertText(sidecar, "PARENT_DELEGATION_CONVERGED");
    assert.equal(delegateRequests, 1, "Task must reach a distinct real provider binding");
    assert.equal(parentRequests, 3);
    assert.equal(sidecar.hostCalls.some((call) => call.method === "tools.execute"), false,
      "Task and TaskWait cannot be synthetic host tools");
    assert.ok([...sidecar.messages.values()].some((message) =>
      message.parentToolCallId && message.content === "EXPLORER_REAL_RUNTIME_REPORT"),
    "real delegate transcript must carry the parent tool correlation");
  });

  await run("search-persist-restore", (body, requests) => {
    if (requests.length === 1) return { search: true, text: "PERSIST_SEARCH" };
    assert.equal(requests.length, 2);
    assertReplay(body);
    assert.match(JSON.stringify(body.input), /RESTORED_USER_PROMPT/);
    return { text: "RESTORED_SEARCH_CONTINUED" };
  }, async ({ provider, start, dir }) => {
    const first = await start("before-restart");
    const params = parameters(provider.baseUrl, dir, "persisted-session");
    await first.prompt(params, "Search and persist this conversation.");
    assertSearch(first);
    const historyPath = join(dir, "ui-history.json");
    const history = [...first.messages.values()];
    assert.ok(history.some((message) => message.role === "user"), "persist the host-owned user row too");
    await writeFile(historyPath, JSON.stringify(history, null, 2));
    await first.stop();
    // Deliberately cross a JSON/disk boundary and restart the Node process. No
    // historyToEntries shortcut and no live AgentMessage injected into runtime.
    const restored = JSON.parse(await readFile(historyPath, "utf8"));
    const second = await start("after-restart", fixtureHost({ history: restored }));
    await second.prompt(params, "RESTORED_USER_PROMPT: continue using the saved search.");
    assertText(second, "RESTORED_SEARCH_CONTINUED");
    assert.equal(second.hostCalls.filter((call) => call.method === "session.get").length, 1);
    assert.equal(provider.requests.length, 2);
  });
  await run("invalid-search-container", () => {
    assert.fail("a corrupt replay container must never reach the provider");
  }, async ({ provider, start, dir }) => {
    const history = [{
      id: "invalid-history", role: "assistant", content: "stored result", status: "complete",
      createdAt: "2026-09-20T00:00:00.000Z",
      hostedSearch: { status: "completed", rounds: [], replay: { invalid: true } },
    }];
    // Serve the malformed row to the failing session only: the recovery prompt
    // below opens a clean session that must still be able to run.
    const fixture = fixtureHost({ history: [] });
    const host = (method, params) => method === "session.get" && params.id === "invalid-history"
      ? { session: { id: params.id, messages: history } }
      : fixture(method, params);
    const sidecar = await start("runtime", host);
    const healthBefore = await sidecar.call("sidecar.health");
    assert.equal(healthBefore.runtimes, 0, "a fresh fixture process must not own a live runtime");
    await assert.rejects(sidecar.call("agent.prompt", {
      ...parameters(provider.baseUrl, dir, "invalid-history"), content: "Continue the restored history.",
    }), (error) => {
      const rpc = JSON.parse(error.message);
      assert.equal(rpc.code, -32000);
      assert.equal(rpc.data.errorCode, "INTERNAL");
      assert.equal(rpc.data.retriable, false);
      assert.deepEqual(rpc.data.details, { origin: "local", phase: "context-validation" });
      return true;
    });
    assert.equal(provider.requests.length, 0);
    // The child only ever receives `history` as an RPC JSON copy, so
    // re-serialising the harness-side array proves nothing about the child's
    // memory. What this harness can observe is the Host surface: a rejected
    // restore may only read the session through the runtime constructor's
    // session.get, and may not call any other Host method. In-memory
    // immutability of the restored copy is covered by the source replay
    // tests, not here.
    const restoreCalls = sidecar.hostCalls.slice();
    assert.deepEqual(restoreCalls.filter((call) => call.method !== "session.get"), [],
      "a rejected restore must not issue persistence-mutating Host RPCs");
    assert.equal(restoreCalls.filter((call) => call.method === "session.get").length, 1,
      "restore must read the session exactly once before rejecting");
    const healthAfter = await sidecar.call("sidecar.health");
    assert.equal(healthAfter.ok, true, "invalid history must not terminate the process");
    assert.equal(healthAfter.runtimes, healthBefore.runtimes,
      "a rejected restore must not register or leak a runtime");
    // Same child, clean session: a rejected restore must not wedge recovery.
    const cleanDir = join(dir, "clean-session");
    await mkdir(cleanDir, { recursive: true });
    const clean = await startProvider(cleanDir, () => ({ text: "CLEAN_SESSION_OK" }));
    try {
      await sidecar.prompt(parameters(clean.baseUrl, dir, "clean-after-invalid"), "CLEAN_SESSION_PROMPT");
      assertText(sidecar, "CLEAN_SESSION_OK");
      assert.equal(clean.requests.length, 1, "the recovery session must make exactly one provider request");
    } finally {
      await clean.close();
    }
  });

  // A single stored block this app itself writes when a gateway drops ids is not
  // a corrupt container: the message must continue without search replay rather
  // than fail every later turn. The unreplayable block never reaches the provider.
  await run("invalid-search-phase", (body) => {
    assert.doesNotMatch(JSON.stringify(body), /private-fixture-value/,
      "an unreplayable stored block must not be sent to the provider");
    return { text: "DEGRADED_SEARCH_CONTINUED" };
  }, async ({ provider, start, dir }) => {
    const history = [{
      id: "invalid-history", role: "assistant", content: "stored result", status: "complete",
      createdAt: "2026-09-20T00:00:00.000Z",
      hostedSearch: { status: "completed", rounds: [], replay: [
        { type: "hostedSearch", phase: "unknown", blockId: "private-fixture-value" },
      ] },
    }];
    const fixture = fixtureHost({ history: [] });
    const host = (method, params) => method === "session.get" && params.id === "invalid-history"
      ? { session: { id: params.id, messages: history } }
      : fixture(method, params);
    const sidecar = await start("runtime", host);
    await sidecar.prompt(parameters(provider.baseUrl, dir, "invalid-history"), "Continue the restored history.");
    assertText(sidecar, "DEGRADED_SEARCH_CONTINUED");
    assert.equal(provider.requests.length, 1, "the turn must continue without the stored search replay");
    const health = await sidecar.call("sidecar.health");
    assert.equal(health.ok, true, "a degraded stored record must not terminate the process");
  });
  return results;
}
