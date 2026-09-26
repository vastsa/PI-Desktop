/** Requests for the paired remote Host's session-scoped terminal. */
export type RemoteTerminalOpenRequest = {
  /** Must be a renderer-visible `remote:<hostKey>:<hostSessionId>` id. */
  sessionId: string;
  cols?: number;
  rows?: number;
  /** Stable across a lost response so a reconnect cannot create a second shell. */
  openRequestId?: string;
  /** Namespaced terminal id to re-attach after reconnect. */
  terminalId?: string;
};

export type RemoteTerminalOpenResult = {
  /** Namespaced by Electron Main with the owning remote session. */
  terminalId: string;
  /** Bounded replay ring, base64 encoded. */
  replay: string;
  cols: number;
  rows: number;
};

export type RemoteTerminalInputRequest = {
  sessionId: string;
  terminalId: string;
  /** Base64 encoded PTY input bytes, as required by the RACP terminal/input operation. */
  data: string;
};

export type RemoteTerminalResizeRequest = {
  sessionId: string;
  terminalId: string;
  cols: number;
  rows: number;
};

export type RemoteTerminalCloseRequest = {
  sessionId: string;
  terminalId: string;
};

export type RemoteTerminalControlResult = { ok: true };

/** Live terminal output and lifecycle events relayed from one paired Host. */
export type RemoteTerminalEvent =
  | {
      type: "output";
      sessionId: string;
      terminalId: string;
      /** Base64 data from the RACP terminal.output payload. */
      output: string;
    }
  | {
      type: "state";
      sessionId: string;
      terminalId: string;
      state: "open" | "closed" | "exited";
      code?: number | null;
    };
