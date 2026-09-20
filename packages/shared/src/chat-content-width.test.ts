import { describe, expect, it } from "vitest";
import {
  CHAT_CONTENT_WIDTH_GUTTER,
  DEFAULT_CHAT_CONTENT_MAX_WIDTH,
  MIN_CHAT_CONTENT_MAX_WIDTH,
  chatContentWidthFromDrag,
  clampChatContentMaxWidth,
  normalizeChatContentMaxWidth,
  resolveChatContentMaxWidth,
} from "./chat-content-width.js";

describe("chat content width", () => {
  it("defaults absent and invalid values to 760", () => {
    expect(resolveChatContentMaxWidth(undefined)).toBe(
      DEFAULT_CHAT_CONTENT_MAX_WIDTH,
    );
    expect(resolveChatContentMaxWidth(null)).toBe(DEFAULT_CHAT_CONTENT_MAX_WIDTH);
    expect(resolveChatContentMaxWidth("900")).toBe(DEFAULT_CHAT_CONTENT_MAX_WIDTH);
    expect(normalizeChatContentMaxWidth(undefined)).toBeUndefined();
  });

  it("snaps below the drag floor up to 560 and rounds", () => {
    expect(normalizeChatContentMaxWidth(400)).toBe(MIN_CHAT_CONTENT_MAX_WIDTH);
    expect(normalizeChatContentMaxWidth(900.4)).toBe(900);
    expect(resolveChatContentMaxWidth(1200)).toBe(1200);
  });

  it("compresses to the pane when the sidebar squeezes past the preference", () => {
    expect(clampChatContentMaxWidth(1100, 700)).toBe(700 - 2 * CHAT_CONTENT_WIDTH_GUTTER);
    expect(clampChatContentMaxWidth(760, 1400)).toBe(760);
    expect(clampChatContentMaxWidth(400, 1400)).toBe(MIN_CHAT_CONTENT_MAX_WIDTH);
  });

  it("lets a tiny pane drop below the drag floor", () => {
    expect(clampChatContentMaxWidth(760, 500)).toBe(500 - 2 * CHAT_CONTENT_WIDTH_GUTTER);
  });

  it("mirrors left and right drags onto the same centered width", () => {
    expect(
      chatContentWidthFromDrag({
        side: "left",
        startWidth: 760,
        startClientX: 200,
        clientX: 150,
        paneWidth: 1400,
      }),
    ).toBe(860);
    expect(
      chatContentWidthFromDrag({
        side: "right",
        startWidth: 760,
        startClientX: 1000,
        clientX: 1050,
        paneWidth: 1400,
      }),
    ).toBe(860);
  });
});
