import assert from "node:assert/strict";
import test from "node:test";
import {
  fileDirOf,
  getToolPreviewTarget,
  isHttpUrl,
  linkifyMdastTree,
  parseFileRef,
  remarkChatFileLinks,
  resolvePreviewTarget,
  splitChatText,
  toWorkspaceRel,
} from "../src/lib/chat-links.ts";

const ROOT = "/Users/dev/project";

test("parseFileRef accepts pathy tokens and strips line refs", () => {
  assert.equal(parseFileRef("apps/desktop/src/App.tsx"), "apps/desktop/src/App.tsx");
  assert.equal(parseFileRef("src/main.rs:42"), "src/main.rs");
  assert.equal(parseFileRef("src/main.rs:42:7"), "src/main.rs");
  assert.equal(parseFileRef("./scripts/build.sh"), "./scripts/build.sh");
  assert.equal(parseFileRef("/abs/path/file.ts"), "/abs/path/file.ts");
  assert.equal(parseFileRef("docs/Makefile"), "docs/Makefile");
  assert.equal(parseFileRef("./README.md"), "./README.md");
  assert.equal(parseFileRef("../adr/0163.md"), "../adr/0163.md");
});

test("parseFileRef accepts bare names only with known extensions", () => {
  assert.equal(parseFileRef("README.md"), "README.md");
  assert.equal(parseFileRef("package.json"), "package.json");
  assert.equal(parseFileRef("Makefile"), "Makefile");
  // dotted identifiers in prose stay plain
  assert.equal(parseFileRef("store.messages"), null);
  assert.equal(parseFileRef("useAppStore.getState"), null);
  assert.equal(parseFileRef("i.e."), null);
});

test("parseFileRef rejects non-path text", () => {
  assert.equal(parseFileRef("hello world"), null);
  assert.equal(parseFileRef("a/b vs c/d"), null);
  assert.equal(parseFileRef("path/to/dir"), null);
  assert.equal(parseFileRef("foo.bar()"), null);
});

test("toWorkspaceRel maps absolute paths under the root and rejects escapes", () => {
  assert.equal(toWorkspaceRel(`${ROOT}/src/a.ts`, ROOT), "src/a.ts");
  assert.equal(toWorkspaceRel("/elsewhere/a.ts", ROOT), null);
  assert.equal(toWorkspaceRel(ROOT, ROOT), null);
  assert.equal(toWorkspaceRel("src/a.ts", ROOT), "src/a.ts");
  assert.equal(toWorkspaceRel("./src/a.ts", ROOT), "src/a.ts");
  assert.equal(toWorkspaceRel("../outside.ts", ROOT), null);
  assert.equal(toWorkspaceRel("~/anything.ts", ROOT), null);
  assert.equal(toWorkspaceRel("apps/../docs/foo.md", ROOT), "docs/foo.md");
});

test("toWorkspaceRel resolves ./ and ../ against a markdown file directory", () => {
  assert.equal(
    toWorkspaceRel("./0163.md", ROOT, "docs/adr"),
    "docs/adr/0163.md",
  );
  assert.equal(
    toWorkspaceRel("../spec/00-baseline.md", ROOT, "docs/adr"),
    "docs/spec/00-baseline.md",
  );
  assert.equal(
    toWorkspaceRel("../../outside.ts", ROOT, "docs/adr"),
    "outside.ts",
  );
  assert.equal(
    toWorkspaceRel("../../../outside.ts", ROOT, "docs/adr"),
    null,
  );
  // Unprefixed paths stay workspace-rooted even when a file base exists.
  assert.equal(
    toWorkspaceRel("apps/desktop/src/App.tsx", ROOT, "docs/adr"),
    "apps/desktop/src/App.tsx",
  );
});

test("fileDirOf returns the parent of a workspace-relative path", () => {
  assert.equal(fileDirOf("docs/adr/0163.md"), "docs/adr");
  assert.equal(fileDirOf("README.md"), "");
  assert.equal(fileDirOf("src/main.rs"), "src");
});

test("resolvePreviewTarget classifies urls and workspace files", () => {
  assert.deepEqual(resolvePreviewTarget("https://example.com/docs", ROOT), {
    kind: "url",
    url: "https://example.com/docs",
  });
  assert.deepEqual(resolvePreviewTarget("src/a.ts:10", ROOT), {
    kind: "file",
    path: "src/a.ts",
  });
  assert.deepEqual(resolvePreviewTarget("./README.md", ROOT, "docs"), {
    kind: "file",
    path: "docs/README.md",
  });
  assert.deepEqual(resolvePreviewTarget(`${ROOT}/src/a.ts`, ROOT), {
    kind: "file",
    path: "src/a.ts",
  });
  assert.equal(resolvePreviewTarget("/outside/root.ts", ROOT), null);
  assert.equal(isHttpUrl("ftp://example.com"), false);
});

