import assert from "node:assert/strict";
import { AgentSidecar } from "../../apps/desktop/electron/main/agent-sidecar";
import type { AgentEventEnvelope } from "@pi-desktop/shared";

Object.defineProperty(process, "resourcesPath", { value: process.argv[2] });
const sidecar = new AgentSidecar((text) => process.stderr.write(text));
sidecar.setHost({
  async call<T>() { return { session: { messages: [] } } as T; },
  onNotification: () => () => {}, onExit: () => () => {},
});
let trust: { systemCount: number; systemIncluded: boolean; extraIncluded: boolean } | undefined;
const events: AgentEventEnvelope[] = [];
const ended = Promise.withResolvers<void>();
sidecar.onNotification((method, params) => {
  if (method === "test.trust") trust = params as typeof trust;
  if (method !== "agent.event") return;
  const envelope = params as AgentEventEnvelope;
  events.push(envelope);
  if (envelope.event.type === "agent_end") ended.resolve();
});
const timeout = setTimeout(() => ended.reject(new Error(`certificate turn timed out: ${JSON.stringify(events)}`)), 15_000);
try {
  await sidecar.call("sidecar.health");
  await sidecar.call("agent.prompt", {
    sessionId: "certificate-e2e", turnId: "turn-e2e", userMessageId: "user-e2e",
    content: "Say hello", mode: "agent", thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    provider: {
      id: "local-fixture", name: "Local TLS fixture", baseUrl: process.argv[3],
      modelId: "fixture", apiKey: "fixture-key", authKind: "api_key", apiStyle: "chat_completions",
      supportsReasoning: false, supportedThinkingLevels: ["off"],
    },
  });
  await ended.promise;
  assert.ok(trust?.systemIncluded, "sidecar must include OS-trusted roots");
  assert.ok(trust?.extraIncluded, "inherited extra CA must remain trusted");
  const messages = events.flatMap(({ event }) => event.type === "message_end" ? [event.message] : []);
  const expected = process.argv[4];
  if (expected === "success") {
    assert.ok(messages.some((m) => m.content === "Hello from TLS" && !m.error));
  } else {
    const error = messages.find((m) => m.error)?.error;
    assert.ok(error, "certificate failure must produce an error row");
    assert.equal(error?.code, "NETWORK_ERROR");
    assert.equal(error?.retriable, false);
    assert.equal((error.details as { networkCode: string }).networkCode, expected);
    assert.equal(events.some(({ event }) => event.type === "status" && event.status.activity?.phase === "retrying"), false);
  }
  console.log(JSON.stringify({ ok: true, expected, trust }));
} finally {
  clearTimeout(timeout);
  await sidecar.dispose();
}
