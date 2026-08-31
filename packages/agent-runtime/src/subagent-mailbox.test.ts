import { describe, expect, it } from "vitest";
import {
  MAX_PEER_INBOX_MESSAGES,
  MAX_PEER_MESSAGE_CHARS,
  MAX_PEER_SENDS_PER_RUN,
  SubagentMailbox,
  formatPeerMessages,
} from "./subagent-mailbox.js";

describe("SubagentMailbox", () => {
  it("delivers a directed message to one running peer", () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("explorer");
    mailbox.join("fixer");

    const outcome = mailbox.send("explorer", "fixer", "I own src/a.ts");

    expect(outcome).toEqual({ ok: true, delivered: ["fixer"] });
    expect(mailbox.drain("explorer").messages).toEqual([]);
    const drained = mailbox.drain("fixer");
    expect(drained.messages).toHaveLength(1);
    expect(drained.messages[0]).toMatchObject({
      from: "explorer",
      to: "fixer",
      text: "I own src/a.ts",
      seq: 1,
    });
  });

  it("broadcasts to every other peer but never back to the sender", () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("a");
    mailbox.join("b");
    mailbox.join("c");

    const outcome = mailbox.send("a", undefined, "schema is v10");

    expect(outcome).toEqual({ ok: true, delivered: ["b", "c"] });
    expect(mailbox.drain("a").messages).toEqual([]);
    expect(mailbox.drain("b").messages[0]?.to).toBeUndefined();
    expect(mailbox.drain("c").messages[0]?.text).toBe("schema is v10");
  });

  it("refuses an unknown peer, a self-send, and an empty body", () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("a");
    mailbox.join("b");

    expect(mailbox.send("a", "ghost", "hi")).toEqual({
      ok: false,
      reason: "unknown-peer",
    });
    expect(mailbox.send("a", "a", "hi")).toEqual({
      ok: false,
      reason: "unknown-peer",
    });
    expect(mailbox.send("a", "b", "   ")).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("reports no-peers for a broadcast with nobody else running", () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("solo");

    expect(mailbox.send("solo", undefined, "anyone there")).toEqual({
      ok: false,
      reason: "no-peers",
    });
  });

  it("truncates an oversized message instead of rejecting it", () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("a");
    mailbox.join("b");

    mailbox.send("a", "b", "x".repeat(MAX_PEER_MESSAGE_CHARS + 500));

    expect(mailbox.drain("b").messages[0]?.text).toHaveLength(
      MAX_PEER_MESSAGE_CHARS,
    );
  });

  it("drops oldest messages past the inbox cap and reports the loss once", () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("a");
    mailbox.join("b");

    for (let i = 0; i < MAX_PEER_INBOX_MESSAGES + 3; i += 1) {
      mailbox.send("a", "b", `m${i}`);
    }

    const drained = mailbox.drain("b");
    expect(drained.messages).toHaveLength(MAX_PEER_INBOX_MESSAGES);
    expect(drained.dropped).toBe(3);
    expect(drained.messages[0]?.text).toBe("m3");
    // Draining resets the loss counter so the next read is not double-warned.
    expect(mailbox.drain("b").dropped).toBe(0);
  });

  it("caps total sends per run", () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("a");
    mailbox.join("b");

    for (let i = 0; i < MAX_PEER_SENDS_PER_RUN; i += 1) {
      expect(mailbox.send("a", "b", `m${i}`).ok).toBe(true);
    }

    expect(mailbox.send("a", "b", "one more")).toEqual({
      ok: false,
      reason: "send-cap",
    });
    // The cap is per sender, not global.
    expect(mailbox.send("b", "a", "still fine").ok).toBe(true);
  });

  it("drains destructively so a message is never read twice", () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("a");
    mailbox.join("b");
    mailbox.send("a", "b", "once");

    expect(mailbox.drain("b").messages).toHaveLength(1);
    expect(mailbox.drain("b").messages).toHaveLength(0);
  });

  it("lists only running peers and forgets a delegate that left", () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("a");
    mailbox.join("b");
    expect(mailbox.peers("a")).toEqual(["b"]);

    mailbox.leave("b");

    expect(mailbox.peers("a")).toEqual([]);
    expect(mailbox.send("a", "b", "still there?")).toEqual({
      ok: false,
      reason: "unknown-peer",
    });
  });

  it("keeps a name addressable while a twin delegation still runs", () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("sender");
    // Two concurrent delegations of one definition share an agent name.
    mailbox.join("fixer");
    mailbox.join("fixer");

    mailbox.leave("fixer");

    expect(mailbox.peers("sender")).toEqual(["fixer"]);
    expect(mailbox.send("sender", "fixer", "still reachable").ok).toBe(true);

    mailbox.leave("fixer");

    expect(mailbox.peers("sender")).toEqual([]);
  });

  it("does not reset a shared name's send cap when a twin joins", () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("fixer");
    mailbox.join("reader");
    for (let i = 0; i < MAX_PEER_SENDS_PER_RUN; i += 1) {
      mailbox.send("fixer", "reader", `m${i}`);
    }

    // A twin starting must not hand the name a fresh send budget.
    mailbox.join("fixer");

    expect(mailbox.send("fixer", "reader", "one more")).toEqual({
      ok: false,
      reason: "send-cap",
    });
  });

  it("does not discard queued mail when a twin joins", () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("sender");
    mailbox.join("fixer");
    mailbox.send("sender", "fixer", "read me");

    mailbox.join("fixer");

    expect(mailbox.drain("fixer").messages).toHaveLength(1);
  });

  it("wakes a waiter when mail arrives", async () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("a");
    mailbox.join("b");

    const waiting = mailbox.waitForMessages("b", Date.now() + 5_000);
    mailbox.send("a", "b", "wake up");

    await expect(waiting).resolves.toBe(true);
    expect(mailbox.drain("b").messages[0]?.text).toBe("wake up");
  });

  it("returns immediately when mail is already queued", async () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("a");
    mailbox.join("b");
    mailbox.send("a", "b", "early");

    await expect(
      mailbox.waitForMessages("b", Date.now() - 1),
    ).resolves.toBe(true);
  });

  it("resolves false when the wait deadline passes with no mail", async () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("a");

    await expect(mailbox.waitForMessages("a", Date.now() + 5)).resolves.toBe(
      false,
    );
  });

  it("wakes a waiter when its last peer leaves, instead of hanging", async () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("a");
    mailbox.join("b");

    const waiting = mailbox.waitForMessages("a", Date.now() + 5_000);
    mailbox.leave("b");

    await expect(waiting).resolves.toBe(false);
  });

  it("resolves false once the run aborts", async () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("a");
    mailbox.join("b");
    const controller = new AbortController();

    const waiting = mailbox.waitForMessages(
      "a",
      Date.now() + 5_000,
      controller.signal,
    );
    controller.abort();

    await expect(waiting).resolves.toBe(false);
  });

  it("does not wait for an agent that never joined", async () => {
    const mailbox = new SubagentMailbox();

    await expect(
      mailbox.waitForMessages("ghost", Date.now() + 5_000),
    ).resolves.toBe(false);
  });

  it("clear() releases waiters and state", async () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("a");
    const waiting = mailbox.waitForMessages("a", Date.now() + 5_000);

    mailbox.clear();

    await expect(waiting).resolves.toBe(false);
    expect(mailbox.peers("a")).toEqual([]);
  });

  it("keeps a monotonic sequence across recipients", () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("a");
    mailbox.join("b");
    mailbox.join("c");

    mailbox.send("a", "b", "first");
    mailbox.send("a", "c", "second");

    expect(mailbox.drain("b").messages[0]?.seq).toBe(1);
    expect(mailbox.drain("c").messages[0]?.seq).toBe(2);
  });
});

describe("formatPeerMessages", () => {
  it("says so plainly when there is nothing to read", () => {
    expect(formatPeerMessages([], 0)).toBe("No peer messages.");
  });

  it("marks a broadcast and keeps the sender and sequence", () => {
    const text = formatPeerMessages(
      [
        { seq: 4, from: "explorer", to: "fixer", text: "directed", ts: 0 },
        { seq: 5, from: "explorer", text: "to everyone", ts: 0 },
      ],
      0,
    );

    expect(text).toContain("- [4] from explorer: directed");
    expect(text).toContain("- [5] from explorer (broadcast): to everyone");
  });

  it("leads with the dropped-message warning", () => {
    const text = formatPeerMessages(
      [{ seq: 9, from: "a", to: "b", text: "kept", ts: 0 }],
      2,
    );

    expect(text.split("\n")[0]).toContain("2 earlier messages dropped");
  });
});
