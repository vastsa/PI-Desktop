import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
  fileDirOf,
  getToolPreviewTarget,
  handleMarkdownFileLinkClick,
  isHttpUrl,
  linkifyMdastTree,
  parseFileRef,
  parseFileRefPosition,
  remarkChatFileLinks,
  resolvePreviewTarget,
  splitChatText,
  toWorkspaceRel,
} from "../src/lib/chat-links.ts";

const ROOT = "/Users/dev/project";

function renderSanitizedMarkdown(source, root = "D:\\person") {
  return renderToStaticMarkup(
    React.createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkChatFileLinks(root)],
      rehypePlugins: [rehypeRaw, rehypeSanitize],
      children: source,
    }),
  );
}

function assertMarkdownLinkClick(markup, expectedPath) {
  const href = markup.match(/<a href="([^"]+)"/)?.[1];
  assert.ok(href, `rendered Markdown link has no href: ${markup}`);
  const calls = [];
  let prevented = false;
  const handled = handleMarkdownFileLinkClick(
    { preventDefault: () => { prevented = true; } },
    href,
    "D:\\person",
    undefined,
    (...args) => calls.push(args),
  );
  assert.equal(handled, true);
  assert.equal(prevented, true);
  assert.deepEqual(calls, [[expectedPath, undefined]]);
}

test("Windows Markdown file links survive parsing and sanitization without changing their paths", () => {
  const paths = [
    String.raw`D:\person\test.js`,
    "D:/person/test.js",
    String.raw`D:\person\dir name\报告 2026.js`,
    "D:/person/dir name/报告 2026.js",
  ];

  for (const path of paths) {
    const source = `[file](<${path}>)`;
    const markup = renderSanitizedMarkdown(source);
    const href = markup.match(/<a href="([^"]+)"/)?.[1];
    assert.ok(href, `sanitized Markdown link lost href for ${path}: ${markup}`);
    assert.equal(decodeURIComponent(href), path);
    assertMarkdownLinkClick(markup, path);
  }

  const plainMarkdown = String.raw`[test.js](D:\person\test.js)`;
  const plainMarkup = renderSanitizedMarkdown(plainMarkdown);
  assert.match(plainMarkup, /<a href="D%3A%5Cperson%5Ctest\.js">test\.js<\/a>/);
  assertMarkdownLinkClick(plainMarkup, String.raw`D:\person\test.js`);

  const referencePath = String.raw`D:\person\dir name\报告 2026.js`;
  const referenceMarkup = renderSanitizedMarkdown(
    `[file][local]\n\n[local]: <${referencePath}>`,
  );
  const referenceHref = referenceMarkup.match(/<a href="([^"]+)"/)?.[1];
  assert.ok(referenceHref, `reference-style link lost href: ${referenceMarkup}`);
  assert.equal(decodeURIComponent(referenceHref), referencePath);
  assertMarkdownLinkClick(referenceMarkup, referencePath);

  const encodedPath = "D%3A%5Cperson%5Cdir%20name%5C%E6%8A%A5%E5%91%8A.js";
  const encodedMarkup = renderSanitizedMarkdown(`[file](${encodedPath})`);
  const encodedHref = encodedMarkup.match(/<a href="([^"]+)"/)?.[1];
  assert.ok(encodedHref, `encoded path link lost href: ${encodedMarkup}`);
  assert.equal(decodeURIComponent(encodedHref), String.raw`D:\person\dir name\报告.js`);
  assert.equal(encodedHref, encodedPath, "normalization must not double-encode an existing URI path");
  assertMarkdownLinkClick(encodedMarkup, String.raw`D:\person\dir name\报告.js`);

  const encodedSlashPath = "D%3A%2Fperson%2Fdir%20name%2F%E6%8A%A5%E5%91%8A.js";
  const encodedSlashMarkup = renderSanitizedMarkdown(`[file](${encodedSlashPath})`);
  const encodedSlashHref = encodedSlashMarkup.match(/<a href="([^"]+)"/)?.[1];
  assert.ok(encodedSlashHref, `encoded forward-slash link lost href: ${encodedSlashMarkup}`);
  assert.equal(decodeURIComponent(encodedSlashHref), "D:/person/dir name/报告.js");
  assert.equal(encodedSlashHref, encodedSlashPath);
  assertMarkdownLinkClick(encodedSlashMarkup, "D:/person/dir name/报告.js");
});

