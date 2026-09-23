import { expect, it } from "vitest";
import { rpcErrorFromWire, rpcErrorToWire } from "./rpc-error.js";

it("retains stable codes and existing metadata without copying private properties", () => {
  const wire = rpcErrorToWire(Object.assign(new Error("Denied"), {
    code: -32602, errorCode: "PERMISSION_DENIED", data: { retryable: false },
    apiKey: "private-test-key",
  }));
  expect(wire).toEqual({ code: -32602, message: "Denied", data: { retryable: false, errorCode: "PERMISSION_DENIED" } });
  expect(JSON.stringify(wire)).not.toContain("private-test-key");
  expect(rpcErrorFromWire(wire)).toMatchObject({ code: -32602, errorCode: "PERMISSION_DENIED", data: wire.data });
});

it("keeps an existing nested code authoritative and preserves legacy data", () => {
  const existing = { errorCode: "HOST_OVERLOADED", retryAfterMs: 100 };
  expect(rpcErrorToWire(Object.assign(new Error("busy"), { errorCode: "GENERIC", data: existing })).data).toEqual(existing);
  for (const data of [null, "legacy", [1, 2]]) {
    const wire = rpcErrorToWire(Object.assign(new Error("failed"), { data, errorCode: "IMAGE_FAILED" }));
    expect(wire.data).toEqual(data);
    expect(rpcErrorFromWire(wire).errorCode).toBe("IMAGE_FAILED");
  }
  expect(rpcErrorToWire(new Error("ordinary"))).toEqual({ code: -32000, message: "ordinary", data: undefined });
});