test("getToolPreviewTarget reads path-like args and fetch urls", () => {
  assert.deepEqual(
    getToolPreviewTarget({ path: `${ROOT}/src/a.ts` }, ROOT),
    { kind: "file", path: "src/a.ts" },
  );
  assert.deepEqual(
    getToolPreviewTarget({ file_path: "src/b.ts" }, ROOT),
    { kind: "file", path: "src/b.ts" },
  );
  assert.equal(getToolPreviewTarget({ path: "/outside/a.ts" }, ROOT), null);
  assert.deepEqual(
    getToolPreviewTarget({ url: "https://example.com" }, ROOT),
    { kind: "url", url: "https://example.com" },
  );
  assert.equal(getToolPreviewTarget({ command: "ls" }, ROOT), null);
});

test("splitChatText linkifies embedded refs and keeps literals", () => {
  const segments = splitChatText(
    "看看 apps/desktop/src/App.tsx 和 https://example.com 吧",
    ROOT,
  );
  assert.deepEqual(
    segments.map((s) => s.kind),
    ["text", "target", "text", "target", "text"],
  );
  assert.deepEqual(segments[1].target, {
    kind: "file",
    path: "apps/desktop/src/App.tsx",
  });
  assert.equal(segments[1].label, "App.tsx");
  assert.deepEqual(segments[3].target, {
    kind: "url",
    url: "https://example.com",
  });
  // text with no refs comes back as one literal run
  assert.deepEqual(splitChatText("普通文本，没有链接。", ROOT), [
    { kind: "text", text: "普通文本，没有链接。" },
  ]);
});

test("splitChatText resolves ./ files against the markdown base directory", () => {
  const segments = splitChatText("see ./0163.md and ../spec/foo.md", ROOT, "docs/adr");
  const files = segments.filter((s) => s.kind === "target" && s.target.kind === "file");
  assert.equal(files.length, 2);
  assert.deepEqual(files[0].target, { kind: "file", path: "docs/adr/0163.md" });
  assert.deepEqual(files[1].target, { kind: "file", path: "docs/spec/foo.md" });
});

test("splitChatText turns composer @paths into leaf-name chips", () => {
  const segments = splitChatText(
    'inspect @apps/desktop/src/App.tsx and @"my file.md" plus @/tmp/scratch/pasted/uuid-photo.png',
    ROOT,
  );
  const files = segments.filter((s) => s.kind === "target" && s.target.kind === "file");
  assert.equal(files.length, 3);
  assert.deepEqual(files[0].target, { kind: "file", path: "apps/desktop/src/App.tsx" });
  assert.equal(files[0].label, "App.tsx");
  assert.deepEqual(files[1].target, { kind: "file", path: "my file.md" });
  assert.equal(files[1].label, "my file.md");
  assert.deepEqual(files[2].target, {
    kind: "file",
    path: "/tmp/scratch/pasted/uuid-photo.png",
  });
  assert.equal(files[2].label, "uuid-photo.png");
});

test("linkifyMdastTree turns bare paths into links and skips code", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [{ type: "text", value: "See apps/desktop/src/App.tsx please" }],
      },
      { type: "inlineCode", value: "apps/desktop/src/App.tsx" },
      {
        type: "link",
        url: "https://example.com",
        children: [{ type: "text", value: "apps/desktop/src/App.tsx" }],
      },
    ],
  };
  linkifyMdastTree(tree, ROOT);
  assert.equal(tree.children[0].children[1].type, "link");
  assert.equal(tree.children[0].children[1].url, "apps/desktop/src/App.tsx");
  assert.equal(tree.children[1].type, "inlineCode");
  assert.equal(tree.children[2].children[0].type, "text");
});

test("linkifyMdastTree ignores a missing tree instead of reading type", () => {
  assert.doesNotThrow(() => linkifyMdastTree(undefined, ROOT));
  assert.doesNotThrow(() =>
    linkifyMdastTree({ type: "root", children: [undefined] }, ROOT),
  );
});

test("remarkChatFileLinks is a unified attacher, not a transformer", () => {
  const plugin = remarkChatFileLinks(ROOT);
  // unified.use(plugin) calls plugin() at freeze with no tree.
  const transformer = plugin();
  assert.equal(typeof transformer, "function");
  const tree = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [{ type: "text", value: "See apps/desktop/src/App.tsx" }],
      },
    ],
  };
  transformer(tree);
  assert.equal(tree.children[0].children[1].type, "link");
  assert.equal(tree.children[0].children[1].url, "apps/desktop/src/App.tsx");
});

test("parseFileRef accepts unicode filenames and home paths", () => {
  assert.equal(parseFileRef("报告.pdf"), "报告.pdf");
  assert.equal(parseFileRef("docs/规范/架构.md"), "docs/规范/架构.md");
  assert.equal(parseFileRef("src/报告.ts:42"), "src/报告.ts");
  assert.equal(parseFileRef("~/Downloads/x.png"), "~/Downloads/x.png");
});