test("Markdown link normalization leaves web, relative, automatic, and unsafe links alone", () => {
  const httpMarkup = renderSanitizedMarkdown("[web](https://example.com/a%20b)");
  assert.match(httpMarkup, /href="https:\/\/example\.com\/a%20b"/);

  const relativeMarkup = renderSanitizedMarkdown("[relative](../docs/readme.md)");
  assert.match(relativeMarkup, /href="\.\.\/docs\/readme\.md"/);

  const autoPath = String.raw`D:\person\test.js`;
  const autoMarkup = renderSanitizedMarkdown(`Open ${autoPath}`);
  assert.match(autoMarkup, /href="D%3A%5Cperson%5Ctest\.js"/);

  for (const destination of [
    "javascript:alert%281%29",
    "data:text/html,unsafe",
    "file:///C:/secret.txt",
    "ms-msdt:/diagnostics",
    "custom:payload",
  ]) {
    const unsafeMarkup = renderSanitizedMarkdown(`[unsafe](${destination})`);
    assert.doesNotMatch(unsafeMarkup, /href=/, destination);
  }
});

test("parseFileRef accepts pathy tokens and strips line refs", () => {
  assert.equal(parseFileRef("apps/desktop/src/App.tsx"), "apps/desktop/src/App.tsx");
  assert.equal(parseFileRef("src/main.rs:42"), "src/main.rs");
  assert.equal(parseFileRef("src/main.rs:42:7"), "src/main.rs");
  assert.equal(parseFileRef("./scripts/build.sh"), "./scripts/build.sh");
  assert.equal(parseFileRef("/abs/path/file.ts"), "/abs/path/file.ts");
  assert.equal(parseFileRef("docs/Makefile"), "docs/Makefile");
  assert.equal(parseFileRef("./README.md"), "./README.md");
  assert.equal(parseFileRef("../adr/0163.md"), "../adr/0163.md");
  assert.equal(parseFileRef("/Users/me/my project/page.md"), "/Users/me/my project/page.md");
  assert.equal(parseFileRef("C:\\demo project\\readme.md"), "C:\\demo project\\readme.md");
  assert.equal(parseFileRef("C:/demo project/readme.md"), "C:/demo project/readme.md");
  assert.equal(parseFileRef("docs/my project/page.md"), "docs/my project/page.md");
});

test("parseFileRef accepts bare names only with known extensions", () => {
  assert.equal(parseFileRef("README.md"), "README.md");
  assert.equal(parseFileRef("package.json"), "package.json");
  assert.equal(parseFileRef("Makefile"), "Makefile");
  assert.equal(parseFileRef("report.md+copy"), "report.md+copy");
  assert.equal(parseFileRef("report.md@draft"), "report.md@draft");
  assert.equal(parseFileRef("report.md-v2"), "report.md-v2");
  assert.equal(parseFileRef("docs/report.md+long-version"), "docs/report.md+long-version");
  assert.equal(parseFileRef("docs/报告.中文"), "docs/报告.中文");
  // dotted identifiers in prose stay plain
  assert.equal(parseFileRef("store.messages"), null);
  assert.equal(parseFileRef("store.messages+copy"), null);
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
  assert.equal(toWorkspaceRel("C:\\demo project\\readme.md", "C:\\demo project"), "readme.md");
  assert.equal(toWorkspaceRel("c:/DEMO PROJECT/readme.md", "C:\\demo project"), "readme.md");
  assert.equal(toWorkspaceRel("C:\\elsewhere\\readme.md", "C:\\demo project"), null);
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
    line: 10,
  });
  assert.deepEqual(resolvePreviewTarget("./README.md", ROOT, "docs"), {
    kind: "file",
    path: "docs/README.md",
  });
  assert.deepEqual(resolvePreviewTarget(`${ROOT}/src/a.ts`, ROOT), {
    kind: "file",
    path: `${ROOT}/src/a.ts`,
  });
  assert.deepEqual(resolvePreviewTarget("/outside/root.ts", ROOT), {
    kind: "file",
    path: "/outside/root.ts",
  });
  assert.equal(isHttpUrl("ftp://example.com"), false);
});

