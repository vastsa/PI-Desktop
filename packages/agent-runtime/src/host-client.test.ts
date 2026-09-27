import { describe, expect, it, vi } from "vitest";
import { HostClient } from "./host-client.js";

describe("HostClient lifecycle", () => {
  it("rejects a default-deadline Bash call when the host child dies", async () => {
    const client = new HostClient(process.execPath);
    const closed = vi.fn();
    client.onClose(closed);
    const pending = client.call("tools.execute", { toolName: "Bash" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    (client as any).child.kill();

    await expect(pending).rejects.toThrow(/host client child exited|stdin/);
    expect(closed).toHaveBeenCalledOnce();
    await client.dispose();
  });

  it("rejects pending calls and removes listeners on disposal", async () => {
    const client = new HostClient(process.execPath);
    const notification = vi.fn();
    client.onNotification(notification);
    const pending = client.call("tools.execute", { toolName: "Bash" });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await client.dispose();
    await expect(pending).rejects.toThrow("host client disposed");
    expect((client as any).notificationHandlers.size).toBe(0);
    expect((client as any).pending.size).toBe(0);
    expect(notification).not.toHaveBeenCalled();
  });
});
