import { readTranscriptSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { intersectSelectionQuoteRect } from "../src/lib/selection-quote.ts";

const source = await readFile(new URL("../src/components/ResponseAnnotationOverlay.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

test("the floating index collapses, expands, navigates by id and edits/removes the same numbered item", () => {
  const annotations = [{ id: "a1", messageId: "m1", text: "first", annotation: "comment" },
    { id: "a2", messageId: "m2", text: "second", annotation: "" }];
  let edited, removed, navigated, cleared = false;
  const state = { responseAnnotations: { s: annotations },
    openResponseAnnotationEditor: (value) => { edited = value; },
    removeResponseAnnotation: (id) => { removed = id; },
    clearResponseAnnotations: () => { cleared = true; },
  };
  const hooks = [];
  let cursor = 0;
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: { useEffect() {}, useLayoutEffect() {}, useRef: () => ({ current: null }),
      useState: (initial) => { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], (value) => { hooks[i] = typeof value === "function" ? value(hooks[i]) : value; }]; },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "react-dom": { createPortal: (node) => node },
    "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
    "../stores/app-store": { useAppStore: (select) => select(state) },
    "../lib/response-annotation-anchor": {}, "../lib/selection-quote": {},
    "./icons": {}, "./ui": { TooltipButton: "button" },
  };
  const exports = {};
  runInNewContext(compiled, { exports, require: (id) => { assert.ok(id in modules, id); return modules[id]; }, document: { body: {} } });
  let tree;
  const render = () => { cursor = 0; tree = exports.ResponseAnnotationOverlay({ sessionId: "s", scrollRef: { current: null }, onNavigate: (annotation) => { navigated = annotation; } }); };
  const nodes = (node) => !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
  const find = (predicate) => nodes(tree).find(predicate);
  render();
  assert.ok(find((node) => node.type === "aside"));
  assert.equal(find((node) => node.props["aria-expanded"] !== undefined).props["aria-expanded"], true);
  find((node) => node.props["aria-expanded"] !== undefined).props.onClick();
  render();
  assert.ok(!find((node) => node.type === "ol"));
  find((node) => node.props["aria-expanded"] !== undefined).props.onClick();
  render();
  find((node) => node.props["aria-label"] === "chat.annotationLocate 2").props.onClick();
  assert.equal(navigated, annotations[1]);
  find((node) => node.props.ariaLabel === "chat.annotationEdit 2").props.onClick();
  assert.equal(edited.annotationId, "a2");
  find((node) => node.props.ariaLabel === "chat.annotationRemove 1").props.onClick();
  assert.equal(removed, "a1");
  find((node) => node.props.ariaLabel === "chat.clearAnnotations").props.onClick();
  assert.equal(cleared, true);
  // Geometry belongs to the previous layout until the layout effect runs. A
  // removal must not dereference an old array index or display the wrong number.
  hooks[2] = { badges: [
    { id: "a1", index: 1, top: 10, left: 10, exact: true },
    { id: "a2", index: 2, top: 40, left: 10, exact: true },
  ], highlights: [] };
  state.responseAnnotations.s = [annotations[1]];
  render();
  const badges = nodes(tree).filter((node) => node.props.className?.startsWith("response-annotation-source-badge"));
  assert.equal(badges.length, 1);
  assert.equal(badges[0].props.children, 1);
  assert.equal(badges[0].props.title, "second");
  state.responseAnnotations.s = [];
  render();
  assert.equal(tree, null);
});

test("all saved resolved ranges stay highlighted without selecting an item or expanding the index", () => {
  const ast = ts.createSourceFile("overlay.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useLayoutEffect") {
      effect = node.arguments[0].getText(ast);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(effect, "exercise the real layout effect, not a copied implementation");
  const executable = ts.transpileModule(`(${effect})();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const rect = (top) => ({ top, bottom: top + 20, left: 20, right: 80, width: 60, height: 20 });
  const saved = [{ id: "a1", messageId: "m1", anchor: [rect(20)] },
    { id: "a2", messageId: "m2", anchor: [rect(60)] },
    { id: "stale", messageId: "m3" }];
  for (const [annotations, activeId, expanded, expected] of [
    [saved, null, true, [20, 60]],
    [saved, "a1", true, [20, 60]],
    [saved, "a2", false, [20, 60]],
    [saved.slice(1), null, false, [60]],
    [[], null, false, []],
  ]) {
    let geometry;
    const root = { addEventListener() {}, removeEventListener() {} };
    class Observer { observe() {} disconnect() {} }
    const cleanup = runInNewContext(executable, {
      annotations, activeId, expanded, scrollRef: { current: root },
      setGeometry: (value) => { geometry = value; },
      document: { querySelector: () => null },
      window: { innerWidth: 100, innerHeight: 100, addEventListener() {}, removeEventListener() {} },
      COMPOSER_DOCK_SELECTOR: "dock",
      selectionQuoteBounds: () => ({ top: 0, bottom: 100, left: 0, right: 100 }),
      annotationRow: () => ({ getBoundingClientRect: () => rect(0) }),
      annotationRange: (_, anchor) => anchor ? { getClientRects: () => anchor } : null,
      intersectSelectionQuoteRect,
      placeAnnotationBadges: (badges) => badges,
      ResizeObserver: Observer, MutationObserver: Observer, cancelAnimationFrame() {},
    });
    assert.deepEqual(Array.from(geometry.highlights, (item) => item.top), expected);
    cleanup?.();
  }
});

test("only the visible writable pane owns badges and navigation releases follow mode", async () => {
  const transcript = await readTranscriptSource();
  assert.match(transcript, /!transcriptReadOnly && paneVisible && !veilCovering && sessionId/);
  assert.match(transcript, /const navigateAnnotation[\s\S]*?pinnedRef\.current = false/);
  assert.match(transcript, /requestAnimationFrame\(\(\) => setWindowSize\(\(size\) =>\s*Math\.min\(Math\.max\(size, allHistoryEntries\.length - index\),\s*growTranscriptWindow\(size, allHistoryEntries\.length\)\)\)/);
  assert.match(transcript, /annotationPagesRef\.current\.has\(messages\.length\)/);
  assert.match(source, /root\.addEventListener\("scroll", schedule/);
  assert.match(source, /mutation\.disconnect\(\)/);
});
