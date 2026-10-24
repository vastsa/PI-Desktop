/**
 * Behavior of the inline-visualization host runtime: guest message parsing,
 * the error / ready / key channel, theme re-post diffing, streaming reference
 * hiding, the live-frame eviction policy, and which URL a card loads.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { catalogs } from "@pi-desktop/i18n";
import { slotSsr } from "./helpers/slot-ssr.mjs";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const SESSION = "sess_owner";
const FORKED_FROM = "sess_parent";
const VIS_PATH = `/Users/me/.pi-desktop/visualizations/${FORKED_FROM}/chart.html`;

test("error, key, and ready messages are honored only from the card's own frame", async (t) => {
  const ssr = await slotSsr(t);
  const { genUiErrorFromMessage, genUiKeyFromMessage, isGenUiReadyMessage } = await ssr.load(
    "/src/features/chat/gen-ui/gen-ui-frames.ts",
  );
  const own = {};
  const other = {};
  const event = (data, source = own) => ({ source, data });

  assert.equal(genUiErrorFromMessage(event({ type: "pi-genui:error", code: "not-found" }), own), "not-found");
  assert.equal(genUiErrorFromMessage(event({ type: "pi-genui:error", code: "too-large" }), own), "too-large");
  assert.equal(genUiErrorFromMessage(event({ type: "pi-genui:error", code: "not-found" }, other), own), null);
  assert.equal(genUiErrorFromMessage(event({ type: "pi-genui:error", code: "not-found" }), null), null);
  assert.equal(genUiErrorFromMessage(event({ type: "pi-genui:error", code: "/etc/passwd" }), own), null);
  assert.equal(genUiErrorFromMessage(event({ type: "pi-genui:size", code: "not-found" }), own), null);
  assert.equal(genUiErrorFromMessage(event("pi-genui:error"), own), null);

  assert.equal(genUiKeyFromMessage(event({ type: "pi-genui:key", key: "Escape" }), own), "Escape");
  assert.equal(genUiKeyFromMessage(event({ type: "pi-genui:key", key: "Escape" }, other), own), null);
  assert.equal(genUiKeyFromMessage(event({ type: "pi-genui:key", key: "Enter" }), own), null);
  assert.equal(genUiKeyFromMessage(event({ type: "pi-genui:error", key: "Escape" }), own), null);

  assert.equal(isGenUiReadyMessage(event({ type: "pi-genui:ready" }), own), true);
  assert.equal(isGenUiReadyMessage(event({ type: "pi-genui:ready" }, other), own), false);
  assert.equal(isGenUiReadyMessage(event({ type: "pi-genui:ready" }), null), false);
  assert.equal(isGenUiReadyMessage(event({ type: "pi-genui:size" }), own), false);
});

test("the error shell reports a code and never echoes caller text", async () => {
  const { buildGenUiErrorDocument } = await import("../electron/main/gen-ui-document.ts");
  for (const code of ["not-found", "too-large", "not-fragment", "runtime-unavailable"]) {
    const html = buildGenUiErrorDocument(code);
    assert.match(html, new RegExp(`"type":"pi-genui:error","code":"${code}"`), code);
    // English fallback content stays in case the host cannot localize.
    assert.match(html, /<p[^>]*>Visualization[^<]+<\/p>/, code);
  }
  assert.match(buildGenUiErrorDocument("not-found"), />Visualization not found\.</);
  // An unknown code (e.g. a caller passing a message) degrades to not-found.
  const unknown = buildGenUiErrorDocument("<b>x</b>");
  assert.doesNotMatch(unknown, /<b>x<\/b>|&lt;b&gt;/);
  assert.match(unknown, /"code":"not-found"/);
});

test("the guest runtime announces readiness and forwards only Escape", async () => {
  const { buildGenUiDocument } = await import("../electron/main/gen-ui-document.ts");
  const html = buildGenUiDocument("<p>hi</p>", { kit: { css: "", head: "", runtime: "", vendorUrls: new Map() } });
  const head = html.slice(0, html.indexOf("</head>"));
  assert.match(head, /const READY = "pi-genui:ready"/);
  assert.match(head, /parent\.postMessage\(\{ type: READY \}, "\*"\)/);
  assert.match(head, /const KEY = "pi-genui:key"/);
  assert.match(head, /event\.key !== "Escape"/);
  assert.match(head, /parent\.postMessage\(\{ type: KEY, key: "Escape" \}, "\*"\)/);
});

test("theme changes notify frames only when resolved values change", async (t) => {
  const ssr = await slotSsr(t);
  const { createGenUiThemeChannel } = await ssr.load("/src/features/chat/gen-ui/gen-ui-theme.ts");
  let theme = { vars: { "--color-text-primary": "#fff" }, colorScheme: "dark" };
  let reads = 0;
  let mutate = null;
  let observing = 0;
  const channel = createGenUiThemeChannel(
    () => {
      reads += 1;
      return { vars: { ...theme.vars }, colorScheme: theme.colorScheme };
    },
    (onMutation) => {
      observing += 1;
      mutate = onMutation;
      return () => {
        observing -= 1;
        mutate = null;
      };
    },
  );
  const seen = [[], []];
  const off0 = channel.subscribe((payload) => seen[0].push(payload));
  const off1 = channel.subscribe((payload) => seen[1].push(payload));
  assert.equal(observing, 1, "one shared observer");

  // A style rewrite that changes no token (e.g. composer resize) posts nothing.
  const before = reads;
  mutate();
  mutate();
  assert.deepEqual(seen, [[], []]);
  assert.equal(reads - before, 2, "resolved once per mutation, not once per frame");

  theme = { vars: { "--color-text-primary": "#000" }, colorScheme: "light" };
  mutate();
  assert.equal(seen[0].length, 1);
  assert.deepEqual(seen[0][0], theme);
  assert.deepEqual(seen[1], seen[0]);
  mutate();
  assert.equal(seen[0].length, 1);
  assert.deepEqual(channel.current(), theme);

  off0();
  off1();
  assert.equal(observing, 0, "observer released with the last subscriber");
});

test("a streaming reply hides a trailing reference line, even a partial one", async (t) => {
  const ssr = await slotSsr(t);
  const { genUiSplitFor, hideStreamingGenUiReference } = await ssr.load(
    "/src/features/chat/gen-ui/gen-ui-split.ts",
  );
  const body = "Here is the chart.\n\n";
  for (const tail of [":", "::", "::vis", "::visualize", '::visualize{"path":"/Users/me/x', "  ::visualize{}"]) {
    assert.equal(hideStreamingGenUiReference(`${body}${tail}`), "Here is the chart.", tail);
    assert.equal(genUiSplitFor(`${body}${tail}`, true).content, "Here is the chart.", tail);
    assert.deepEqual(genUiSplitFor(`${body}${tail}`, true).references, []);
  }
  assert.equal(hideStreamingGenUiReference(`${body}::visualize{}\n`), "Here is the chart.");
  assert.equal(hideStreamingGenUiReference("::vis"), "");
  for (const content of [`${body}Done.`, `${body}::other`, `${body}a ::visualize`, "x\n::visualizer", "plain"]) {
    assert.equal(hideStreamingGenUiReference(content), content, content);
  }
});

test("eviction prefers off-screen frames and only then the oldest", async (t) => {
  const ssr = await slotSsr(t);
  const { createGenUiFramePool, GEN_UI_MAX_LIVE_FRAMES } = await ssr.load(
    "/src/features/chat/gen-ui/gen-ui-frames.ts",
  );
  assert.equal(GEN_UI_MAX_LIVE_FRAMES, 8);
  const pool = createGenUiFramePool(2);
  const evicted = [];
  const [a, b, c, d] = [Symbol("a"), Symbol("b"), Symbol("c"), Symbol("d")];
  pool.acquire(a, () => evicted.push("a"), true);
  pool.acquire(b, () => evicted.push("b"), true);
  pool.setVisible(b, false);
  pool.acquire(c, () => evicted.push("c"), true);
  assert.deepEqual(evicted, ["b"], "the off-screen frame goes before the older visible one");
  // An off-screen newcomer does not push out frames the reader is looking at.
  pool.acquire(d, () => evicted.push("d"), false);
  assert.deepEqual(evicted, ["b", "d"]);
  assert.equal(pool.size, 2);
  pool.release(a);
  assert.equal(pool.size, 1);
});

test("a card releases its frame off-screen and reloads on re-entry", async (t) => {
  const ssr = await slotSsr(t);
  const { genUiViewportReducer, GEN_UI_VIEWPORT_INITIAL, isGenUiViewportLive } = await ssr.load(
    "/src/features/chat/gen-ui/gen-ui-viewport.ts",
  );
  let state = GEN_UI_VIEWPORT_INITIAL;
  const step = (event) => {
    state = genUiViewportReducer(state, event);
    return isGenUiViewportLive(state);
  };
  assert.equal(isGenUiViewportLive(state), false);
  assert.equal(step({ type: "near", value: true }), true);
  assert.equal(step({ type: "visible", value: true }), true);
  assert.equal(step({ type: "evict" }), false, "evicted while on screen shows the load prompt");
  assert.equal(step({ type: "load" }), true, "manual load");
  assert.equal(step({ type: "evict" }), false);
  assert.equal(step({ type: "visible", value: true }), false, "no reload storm while it stays visible");
  assert.equal(step({ type: "visible", value: false }), false);
  assert.equal(step({ type: "visible", value: true }), true, "scrolling back into view reloads");
  assert.equal(step({ type: "evict" }), false);
  assert.equal(step({ type: "near", value: false }), false, "leaving releases the slot");
  assert.equal(state.evicted, false);
  assert.equal(step({ type: "near", value: true }), true, "re-entry reloads without a click");
});

test("cards load the owning session's copy and refuse remote sessions", async (t) => {
  const ssr = await slotSsr(t);
  const { genUiCardSource } = await ssr.load("/src/features/chat/gen-ui/gen-ui-source.ts");
  const reference = { path: VIS_PATH, title: "Growth", location: { sessionId: FORKED_FROM, fileName: "chart.html" } };
  assert.deepEqual(genUiCardSource(reference, { sessionId: SESSION, remote: false }), {
    kind: "live",
    url: `pi-genui://session/${SESSION}/chart.html`,
  });
  assert.deepEqual(genUiCardSource(reference, { sessionId: SESSION, remote: true }), {
    kind: "unavailable",
    reason: "remote",
  });
  assert.deepEqual(genUiCardSource({ path: "/tmp/x.html", location: null }, { sessionId: SESSION, remote: false }), {
    kind: "unavailable",
    reason: "outside",
  });
  assert.deepEqual(genUiCardSource(reference, { sessionId: "", remote: false }), {
    kind: "unavailable",
    reason: "outside",
  });
  assert.deepEqual(genUiCardSource(reference, { sessionId: "native-pi:abc", remote: false }), {
    kind: "unavailable",
    reason: "outside",
  });
});

test("a remote session renders the localized unavailable card without a frame", async (t) => {
  const ssr = await slotSsr(t);
  const { GenUiCards } = await ssr.load("/src/features/chat/gen-ui/GenUiCard.tsx");
  const html = ssr.render(
    createElement(GenUiCards, {
      references: [{ path: VIS_PATH, title: "Growth", location: { sessionId: FORKED_FROM, fileName: "chart.html" } }],
      sessionId: SESSION,
      remote: true,
    }),
  );
  assert.match(html, /gen-ui-card is-unavailable/);
  assert.match(html, new RegExp(catalogs.en.chat.genUi.unavailableRemote.replace("'", "&#x27;")));
  assert.doesNotMatch(html, /<iframe|data-gen-ui-url/);

  const live = ssr.render(
    createElement(GenUiCards, {
      references: [{ path: VIS_PATH, title: "Growth", location: { sessionId: FORKED_FROM, fileName: "chart.html" } }],
      sessionId: SESSION,
      remote: false,
    }),
  );
  assert.match(live, new RegExp(`data-gen-ui-url="pi-genui://session/${SESSION}/chart\\.html"`));
});

test("every locale has a reason for each unavailable state", () => {
  const keys = [
    "unavailableRemote",
    "unavailableNotFound",
    "unavailableTooLarge",
    "unavailableNotFragment",
    "unavailableRuntime",
  ];
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const key of keys) {
      const value = catalog.chat?.genUi?.[key];
      assert.equal(typeof value, "string", `${locale} chat.genUi.${key}`);
      assert.ok(value.trim(), `${locale} chat.genUi.${key}`);
    }
  }
});

test("the expanded dialog traps Tab and closes on the guest's Escape", async (t) => {
  const ssr = await slotSsr(t);
  const { genUiDialogTabTarget } = await ssr.load("/src/features/chat/gen-ui/GenUiDialog.tsx");
  const [first, middle, last] = [{ id: "first" }, { id: "middle" }, { id: "last" }];
  const focusable = [first, middle, last];
  assert.equal(genUiDialogTabTarget(focusable, last, false), first);
  assert.equal(genUiDialogTabTarget(focusable, first, true), last);
  assert.equal(genUiDialogTabTarget(focusable, middle, false), null);
  assert.equal(genUiDialogTabTarget(focusable, { id: "outside" }, false), first);
  assert.equal(genUiDialogTabTarget([], first, false), null);
});
