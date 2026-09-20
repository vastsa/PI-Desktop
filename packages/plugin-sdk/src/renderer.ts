/** Renderer entries execute with the application's UI privileges after trust review. */
export type ComposerReference = {
  refId: string;
  label: string;
  description?: string;
};

export type ComposerPluginReference = ComposerReference & { pluginId: string; providerId: string };

export type ComposerCompletion = {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  reference: ComposerReference;
};

export type ComposerReferenceContent = {
  text: string;
  attachments?: Array<{ path: string; name: string; kind: "image" | "file"; mimeType?: string }>;
};

export type ComposerCompletionProvider = {
  /** A punctuation trigger; built-in @ and / providers remain registered. */
  trigger: string;
  items?: readonly ComposerCompletion[];
  search?: (query: string, signal: AbortSignal) => Promise<readonly ComposerCompletion[]>;
  resolve: (reference: ComposerReference, signal: AbortSignal) => Promise<ComposerReferenceContent>;
  onRemove?: (reference: ComposerReference) => void;
};

export type RendererSession = { id: string; title: string };
export type RendererSessionMessage = {
  role: string;
  content: string;
  status?: string;
  parentToolCallId?: string;
};

export type PiRendererApi = {
  readonly pluginId: string;
  readonly signal: AbortSignal;
  composer: {
    registerCompletion: (id: string, provider: ComposerCompletionProvider) => () => void;
    updateCompletion: (id: string, items: readonly ComposerCompletion[]) => void;
    reference: {
      insert: (providerId: string, reference: ComposerReference) => void;
    };
  };
  session: {
    list: () => Promise<RendererSession[]>;
    /** Available only for a session reference selected in this composer. */
    readSelected: (sessionId: string) => Promise<RendererSessionMessage[]>;
  };
};

export type RendererPlugin = (api: PiRendererApi) => void | (() => void) | Promise<void | (() => void)>;
