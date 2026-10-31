import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const tool = (id, offsetSeconds, extra = {}) => ({
  kind: "tool",
  message: {
    id,
    role: "tool",
    content: "",
    toolName: "Read",
    createdAt: `2026-09-17T00:00:${String(offsetSeconds).padStart(2, "0")}.000Z`,
    ...extra,
  },
});

const answer = {
  kind: "message",
  message: {
    id: "answer",
    role: "assistant",
    content: "Done",
    status: "complete",
    createdAt: "2026-09-17T00:00:08.000Z",
  },
};

test("the top-level header keeps only status, duration, tool count and an inline caret", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { TurnProcess } = await server.ssrLoadModule(
      "/src/features/chat/transcript/TurnProcess.tsx",
    );
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = (props, children = "process body") =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(TurnProcess, {
            ...props,
            children: createElement("span", null, children),
          }),
        ),
      );

    const tools = Array.from({ length: 12 }, (_, index) =>
      tool(`tool-${index}`, index === 11 ? 7 : 0),
    );
    const processParts = [{ kind: "activity", items: tools }];
    const turnParts = [...processParts, answer];
    const html = render({
      turnId: "turn",
      processParts,
      turnParts,
      visibleSteps: 13,
      isActive: false,
      failed: false,
    });

    assert.match(html, /class="tool-activity-label">Finished</);
    assert.match(html, />8s</);
    assert.match(html, />12 tools</);
    assert.doesNotMatch(html, /issue|turn-process-error|activityFailures/i);
    assert.ok(
      html.indexOf("Finished") < html.indexOf("8s") &&
        html.indexOf("8s") < html.indexOf("12 tools") &&
        html.indexOf("12 tools") < html.indexOf("tool-activity-caret"),
      "status, duration, tool count and the caret must stay in that order",
    );
    assert.match(html, /aria-expanded="false"/);

    // A turn with recorded issues still names only its failed status: the issue
    // count no longer has a place in the top-level header.
    const failedTools = [
      tool("denied", 0, { toolStatus: "denied" }),
      ...Array.from({ length: 8 }, (_, index) => tool(`failed-tool-${index}`, index)),
    ];
    const failedParts = [{ kind: "activity", items: failedTools }];
    const failedHtml = render({
      turnId: "failed-turn",
      processParts: failedParts,
      turnParts: [...failedParts, answer],
      visibleSteps: 10,
      isActive: false,
      failed: true,
    });

    assert.match(failedHtml, />Failed</);
    assert.match(failedHtml, />9 tools</);
    assert.doesNotMatch(
      failedHtml,
      /issue|问题|turn-process-error|activityFailures/i,
    );
  } finally {
    await server.close();
  }
});
