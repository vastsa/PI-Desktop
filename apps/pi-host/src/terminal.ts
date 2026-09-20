import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { RacpError } from "@pi-desktop/agent-host";
import type { RacpTerminalAccess, TerminalOpenResult } from "@pi-desktop/racp";
import { RACP_DEFAULT_LIMITS } from "@pi-desktop/shared";

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
  pty: Pty;
  cols: number;
  rows: number;
  ring: Buffer[];
  ringBytes: number;
  sink: TerminalSink | null;
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
  private readonly ringBytes: number;
  private readonly maxPerSession: number;

  constructor(private readonly options: TerminalServiceOptions) {
    this.ringBytes = options.replayRingBytes ?? RACP_DEFAULT_LIMITS.terminalReplayRingBytes;
    this.maxPerSession = options.maxPerSession ?? RACP_DEFAULT_LIMITS.maxOpenTerminalsPerSession;
  }

  private snapshot(record: TerminalRecord): TerminalOpenResult {
    return { terminalId: record.id, replay: Buffer.concat(record.ring).toString("base64"), cols: record.cols, rows: record.rows };
  }

  async open(sessionId: string, size: { cols: number; rows: number }, sink: TerminalSink): Promise<TerminalOpenResult> {
    const open = [...this.terminals.values()].filter((record) => record.sessionId === sessionId && record.exited === null);
    if (open.length >= this.maxPerSession) {
      throw new RacpError("RATE_LIMITED", "terminal limit reached for this session", { details: { limit: this.maxPerSession } });
    }
    const cwd = await this.options.sessionRoot(sessionId);
    const shell = this.options.shell ?? process.env.SHELL ?? "/bin/sh";
    const pty = this.options.pty.spawn(shell, [], { name: "xterm-256color", cols: size.cols, rows: size.rows, cwd, env: { ...process.env, TERM: "xterm-256color" } });
    const record: TerminalRecord = { id: `term_${randomUUID()}`, sessionId, pty, cols: size.cols, rows: size.rows, ring: [], ringBytes: 0, sink, exited: null };
    this.terminals.set(record.id, record);
    pty.onData((data) => {
      const chunk = Buffer.from(data, "utf8");
      record.ring.push(chunk);
      record.ringBytes += chunk.length;
      while (record.ringBytes > this.ringBytes && record.ring.length > 0) {
        const dropped = record.ring.shift()!;
        record.ringBytes -= dropped.length;
      }
      record.sink?.output(Buffer.from(data, "utf8").toString("base64"));
    });
    pty.onExit(({ exitCode }) => {
      record.exited = exitCode;
      record.sink?.exit(exitCode);
      this.terminals.delete(record.id);
      this.options.log("info", "terminal exited", { terminalId: record.id, sessionId, exitCode });
    });
    this.options.log("info", "terminal opened", { terminalId: record.id, sessionId, pid: pty.pid });
    return this.snapshot(record);
  }

  async input(terminalId: string, data: string): Promise<void> {
    this.require(terminalId).pty.write(Buffer.from(data, "base64").toString("utf8"));
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    const record = this.require(terminalId);
    record.cols = cols;
    record.rows = rows;
    record.pty.resize(cols, rows);
  }

  async close(terminalId: string): Promise<void> {
    const record = this.terminals.get(terminalId);
    if (!record) return;
    this.terminals.delete(terminalId);
    record.sink = null;
    try {
      record.pty.kill();
    } catch {
      // Already gone.
    }
  }

  async attach(terminalId: string, sink: TerminalSink): Promise<TerminalOpenResult | null> {
    const record = this.terminals.get(terminalId);
    if (!record || record.exited !== null) return null;
    record.sink = sink;
    return this.snapshot(record);
  }

  detach(terminalId: string): void {
    const record = this.terminals.get(terminalId);
    if (record) record.sink = null;
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.terminals.keys()]) await this.close(id);
  }

  private require(terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId);
    if (!record || record.exited !== null) throw new RacpError("NOT_FOUND", `terminal ${terminalId} is not open`);
    return record;
  }
}