test("getToolPreviewTarget reads path-like args and fetch urls", () => {
  assert.deepEqual(
    getToolPreviewTarget({ path: `${ROOT}/src/a.ts` }, ROOT),
    { kind: "file", path: `${ROOT}/src/a.ts` },
  );
  assert.deepEqual(
    getToolPreviewTarget({ file_path: "src/b.ts" }, ROOT),
    { kind: "file", path: "src/b.ts" },
  );
  assert.deepEqual(getToolPreviewTarget({ path: "/outside/a.ts" }, ROOT), {
    kind: "file", path: "/outside/a.ts",
  });
  assert.deepEqual(
    getToolPreviewTarget({ url: "https://example.com" }, ROOT),
    { kind: "url", url: "https://example.com" },
  );
  assert.equal(getToolPreviewTarget({ command: "ls" }, ROOT), null);
  assert.deepEqual(
    getToolPreviewTarget({ path: "C:\\demo project\\readme.md" }, "C:\\demo project"),
    { kind: "file", path: "C:\\demo project\\readme.md" },
  );
});

test("complete spaced and Windows paths are scanned without linking their suffixes", () => {
  const posix = "/Users/me/my project/page.md";
  const windows = "C:\\demo project\\readme.md";
  for (const [path, root] of [[posix, "/Users/me/my project"], [windows, "C:\\demo project"]]) {
    const segments = splitChatText(`Open ${path} now`, root);
    const links = segments.filter((segment) => segment.kind === "target");
    assert.equal(links.length, 1);
    assert.equal(links[0].text, path);
    assert.equal(segments.map((segment) => segment.text).join(""), `Open ${path} now`);
  }
  assert.deepEqual(
    splitChatText("Open /Users/me/my project/page.md now", ROOT)
      .filter((segment) => segment.kind === "target")
      .map((segment) => segment.text),
    [posix],
  );
  const relative = splitChatText("Open docs/my project/page.md now", ROOT);
  assert.deepEqual(relative.filter((segment) => segment.kind === "target").map((segment) => segment.text), ["docs/my project/page.md"]);
  const forward = splitChatText("Open C:/demo project/readme.md now", "C:/demo project");
  assert.deepEqual(forward.filter((segment) => segment.kind === "target").map((segment) => segment.text), ["C:/demo project/readme.md"]);
  assert.deepEqual(resolvePreviewTarget('@"C:\\demo project\\readme.md"', "C:/demo project"), {
    kind: "file", path: "C:\\demo project\\readme.md",
  });
});

test("multi-dot absolute paths keep their final extension", () => {
  for (const path of [
    "C:/demo/report.v1.md",
    "C:/demo project/a.test.ts",
    "/Users/me/my project/report.v1.md",
  ]) {
    const segments = splitChatText(`Open ${path} now`, ROOT);
    assert.deepEqual(
      segments.filter((segment) => segment.kind === "target").map((segment) => segment.text),
      [path],
    );
  }
  assert.deepEqual(
    splitChatText("Open C:/demo/report.v1.md. Next", ROOT)
      .filter((segment) => segment.kind === "target")
      .map((segment) => segment.text),
    ["C:/demo/report.v1.md"],
  );
  assert.deepEqual(
    splitChatText("see docs/report.v1.md and report.v2.md", ROOT)
      .filter((segment) => segment.kind === "target")
      .map((segment) => segment.text),
    ["docs/report.v1.md", "report.v2.md"],
  );
});

