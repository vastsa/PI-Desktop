import { describe, expect, it } from "vitest";
import { HostProcess } from "./host-process.js";

/**
 * The gate that stops a call from racing `app.handshake`.
 *
 * These build the object with `Object.create` on purpose: that skips field
 * initializers, which is exactly how the request-limit tests fabricate a
 * HostProcess. If the gate handling assumed its fields were always set, every
 * one of those tests would hang instead of failing.
 */

type GateInternals = {
  handshakeSettled: boolean;
  handshakeGate?: Promise<void>;
  resolveHandshakeGate?: () => void;
  waitForHandshake: () => Promise<void>;
  settleHandshakeGate: () => void;
};

function bareHost(): GateInternals {
  return Object.create(HostProcess.prototype) as unknown as GateInternals;
}

describe("handshake gate", () => {
  it("does not wait when the instance was built without field initializers", async () => {
    const host = bareHost();
    // No gate at all: waiting here would hang the caller forever.
    await expect(host.waitForHandshake()).resolves.toBeUndefined();
  });

  it("does not wait once the handshake has settled", async () => {
    const host = bareHost();
    host.handshakeSettled = true;
    await expect(host.waitForHandshake()).resolves.toBeUndefined();
  });

  it("releases a waiter when the handshake lands", async () => {
    const host = bareHost();
    host.handshakeSettled = false;
    host.handshakeGate = new Promise<void>((resolve) => {
      host.resolveHandshakeGate = resolve;
    });

    let released = false;
    const waiting = host.waitForHandshake().then(() => {
      released = true;
    });

    // Still blocked: the handshake has not answered yet.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(released).toBe(false);

    host.settleHandshakeGate();
    await waiting;
    expect(released).toBe(true);
  });

  it("marks itself settled so later calls stop waiting", () => {
    const host = bareHost();
    host.handshakeSettled = false;
    host.handshakeGate = new Promise<void>((resolve) => {
      host.resolveHandshakeGate = resolve;
    });

    host.settleHandshakeGate();
    expect(host.handshakeSettled).toBe(true);
  });
});
