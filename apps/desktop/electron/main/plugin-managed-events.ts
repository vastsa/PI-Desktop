import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_PARAMS" });
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("An object is required");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) invalid(`${name} is invalid`);
  return value.trim();
}

/** Presentation only. No lifecycle, permission, Ask, model or persistence authority. */
export function managedPresentationEvent(input: unknown): AgentEventEnvelope {
  let encoded: string;
  try { encoded = JSON.stringify(input); } catch { invalid("Event must be JSON"); }
  if (!encoded! || Buffer.byteLength(encoded!, "utf8") > 1024 * 1024) invalid("Event exceeds 1 MiB");
  const raw = record(JSON.parse(encoded!));
  const sessionId = text(raw.sessionId, "sessionId", 128);
  const envelope = record(raw.envelope);
  const turnId = text(envelope.turnId, "turnId");
  const author = raw.author === undefined ? undefined : text(raw.author, "author");
  const ts = envelope.ts;
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts < 0 || ts > 8.64e15) invalid("ts is invalid");
  const event = record(envelope.event);
  const stable = (id: unknown) => `plugin:${sessionId}:${text(id, "message id")}`;
  const tool = (id: unknown) => `plugin:${sessionId}:tool:${text(id, "tool id")}`;
  const message = (value: unknown): UiMessage => {
    const m = record(value);
    if (m.role !== "assistant" && m.role !== "tool") invalid("Only assistant and tool presentation is supported");
    if (m.content !== undefined && typeof m.content !== "string") invalid("Message content must be text");
    if (m.thinking !== undefined && typeof m.thinking !== "string") invalid("Message thinking must be text");
    if (m.createdAt !== undefined && (typeof m.createdAt !== "string" || !Number.isFinite(Date.parse(m.createdAt)))) invalid("createdAt is invalid");
    if (m.status !== undefined && !["streaming", "complete", "error", "aborted"].includes(String(m.status))) invalid("status is invalid");
    if (m.toolStatus !== undefined && !["running", "success", "error", "denied"].includes(String(m.toolStatus))) invalid("toolStatus is invalid");
    for (const key of ["modelId", "providerId", "toolName", "toolCompletedAt"]) {
      if (m[key] !== undefined && typeof m[key] !== "string") invalid(`${key} must be text`);
    }
    if (m.isError !== undefined && typeof m.isError !== "boolean") invalid("isError must be boolean");
    const fields = Object.fromEntries(["thinking", "status", "modelId", "providerId", "toolName", "toolStatus", "toolArgs", "toolResult", "toolCompletedAt", "isError"]
      .filter(key => m[key] !== undefined).map(key => [key, m[key]]));
    return { ...fields, id: stable(m.id), role: m.role, content: m.content ?? "",
      createdAt: m.createdAt ?? new Date(ts).toISOString(),
      ...(m.toolCallId ? { toolCallId: tool(m.toolCallId) } : {}),
      ...(m.parentToolCallId ? { parentToolCallId: tool(m.parentToolCallId) } : {}),
      ...(m.nestedParentToolCallId ? { nestedParentToolCallId: tool(m.nestedParentToolCallId) } : {}),
      ...(author ? { agentName: author } : {}),
    } as UiMessage;
  };
  let normalized: AgentEventEnvelope["event"];
  switch (event.type) {
    case "message_start": normalized = { type: "message_start", message: message(event.message) }; break;
    case "message_update": {
      for (const key of ["deltaText", "deltaThinking"]) {
        if (event[key] !== undefined && typeof event[key] !== "string") invalid(`${key} must be text`);
      }
      for (const key of ["resetText", "resetThinking"]) {
        if (event[key] !== undefined && typeof event[key] !== "boolean") invalid(`${key} must be boolean`);
      }
      if (event.stream !== undefined && event.stream !== "delta") invalid("stream is invalid");
      normalized = { type: "message_update", message: message(event.message),
        ...(event.deltaText !== undefined ? { deltaText: event.deltaText as string } : {}),
        ...(event.deltaThinking !== undefined ? { deltaThinking: event.deltaThinking as string } : {}),
        ...(event.stream === "delta" ? { stream: "delta" } : {}),
        ...(event.resetText !== undefined ? { resetText: event.resetText as boolean } : {}),
        ...(event.resetThinking !== undefined ? { resetThinking: event.resetThinking as boolean } : {}),
      }; break;
    }
    case "message_end": normalized = { type: "message_end", message: message(event.message),
      ...(event.precedingAssistant ? { precedingAssistant: message(event.precedingAssistant) } : {}),
      ...(event.replacesMessageId ? { replacesMessageId: stable(event.replacesMessageId) } : {}),
    }; break;
    case "tool_start": normalized = { type: "tool_start", toolCallId: tool(event.toolCallId), toolName: text(event.toolName, "toolName"), args: event.args }; break;
    case "tool_update": normalized = { type: "tool_update", toolCallId: tool(event.toolCallId), partialResult: event.partialResult }; break;
    case "tool_end":
      if (event.isError !== undefined && typeof event.isError !== "boolean") invalid("isError must be boolean");
      normalized = { type: "tool_end", toolCallId: tool(event.toolCallId), result: event.result,
        ...(event.isError !== undefined ? { isError: event.isError as boolean } : {}) }; break;
    default: invalid("Unsupported presentation event");
  }
  return { sessionId, turnId: `plugin:${sessionId}:turn:${turnId}`, ts, event: normalized,
    ...(envelope.parentToolCallId ? { parentToolCallId: tool(envelope.parentToolCallId) } : {}),
    ...(envelope.nestedParentToolCallId ? { nestedParentToolCallId: tool(envelope.nestedParentToolCallId) } : {}),
    ...(author ? { agentName: author } : {}),
  };
}