test("suffix characters after extensions stay in path links", () => {
  for (const path of [
    "report.md+copy",
    "report.md@draft",
    "report.md-v2",
    "/tmp/report.md+copy",
    "/tmp/report.md+",
    "/tmp/report.md@draft",
    "docs/report.md-v2",
    "C:/repo/report.md+copy",
    "C:\\repo\\report.md@draft",
    "\\\\server\\share\\report.md+copy",
  ]) {
    const source = `Open ${path} now`;
    const segments = splitChatText(source, ROOT);
    assert.deepEqual(
      segments.filter((segment) => segment.kind === "target").map((segment) => segment.text),
      [path],
      path,
    );
    assert.equal(segments.map((segment) => segment.text).join(""), source);
    assert.deepEqual(resolvePreviewTarget(path, ROOT), { kind: "file", path });
  }
  assert.deepEqual(
    splitChatText('@"report.md@draft"', ROOT)
      .filter((segment) => segment.kind === "target")
      .map((segment) => segment.target),
    [{ kind: "file", path: "report.md@draft" }],
  );
  assert.deepEqual(splitChatText("Open store.messages+copy", ROOT), [
    { kind: "text", text: "Open store.messages+copy" },
  ]);
});

test("dotted directories do not split absolute file paths", () => {
  for (const path of [
    "/tmp/archive.md/report.md",
    "/tmp/archive.md备份/report.md",
    "/tmp/archive.md+copy/report.md",
    "C:/repo.v1/docs/page.md",
    "C:\\repo.v1\\docs\\page.md",
    "\\\\server\\share.v1\\page.md",
    "//server/share.v1/page.md",
  ]) {
    const source = `Open ${path} now`;
    const segments = splitChatText(source, ROOT);
    assert.deepEqual(
      segments.filter((segment) => segment.kind === "target").map((segment) => segment.text),
      [path],
      path,
    );
    assert.equal(segments.map((segment) => segment.text).join(""), source);
  }
});

test("quoted refs preserve ambiguous spaced dotted directories", () => {
  for (const path of [
    "/tmp/archive.md backup/report.md",
    "/tmp/archive.md backup files/report.md",
    "C:/repo.v1 backup/docs/page.md",
    "C:\\repo.v1 backup\\docs\\page.md",
    "\\\\server\\share.v1 backup\\page.md",
  ]) {
    const targets = splitChatText(`@"${path}"`, ROOT)
      .filter((segment) => segment.kind === "target")
      .map((segment) => segment.target);
    assert.deepEqual(targets, [{ kind: "file", path }], path);
  }
  const ambiguous = "Open /tmp/archive.md backup/report.md";
  const segments = splitChatText(ambiguous, ROOT);
  assert.deepEqual(
    segments.filter((segment) => segment.kind === "target").map((segment) => segment.text),
    ["/tmp/archive.md", "backup/report.md"],
  );
  assert.equal(segments.map((segment) => segment.text).join(""), ambiguous);
});

test("prose between separate paths stays outside both links", () => {
  for (const [source, expected] of [
    ["Open /tmp/first.md and /tmp/second.md", ["/tmp/first.md", "/tmp/second.md"]],
    ["Open /tmp/first.md and docs/second.md", ["/tmp/first.md", "docs/second.md"]],
    ["Open C:/repo/first.md or C:/repo/second.md", ["C:/repo/first.md", "C:/repo/second.md"]],
    ["Open /tmp/first.md plus docs/second.md", ["/tmp/first.md", "docs/second.md"]],
    ["Open /tmp/first.md because docs/second.md", ["/tmp/first.md", "docs/second.md"]],
    ["Open /tmp/first.md with docs/second.md", ["/tmp/first.md", "docs/second.md"]],
    ["Open docs/a.md then docs/b.md", ["docs/a.md", "docs/b.md"]],
    ["Open docs/a.md against docs/b.md", ["docs/a.md", "docs/b.md"]],
    ["Open /tmp/a.md, then docs/b.md", ["/tmp/a.md", "docs/b.md"]],
    ["打开 /tmp/first.md 与 docs/second.md", ["/tmp/first.md", "docs/second.md"]],
    ["打开 /tmp/App.tsx文件 docs/second.md", ["/tmp/App.tsx", "docs/second.md"]],
  ]) {
    const targets = splitChatText(source, ROOT)
      .filter((segment) => segment.kind === "target")
      .map((segment) => segment.text);
    assert.deepEqual(targets, expected, source);
    assert.equal(splitChatText(source, ROOT).map((segment) => segment.text).join(""), source);
  }
});

