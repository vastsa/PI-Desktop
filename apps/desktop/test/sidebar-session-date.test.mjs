import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { formatSessionLastReplyDate } from "../src/lib/sidebar-session-date.ts";

const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const sidebarStyles = await Promise.all([
  readFile(new URL("../src/styles/sidebar-threads.css", import.meta.url), "utf8"),
  readFile(new URL("../src/styles/sessions.css", import.meta.url), "utf8"),
]).then((styles) => styles.join("\n"));

test("formats session activity through seven calendar days and uses a date after that", () => {
  const now = new Date(2026, 9, 16, 12);
  const atLocalDay = (daysAgo) =>
    new Date(2026, 9, 16 - daysAgo, 8).toISOString();

  assert.equal(
    formatSessionLastReplyDate(atLocalDay(0), now, "zh-CN"),
    "0天前",
  );
  assert.equal(
    formatSessionLastReplyDate(atLocalDay(7), now, "zh-CN"),
    "7天前",
  );
  assert.equal(
    formatSessionLastReplyDate(atLocalDay(8), now, "en"),
    "Oct 8",
  );
});

test("invalid timestamps do not render a misleading date", () => {
  assert.equal(formatSessionLastReplyDate(undefined), "");
  assert.equal(formatSessionLastReplyDate("not-a-date"), "");
});

test("project session rows show the date until hover or focus reveals actions", () => {
  assert.match(sidebarSource, /sidebarSessionTime === true/);
  assert.match(sidebarSource, /className=\{cx\([\s\S]*?"thread-item-meta"[\s\S]*?sessionMenu === session\.id/);
  assert.match(sidebarSource, /className="thread-item-last-reply"/);
  assert.match(
    sidebarStyles,
    /\.thread-item:hover \.thread-item-last-reply,[\s\S]*?\.thread-item:focus-within \.thread-item-last-reply\s*\{\s*opacity:\s*0;\s*visibility:\s*hidden;/,
  );
  assert.match(
    sidebarStyles,
    /\.thread-item:hover \.thread-item-more[\s\S]*?\.thread-item:focus-within \.thread-item-more[\s\S]*?opacity:\s*1;/,
  );
});
