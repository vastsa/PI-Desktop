/** Host speech capability bindings. Protocol ids are open strings. */
export const SPEECH_ROLES = ["transcribe", "synthesize"] as const;
export type SpeechRole = (typeof SPEECH_ROLES)[number];

/** Wire identity for a request-shape adapter. Built-ins plus plugin ids. */
export const SPEECH_PROTOCOL_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

export const MAX_SPEECH_INPUT_BYTES = 25_000_000;
export const MAX_SPEECH_TTS_DATA_URL_BYTES = 8_000_000;

export const BUILTIN_SPEECH_PROTOCOL_IDS = ["openai_audio", "openai_chat_audio"] as const;
export type BuiltinSpeechProtocolId = (typeof BUILTIN_SPEECH_PROTOCOL_IDS)[number];

export const BUILTIN_SPEECH_PROTOCOLS: Record<
  BuiltinSpeechProtocolId,
  { id: BuiltinSpeechProtocolId; label: string; roles: readonly SpeechRole[] }
> = {
  openai_audio: {
    id: "openai_audio",
    label: "OpenAI Audio",
    roles: ["transcribe", "synthesize"],
  },
  openai_chat_audio: {
    id: "openai_chat_audio",
    label: "Chat Completions Audio",
    roles: ["synthesize"],
  },
};

export type SpeechBinding = {
  providerId: string;
  modelId: string;
  protocol: string;
  voice?: string;
  format?: string;
  /** Optional path under the provider base URL. */
  path?: string;
  extra?: Record<string, string>;
};

export type SpeechSettings = {
  transcribe?: SpeechBinding;
  synthesize?: SpeechBinding;
};

export type SpeechProtocolInfo = {
  id: string;
  label: string;
  roles: SpeechRole[];
  source: "builtin" | "plugin";
  pluginId?: string;
};

export type SpeechRoleStatus = {
  configured: boolean;
  available: boolean;
  providerId?: string;
  modelId?: string;
  protocol?: string;
};

export type SpeechStatus = {
  transcribe: SpeechRoleStatus;
  synthesize: SpeechRoleStatus;
  protocols: SpeechProtocolInfo[];
};

export type SpeechTranscribeRequest = {
  sessionId?: string | null;
  path: string;
  mimeType?: string;
  language?: string;
};

export type SpeechTranscribeResult = { text: string };

export type SpeechSynthesizeRequest = {
  sessionId?: string | null;
  text: string;
  voice?: string;
  format?: string;
};

export type SpeechSynthesizeResult = {
  path: string;
  mimeType: string;
  /** Bounded playback payload; omitted when the file is larger than the cap. */
  dataUrl?: string;
};
