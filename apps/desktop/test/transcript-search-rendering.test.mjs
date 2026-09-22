import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

test("rendered Markdown and file chips map source-only hits to their visible owner", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const originalDocument = globalThis.document;
  const originalFilter = globalThis.NodeFilter;
  try {
    const { Markdown } = await server.ssrLoadModule("/src/components/Markdown.tsx");
    const { LinkifiedText } = await server.ssrLoadModule(
      "/src/features/chat/transcript/shared.tsx",
    );
    const { SubagentPanel } = await server.ssrLoadModule(
      "/src/components/workpanel/SubagentPanel.tsx",
    );
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const { ActivityGroup } = await server.ssrLoadModule(
      "/src/features/chat/transcript/ActivityGroup.tsx",
    );
    const { TranscriptSearchContext } = await server.ssrLoadModule(
      "/src/lib/transcript-search-context.ts",
    );
    const { locateTranscriptSearch } = await server.ssrLoadModule(
      "/src/lib/transcript-search-highlight.ts",
    );
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = (component, props) =>
      renderToStaticMarkup(
        createElement(I18nextProvider, { i18n }, createElement(component, props)),
      );

    // Feed the source resolver the offsets emitted by the actual Markdown
    // renderer, including block splitting and custom inline components.
    const prefix = `${"Unrelated paragraph.\n\n".repeat(3)}${"prefix ".repeat(15_000)}\n\n`;
    for (const fixture of [
      {
        raw: "Read **needle** carefully.",
        query: "**needle**",
        owner: "**needle**",
        tag: "strong",
        visible: "needle",
        sourceOnly: true,
      },
      {
        raw: "Read **NEEDLE** carefully.",
        query: "needle",
        owner: "**NEEDLE**",
        tag: "strong",
        visible: "NEEDLE",
        sourceOnly: false,
      },
      {
        raw: "Open [guide](https://example.test/hidden-path).",
        query: "example.test/hidden-path",
        owner: "[guide](https://example.test/hidden-path)",
        tag: "a",
        visible: "guide",
        sourceOnly: true,
      },
      {
        raw: "Open `src/needle.ts` now.",
        query: "needle",
        owner: "`src/needle.ts`",
        tag: "code",
        visible: "src/needle.ts",
        sourceOnly: false,
      },
    ]) {
      const source = prefix + fixture.raw;
      const start = source.indexOf(fixture.owner);
      const end = start + fixture.owner.length;
      const html = render(Markdown, { source });
      assert.match(
        html,
        new RegExp(`<${fixture.tag}[^>]*data-source-start="${start}"[^>]*data-source-end="${end}"`),
      );
      const owner = {
        dataset: { sourceStart: String(start), sourceEnd: String(end) },
        nodes: [],
      };
      const node = { textContent: fixture.visible, parentElement: { closest: () => null } };
      owner.nodes.push(node);
      const root = { querySelectorAll: () => [owner], nodes: [] };
      globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
      globalThis.document = {
        createTreeWalker: (element, _mask, filter) => {
          const accepted = element.nodes.filter((text) => filter.acceptNode(text) === 1);
          let index = 0;
          return { nextNode: () => accepted[index++] ?? null };
        },
        createRange: () => ({
          setStart(node, offset) {
            this.startContainer = node;
            this.startOffset = offset;
          },
          setEnd(node, offset) {
            this.endContainer = node;
            this.endOffset = offset;
          },
        }),
      };
      const match = locateTranscriptSearch(root, fixture.query, source);
      if (fixture.sourceOnly) {
        assert.equal(match.sourceElement, owner, fixture.query);
        assert.equal(match.ranges.length, 0);
      } else {
        assert.equal(match.ranges.length, 1, fixture.query);
        assert.equal(match.ranges[0].startContainer, node);
        assert.equal(match.ranges[0].endOffset - match.ranges[0].startOffset, 6);
      }
    }

    const windowsSource =
      "First paragraph.\r\n\r\nRead [guide](https://example.test/hidden) now.\r\n";
    const windowsStart = windowsSource.indexOf("[guide]");
    const windowsEnd = windowsSource.indexOf(") now") + 1;
    assert.match(
      render(Markdown, { source: windowsSource }),
      new RegExp(`<a[^>]*data-source-start="${windowsStart}"[^>]*data-source-end="${windowsEnd}"`),
    );

    Object.assign(useAppStore.getInitialState(), { workspace: { path: "/workspace" } });
    const userText = "Open @src/hidden-directory/file.ts now.";
    const chipStart = userText.indexOf("@");
    const chipEnd = userText.indexOf(" now");
    const chips = render(LinkifiedText, { text: userText });
    assert.match(
      chips,
      new RegExp(
        `class="composer-chip chat-file-chip" data-source-start="${chipStart}" data-source-end="${chipEnd}"`,
      ),
    );
    assert.match(chips, /class="composer-chip-name">file.ts<\/span>/);

    const focus = { sessionId: "s", messageId: "child", query: "needle", requestId: 1 };
    const child = {
      id: "child",
      role: "assistant",
      content: "Read **needle** now.",
      parentToolCallId: "task",
      agentName: "reviewer",
    };
    const parent = {
      id: "parent-row",
      role: "tool",
      toolName: "task",
      toolCallId: "task",
      content: "",
      toolArgs: { task: "Review this" },
    };
    // Zustand's server snapshot is its initial state. Seed that snapshot only
    // inside this isolated rendering test; production state stays immutable.
    Object.assign(useAppStore.getInitialState(), {
      activeSessionId: "s",
      retainedSessionIds: ["s"],
      messages: [],
      transcriptViews: {
        s: {
          messages: [child],
          parentMessage: parent,
          messageStart: 20,
          messageEnd: 80,
          hasMoreBefore: true,
          hasMoreAfter: true,
          focus,
          loading: null,
        },
      },
    });
    const panel = render(SubagentPanel, {
      selection: { sessionId: "s", delegationId: "task", searchRequestId: 1 },
    });
    assert.match(panel, /data-message-id="child"/);
    const groupProps = { items: [{ kind: "tool", message: parent }], isActive: false };
    const group = (target) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(
            TranscriptSearchContext.Provider,
            { value: target },
            createElement(ActivityGroup, groupProps),
          ),
        ),
      );
    assert.match(group(null), /class="tool-activity-header" aria-expanded="false"/);
    assert.match(
      group({ ...focus, messageId: parent.id, query: "" }),
      /class="tool-activity-header" aria-expanded="true"/,
    );

    assert.match(panel, /<strong data-source-start="5" data-source-end="15">needle<\/strong>/);
    assert.doesNotMatch(panel, /subagent-panel-empty/);
    Object.assign(useAppStore.getInitialState(), {
      transcriptViews: {},
      messages: [parent, { ...child, content: "Updated live answer." }],
    });
    const livePanel = render(SubagentPanel, {
      selection: { sessionId: "s", delegationId: "task" },
    });
    assert.match(livePanel, /Updated live answer/);
    assert.doesNotMatch(livePanel, /Read <strong/);
  } finally {
    globalThis.document = originalDocument;
    globalThis.NodeFilter = originalFilter;
    await server.close();
  }
});
