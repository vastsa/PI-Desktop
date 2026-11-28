import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { HostProcess } from "./host-process.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("node:buffer", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:buffer")>();
  return { ...original, constants: { ...original.constants, MAX_STRING_LENGTH: 256 } };
});

describe("local Host response limit", () => {
  it("rejects only the oversized reply and still handles the next frame", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitCode: null,
      killed: false,
    });
    spawn.mockReturnValueOnce(child);
    const sent: Array<{ id: string }> = [];
    child.stdin.on("data", (chunk: Buffer) => sent.push(JSON.parse(chunk.toString())));
    const host = new HostProcess({ binaryPath: "fake-host", dataDir: "unused", onStderr() {} });
    try {
      const bad = host.call("session.get", {});
      const failed = expect(bad).rejects.toMatchObject({
        errorCode: "LIMIT_EXCEEDED",
        data: { scope: "host-response" },
      });
      const good = host.call("app.handshake", {});
      child.stdout.write(`{"jsonrpc":"2.0","id":"${sent[0].id}","result":"`);
      child.stdout.write("x".repeat(512));
      child.stdout.write(`"}\n${JSON.stringify({ jsonrpc: "2.0", id: sent[1].id, result: "healthy" })}\n`);
      await failed;
      await expect(good).resolves.toBe("healthy");
      expect(sent).toHaveLength(2);
    } finally {
      child.emit("exit", 0, null);
      await host.dispose();
    }
  });
});
