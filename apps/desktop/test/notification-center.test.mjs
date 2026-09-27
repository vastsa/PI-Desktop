import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const componentSource = await readFile(
  new URL("../src/components/NotificationCenter.tsx", import.meta.url),
  "utf8",
);
const globalStyles = await loadStyles();
const englishCatalog = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);
const chineseCatalog = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-CN/index.ts", import.meta.url),
  "utf8",
);

test("notification center exposes an accessible sidebar footer trigger and dialog", () => {
  assert.match(componentSource, /<IconBell size=\{14\} aria-hidden \/>/);
  assert.match(componentSource, /className=\{`footer-notification notification-trigger/);
  assert.match(componentSource, /onBeforeOpen\?\.\(\)/);
  assert.match(componentSource, /aria-haspopup="dialog"/);
  assert.match(componentSource, /aria-controls="notification-popover"/);
  assert.match(componentSource, /aria-expanded=\{open\}/);
  assert.match(componentSource, /role="dialog"/);
  assert.match(componentSource, /aria-labelledby="notification-title"/);
  assert.match(componentSource, /unreadCount > 99 \? "99\+" : unreadCount/);
});

test("notification center supports filtering, bulk actions, and session navigation", () => {
  assert.match(componentSource, /filter === "unread"/);
  assert.match(componentSource, /notification\.readAt/);
  assert.match(componentSource, /aria-pressed=\{filter === value\}/);
  assert.match(componentSource, /markAllNotificationsRead/);
  assert.match(componentSource, /clearNotifications/);
  assert.match(componentSource, /openNotification\(notification\.id\)/);
  assert.match(componentSource, /notification\.kind === "task\.failed"/);
  assert.match(componentSource, /notification\.errorCode/);
});

test("notification popover preserves keyboard and focus behavior", () => {
  assert.match(componentSource, /event\.key !== "Escape"/);
  assert.match(componentSource, /"ArrowDown", "ArrowUp", "Home", "End"/);
  assert.match(componentSource, /\.notification-item:not\(:disabled\)/);
  assert.match(componentSource, /Math\.max\(0,/);
  assert.match(componentSource, /Math\.min\(buttons\.length - 1,/);
  assert.match(componentSource, /triggerRef\.current\?\.focus\(\)/);
  assert.match(componentSource, /rootRef\.current\?\.contains/);
  assert.match(componentSource, /popoverRef\.current\?\.contains/);
  assert.match(componentSource, /createPortal/);
  assert.match(componentSource, /notification-popover-portaled/);
  assert.match(componentSource, /\.notification-item\.unread, \.notification-item/);
  assert.match(componentSource, /\.notification-filter\.active/);
  assert.match(componentSource, /aria-live="polite"/);
});

test("notification content is localized and timestamps are relative", () => {
  assert.match(componentSource, /Intl\.RelativeTimeFormat/);
  assert.match(componentSource, /Intl\.DateTimeFormat/);
  assert.match(englishCatalog, /notifications:\s*\{/);
  assert.match(englishCatalog, /failedBodyWithCode:/);
  assert.match(chineseCatalog, /notifications:\s*\{/);
  assert.match(chineseCatalog, /failedBodyWithCode:/);
});

test("notification popover has bounded desktop and mobile layouts", () => {
  assert.match(
    globalStyles,
    /\.notification-popover\s*\{[^}]*width:\s*min\(360px, calc\(100vw - 24px\)\);[^}]*max-height:\s*min\(560px, calc\(100vh - 58px\)\);/s,
  );
  assert.match(
    globalStyles,
    /\.notification-popover\s*\{[^}]*bottom:\s*calc\(100% \+ 8px\);[^}]*left:\s*0;/s,
  );
  assert.match(
    globalStyles,
    /\.notification-popover-portaled\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*60;/s,
  );
  assert.match(globalStyles, /\.notification-badge\s*\{[^}]*var\(--ds-bg-sidebar\)/s);
  assert.match(globalStyles, /\.notification-list\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(globalStyles, /\.notification-item\.unread\s*\{/);
});
