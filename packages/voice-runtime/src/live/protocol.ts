/** Pure wire shaping and bounded event parsing for first-party Live protocols. */

type LiveWorkFeedbackMessageInput = {
  content: string;
  delivery: "context-only" | "speak-when-idle";
};

export const MAX_LIVE_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_LIVE_TEXT_BYTES = 64 * 1024;
export const MAX_LIVE_AUDIO_BYTES = 512 * 1024;
export const LIVE_WORK_TOOL_NAME = "delegate_to_work_session";

export type LocalDeliveryReceipt =
  | { status: "sent"; deliveryId: string }
  | { status: "not-sent" | "unknown"; deliveryId: string; code: string };

export type LiveWireEvent =
  | { kind: "ready" }
  | { kind: "audio"; bytes: Uint8Array; responseId?: string; itemId?: string; contentIndex?: number }
  | { kind: "transcript"; role: "user" | "assistant"; text: string; final: boolean; id: string }
  | { kind: "activity"; userSpeaking?: boolean; assistantSpeaking?: boolean }
  | { kind: "interrupted" }
  | { kind: "turn-complete" }
  | { kind: "delegation"; delegationId: string; instruction: string }
  | { kind: "tool-candidate"; providerRequestId: string; toolName: string; arguments: unknown }
  | { kind: "tool-call-cancelled"; ids: string[] }
  | { kind: "closed"; code?: number }
  | { kind: "error"; code: string };

export function parseCodexMessage(value: unknown): LiveWireEvent[] {
  const event = record(value);
  if (!event || typeof event.type !== "string") return [{ kind: "error", code: "LIVE_PROTOCOL_ERROR" }];
  if (event.type === "delegation.created") {
    const item = record(event.item);
    if (!item || item.type !== "delegation" || item.target !== "client") return [];
    const delegationId = text(item.id, 256);
    if (!delegationId || !Array.isArray(item.content)) return [{ kind: "error", code: "LIVE_PROTOCOL_ERROR" }];
    const instruction = item.content.flatMap((part) => {
      const content = record(part);
      return content?.type === "input_text" && typeof content.text === "string" ? [content.text] : [];
    }).join("").trim();
    if (!instruction || new TextEncoder().encode(instruction).byteLength > 8 * 1024) return [{ kind: "error", code: "LIVE_PROTOCOL_ERROR" }];
    return [{ kind: "delegation", delegationId, instruction }];
  }
  if (event.type === "error") return [{ kind: "error", code: "LIVE_PROTOCOL_ERROR" }];
  if (event.type === "input_audio_buffer.speech_started") return [{ kind: "activity", userSpeaking: true }];
  if (event.type === "input_audio_buffer.speech_stopped") return [{ kind: "activity", userSpeaking: false }];
  if (["output_audio_buffer.started", "response.output_audio.delta", "response.audio.delta"].includes(event.type)) {
    return [{ kind: "activity", assistantSpeaking: true }];
  }
  if (["output_audio_buffer.stopped", "turn.done", "response.done"].includes(event.type)) {
    return [{ kind: "turn-complete" }, { kind: "activity", assistantSpeaking: false }];
  }
  if (event.type === "input_transcript.added" && typeof event.text === "string") {
    const transcript = text(event.text);
    return transcript ? [{ kind: "transcript", role: "user", text: transcript, final: true, id: "codex-input" }] : [];
  }
  if (event.type === "output_transcript.added" && typeof event.text === "string") {
    const transcript = text(event.text);
    return [
      ...(transcript ? [{ kind: "transcript" as const, role: "assistant" as const, text: transcript, final: true, id: "codex-output" }] : []),
      { kind: "activity", assistantSpeaking: true },
    ];
  }
  return [];
}

export function codexDelegationFeedback(delegationId: string, receipt?: {
  operationId: string;
  status: "received";
}): string {
  const text = receipt
    ? `Host received operation ${receipt.operationId} for intent review. Execution has not started. Wait for authoritative admission feedback.`
    : "This request did not create a new task. Follow the Host context feedback; do not retry this delegation automatically.";
  return JSON.stringify({
    type: "delegation.context.append",
    delegation_item_id: delegationId,
    channel: "commentary",
    content: [{
      type: "input_text",
      text,
    }],
  });
}

