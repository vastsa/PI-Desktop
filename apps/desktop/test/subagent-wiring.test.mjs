import { readMainModule } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sessionLaunchSource = await readMainModule("runtime/session-launch.ts");
const providerCatalogSource = await readMainModule("runtime/provider-catalog.ts");
const desktopSidecarSource = await readMainModule("runtime/sidecar.ts");
const eventPersistenceSource = await readMainModule("runtime/event-persistence.ts");
const hostRuntimeSource = await readMainModule("runtime/host.ts");
const sidecarSource = await readFile(
  new URL("../../../packages/agent-runtime/src/sidecar.ts", import.meta.url),
  "utf8",
);
const hostSessionsSource = await readFile(
  new URL("../../../crates/host-core/src/sessions.rs", import.meta.url),
  "utf8",
);
const pageSource = await readFile(
  new URL("../src/components/settings/AgentSubagentsPage.tsx", import.meta.url),
  "utf8",
);
const hostCollectionSource = await readFile(
  new URL("../src/hooks/use-host-collection.ts", import.meta.url),
  "utf8",
);
const hostProcessSource = await readFile(
  new URL("../electron/main/host-process.ts", import.meta.url),
  "utf8",
);

test("every launch resolves the subagent catalog and its pinned models", () => {
  assert.match(sessionLaunchSource, /loadSubagentDefinitions,/);
  assert.match(sessionLaunchSource, /resolveSubagentProviders,/);
  // The catalog is re-read per prompt, registry documents included, so an edit
  // in the UI takes effect on the next turn with no restart (D202).
  assert.match(sessionLaunchSource, /await loadSubagentDefinitions\(projectPath, \{/);
  assert.match(
    sessionLaunchSource,
    /userDocuments: await activeUserSubagentDocuments\(projectPath\),/,
  );
  assert.match(sessionLaunchSource, /await resolveSubagentProviders\(\{/);
  assert.match(sessionLaunchSource, /subagents: subagentCatalog\.definitions,/);
  assert.match(sessionLaunchSource, /subagentProviders: subagentBindings\.providers,/);
  // Discovery problems must not fail the turn, only be reported.
  assert.match(sessionLaunchSource, /"subagent definitions have problems"/);
});

test("subagent models use the exact stored binding for thinking capability", () => {
  assert.match(providerCatalogSource, /const effectiveSubagentModelConfig = \(/);
  assert.match(
    providerCatalogSource,
    /const effectiveSubagentModelConfig = \([\s\S]*?bindingForModel\(provider, modelId\)[\s\S]*?modelConfigWithBinding\(/,
  );
  // The helper is used for definition pins, the pre-resolved delegation
  // catalog, and the on-demand Task.model path.
  const modelSource = [providerCatalogSource, sessionLaunchSource, desktopSidecarSource].join("\n");
  assert.equal(modelSource.match(/effectiveSubagentModelConfig\(/g)?.length, 3);
  assert.match(
    sessionLaunchSource,
    /const configuredProvider = providers\.providers\.find\([\s\S]*?effectiveSubagentModelConfig\(/,
  );
});

test("the sidecar forwards both subagent params to the runtime", () => {
  assert.match(sidecarSource, /subagents\?: SubagentDefinition\[\];/);
  assert.match(
    sidecarSource,
    /subagentProviders\?: Record<string, RuntimeProviderConfig>;/,
  );
  // Once for the reuse check, once for the constructor: a changed catalog must
  // rebuild the runtime rather than silently keep the old delegates.
  assert.equal(sidecarSource.match(/^\s+subagents,$/gm)?.length, 2);
  assert.equal(sidecarSource.match(/^\s+subagentProviders,$/gm)?.length, 2);
});

test("persisted subagent rows keep their attribution", () => {
  assert.match(
    eventPersistenceSource,
    /function subagentTagged\(message: UiMessage, envelope: AgentEventEnvelope\)/,
  );
  assert.match(eventPersistenceSource, /message: subagentTagged\(event\.message, envelope\),/);
  assert.match(eventPersistenceSource, /started\?\.parentToolCallId/);
  assert.match(eventPersistenceSource, /started\?\.agentName/);
  // host-core round-trips both through the message `meta` object.
  assert.match(hostSessionsSource, /pub parent_tool_call_id: Option<String>/);
  assert.match(hostSessionsSource, /meta_obj\.insert\("parentToolCallId"\.into\(\)/);
  assert.match(hostSessionsSource, /\.get\("agentName"\)/);
});

test("a permission request names the delegate that asked", () => {
  assert.match(hostRuntimeSource, /const asking = activeToolCalls\.get\(/);
  assert.match(hostRuntimeSource, /asking\?\.agentName \? \{ agentName: asking\.agentName \}/);
  assert.match(hostRuntimeSource, /asking\?\.parentToolCallId/);
});

test("a dead host transport degrades quietly instead of warning", () => {
  // Shutdown and supervised restarts reject every call. These three reads only
  // add optional context, so they check the transport first — otherwise every
  // quit files routine teardown under the same warn line as a registry that
  // genuinely cannot be read.
  for (const fn of [
    "refreshUserMcp",
    "activeUserSkills",
    "activeUserSubagentDocuments",
  ]) {
    const start = sessionLaunchSource.indexOf(`async function ${fn}(`);
    assert.notEqual(start, -1, fn);
    const body = sessionLaunchSource.slice(start, start + 1800);
    assert.match(body, /if \(!runtimeState\.host\?\.isAvailable\(\)\) return \[\];/, fn);
    // The guard only stops calls that have not started; one already in flight at
    // dispose is rejected too, so the catch has to classify it as well.
    assert.match(body, /if \(!isHostUnavailable\(error\)\) \{/, fn);
  }
  // The bare guard only covers a host that was never constructed.
  assert.doesNotMatch(sessionLaunchSource, /^\s+if \(!host\) return \[\];$/m);
  assert.match(
    sessionLaunchSource,
    /const isHostUnavailable = \(error: unknown\): boolean =>[\s\S]*?ErrorCodes\.HOST_UNAVAILABLE/,
  );
  // Classification works only because both teardown rejections are tagged.
  assert.match(
    hostProcessSource,
    /if \(this\.closed\) throw this\.unavailableError\("host-core is unavailable"\);/,
  );
  assert.match(
    hostProcessSource,
    /this\.closeTransport\(this\.unavailableError\("host-core disposed"\)\);/,
  );
  assert.match(hostProcessSource, /errorCode: ErrorCodes\.HOST_UNAVAILABLE,/);
});

test("the subagents page recovers when the host comes back", () => {
  // The page loads through the shared host-collection hook, which owns the
  // plugin-changed and host-status subscriptions.
  assert.match(pageSource, /useHostCollection\(fetchSubagents/);
  assert.match(hostCollectionSource, /api\.onHostStatus\(\(status\) => \{\n\s+if \(status\.ok\) void reload\(\);/);
  // Both subscriptions have to be released, so the effect returns a composed
  // cleanup rather than a single unsubscribe.
  assert.match(hostCollectionSource, /offPluginChanged\(\);\n\s+offHostStatus\(\);/);
});
