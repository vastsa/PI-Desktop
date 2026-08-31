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
    mailbox.join("c");

    // Send cap is per-sender, so split across two senders to exceed inbox.
    const half = Math.ceil((MAX_PEER_INBOX_MESSAGES + 3) / 2);
    for (let i = 0; i < half; i += 1) {
      mailbox.send("a", "c", `a-${i}`);
    }
    for (let i = 0; i < MAX_PEER_INBOX_MESSAGES + 3 - half; i += 1) {
      mailbox.send("b", "c", `b-${i}`);
    }

    const drained = mailbox.drain("c");
    expect(drained.messages).toHaveLength(MAX_PEER_INBOX_MESSAGES);
    expect(drained.dropped).toBe(3);
    // Draining resets the loss counter so the next read is not double-warned.
    expect(mailbox.drain("c").dropped).toBe(0);
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
    expect(mailbox.send("b", "a", "still fine").ok).toBe(true);
  });

  it("carries topic and inReplyTo through to the reader", () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("a");
    mailbox.join("b");

    mailbox.send("a", "b", "schema v10", { topic: "schema-design", inReplyTo: 42 });

    const msg = mailbox.drain("b").messages[0];
    expect(msg?.topic).toBe("schema-design");
    expect(msg?.inReplyTo).toBe(42);
  });

  it("truncates a topic longer than 80 characters", () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("a");
    mailbox.join("b");

    mailbox.send("a", "b", "hi", { topic: "x".repeat(100) });

    expect(mailbox.drain("b").messages[0]?.topic).toHaveLength(80);
  });

  it("drains selectively by sender when a from filter is given", () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("a");
    mailbox.join("b");
    mailbox.join("c");
    mailbox.send("a", "c", "from a");
    mailbox.send("b", "c", "from b");
    mailbox.send("a", "c", "also from a");

    const { messages } = mailbox.drain("c", { from: "a" });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.text).toBe("from a");
    expect(messages[1]?.text).toBe("also from a");
    // b's message is still queued
    expect(mailbox.drain("c").messages).toHaveLength(1);
    expect(mailbox.drain("c").messages).toHaveLength(0);
  });

  it("waits for a specific sender when filter is provided", async () => {
    const mailbox = new SubagentMailbox();
    mailbox.join("a");
    mailbox.join("b");
    mailbox.join("c");

    const waiting = mailbox.waitForMessages("c", Date.now() + 5_000, undefined, { from: "b" });
    // a's message should not wake the waiter
    mailbox.send("a", "c", "not what you want");
    // Give the event loop a tick
    await new Promise((r) => setTimeout(r, 5));
    // b's message should wake it
    mailbox.send("b", "c", "this is it");

    await expect(waiting).resolves.toBe(true);
    const { messages } = mailbox.drain("c", { from: "b" });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("this is it");
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

  it("allows separate inboxes for unique peer identities of the same role", () => {
    const mailbox = new SubagentMailbox();
    // Simulates three "discussant" delegates with unique peer IDs.
    mailbox.join("discussant");
    mailbox.join("discussant-2");
    mailbox.join("discussant-3");

    // Each sees the other two as peers.
    expect(mailbox.peers("discussant").sort()).toEqual(
      ["discussant-2", "discussant-3"],
    );
    expect(mailbox.peers("discussant-2").sort()).toEqual(
      ["discussant", "discussant-3"],
    );

    // A directed message reaches only its target.
    const outcome = mailbox.send("discussant", "discussant-2", "I advocate REST");
    expect(outcome).toEqual({ ok: true, delivered: ["discussant-2"] });
    expect(mailbox.drain("discussant-2").messages[0]?.text).toBe("I advocate REST");
    expect(mailbox.drain("discussant-3").messages).toHaveLength(0);

    // A broadcast reaches all peers but not the sender.
    mailbox.send("discussant-3", undefined, "My final summary");
    expect(mailbox.drain("discussant").messages[0]?.text).toBe("My final summary");
    expect(mailbox.drain("discussant-2").messages[0]?.text).toBe("My final summary");
    expect(mailbox.drain("discussant-3").messages).toHaveLength(0);

    // Leaving one does not affect the others.
    mailbox.leave("discussant-2");
    expect(mailbox.peers("discussant")).toEqual(["discussant-3"]);
    expect(mailbox.send("discussant", "discussant-2", "still there?")).toEqual({
      ok: false,
      reason: "unknown-peer",
    });
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

    expect(text).toContain("[4] from explorer");
    expect(text).toContain("directed");
    expect(text).toContain("[5] from explorer (broadcast)");
    expect(text).toContain("to everyone");
  });

  it("leads with the dropped-message warning", () => {
    const text = formatPeerMessages(
      [{ seq: 9, from: "a", to: "b", text: "kept", ts: 0 }],
      2,
    );

    expect(text.split("\n")[0]).toContain("2 earlier messages dropped");
  });

  it("includes topic and inReplyTo in the formatted output", () => {
    const text = formatPeerMessages(
      [{ seq: 1, from: "a", to: "b", topic: "schema", inReplyTo: 5, text: "v10", ts: 0 }],
      0,
    );

    expect(text).toContain("[schema]");
    expect(text).toContain("(re: #5)");
    expect(text).toContain("v10");
  });
});
