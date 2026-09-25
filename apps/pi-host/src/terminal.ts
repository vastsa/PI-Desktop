import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { TextDecoder } from "node:util";

import { RacpError } from "@pi-desktop/agent-host";
import type { RacpTerminalAccess, TerminalIdentity, TerminalOpenResult } from "@pi-desktop/racp";
import { RACP_DEFAULT_LIMITS, validateRacpTerminalInputData } from "@pi-desktop/shared";

/** The subset of `node-pty` this module uses; the package is loaded lazily. */
type Pty = {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
};

type PtyModule = {
  spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }): Pty;
};

type TerminalSink = { output: (data: string) => void; exit: (code: number | null) => void };

type TerminalRecord = {
  id: string;
  sessionId: string;
  principalSubject: string;
  pty: Pty;
  cols: number;
  rows: number;
  ring: Buffer[];
  ringBytes: number;
  sink: TerminalSink | null;
  attachmentConnectionId: string | null;
  exited: number | null;
};

/**
 * Load `node-pty` when it is installed beside the bundle. The Host advertises
 * `terminal: false` when it is not, instead of failing at open time.
 */
export function loadPty(): PtyModule | null {
  try {
    const require = createRequire(import.meta.url);
    return require("node-pty") as PtyModule;
  } catch {
    return null;
  }
}

export type TerminalServiceOptions = {
  pty: PtyModule;
  /** The session's working directory: the Host resolves it, never the client. */
  sessionRoot: (sessionId: string) => Promise<string>;
  shell?: string;
  replayRingBytes?: number;
  maxPerSession?: number;
  log: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
};

/**
 * Session terminals on the Host machine (spec §6.2, security §7): a pty with
 * the session root as cwd, a bounded replay ring per terminal, and at most
 * two open terminals per session. Output is delivered to whichever
 * connection is attached; a dropped connection keeps the pty alive and the
 * next attach receives the ring.
 */
export class TerminalService implements RacpTerminalAccess {
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly openingRequests = new Map<string, Promise<TerminalOpenResult>>();
  private readonly openRequests = new Map<string, string>();
  private readonly closedOwners = new Map<string, string>();
  private readonly pendingBySession = new Map<string, number>();
  private readonly ringBytes: number;
  private readonly maxPerSession: number;

  private static readonly MAX_OPEN_REQUESTS = 1024;

  constructor(private readonly options: TerminalServiceOptions) {
    this.ringBytes = options.replayRingBytes ?? RACP_DEFAULT_LIMITS.terminalReplayRingBytes;
    this.maxPerSession = options.maxPerSession ?? RACP_DEFAULT_LIMITS.maxOpenTerminalsPerSession;
  }

  private snapshot(record: TerminalRecord): TerminalOpenResult {
    return { terminalId: record.id, replay: Buffer.concat(record.ring).toString("base64"), cols: record.cols, rows: record.rows };
  }

  async open(
    sessionId: string,
    size: { cols: number; rows: number; openRequestId?: string },
    identity: TerminalIdentity,
    sink: TerminalSink,
  ): Promise<TerminalOpenResult> {
    const requestKey = size.openRequestId ? `${identity.principalSubject}\u0000${sessionId}\u0000${size.openRequestId}` : undefined;
    if (requestKey) {
      const priorId = this.openRequests.get(requestKey);
      if (priorId) {
        this.openRequests.delete(requestKey);
        this.openRequests.set(requestKey, priorId);
        const attached = await this.attach(sessionId, priorId, identity, sink);
        if (!attached) throw new RacpError("NOT_FOUND", `terminal ${priorId} is not open`);
        return attached;
      }
      const pending = this.openingRequests.get(requestKey);
      if (pending) {
        const opened = await pending;
        const attached = await this.attach(sessionId, opened.terminalId, identity, sink);
        if (!attached) throw new RacpError("NOT_FOUND", `terminal ${opened.terminalId} is not open`);
        return attached;
      }
    }

    const opening = this.openNew(sessionId, size, identity, sink);
    if (!requestKey) return opening;

    this.openingRequests.set(requestKey, opening);
    try {
      const opened = await opening;
      this.rememberOpenRequest(requestKey, opened.terminalId);
      return opened;
    } finally {
      if (this.openingRequests.get(requestKey) === opening) this.openingRequests.delete(requestKey);
    }
  }

