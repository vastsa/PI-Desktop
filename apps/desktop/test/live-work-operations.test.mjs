import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("Live work status renders the exact terminal summary as escaped text", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());

  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { LiveWorkOperations } = await server.ssrLoadModule("/src/features/voice/live/LiveWorkOperations.tsx");
  const html = renderToStaticMarkup(React.createElement(LiveWorkOperations, {
    sessionId: "session-a",
    callId: "call-1",
    operations: [{
      operationId: "operation-1",
      admission: "accepted",
      execution: "completed",
      summary: "Fixed the login bug. <script>ignored</script>",
    }],
    t: (key) => key,
    busyOperationId: null,
    setBusyOperationId() {},
    setMessage() {},
    onOpenSelection: async () => {},
    onCreateSession: async () => {},
  }));

  assert.match(html, /liveVoice\.workStatus\.completed/);
  assert.match(html, /Fixed the login bug\./);
  assert.match(html, /&lt;script&gt;ignored&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("Live work selection actions render from opaque references", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());

  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { LiveWorkOperations } = await server.ssrLoadModule("/src/features/voice/live/LiveWorkOperations.tsx");
  const html = renderToStaticMarkup(React.createElement(LiveWorkOperations, {
    sessionId: "session-a",
    callId: "call-1",
    operations: [{
      operationId: "operation-2",
      admission: "accepted",
      execution: "not-started",
      selections: [
        { selectionRef: "opaque-session-ref", kind: "session", action: "open", label: "Demo / Chat" },
        { selectionRef: "opaque-project-ref", kind: "project", action: "create", label: "Demo" },
      ],
    }],
    t: (key) => key,
    busyOperationId: null,
    setBusyOperationId() {},
    setMessage() {},
    onOpenSelection: async () => {},
    onCreateSession: async () => {},
  }));

  assert.match(html, /liveVoice\.openSelectedSession/);
  assert.match(html, /liveVoice\.createInProject/);
  assert.match(html, /Demo \/ Chat/);
  assert.doesNotMatch(html, /\/Users\//);
});
