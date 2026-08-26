import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [app, splash, css, english, chinese] = await Promise.all([
  read("../src/App.tsx"),
  read("../src/components/StartupSplash.tsx"),
  loadStyles(),
  read("../../../packages/i18n/src/locales/en/index.ts"),
  read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
]);

test("boot path renders a branded startup splash instead of plain status text", () => {
  assert.match(splash, /export function StartupSplash/);
  assert.match(splash, /data-testid="startup-splash"/);
  assert.match(splash, /<BrandLogo size=\{64\}/);
  assert.match(splash, /t\("app\.shellName"\)/);
  assert.match(splash, /t\("app\.tagline"\)/);
  assert.match(splash, /t\("app\.starting"\)/);
  assert.match(app, /import \{ StartupSplash \}/);
  assert.match(app, /app-shell-boot/);
  assert.match(app, /splashPhase/);
  assert.doesNotMatch(
    app,
    /flex h-full items-center justify-center bg-bg-primary text-sm text-text-muted[\s\S]*app\.starting/,
  );
});

test("startup splash motion respects reduced-motion and uses design tokens", () => {
  assert.match(css, /--motion-duration-fast:\s*150ms/);
  assert.match(css, /--motion-duration-normal:\s*200ms/);
  assert.match(css, /--motion-duration-slow:\s*300ms/);
  assert.match(css, /--motion-ease-out:\s*cubic-bezier/);
  assert.match(css, /\.startup-splash\s*\{/);
  assert.match(css, /@keyframes startup-splash-out/);
  assert.match(
    css,
    /prefers-reduced-motion:\s*reduce[\s\S]*\.startup-splash-bar[\s\S]*animation:\s*none/,
  );
  assert.match(css, /@keyframes overlay-in/);
  assert.match(css, /@keyframes surface-in/);
  assert.match(
    css,
    /\.overlay\s*\{[\s\S]*animation:\s*overlay-in var\(--motion-duration-normal\)/,
  );
});

test("crash and empty-home copy is catalog-backed in English and Chinese", () => {
  assert.match(english, /uiCrashed:\s*"Something went wrong with the interface"/);
  assert.match(chinese, /uiCrashed:\s*"界面出现了问题"/);
  assert.match(app, /i18n\.t\("app\.uiCrashed"\)/);
  assert.match(chinese, /emptyTitle:\s*"今天想做点什么？"/);
  assert.match(english, /emptyTitleTemporary:\s*"What would you like to explore temporarily\?"/);
  assert.match(chinese, /emptyTitleTemporary:\s*"临时聊点什么？"/);
  assert.match(
    chinese,
    /emptyTitleInProject:\s*"今天想在 \{\{project\}\} 里做点什么？"/,
  );
  assert.match(chinese, /emptySubtitle:\s*"从一个任务开始，或者选择一个方向。"/);
  assert.match(chinese, /emptySubtitleTemporary:\s*"这是一个独立的临时对话，会随本次会话一起丢弃。"/);
});
