import { describe, expect, it } from "vitest";
import type { UiMessage } from "./types/messages.js";
import {
  DEFAULT_SESSION_REFERENCE_PAGE_LIMIT,
  MAX_SESSION_REFERENCE_READ_PAGES,
  readSessionReferenceSource,
  type SessionReferencePage,
} from "./session-reference-reader.js";
import { pairCompletedQaTurns } from "./session-reference.js";

function msg(partial: Partial<UiMessage> & Pick<UiMessage, "role" | "content">): UiMessage {
  return {
    id: partial.id ?? crypto.randomUUID(),
    createdAt: partial.createdAt ?? "2026-09-16T00:00:00.000Z",
    status: "complete",
    ...partial,
  };
}

describe("session-reference-reader", () => {
  it("exports page limits", () => {
    expect(DEFAULT_SESSION_REFERENCE_PAGE_LIMIT).toBe(400);
    expect(MAX_SESSION_REFERENCE_READ_PAGES).toBe(25);
  });

  it("pagination450toolrows crosses400 withsameQ/A: retains cross-page orphan assistant until question is fetched", async () => {
    const id = "42cf934f-ba75-46e1-84b5-e44bb76eba83";

    // Simulate 452 lines:
    // Line 0: user question
    // Lines 1..450: tool rows
    // Line 451: assistant final answer
    // Page 1 (tail): lines 52..451 (messageStart: 52, messageEnd: 452, hasMoreBefore: true)
    // Page 2 (head): lines 0..51 (messageStart: 0, messageEnd: 52, hasMoreBefore: false)

    const page1Messages: UiMessage[] = [
      ...Array.from({ length: 399 }, (_, i) => msg({ role: "tool", content: `tool trace ${i + 52}` })),
      msg({ id: "final-answer", role: "assistant", content: "FULL_FINAL_ANSWER" }),
    ];

    const page2Messages: UiMessage[] = [
      msg({ id: "q1", role: "user", content: "Long task question" }),
      ...Array.from({ length: 51 }, (_, i) => msg({ role: "tool", content: `tool trace ${i + 1}` })),
    ];

    const source = await readSessionReferenceSource(
      id,
      async (targetId, before) => {
        if (before === undefined) {
          return {
            id,
            title: "Long Task",
            messages: page1Messages,
            messageStart: 52,
            messageEnd: 452,
            hasMoreBefore: true,
          };
        }
        if (before === 52) {
          return {
            id,
            title: "Long Task",
            messages: page2Messages,
            messageStart: 0,
            messageEnd: 52,
            hasMoreBefore: false,
          };
        }
        return null;
      },
      { budgetTokens: 1000 },
    );

    expect(source).not.toBeNull();
    const turns = pairCompletedQaTurns(source!.messages);
    expect(turns).toEqual([
      { question: "Long task question", answer: "FULL_FINAL_ANSWER" },
    ]);
  });

  it("emptyphysicalpage: advances past empty physical page when messageStart decreases", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const calls: (number | undefined)[] = [];

    const source = await readSessionReferenceSource(
      id,
      async (targetId, before) => {
        calls.push(before);
        if (before === undefined) {
          return {
            id,
            title: "Empty Mid Page",
            messages: [msg({ role: "assistant", content: "A1" })],
            messageStart: 800,
            hasMoreBefore: true,
          };
        }
        if (before === 800) {
          // Empty physical page (e.g. only system records that were filtered before reaching message list)
          return {
            id,
            title: "Empty Mid Page",
            messages: [],
            messageStart: 400,
            hasMoreBefore: true,
          };
        }
        if (before === 400) {
          return {
            id,
            title: "Empty Mid Page",
            messages: [msg({ role: "user", content: "Q1" })],
            messageStart: 0,
            hasMoreBefore: false,
          };
        }
        return null;
      },
      { budgetTokens: 500 },
    );

    expect(calls).toEqual([undefined, 800, 400]);
    expect(source).not.toBeNull();
    const turns = pairCompletedQaTurns(source!.messages);
    expect(turns).toEqual([{ question: "Q1", answer: "A1" }]);
  });

  it("dedupe: first chronological position, latest content per duplicate ID", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const sharedId = "shared-msg-id";

    // Tail page has latest content of sharedId
    const tailPage: SessionReferencePage = {
      id,
      title: "Dedupe",
      messages: [
        msg({ id: sharedId, role: "assistant", content: "LATEST_CONTENT", status: "complete" }),
      ],
      messageStart: 400,
      hasMoreBefore: true,
    };

    // Older page has earlier content and earlier position
    const olderPage: SessionReferencePage = {
      id,
      title: "Dedupe",
      messages: [
        msg({ id: "user-1", role: "user", content: "Original Question" }),
        msg({ id: sharedId, role: "assistant", content: "OLD_CONTENT", status: "streaming" }),
        msg({ id: "user-2", role: "user", content: "Next Question" }),
      ],
      messageStart: 0,
      hasMoreBefore: false,
    };

    const source = await readSessionReferenceSource(
      id,
      async (_, before) => (before === undefined ? tailPage : olderPage),
      { budgetTokens: 1000 },
    );

    expect(source).not.toBeNull();
    // In chronological order: user-1, shared-msg-id (with latest content), user-2
    expect(source!.messages.map((m) => m.id)).toEqual(["user-1", sharedId, "user-2"]);
    expect(source!.messages[1].content).toBe("LATEST_CONTENT");
    expect(source!.messages[1].status).toBe("complete");
  });

  it("badcursor: invalid, stalled, or discontinuous windows fail closed", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    await expect(
      readSessionReferenceSource(
        id,
        async () => ({
          id,
          title: "Bad Cursor",
          messages: [msg({ role: "assistant", content: "Ans" })],
          messageStart: -1,
          hasMoreBefore: true,
        }),
        { budgetTokens: 1000 },
      ),
    ).rejects.toThrow(/cursor is invalid/);

    await expect(
      readSessionReferenceSource(
        id,
        async () => ({
          id,
          title: "Stalled Cursor",
          messages: [msg({ role: "assistant", content: "Ans" })],
          messageStart: 500,
          hasMoreBefore: true,
        }),
        { budgetTokens: 1000 },
      ),
    ).rejects.toThrow(/did not advance/);

    await expect(
      readSessionReferenceSource(
        id,
        async (_, before) =>
          before === undefined
            ? {
                id,
                title: "Bad Contiguous",
                messages: [msg({ role: "assistant", content: "Ans" })],
                messageStart: 400,
                messageEnd: 800,
                hasMoreBefore: true,
              }
            : {
                id,
                title: "Bad Contiguous",
                messages: [msg({ role: "user", content: "Q" })],
                messageStart: 0,
                messageEnd: 399,
                hasMoreBefore: false,
              },
        { budgetTokens: 1000 },
      ),
    ).rejects.toThrow(/not contiguous/);
  });

  it("source disappearance or id change after the first page fails closed", async () => {
    const id = "66666666-6666-4666-8666-666666666666";
    await expect(
      readSessionReferenceSource(
        id,
        async (_, before) =>
          before === undefined
            ? {
                id,
                title: "Gone",
                messages: [msg({ role: "assistant", content: "Ans" })],
                messageStart: 400,
                hasMoreBefore: true,
              }
            : null,
        { budgetTokens: 1000 },
      ),
    ).rejects.toThrow(/disappeared/);

    await expect(
      readSessionReferenceSource(
        id,
        async (_, before) =>
          before === undefined
            ? {
                id,
                title: "Swap",
                messages: [msg({ role: "assistant", content: "Ans" })],
                messageStart: 400,
                hasMoreBefore: true,
              }
            : {
                id: "77777777-7777-4777-8777-777777777777",
                title: "Other",
                messages: [msg({ role: "user", content: "Q" })],
                messageStart: 0,
                hasMoreBefore: false,
              },
        { budgetTokens: 1000 },
      ),
    ).rejects.toThrow(/id mismatch/);
  });

  it("cancellation: aborted signal throws AbortError", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const controller = new AbortController();
    controller.abort();

    await expect(
      readSessionReferenceSource(id, async () => null, {
        budgetTokens: 1000,
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    const liveController = new AbortController();
    await expect(
      readSessionReferenceSource(
        id,
        async () => {
          liveController.abort();
          return {
            id,
            title: "Abort mid",
            messages: [],
            messageStart: 0,
            hasMoreBefore: false,
          };
        },
        { budgetTokens: 1000, signal: liveController.signal },
      ),
    ).rejects.toThrow();
  });

  it("readcap: stops at maxPages and sets readLimitReached only if budget not satisfied", async () => {
    const id = "55555555-5555-4555-8555-555555555555";
    let cursor = 10000;

    const source = await readSessionReferenceSource(
      id,
      async () => {
        cursor -= 400;
        return {
          id,
          title: "Huge Session",
          messages: [msg({ role: "assistant", content: "short" })],
          messageStart: cursor,
          hasMoreBefore: true,
        };
      },
      { budgetTokens: 100000, maxPages: 5 }, // Cap at 5 pages
    );

    expect(source).not.toBeNull();
    expect(source!.hasMoreBefore).toBe(true);
    expect(source!.readLimitReached).toBe(true);
  });
});
