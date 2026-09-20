import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

function loadModule(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(read(relative), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unmocked dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const calls = { pages: [], urls: [], externals: [] };
const reset = () => {
  calls.pages.length = 0;
  calls.urls.length = 0;
  calls.externals.length = 0;
};

let storeState = {};
const {
  resolveLinkOpenTarget,
  canPresentWorkPanelBrowser,
  planHttpUrlOpen,
  openHttpUrl,
} = loadModule("../src/lib/open-http-url.ts", {
  "./api": {
    api: { browserOpenExternal: (url) => calls.externals.push(url) },
  },
  "../stores/app-store": {
    useAppStore: { getState: () => storeState },
  },
});

const sessionState = (overrides = {}) => ({
  settings: { linkOpenTarget: "workpanel" },
  activeSessionId: "session-1",
  page: "chat",
  setPage: (...args) => calls.pages.push(args),
  openUrlInWorkPanel: (url) => calls.urls.push(url),
  ...overrides,
});

test("resolveLinkOpenTarget treats only external as the OS browser", () => {
  assert.equal(resolveLinkOpenTarget("external"), "external");
  assert.equal(resolveLinkOpenTarget("workpanel"), "workpanel");
  assert.equal(resolveLinkOpenTarget(undefined), "workpanel");
  assert.equal(resolveLinkOpenTarget("unknown"), "workpanel");
});

test("work-panel destination needs an active session", () => {
  assert.equal(canPresentWorkPanelBrowser({ activeSessionId: "session-1" }), true);
  assert.equal(canPresentWorkPanelBrowser({ activeSessionId: null }), false);
  assert.equal(canPresentWorkPanelBrowser({}), false);
});

test("planHttpUrlOpen ignores non-HTTP strings and trims", () => {
  assert.deepEqual(planHttpUrlOpen("file:///tmp/a", sessionState()), {
    action: "ignore",
  });
  assert.deepEqual(
    planHttpUrlOpen("  https://example.com/x  ", sessionState()),
    { action: "workpanel", url: "https://example.com/x", returnToChat: false },
  );
});

test("planHttpUrlOpen returns to chat from a covering page", () => {
  assert.deepEqual(
    planHttpUrlOpen("https://example.com", sessionState({ page: "plugins" })),
    { action: "workpanel", url: "https://example.com", returnToChat: true },
  );
  assert.deepEqual(
    planHttpUrlOpen("https://example.com", sessionState({ page: "settings" })),
    { action: "workpanel", url: "https://example.com", returnToChat: true },
  );
});

test("planHttpUrlOpen falls back to the OS browser without a session or when set external", () => {
  assert.deepEqual(
    planHttpUrlOpen("https://example.com", sessionState({ activeSessionId: null })),
    { action: "external", url: "https://example.com" },
  );
  assert.deepEqual(
    planHttpUrlOpen(
      "https://example.com",
      sessionState({ settings: { linkOpenTarget: "external" } }),
    ),
    { action: "external", url: "https://example.com" },
  );
});

test("openHttpUrl reveals chat without recording a navigation hop", () => {
  reset();
  storeState = sessionState({ page: "plugins" });
  openHttpUrl("https://example.com");
  assert.deepEqual(calls.pages, [["chat", { record: false }]]);
  assert.deepEqual(calls.urls, ["https://example.com"]);
  assert.deepEqual(calls.externals, []);
});

test("openHttpUrl stays on chat without touching the page stack", () => {
  reset();
  storeState = sessionState({ page: "chat" });
  openHttpUrl("https://example.com");
  assert.deepEqual(calls.pages, []);
  assert.deepEqual(calls.urls, ["https://example.com"]);
});

test("openHttpUrl uses the OS browser when the work panel cannot show", () => {
  reset();
  storeState = sessionState({ activeSessionId: null, page: "plugins" });
  openHttpUrl("https://example.com");
  assert.deepEqual(calls.pages, []);
  assert.deepEqual(calls.urls, []);
  assert.deepEqual(calls.externals, ["https://example.com"]);
});

const markdownSource = await readFile(
  new URL("../src/components/Markdown.tsx", import.meta.url),
  "utf8",
);
const previewSource = await readFile(
  new URL("../src/hooks/use-preview-target.ts", import.meta.url),
  "utf8",
);
const pluginSheetSource = await readFile(
  new URL("../src/features/plugins/PluginDetailSheet.tsx", import.meta.url),
  "utf8",
);
const workPanelSource = await readFile(
  new URL("../src/stores/slices/work-panel-slice.ts", import.meta.url),
  "utf8",
);

test("chat markdown HTTP clicks share openHttpUrl", () => {
  assert.match(markdownSource, /import \{ openHttpUrl \} from "\.\.\/lib\/open-http-url"/);
  assert.match(markdownSource, /openHttpUrl\(href\)/);
  assert.match(markdownSource, /openHttpUrl\(target\.url\)/);
  assert.match(markdownSource, /openHttpUrl\(source\)/);
  assert.doesNotMatch(
    markdownSource,
    /if \(linkOpenTarget === "external"\) \{\s*void api\.browserOpenExternal\(href\);/,
  );
});

test("previewable transcript URLs follow the link-open setting", () => {
  assert.match(previewSource, /import \{ openHttpUrl \} from "\.\.\/lib\/open-http-url"/);
  assert.match(
    previewSource,
    /target\.kind === "file" \? openFileRef\(target\.path\) : openHttpUrl\(target\.url\)/,
  );
});

test("plugin homepage and repository links follow the link-open setting", () => {
  assert.match(
    pluginSheetSource,
    /import \{ openHttpUrl \} from "\.\.\/\.\.\/lib\/open-http-url"/,
  );
  assert.match(pluginSheetSource, /openHttpUrl\(link\.url\)/);
  assert.match(pluginSheetSource, /openHttpUrl\(activeVersion\.provenance!\.sourceRepository\)/);
  assert.doesNotMatch(pluginSheetSource, /openUrlInWorkPanel\(/);
});

test("forced work-panel preview does not read linkOpenTarget", () => {
  assert.doesNotMatch(workPanelSource, /linkOpenTarget/);
});