test("spaced absolute paths keep known extensionless filenames", () => {
  for (const path of [
    "/tmp/my project/Makefile",
    "C:/my project/Makefile",
    "C:\\my project\\Dockerfile",
    "\\\\server\\my share\\LICENSE",
  ]) {
    const source = `Open ${path} now`;
    const segments = splitChatText(source, ROOT);
    assert.deepEqual(
      segments.filter((segment) => segment.kind === "target").map((segment) => segment.text),
      [path],
      path,
    );
    assert.equal(segments.map((segment) => segment.text).join(""), source);
  }
});

test("unmarked first-segment spaces stay plain; explicit refs stay whole", () => {
  for (const path of ["my project/page.md", "my project/sub/page.md", "My Project/page.md", "my new project/page.md", "test project/page.md"]) {
    const source = `Open ${path} now`;
    assert.deepEqual(splitChatText(source, ROOT), [{ kind: "text", text: source }]);
    assert.deepEqual(
      splitChatText(`@"${path}"`, ROOT)
        .filter((segment) => segment.kind === "target")
        .map((segment) => segment.target),
      [{ kind: "file", path }],
    );
  }
  assert.deepEqual(
    splitChatText("Open docs/my project/page.md and file.md", ROOT)
      .filter((segment) => segment.kind === "target")
      .map((segment) => segment.text),
    ["docs/my project/page.md", "file.md"],
  );
  assert.deepEqual(
    splitChatText("Open docs/page.md and file.md", ROOT)
      .filter((segment) => segment.kind === "target")
      .map((segment) => segment.text),
    ["docs/page.md", "file.md"],
  );
  for (const prose of ["see docs/page.md", "and docs/page.md"]) {
    assert.deepEqual(
      splitChatText(prose, ROOT)
        .filter((segment) => segment.kind === "target")
        .map((segment) => segment.text),
      ["docs/page.md"],
    );
  }
  assert.deepEqual(splitChatText("打开 my project/page.md", ROOT), [
    { kind: "text", text: "打开 my project/page.md" },
  ]);
  assert.deepEqual(
    splitChatText("Open docs/a.md and my project/page.md", ROOT)
      .filter((segment) => segment.kind === "target")
      .map((segment) => segment.text),
    ["docs/a.md"],
  );
  assert.deepEqual(
    splitChatText("Open docs/a.md my project/page.md", ROOT)
      .filter((segment) => segment.kind === "target")
      .map((segment) => segment.text),
    ["docs/a.md"],
  );
  for (const source of [
    "Open my project/a.md and my project/b.md",
    'Open "my project/a.md" and "my project/b.md"',
    "please open my project/a.md and my project/b.md",
  ]) {
    assert.deepEqual(
      splitChatText(source, ROOT)
        .filter((segment) => segment.kind === "target")
        .map((segment) => segment.text),
      [],
      source,
    );
  }
  assert.deepEqual(
    splitChatText("Open a long directory name/page.md", ROOT),
    [{ kind: "text", text: "Open a long directory name/page.md" }],
  );
  assert.deepEqual(
    splitChatText('@"a long directory name/page.md"', ROOT)
      .filter((segment) => segment.kind === "target")
      .map((segment) => segment.target),
    [{ kind: "file", path: "a long directory name/page.md" }],
  );
});

