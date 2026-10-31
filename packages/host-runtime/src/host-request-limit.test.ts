import { MAX_HOST_STDIN_LINE_BYTES } from "@pi-desktop/shared";
import { describe, expect, it } from "vitest";
import { HostProcess } from "./host-process.js";

describe("local Host request limit", () => {
  it("reports method and UTF-8 size without writing or retrying an oversized request", async () => {
    let writes = 0;
    const host = Object.assign(Object.create(HostProcess.prototype), {
      closed: false,
      available: true,
      disposed: false,
      child: {
        exitCode: null,
        killed: false,
        stdin: {
          writable: true,
          destroyed: false,
          write() {
            writes++;
          },
        },
      },
    }) as HostProcess;
    const once = (host as any).callOnce.bind(host);
    let attempts = 0;
    (host as any).callOnce = (...args: unknown[]) => {
      attempts++;
      return once(...args);
    };
    const params = { content: "x".repeat(MAX_HOST_STDIN_LINE_BYTES) };
    let failure: any;
    try {
      await host.call("session.replaceMessages", params);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      errorCode: "LIMIT_EXCEEDED",
      code: 1002,
      data: {
        method: "session.replaceMessages",
        limitBytes: MAX_HOST_STDIN_LINE_BYTES,
        scope: "host-request",
      },
    });
    expect(failure.data.requestBytes).toBeGreaterThan(MAX_HOST_STDIN_LINE_BYTES);
    expect(JSON.stringify(failure)).not.toContain(params.content);
    expect(writes).toBe(0);
    expect(attempts).toBe(1);
  });
});
