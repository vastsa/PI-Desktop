import type { McpControlOperation } from "./mcp-control";

/**
 * No renderer IPC mutation channel exists for these authenticated operations.
 *
 * They are plugin-only: only an authenticated first-party plugin context can
 * supply the session provenance they require, so they stay callable through
 * PluginRuntime while the external MCP surface hides them.
 */
export const SESSION_COLLABORATION_OPERATIONS: McpControlOperation[] = [
  {
    id: "session/collaboration/spawn", channel: "internal:session-collaboration", risk: "write",
    description: "Create a durable Agent session and deliver its first task with authenticated session provenance.",
    argumentShape: ["{task,title?,modelKey?,notifyOnCompletion?,idempotencyKey?}"],
    pluginOnly: true,
  },
  {
    id: "session/collaboration/send", channel: "internal:session-collaboration", risk: "write",
    description: "Send a task or message to an existing Session ID, preserving context and permissions.",
    argumentShape: ["{sessionId,content,kind?,notifyOnCompletion?,delivery?,idempotencyKey?}"],
    pluginOnly: true,
  },
  {
    id: "session/collaboration/status", channel: "internal:session-collaboration", risk: "read",
    description: "Read session provenance, current task, recent exchanges and execution state.",
    argumentShape: ["{sessionId}"],
    pluginOnly: true,
  },
  {
    id: "session/collaboration/list", channel: "internal:session-collaboration", risk: "read",
    description: "List bounded, communicable Agent sessions without loading their transcripts.",
    argumentShape: ["{}"],
    pluginOnly: true,
  },
  {
    id: "session/collaboration/result", channel: "internal:session-collaboration", risk: "read",
    description: "Read the durable outcome of a specific delivery or the session's latest delivery.",
    argumentShape: ["{sessionId,messageId?,turnId?}"],
    pluginOnly: true,
  },
  {
    id: "session/collaboration/cancel", channel: "internal:session-collaboration", risk: "write",
    description: "Cancel this plugin's received task without deleting the reusable session or transcript.",
    argumentShape: ["{sessionId,messageId?}"],
    pluginOnly: true,
  },
];