test("splitChatText linkifies workspace unicode filenames", () => {
  const segments = splitChatText("先看 报告.pdf，再看 docs/规范/架构.md", ROOT);
  assert.deepEqual(
    segments
      .filter((s) => s.kind === "target" && s.target.kind === "file")
      .map((s) => s.target.path),
    ["报告.pdf", "docs/规范/架构.md"],
  );
});

test("splitChatText resolves a unicode absolute path under the root", () => {
  const segments = splitChatText(`see ${ROOT}/src/报告.md please`, ROOT);
  assert.deepEqual(
    segments
      .filter((s) => s.kind === "target" && s.target.kind === "file")
      .map((s) => s.target.path),
    ["src/报告.md"],
  );
});

test("splitChatText leaves outside absolute and home paths as plain text", () => {
  // #235: the scanner used to drop the leading "/" (or "~") and chip the
  // suffix as a workspace-relative path that could never open.
  const outside = splitChatText(
    "see /elsewhere/a.ts and ~/Downloads/x.png here",
    ROOT,
  );
  assert.deepEqual(outside, [
    { kind: "text", text: "see /elsewhere/a.ts and ~/Downloads/x.png here" },
  ]);
});

test("splitChatText keeps unknown extensions literal", () => {
  assert.deepEqual(splitChatText("安装包.dmg 在下载目录", ROOT), [
    { kind: "text", text: "安装包.dmg 在下载目录" },
  ]);
});

test("an ascii filename followed by cjk prose still linkifies", () => {
  const segments = splitChatText("打开 App.tsx文件 看看", ROOT);
  assert.deepEqual(
    segments
      .filter((s) => s.kind === "target" && s.target.kind === "file")
      .map((s) => s.target.path),
    ["App.tsx"],
  );
});


test("splitChatText preserves parentheses inside HTTP URLs", () => {
  for (const url of [
    "https://en.wikipedia.org/wiki/React_(software)",
    "https://example.com/a_(b_(c))/details?q=(one)&next=two#part(3)",
    "https://example.com/React_%28software%29",
  ]) {
    const segments = splitChatText(url, ROOT);
    assert.equal(segments.length, 1);
    assert.deepEqual(segments[0].target, { kind: "url", url });
    assert.equal(segments[0].text, url);
  }
});

test("splitChatText keeps prose closing parentheses outside URL links", () => {
  for (const url of ["https://example.com", "https://en.wikipedia.org/wiki/React_(software)"]) {
    for (const suffix of [")", ")).", "), next"]) {
      const source = `See (${url}${suffix}`;
      const segments = splitChatText(source, ROOT);
      assert.deepEqual(segments.filter(s => s.kind === "target").map(s => s.target), [{ kind: "url", url }]);
      assert.equal(segments.map(s => s.text).join(""), source);
      assert.equal(segments.at(-1).text, suffix);
    }
  }
});

test("markdown bare-link rewriting preserves parenthesized URL destinations", () => {
  const url = "https://en.wikipedia.org/wiki/React_(software)";
  const tree = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: `See (${url}).` }] }] };
  linkifyMdastTree(tree, ROOT);
  const nodes = tree.children[0].children;
  assert.equal(nodes.find(node => node.type === "link").url, url);
  assert.equal(nodes.at(-1).value, ").");
});


test("a prose wrapper does not swallow the next URL or file reference", () => {
  const source = "(https://example.com)src/a.ts (https://example.org)https://example.net";
  const segments = splitChatText(source, ROOT);
  assert.deepEqual(segments.filter(s => s.kind === "target").map(s => s.target), [
    { kind: "url", url: "https://example.com" },
    { kind: "file", path: "src/a.ts" },
    { kind: "url", url: "https://example.org" },
    { kind: "url", url: "https://example.net" },
  ]);
  assert.equal(segments.map(s => s.text).join(""), source);
});


test("sentence punctuation after URLs stays outside the link", () => {
  for (const url of [
    "https://example.com",
    "https://en.wikipedia.org/wiki/React_(software)",
    "https://example.com/report_(draft).html?q=(one)#part(2)",
  ]) {
    for (const suffix of [".", ",", "!", "?", ";", ":", "。", "，", "！", "？", "..."]) {
      const source = `See ${url}${suffix}`;
      const segments = splitChatText(source, ROOT);
      assert.equal(segments.find(s => s.kind === "target").target.url, url);
      assert.equal(segments.at(-1).text, suffix);
      assert.equal(segments.map(s => s.text).join(""), source);
    }
  }
  assert.equal(
    splitChatText("See https://example.com/report_(draft).html, next", ROOT)[1].target.url,
    "https://example.com/report_(draft).html",
  );
});

test("adjacent parenthesis-wrapped URLs all remain independently linkable", () => {
  const source = "(https://example.com)".repeat(1000);
  const segments = splitChatText(source, ROOT);
  assert.equal(segments.filter(s => s.kind === "target").length, 1000);
  assert.equal(segments.map(s => s.text).join(""), source);
});