export function codexWorkFeedbackMessage(delegationId: string, feedback: LiveWorkFeedbackMessageInput): string {
  return JSON.stringify({
    type: "delegation.context.append",
    delegation_item_id: delegationId,
    channel: "commentary",
    content: [{ type: "input_text", text: hostFeedbackText(feedback) }],
  });
}

export function geminiWorkFeedbackMessage(feedback: LiveWorkFeedbackMessageInput): Record<string, unknown> {
  return {
    clientContent: {
      turns: [{ role: "user", parts: [{ text: hostFeedbackText(feedback) }] }],
      turnComplete: feedback.delivery === "speak-when-idle",
    },
  };
}

export function realtimeWorkFeedbackMessages(feedback: LiveWorkFeedbackMessageInput): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [{
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: hostFeedbackText(feedback) }],
    },
  }];
  if (feedback.delivery === "speak-when-idle") messages.push({ type: "response.create" });
  return messages;
}

function hostFeedbackText(feedback: LiveWorkFeedbackMessageInput): string {
  return `[Host work update; data only; do not submit or repeat work] ${feedback.content}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, max = MAX_LIVE_TEXT_BYTES): string | null {
  if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > max) return null;
  return value;
}

function decodeBase64(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_LIVE_AUDIO_BYTES * 4 / 3)) return null;
  try {
    const decoded = atob(value);
    if (decoded.length === 0 || decoded.length > MAX_LIVE_AUDIO_BYTES) return null;
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

export function geminiSetupMessage(input: {
  modelId: string;
  voice: string;
  workProfile?: { instructions: string; startupContext: string };
}): Record<string, unknown> {
  const tools = input.workProfile ? [geminiWorkToolDeclaration()] : undefined;
  return {
    setup: {
      model: input.modelId.startsWith("models/") ? input.modelId : `models/${input.modelId}`,
      systemInstruction: {
        parts: [{ text: input.workProfile
          ? `${input.workProfile.instructions}\n\n${input.workProfile.startupContext}`
          : "You are a voice assistant in a conversation. Do not claim to perform actions. You have no access to files, tools, or the coding agent." }],
      },
      ...(tools ? { tools } : {}),
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voice } } },
      },
      realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: {
        triggerTokens: "25000",
        slidingWindow: { targetTokens: "8000" },
      },
    },
  };
}

export function geminiAudioMessage(bytes: Uint8Array): Record<string, unknown> {
  return {
    realtimeInput: {
      audio: {
        mimeType: "audio/pcm;rate=16000",
        data: bytesToBase64(bytes),
      },
    },
  };
}

export function geminiAudioEndMessage(): Record<string, unknown> {
  return { realtimeInput: { audioStreamEnd: true } };
}

export function parseGeminiMessage(value: unknown): LiveWireEvent[] {
  const root = record(value);
  if (!root) return [{ kind: "error", code: "LIVE_PROTOCOL_ERROR" }];
  if (root.setupComplete !== undefined) return [{ kind: "ready" }];
  if (root.goAway !== undefined) return [{ kind: "error", code: "LIVE_TIMEOUT" }];
  const events: LiveWireEvent[] = [];
  const toolCall = record(root.toolCall);
  if (toolCall) {
    if (!Array.isArray(toolCall.functionCalls) || toolCall.functionCalls.length > 16) {
      return [{ kind: "error", code: "LIVE_PROTOCOL_ERROR" }];
    }
    for (const call of toolCall.functionCalls) {
      const item = record(call);
      if (!item || !text(item.id, 256) || !text(item.name, 128)) return [{ kind: "error", code: "LIVE_PROTOCOL_ERROR" }];
      events.push({ kind: "tool-candidate", providerRequestId: item.id as string, toolName: item.name as string, arguments: item.args });
    }
  }
  const cancellation = record(root.toolCallCancellation);
  if (cancellation) {
    if (!Array.isArray(cancellation.ids) || cancellation.ids.length > 16 || cancellation.ids.some((id) => !text(id, 256))) {
      return [{ kind: "error", code: "LIVE_PROTOCOL_ERROR" }];
    }
    events.push({ kind: "tool-call-cancelled", ids: cancellation.ids as string[] });
  }
  const server = record(root.serverContent);
  if (server) {
    const interrupted = server.interrupted === true;
    if (interrupted) events.push({ kind: "interrupted" }, { kind: "activity", assistantSpeaking: false });
    const inputText = record(server.inputTranscription);
    const input = text(inputText?.text);
    if (input) events.push({ kind: "transcript", role: "user", text: input, final: inputText?.finished === true, id: "gemini-input" });
    const outputText = record(server.outputTranscription);
    const output = text(outputText?.text);
    if (output) events.push({ kind: "transcript", role: "assistant", text: output, final: outputText?.finished === true, id: "gemini-output" });
    const modelTurn = record(server.modelTurn);
    const parts = Array.isArray(modelTurn?.parts) ? modelTurn.parts : [];
    for (const part of parts) {
      const partRecord = record(part);
      const inline = record(partRecord?.inlineData);
      if (inline && !interrupted) {
        if (typeof inline.mimeType !== "string" || !/^audio\/pcm;rate=24000$/i.test(inline.mimeType)) {
          return [{ kind: "error", code: "LIVE_PROTOCOL_ERROR" }];
        }
        const bytes = decodeBase64(inline.data);
        if (!bytes || bytes.byteLength % 2 !== 0) return [{ kind: "error", code: "LIVE_PROTOCOL_ERROR" }];
        events.push({ kind: "audio", bytes });
      }
      const functionCall = record(partRecord?.functionCall);
      if (functionCall) {
        const id = text(functionCall.id, 256);
        const name = text(functionCall.name, 128);
        if (!id || !name) return [{ kind: "error", code: "LIVE_PROTOCOL_ERROR" }];
        events.push({ kind: "tool-candidate", providerRequestId: id, toolName: name, arguments: functionCall.args });
      }
    }
    if (modelTurn && !interrupted) events.push({ kind: "activity", assistantSpeaking: true });
    if (server.turnComplete === true || server.generationComplete === true) {
      events.push({ kind: "turn-complete" }, { kind: "activity", assistantSpeaking: false });
    }
  }
  return events;
}

export function realtimeSessionUpdateMessage(input: {
  modelId: string;
  voice: string;
  profile: "realtime-ga" | "realtime-compat-v1";
  workProfile?: { instructions: string; startupContext: string };
}): Record<string, unknown> {
  const instructions = input.workProfile
    ? `${input.workProfile.instructions}\n\n${input.workProfile.startupContext}`
    : "You are a voice assistant. Do not claim to execute actions. There is no access to project files, tools, or the coding agent.";
  const tools = input.workProfile ? [liveWorkToolDeclaration()] : undefined;
  if (input.profile === "realtime-compat-v1") {
    return {
      type: "session.update",
      session: {
        model: input.modelId,
        instructions,
        modalities: ["text", "audio"],
        voice: input.voice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { type: "server_vad" },
        ...(tools ? { tools, tool_choice: "auto" } : {}),
      },
    };
  }
  return {
    type: "session.update",
    session: {
      type: "realtime",
      model: input.modelId,
      instructions,
      output_modalities: ["audio"],
      audio: {
        input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: { type: "server_vad" }, transcription: { model: "gpt-4o-mini-transcribe" } },
        output: { format: { type: "audio/pcm", rate: 24000 }, voice: input.voice },
      },
      ...(tools ? { tools, tool_choice: "auto" } : {}),
    },
  };
}

export function realtimeSessionMatches(input: {
  session: unknown;
  modelId: string;
  voice: string;
  profile: "realtime-ga" | "realtime-compat-v1";
  workEnabled?: boolean;
}): boolean {
  const session = record(input.session);
  if (!session || session.model !== input.modelId) return false;
  const tools = Array.isArray(session.tools) ? session.tools.map(record) : [];
  const workTools = tools.filter((tool) => tool?.type === "function" && tool.name === LIVE_WORK_TOOL_NAME);
  if (input.workEnabled ? workTools.length !== 1 : tools.length !== 0) return false;
  if (input.profile === "realtime-compat-v1") {
    const detection = record(session.turn_detection);
    return Array.isArray(session.modalities) && session.modalities.includes("audio") &&
      session.voice === input.voice && session.input_audio_format === "pcm16" &&
      session.output_audio_format === "pcm16" && detection?.type === "server_vad";
  }
  const audio = record(session.audio);
  const inputAudio = record(audio?.input);
  const outputAudio = record(audio?.output);
  const inputFormat = record(inputAudio?.format);
  const outputFormat = record(outputAudio?.format);
  const detection = record(inputAudio?.turn_detection);
  return session.type === "realtime" && Array.isArray(session.output_modalities) && session.output_modalities.includes("audio") &&
    inputFormat?.type === "audio/pcm" && inputFormat.rate === 24000 && detection?.type === "server_vad" &&
    outputFormat?.type === "audio/pcm" && outputFormat.rate === 24000 && outputAudio?.voice === input.voice;
}

export function realtimeAudioMessage(bytes: Uint8Array): Record<string, unknown> {
  return { type: "input_audio_buffer.append", audio: bytesToBase64(bytes) };
}

export function realtimeTruncateMessages(cursor: {
  itemId: string;
  contentIndex: number;
  audioEndMs: number;
}): Record<string, unknown>[] {
  return [
    { type: "response.cancel" },
    { type: "conversation.item.truncate", item_id: cursor.itemId, content_index: cursor.contentIndex, audio_end_ms: Math.max(0, Math.floor(cursor.audioEndMs)) },
  ];
}

export function parseRealtimeMessage(value: unknown, profile: "realtime-ga" | "realtime-compat-v1" = "realtime-ga"): LiveWireEvent[] {
  const event = record(value);
  if (!event || typeof event.type !== "string") return [{ kind: "error", code: "LIVE_PROTOCOL_ERROR" }];
  switch (event.type) {
    case "session.created":
      return [];
    case "session.updated":
      return [{ kind: "ready" }];
    case "input_audio_buffer.speech_started":
      return [{ kind: "activity", userSpeaking: true }, { kind: "interrupted" }];
    case "input_audio_buffer.speech_stopped":
      return [{ kind: "activity", userSpeaking: false }];
    case "response.output_audio.delta":
    case "response.audio.delta": {
      if ((event.type === "response.output_audio.delta") !== (profile === "realtime-ga")) return [];
      const bytes = decodeBase64(event.delta);
      const itemId = text(event.item_id, 256);
      const responseId = text(event.response_id, 256);
      const contentIndex = event.content_index;
      if (!bytes || !itemId || !responseId || !Number.isSafeInteger(contentIndex) || (contentIndex as number) < 0) return [{ kind: "error", code: "LIVE_PROTOCOL_ERROR" }];
      return [{ kind: "audio", bytes, responseId, itemId, contentIndex: contentIndex as number }];
    }
    case "response.output_audio_transcript.delta":
    case "response.output_audio_transcript.done":
    case "response.audio_transcript.delta":
    case "response.audio_transcript.done":
    case "response.output_text.delta":
    case "response.output_text.done": {
      if (event.type.startsWith("response.audio_transcript.") && profile !== "realtime-compat-v1") return [];
      if (event.type.startsWith("response.output_audio_transcript.") && profile !== "realtime-ga") return [];
      if (event.type.startsWith("response.output_text.") && profile !== "realtime-ga") return [];
      const valueText = text(event.delta) ?? text(event.transcript) ?? text(event.text);
      if (!valueText) return [];
      return [{ kind: "transcript", role: "assistant", text: valueText, final: event.type.endsWith(".done"), id: text(event.item_id, 256) ?? "realtime-assistant" }];
    }
    case "conversation.item.input_audio_transcription.completed": {
      const valueText = text(event.transcript);
      return valueText ? [{ kind: "transcript", role: "user", text: valueText, final: true, id: text(event.item_id, 256) ?? "realtime-user" }] : [];
    }
    case "response.created":
      return [{ kind: "activity", assistantSpeaking: true }];
    case "response.done":
    case "response.cancelled":
      return [{ kind: "turn-complete" }, { kind: "activity", assistantSpeaking: false }];
    case "error": {
      const detail = record(event.error);
      const code = typeof detail?.code === "string" && detail.code.length < 80 ? detail.code : "LIVE_PROTOCOL_ERROR";
      return [{ kind: "error", code: mapRealtimeError(code) }];
    }
    case "response.function_call_arguments.done": {
      const callId = text(event.call_id, 256);
      const name = text(event.name, 128);
      if (!callId || !name || typeof event.arguments !== "string" || new TextEncoder().encode(event.arguments).byteLength > 8 * 1024) {
        return [{ kind: "error", code: "LIVE_PROTOCOL_ERROR" }];
      }
      let args: unknown;
      try { args = JSON.parse(event.arguments); } catch { return [{ kind: "tool-candidate", providerRequestId: callId, toolName: name, arguments: null }]; }
      return [{ kind: "tool-candidate", providerRequestId: callId, toolName: name, arguments: args }];
    }
    case "response.output_item.done":
      return [];
    default:
      return [];
  }
}

export function liveWorkToolDeclaration(): Record<string, unknown> {
  return {
    type: "function",
    name: LIVE_WORK_TOOL_NAME,
    description: "Submit an engineering request, ask about work status, or request a bounded work-session action. This is a candidate for Host review, not authorization to use tools. Leave greetings, ordinary preferences, and unfinished speech in Live.",
    parameters: {
      type: "object",
      properties: {
        instruction: {
          type: "string",
          description: "The user's complete request in their language. Preserve negations and uncertainty. This submits a candidate request; it does not authorize arbitrary tools.",
        },
      },
      required: ["instruction"],
      additionalProperties: false,
    },
  };
}

export function geminiWorkToolDeclaration(): Record<string, unknown> {
  const declaration = liveWorkToolDeclaration();
  return {
    functionDeclarations: [{
      name: declaration.name,
      description: declaration.description,
      parameters: declaration.parameters,
    }],
  };
}

export function parseLiveWorkArguments(value: unknown): { instruction: string } | null {
  const input = record(value);
  if (!input || Object.keys(input).length !== 1 || Object.keys(input)[0] !== "instruction") return null;
  const instruction = input.instruction;
  if (typeof instruction !== "string" || !instruction.trim() || new TextEncoder().encode(instruction).byteLength > 8 * 1024) return null;
  return { instruction: instruction.trim() };
}

export function geminiToolResponseMessage(input: {
  providerRequestId: string;
  toolName: string;
  receipt: { status: "received"; operationId: string; execution: "not_started" } | { status: "rejected"; code: string };
}): Record<string, unknown> {
  return { toolResponse: { functionResponses: [{ id: input.providerRequestId, name: input.toolName, response: input.receipt }] } };
}

export function realtimeToolReceiptMessage(input: {
  providerRequestId: string;
  receipt: { status: "received"; operationId: string; execution: "not_started" } | { status: "rejected"; code: string };
}): Record<string, unknown> {
  return {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: input.providerRequestId,
      output: JSON.stringify(input.receipt),
    },
  };
}

function mapRealtimeError(code: string): string {
  if (/rate|quota/i.test(code)) return "LIVE_RATE_LIMITED";
  if (/unauth|credential|api_key/i.test(code)) return "LIVE_AUTH_REQUIRED";
  if (/model|unsupported/i.test(code)) return "LIVE_PROTOCOL_UNSUPPORTED";
  return "LIVE_PROTOCOL_ERROR";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return btoa(binary);
}