  private async openNew(
    sessionId: string,
    size: { cols: number; rows: number },
    identity: TerminalIdentity,
    sink: TerminalSink,
  ): Promise<TerminalOpenResult> {
    const open = [...this.terminals.values()].filter((record) => record.sessionId === sessionId && record.exited === null);
    const pending = this.pendingBySession.get(sessionId) ?? 0;
    if (open.length + pending >= this.maxPerSession) {
      throw new RacpError("RATE_LIMITED", "terminal limit reached for this session", { details: { limit: this.maxPerSession } });
    }
    this.pendingBySession.set(sessionId, pending + 1);
    try {
      const cwd = await this.options.sessionRoot(sessionId);
      const shell = this.options.shell ?? process.env.SHELL ?? "/bin/sh";
      const pty = this.options.pty.spawn(shell, [], { name: "xterm-256color", cols: size.cols, rows: size.rows, cwd, env: { ...process.env, TERM: "xterm-256color" } });
      const record: TerminalRecord = {
        id: `term_${randomUUID()}`,
        sessionId,
        principalSubject: identity.principalSubject,
        pty,
        cols: size.cols,
        rows: size.rows,
        ring: [],
        ringBytes: 0,
        sink,
        attachmentConnectionId: identity.connectionId,
        exited: null,
      };
      this.terminals.set(record.id, record);
      pty.onData((data) => {
        const chunk = Buffer.from(data, "utf8");
        record.ring.push(chunk);
        record.ringBytes += chunk.length;
        while (record.ringBytes > this.ringBytes && record.ring.length > 0) {
          const excess = record.ringBytes - this.ringBytes;
          const first = record.ring[0]!;
          const droppedBytes = Math.min(excess, first.length);
          if (droppedBytes === first.length) record.ring.shift();
          else record.ring[0] = first.subarray(droppedBytes);
          record.ringBytes -= droppedBytes;
        }
        record.sink?.output(chunk.toString("base64"));
      });
      pty.onExit(({ exitCode }) => {
        record.exited = exitCode;
        record.sink?.exit(exitCode);
        record.sink = null;
        record.attachmentConnectionId = null;
        this.terminals.delete(record.id);
        this.rememberClosedOwner(record.id, record.principalSubject);
        this.options.log("info", "terminal exited", { terminalId: record.id, sessionId, exitCode });
      });
      this.options.log("info", "terminal opened", { terminalId: record.id, sessionId, pid: pty.pid });
      return this.snapshot(record);
    } finally {
      const remaining = (this.pendingBySession.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.pendingBySession.set(sessionId, remaining);
      else this.pendingBySession.delete(sessionId);
    }
  }

  private rememberOpenRequest(key: string, terminalId: string): void {
    this.openRequests.delete(key);
    this.openRequests.set(key, terminalId);
    while (this.openRequests.size > TerminalService.MAX_OPEN_REQUESTS) {
      const oldest = this.openRequests.keys().next().value;
      if (oldest === undefined) break;
      this.openRequests.delete(oldest);
    }
  }

  private rememberClosedOwner(terminalId: string, principalSubject: string): void {
    this.closedOwners.delete(terminalId);
    this.closedOwners.set(terminalId, principalSubject);
    while (this.closedOwners.size > TerminalService.MAX_OPEN_REQUESTS) {
      const oldest = this.closedOwners.keys().next().value;
      if (oldest === undefined) break;
      this.closedOwners.delete(oldest);
    }
  }

  async input(terminalId: string, data: string, connectionId: string): Promise<void> {
    const record = this.requireAttached(terminalId, connectionId);
    const validation = validateRacpTerminalInputData(data);
    if (!validation.valid) {
      if (validation.reason === "payload-too-large") {
        throw new RacpError("PAYLOAD_TOO_LARGE", "terminal input exceeds the byte limit", {
          details: {
            limitBytes: validation.limitBytes,
            ...(validation.byteLength === undefined ? {} : { actualBytes: validation.byteLength }),
          },
        });
      }
      const message = validation.reason === "invalid-base64"
        ? "terminal input must use canonical Base64 encoding"
        : "terminal input must contain valid UTF-8 bytes";
      throw new RacpError("INVALID_ARGUMENT", message);
    }
    if (validation.byteLength === 0) return;

    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(data, "base64"));
    } catch {
      throw new RacpError("INVALID_ARGUMENT", "terminal input must contain valid UTF-8 bytes");
    }
    record.pty.write(decoded);
  }

  async resize(terminalId: string, cols: number, rows: number, connectionId: string): Promise<void> {
    const record = this.requireAttached(terminalId, connectionId);
    record.cols = cols;
    record.rows = rows;
    record.pty.resize(cols, rows);
  }

  async close(terminalId: string, identity?: TerminalIdentity): Promise<void> {
    const record = this.terminals.get(terminalId);
    if (!record) {
      const owner = this.closedOwners.get(terminalId);
      if (!identity || owner === identity.principalSubject) return;
      throw new RacpError("NOT_FOUND", `terminal ${terminalId} is not open`);
    }
    if (identity && (record.principalSubject !== identity.principalSubject || record.attachmentConnectionId !== identity.connectionId)) {
      throw new RacpError("NOT_FOUND", `terminal ${terminalId} is not attached to this connection`);
    }
    this.terminals.delete(terminalId);
    this.rememberClosedOwner(terminalId, record.principalSubject);
    record.sink = null;
    record.attachmentConnectionId = null;
    try {
      record.pty.kill();
    } catch {
      // Already gone.
    }
  }

  async attach(sessionId: string, terminalId: string, identity: TerminalIdentity, sink: TerminalSink): Promise<TerminalOpenResult | null> {
    const record = this.terminals.get(terminalId);
    if (!record || record.exited !== null || record.sessionId !== sessionId || record.principalSubject !== identity.principalSubject) return null;
    record.sink = sink;
    record.attachmentConnectionId = identity.connectionId;
    return this.snapshot(record);
  }

  detach(terminalId: string, connectionId: string): void {
    const record = this.terminals.get(terminalId);
    if (record?.attachmentConnectionId !== connectionId) return;
    record.sink = null;
    record.attachmentConnectionId = null;
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.terminals.keys()]) await this.close(id);
  }

  private require(terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId);
    if (!record || record.exited !== null) throw new RacpError("NOT_FOUND", `terminal ${terminalId} is not open`);
    return record;
  }

  private requireAttached(terminalId: string, connectionId: string): TerminalRecord {
    const record = this.require(terminalId);
    if (record.attachmentConnectionId !== connectionId) {
      throw new RacpError("NOT_FOUND", `terminal ${terminalId} is not attached to this connection`);
    }
    return record;
  }
}
