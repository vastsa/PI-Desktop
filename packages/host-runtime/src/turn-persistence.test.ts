import { describe, expect, it } from "vitest";
import type { UiMessage } from "@pi-desktop/shared";

import { TurnPersistence } from "./turn-persistence.js";

function row(id: string): UiMessage {
  return { id, role: "assistant", content: id, createdAt: "2026-09-18T00:00:00.000Z", status: "complete" };
}

describe("TurnPersistence", () => {
  it("writes a session's rows in order and reports nothing pending afterwards", async () => {
    const written: string[] = [];
    const persistence = new TurnPersistence({
      getHost: () => ({
        async call(_method: string, params: { message: UiMessage }) {
          written.push(params.message.id);
        },
      }),
      log: () => undefined,
    });
    const first = persistence.append({ sessionId: "s", message: row("a") });
    const second = persistence.append({ sessionId: "s", message: row("b") });
    expect(persistence.size()).toBe(2);
    await Promise.all([first, second]);
    expect(written).toEqual(["a", "b"]);
    expect(persistence.size()).toBe(0);
  });

  it("retries while host-core is unavailable and lands the row once it is back", async () => {
    let attempts = 0;
    let available = false;
    const sleeps: number[] = [];
    const persistence = new TurnPersistence({
      getHost: () => ({
        isAvailable: () => available,
        async call() {
          attempts += 1;
        },
      }),
      log: () => undefined,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 3) available = true;
      },
    });
    await persistence.append({ sessionId: "s", message: row("a") });
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([100, 250, 500]);
  });

  it("treats a duplicate message id as already written and logs other failures", async () => {
    const logs: string[] = [];
    let calls = 0;
    const persistence = new TurnPersistence({
      getHost: () => ({
        async call() {
          calls += 1;
          if (calls === 1) throw new Error("UNIQUE constraint failed: messages.id");
          throw Object.assign(new Error("bad row"), { errorCode: "INVALID_ARGUMENT" });
        },
      }),
      log: (_level, message) => logs.push(message),
    });
    await persistence.append({ sessionId: "s", message: row("dup") });
    await persistence.append({ sessionId: "s", message: row("bad") });
    expect(calls).toBe(2);
    expect(logs).toEqual(["transcript append failed"]);
  });
});
