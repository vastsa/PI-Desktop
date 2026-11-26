import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { HostProcess } from "./host-process.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof childProcess>(),
  spawn: vi.fn(),
}));

const maxResponseLineBytes = 256;
const privatePayload = "private text 中🙂\u2028\u2029";

type Request = { id: string; method: string; params: { id?: string; sessionId?: string } };
const frame = (value: unknown) => `${JSON.stringify(value)}\n`;

function fixture() {
  const child = new childProcess.ChildProcess();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr });
  stdin.on("end", () => {
    stdout.end();
    stderr.end();
    child.emit("exit", 0, null);
  });
  const requests: Request[] = [];
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    for (const line of chunk.trimEnd().split("\n")) requests.push(JSON.parse(line));
  });
  vi.mocked(childProcess.spawn).mockReturnValueOnce(child);
  const host = new HostProcess({
    binaryPath: "unused-host-binary",
    dataDir: "unused-data-dir",
    maxResponseLineBytes,
    onStderr: () => {},
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return { host, stdout, requests, warn };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("rejects only the matching session RPC and keeps the same child available", async () => {
  const { host, stdout, requests, warn } = fixture();
  try {
    const first = host.call("session.get", { id: "session-a" }, 1000);
    const rejected = expect(first).rejects.toMatchObject({
      code: 1002,
      errorCode: "LIMIT_EXCEEDED",
      data: { scope: "host-response", limitBytes: maxResponseLineBytes },
    });
    const second = host.call("session.get", { id: "session-b" }, 1000);
    const fulfilled = expect(second).resolves.toEqual({ session: { messages: [{ content: privatePayload }] } });
    const over = Buffer.from(frame({
      jsonrpc: "2.0", id: requests[0].id, result: privatePayload.repeat(64),
    }));
    const valid = Buffer.from(frame({
      jsonrpc: "2.0", id: requests[1].id, result: { session: { messages: [{ content: privatePayload }] } },
    }));
    stdout.write(over.subarray(0, 22));
    stdout.write(over.subarray(22, over.length - 8));
    stdout.write(Buffer.concat([over.subarray(over.length - 8), valid]));
    await Promise.all([rejected, fulfilled]);
    expect(host.isAvailable()).toBe(true);
    expect(requests.map(({ params }) => params.id)).toEqual(["session-a", "session-b"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain(privatePayload);
    expect(String(warn.mock.calls[0][0])).not.toContain(requests[0].id);

    const health = host.call("app.health", {}, 1000);
    stdout.write(frame({ id: requests[2].id, result: { ok: true } }));
    await expect(health).resolves.toEqual({ ok: true });
  } finally {
    await host.dispose();
  }
});

it("ignores an oversized frame with a nested or unknown ID", async () => {
  const { host, stdout, requests, warn } = fixture();
  try {
    const pending = host.call("app.health", {}, 1000);
    const fulfilled = expect(pending).resolves.toEqual({ ok: true });
    const [{ id }] = requests;
    stdout.write(
      frame({ method: "probe", params: { id, content: privatePayload.repeat(32) } }) +
      frame({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", result: privatePayload.repeat(32) }) +
      frame({ id, result: { ok: true } }),
    );
    await fulfilled;
    expect(warn).toHaveBeenCalledTimes(2);
  } finally {
    await host.dispose();
  }
});

it("surfaces a small host-side response limit error without retrying a mutation", async () => {
  const { host, stdout, requests, warn } = fixture();
  try {
    const pending = host.call("session.activateRevision", { sessionId: "session-a" }, 1000);
    const data = { errorCode: "LIMIT_EXCEEDED", scope: "host-response", limitBytes: 64 * 1024 * 1024 };
    const rejected = expect(pending).rejects.toMatchObject({ code: 1002, errorCode: "LIMIT_EXCEEDED", data });
    stdout.write(frame({
      jsonrpc: "2.0", id: requests[0].id,
      error: { code: 1002, message: "Host response exceeds the stdout line byte limit", data },
    }));
    await rejected;
    expect(requests).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    expect(host.isAvailable()).toBe(true);
  } finally {
    await host.dispose();
  }
});
