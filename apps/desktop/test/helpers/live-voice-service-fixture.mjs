import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

export const owner = { webContentsId: 4, frameProcessId: 1, frameRoutingId: 2, url: "file:///app/index.html" };
export const otherOwner = { ...owner, frameRoutingId: 3 };
export const binding = { id: "codex-main", adapterId: "codex-live", providerId: "codex-account-a", voice: "cove" };
export const requestId = "3d7d68a1-6283-4cfb-a40e-2dd1a74fd19f";

export async function loadModules(t) {
  const server = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  return {
    ...(await server.ssrLoadModule("/electron/main/live-voice/call-service.ts")),
    ...(await server.ssrLoadModule("/electron/main/live-voice/microphone-lease.ts")),
  };
}

export function dependencies(overrides = {}) {
  const state = {
    events: [],
    controls: [],
    transcripts: [],
    adapters: [],
    releasedMic: [],
    settings: { liveVoice: { enabled: true, selectedBindingId: binding.id, bindings: [binding] }, voice: { enabled: false } },
  };
  const provider = {
    id: binding.providerId,
    name: "Codex",
    vendorKey: "openai-codex",
    enabled: true,
    authKind: "oauth",
    hasSecret: true,
    models: [],
    supportsReasoning: false,
    supportedThinkingLevels: [],
  };
  const deps = {
    loadSettings: async () => state.settings,
    authResolver: {
      provider: async (providerId) => providerId === provider.id ? { provider } : null,
      resolve: async () => ({ provider, auth: { kind: "codex-oauth", accessToken: "test-token", accountId: "account-a" } }),
    },
    createAdapter: (context) => {
      state.adapters.push(context);
      return {
        adapterId: "codex-live",
        mediaKind: "webrtc",
        connect: async ({ offerSdp }) => {
          assert.equal(offerSdp, "v=0\r\n");
          return { answerSdp: "v=0\r\n" };
        },
        close: async () => undefined,
      };
    },
    createPcmBridge: () => { throw new Error("Codex must not create a PCM bridge"); },
    sendView: (_owner, view) => state.events.push(view),
    sendControl: (_owner, event) => state.controls.push(event),
    sendTranscript: (_owner, event) => state.transcripts.push(event),
    ownerAlive: () => true,
    acquireMicrophone: (callId) => () => state.releasedMic.push(callId),
    ...overrides,
  };
  return { deps, state, provider };
}