test("ambiguous bare names stay plain while prose still links single tokens", () => {
  assert.deepEqual(resolvePreviewTarget("my file.md", ROOT), { kind: "file", path: "my file.md" });
  for (const source of [
    "my file.md", "Open my file.md now", "Please test file.md",
    "Test file.md before release", "My report.md is ready", "New report.md is ready",
  ]) {
    assert.deepEqual(splitChatText(source, ROOT), [{ kind: "text", text: source }]);
  }
  for (const [source, expected] of [
    ["see App.tsx", "App.tsx"],
    ["see file.md", "file.md"],
    ["update package.json", "package.json"],
    ["review docs/page.md", "docs/page.md"],
    ["Created report.md", "report.md"],
    ["I created report.md", "report.md"],
    ["Saved report.md", "report.md"],
    ["This is report.md and file.md", "report.md"],
  ]) {
    const segments = splitChatText(source, ROOT);
    assert.deepEqual(
      segments.filter((segment) => segment.kind === "target").map((segment) => segment.text),
      source === "This is report.md and file.md" ? ["report.md", "file.md"] : [expected],
      source,
    );
    assert.equal(segments.map((segment) => segment.text).join(""), source);
  }
  const tree = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: 'Open @"my file.md" and see App.tsx' }] }] };
  linkifyMdastTree(tree, ROOT);
  assert.deepEqual(
    tree.children[0].children.filter((node) => node.type === "link").map((node) => node.url),
    ["my file.md", "App.tsx"],
  );
  const markup = renderToStaticMarkup(
    React.createElement(ReactMarkdown, {
      remarkPlugins: [remarkChatFileLinks(ROOT)],
      children: 'Open @"my file.md" and see App.tsx',
    }),
  );
  assert.match(markup, /href="my%20file\.md"/);
  assert.match(markup, /href="App\.tsx"/);
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

test("linkifyMdastTree turns bare paths and resolvable inline code into links", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [{ type: "text", value: "See apps/desktop/src/App.tsx please" }],
      },
      { type: "inlineCode", value: "apps/desktop/src/App.tsx" },
      { type: "inlineCode", value: "some ordinary prose here" },
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
  // A resolvable inline-code path becomes a link whose child stays inline code (#1169).
  assert.equal(tree.children[1].type, "link");
  assert.equal(tree.children[1].url, "apps/desktop/src/App.tsx");
  assert.equal(tree.children[1].children[0].type, "inlineCode");
  // A spaced prose code run is not path-like and stays plain inline code.
  assert.equal(tree.children[2].type, "inlineCode");
  assert.equal(tree.children[3].children[0].type, "text");
});

test("linkifyMdastTree links a spaced Windows path in inline code (#1169)", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [{ type: "inlineCode", value: "C:/demo project/readme.md" }],
      },
    ],
  };
  // The issue's workspace root is the spaced directory itself, so the
  // reference resolves under it; the link keeps the full source path.
  linkifyMdastTree(tree, "C:\\demo project");
  assert.equal(tree.children[0].children[0].type, "link");
  assert.equal(
    tree.children[0].children[0].url,
    encodeURIComponent("C:/demo project/readme.md"),
  );

  const markup = renderToStaticMarkup(
    React.createElement(ReactMarkdown, {
      remarkPlugins: [remarkChatFileLinks("C:\\demo project")],
      children: "`C:/demo project/readme.md`",
    }),
  );
  assert.ok(
    markup.includes(
      '<a href="C%3A%2Fdemo%20project%2Freadme.md"><code>C:/demo project/readme.md</code></a>',
    ),
  );
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
    [`${ROOT}/src/报告.md`],
  );
});

test("splitChatText keeps outside absolute paths whole and home paths plain", () => {
  const outside = splitChatText(
    "see /elsewhere/a.ts and ~/Downloads/x.png here",
    ROOT,
  );
  assert.deepEqual(outside.filter((segment) => segment.kind === "target").map((segment) => segment.text), ["/elsewhere/a.ts"]);
  assert.equal(outside.map((segment) => segment.text).join(""), "see /elsewhere/a.ts and ~/Downloads/x.png here");
  for (const source of ["~/my project/page.md", "see ~/my project/page.md here", "~\\my project\\page.md"]) {
    assert.deepEqual(splitChatText(source, ROOT), [{ kind: "text", text: source }]);
  }
  const unc = "\\\\server\\my share\\page.md";
  const segments = splitChatText(`Open ${unc} now`, ROOT);
  assert.deepEqual(segments.filter((segment) => segment.kind === "target").map((segment) => segment.text), [unc]);
  assert.deepEqual(segments.filter((segment) => segment.kind === "target").map((segment) => segment.target), [
    { kind: "file", path: unc },
  ]);
  const forwardUnc = "//server/my share/page.md";
  assert.deepEqual(
    splitChatText(`Open ${forwardUnc} now`, ROOT)
      .filter((segment) => segment.kind === "target")
      .map((segment) => segment.text),
    [forwardUnc],
  );
});

