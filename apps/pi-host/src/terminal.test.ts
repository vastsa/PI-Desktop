import { describe, expect, it } from "vitest";

import { TerminalService, type TerminalServiceOptions } from "./terminal.js";

type Sink = Parameters<TerminalService["open"]>[3];

class FakePty {
  readonly pid: number;
  readonly writes: string[] = [];
  readonly sizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  constructor(pid: number) {
    this.pid = pid;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.sizes.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
  }

  onData(listener: (data: string) => void): { dispose: () => void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose: () => void } {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode: number): void {
    for (const listener of this.exitListeners) listener({ exitCode });
  }
}

function setup(options: Partial<TerminalServiceOptions> = {}) {
  const ptys: FakePty[] = [];
  const pty: TerminalServiceOptions["pty"] = {
    spawn: () => {
      const fake = new FakePty(ptys.length + 1);
      ptys.push(fake);
      return fake;
    },
  };
  const terminal = new TerminalService({
    pty,
    sessionRoot: async (sessionId) => `/workspace/${sessionId}`,
    log: () => undefined,
    ...options,
  });
  return { terminal, ptys };
}

function sink() {
  const outputs: string[] = [];
  const exits: Array<number | null> = [];
  const value: Sink = { output: (data) => outputs.push(data), exit: (code) => exits.push(code) };
  return { value, outputs, exits };
}

describe("Host session terminal lifecycle", () => {
  it("binds a terminal to its session and principal, deduplicates opens, and protects a newer attachment", async () => {
    const { terminal, ptys } = setup();
    const firstSink = sink();
    const identity = { principalSubject: "device-1", connectionId: "conn-1" };
    const opened = await terminal.open("s1", { cols: 90, rows: 30, openRequestId: "open-1" }, identity, firstSink.value);
    expect(ptys).toHaveLength(1);

    ptys[0]!.emitData("first");
    expect(firstSink.outputs).toEqual([Buffer.from("first").toString("base64")]);

    const wrongSessionSink = sink();
    await expect(terminal.attach("s2", opened.terminalId, identity, wrongSessionSink.value)).resolves.toBeNull();
    const wrongPrincipalSink = sink();
    await expect(terminal.attach("s1", opened.terminalId, { principalSubject: "device-2", connectionId: "conn-2" }, wrongPrincipalSink.value)).resolves.toBeNull();

    const secondSink = sink();
    const attached = await terminal.open("s1", { cols: 90, rows: 30, openRequestId: "open-1" }, { principalSubject: "device-1", connectionId: "conn-2" }, secondSink.value);
    expect(attached).toMatchObject({ terminalId: opened.terminalId, replay: Buffer.from("first").toString("base64") });
    expect(ptys).toHaveLength(1);

    await expect(terminal.input(opened.terminalId, Buffer.from("old").toString("base64"), "conn-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await terminal.input(opened.terminalId, Buffer.from("new").toString("base64"), "conn-2");
    expect(ptys[0]!.writes).toEqual(["new"]);
    await expect(terminal.close(opened.terminalId, { principalSubject: "device-1", connectionId: "conn-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    terminal.detach(opened.terminalId, "conn-1");
    ptys[0]!.emitData("second");
    expect(secondSink.outputs).toEqual([Buffer.from("second").toString("base64")]);
    expect(firstSink.outputs).toHaveLength(1);
    await terminal.close(opened.terminalId, { principalSubject: "device-1", connectionId: "conn-2" });
    await terminal.close(opened.terminalId, { principalSubject: "device-1", connectionId: "conn-2" });
    await expect(terminal.close(opened.terminalId, { principalSubject: "device-2", connectionId: "conn-3" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps the replay ring bounded, enforces per-session limits, and closes PTYs on shutdown", async () => {
    const { terminal, ptys } = setup({ replayRingBytes: 4, maxPerSession: 2 });
    const identity = { principalSubject: "device-1", connectionId: "conn-1" };
    const first = await terminal.open("s1", { cols: 80, rows: 24, openRequestId: "open-1" }, identity, sink().value);
    const second = await terminal.open("s1", { cols: 80, rows: 24, openRequestId: "open-2" }, identity, sink().value);
    ptys[0]!.emitData("abcdef");
    const resumed = await terminal.attach("s1", first.terminalId, identity, sink().value);
    expect(resumed?.replay).toBe(Buffer.from("cdef").toString("base64"));
    await expect(terminal.open("s1", { cols: 80, rows: 24, openRequestId: "open-3" }, identity, sink().value)).rejects.toMatchObject({ code: "RATE_LIMITED" });

    await terminal.closeAll();
    expect(ptys.map((pty) => pty.killed)).toEqual([true, true]);
    await expect(terminal.attach("s1", second.terminalId, identity, sink().value)).resolves.toBeNull();
  });

  it("clears the active record when the process exits", async () => {
    const { terminal, ptys } = setup();
    const opened = await terminal.open("s1", { cols: 80, rows: 24, openRequestId: "open-1" }, { principalSubject: "device-1", connectionId: "conn-1" }, sink().value);
    const activeSink = sink();
    await terminal.attach("s1", opened.terminalId, { principalSubject: "device-1", connectionId: "conn-2" }, activeSink.value);

    ptys[0]!.emitExit(7);

    expect(activeSink.exits).toEqual([7]);
    await expect(terminal.attach("s1", opened.terminalId, { principalSubject: "device-1", connectionId: "conn-3" }, sink().value)).resolves.toBeNull();
  });
});
