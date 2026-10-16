import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

test("TodoDock renders bounded session progress and cancelled state", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { TodoDock } = await server.ssrLoadModule("/src/components/TodoDock.tsx");
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = () =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(TodoDock, { sessionId: "session-todo-test" }),
        ),
      );

    Object.assign(useAppStore.getInitialState(), {
      sessionTodos: {
        "session-todo-test": {
          sessionId: "session-todo-test",
          revision: 3,
          updatedAt: 100,
          todos: [
            { content: "first", status: "completed", priority: "medium" },
            { content: "second", status: "in_progress", priority: "high" },
            ...Array.from({ length: 10 }, (_, index) => ({
              content: `extra-${index}`,
              status: "pending",
              priority: "low",
            })),
          ],
        },
      },
    });
    const html = render();
    assert.match(html, /<div class="todo-dock-header">/);
    assert.doesNotMatch(html, /<button[^>]*class="todo-dock-header/);
    assert.match(html, /class="[^"]*todo-dock-toggle[^"]*"[^>]*aria-label="Expand checklist"/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /aria-controls="[^"]+"/);
    assert.match(html, /class="todo-dock-header-current todo-dock-shimmer"[^>]*>second<\/span>/);
    assert.match(html, /class="todo-dock-content" aria-hidden="true"/);
    assert.match(html, /class="todo-dock-content" aria-hidden="true"><div class="todo-dock-clip">/);
    assert.match(html, /extra-0/);
    // The expanded dock lists every row (#1319): the whole list is mounted, and
    // the dock scrolls inside instead of printing a static overflow line.
    assert.equal((html.match(/role="listitem"/g) ?? []).length, 12, "every ordered row renders");
    assert.doesNotMatch(html, /more items/);
    assert.match(html, /class="todo-dock-list" role="list" tabindex="-1"/);
    assert.match(html, /lucide-chevron-up/);
    assert.match(html, /lucide-check/);
    // The sweep rides the text of the working step only, and only once: while
    // collapsed it is the header's current-item line, because the list stays
    // mounted behind the disclosure and would otherwise sweep the same text.
    assert.equal((html.match(/todo-dock-shimmer/g) ?? []).length, 1, "one shimmer at a time");
    assert.match(html, /class="todo-dock-header-current todo-dock-shimmer" title="second"/);
    assert.match(html, /class="todo-dock-row-content" title="second"/);
    // The marker is a glyph, not a bordered box: the completed row keeps the
    // check icon and the working row keeps the bullet, with no extra chrome.
    assert.match(html, /todo-dock-row-in_progress" role="listitem"><span class="todo-dock-row-symbol" role="img" aria-label="In progress"[^>]*>•<\/span>/);

    Object.assign(useAppStore.getInitialState(), {
      sessionTodos: {
        "session-todo-test": {
          sessionId: "session-todo-test",
          revision: 4,
          updatedAt: 101,
          todos: [
            { content: "cancelled work", status: "cancelled", priority: "low" },
          ],
        },
      },
    });
    assert.match(render(), /Cancelled/);
    assert.doesNotMatch(render(), /0\/0 completed/);
  } finally {
    await server.close();
  }
});

test("TodoDock uses a quiet disclosure animation and state surfaces", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../src/styles/composer.css", import.meta.url), "utf8");
  assert.match(css, /\.todo-dock-toggle:active:not\(:disabled\)\s*\{[\s\S]*?transform:\s*none;/);
  assert.match(css, /\.todo-dock-header-copy\s*\{[\s\S]*?flex:\s*1;[\s\S]*?align-items:\s*center;/);
  assert.match(css, /\.todo-dock-row-completed \.todo-dock-row-content\s*\{[\s\S]*?text-decoration:\s*line-through;/);
  assert.match(css, /\.todo-dock-content\s*\{[\s\S]*?grid-template-rows:\s*0fr;[\s\S]*?opacity:\s*0;/);
  assert.match(css, /\.todo-dock\.is-expanded \.todo-dock-content\s*\{[\s\S]*?grid-template-rows:\s*1fr;/);
  assert.match(css, /\.todo-dock-row\s*\{[\s\S]*?min-height:\s*24px;[\s\S]*?font-size:/);
  // The status marker is a glyph, not a bordered square: the plain list must
  // not regain per-row chrome.
  assert.match(css, /\.todo-dock-row-symbol\s*\{[^}]*display:\s*inline-flex;/);
  assert.doesNotMatch(css, /\.todo-dock-row-symbol\s*\{[^}]*border:/);
  assert.doesNotMatch(css, /\.todo-dock-row-symbol\s*\{[^}]*border-radius:/);
  assert.match(css, /\.todo-dock-row-completed\s*\{[\s\S]*?color:\s*var\(--ds-text-muted\);/);
  assert.match(css, /\.todo-dock-row-in_progress\s*\{[\s\S]*?font-weight:/);
  assert.doesNotMatch(css, /\.todo-dock-row(?:-completed|-in_progress)?\s*\{[^}]*background:/);
  // The shimmer is the only motion and it rides the text itself.
  assert.match(css, /\.todo-dock-shimmer\s*\{[\s\S]*?background-clip:\s*text;/);
  assert.match(css, /\.todo-dock-shimmer\s*\{[\s\S]*?background-size:\s*200% 100%;/);
  assert.match(css, /@keyframes todo-dock-shimmer-sweep\s*\{[\s\S]*?background-position:\s*100% 0;/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.todo-dock-shimmer\s*\{[\s\S]*?animation:\s*none;[\s\S]*?background-image:\s*none;/,
  );
  // The expanded list is the scrollport (#1319): bounded height, internal
  // scroll, no chaining into the transcript, and reachable from the keyboard.
  assert.match(
    css,
    /\.todo-dock\.is-expanded \.todo-dock-list\s*\{[\s\S]*?max-height:[\s\S]*?overflow-y:\s*auto;[\s\S]*?overscroll-behavior:\s*contain;/,
  );
  assert.match(css, /\.todo-dock-list:focus-visible\s*\{[\s\S]*?outline:/);
  assert.doesNotMatch(css, /\.todo-dock-more\s*\{/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.todo-dock-content/);
});