test("markdown linkification encodes a Windows file path without losing its source text", () => {
  const path = "C:\\demo project\\readme.md";
  const tree = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: `Open ${path}` }] }] };
  linkifyMdastTree(tree, "C:\\demo project");
  const link = tree.children[0].children.find((node) => node.type === "link");
  assert.equal(link.url, encodeURIComponent(path));
  assert.equal(link.children[0].value, path);
  const markup = renderToStaticMarkup(
    React.createElement(ReactMarkdown, {
      remarkPlugins: [remarkChatFileLinks("C:\\demo project")],
      children: `Open ${path}`,
    }),
  );
  assert.match(markup, /href="C%3A%5Cdemo%20project%5Creadme.md"/);
  const unc = "\\\\server\\my share\\page.md";
  const uncTree = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: `Open ${unc}` }] }] };
  linkifyMdastTree(uncTree, ROOT);
  const uncLink = uncTree.children[0].children.find((node) => node.type === "link");
  assert.equal(uncLink.url, encodeURIComponent(unc));
  assert.equal(uncLink.children[0].value, unc);
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

test("URL link creation is capped per conversion without changing source text", () => {
  const source = "(https://example.com)".repeat(1000);
  const segments = splitChatText(source, ROOT);
  assert.equal(segments.filter(s => s.kind === "target").length, 256);
  assert.equal(segments.map(s => s.text).join(""), source);
  assert.equal(
    splitChatText("(https://example.com)", ROOT).filter((s) => s.kind === "target").length,
    1,
  );
});

test("parseFileRefPosition keeps :line[:col] that parseFileRef strips", () => {
  assert.deepEqual(parseFileRefPosition("src/main.rs:42"), { line: 42 });
  assert.deepEqual(parseFileRefPosition("src/main.rs:42:7"), { line: 42, column: 7 });
  assert.deepEqual(parseFileRefPosition("src/main.rs:42."), { line: 42 });
  assert.deepEqual(parseFileRefPosition("src/main.rs:42:7,"), { line: 42, column: 7 });
  assert.equal(parseFileRefPosition("src/main.rs"), null);
  assert.equal(parseFileRefPosition("src/main.rs:0"), null);
});

test("resolvePreviewTarget carries line/col on file chips (#681)", () => {
  assert.deepEqual(resolvePreviewTarget("src/a.ts:42", ROOT), {
    kind: "file",
    path: "src/a.ts",
    line: 42,
  });
  assert.deepEqual(resolvePreviewTarget("src/a.ts:42:7", ROOT), {
    kind: "file",
    path: "src/a.ts",
    line: 42,
    column: 7,
  });
  assert.deepEqual(resolvePreviewTarget("src/a.ts:42:7.", ROOT), {
    kind: "file",
    path: "src/a.ts",
    line: 42,
    column: 7,
  });
  assert.deepEqual(resolvePreviewTarget(`${ROOT}/src/a.ts:42:7`, ROOT), {
    kind: "file",
    path: `${ROOT}/src/a.ts`,
    line: 42,
    column: 7,
  });
});

test("session links segment as their own target", () => {
  const link = "pi-desktop://session/6f1d2c3b-4a59-4e7f-8a90-b1c2d3e4f506";
  const segments = splitChatText(`analyze ${link} please`, ROOT);
  assert.deepEqual(
    segments.map((segment) => segment.text),
    ["analyze ", link, " please"],
  );
  const target = segments.find((segment) => segment.kind === "target");
  assert.deepEqual(target.target, {
    kind: "session",
    sessionId: "6f1d2c3b-4a59-4e7f-8a90-b1c2d3e4f506",
  });
  // A remote id and a bare scheme are not local conversations.
  assert.equal(resolvePreviewTarget("pi-desktop://session/remote:abc", ROOT), null);
  assert.equal(resolvePreviewTarget("pi-desktop://session/", ROOT), null);
});
