import { describe, expect, it } from "vitest";
import {
  applyCompletion,
  buildAgentDispatchInstruction,
  detectTrigger,
  fileReferenceLabel,
  findAgentMentions,
  formatCommandInsert,
  formatFileInsert,
  normalizeLargePasteThreshold,
  restoreInlineComposerFileReferenceTokens,
  rewriteIdeographicCommaTrigger,
  serializeComposerFileReferences,
  serializeInlineComposerFileReferences,
  stripInlineComposerFileReferenceTokens,
} from "./composer-trigger.js";

describe("detectTrigger — slash mode", () => {
  it("triggers on a bare slash at position 0", () => {
    expect(detectTrigger("/", 1)).toEqual({
      mode: "slash",
      query: "",
      tokenStart: 0,
      tokenEnd: 1,
    });
  });

  it("carries the typed query", () => {
    expect(detectTrigger("/rev", 4)).toMatchObject({ mode: "slash", query: "rev" });
  });

  it("does not trigger before the slash", () => {
    expect(detectTrigger("/rev", 0)).toBeNull();
  });

  it("closes once the first token has whitespace before the cursor", () => {
    expect(detectTrigger("/review src", 11)).toBeNull();
    expect(detectTrigger("/review ", 8)).toBeNull();
  });

  it("stays open when the cursor is inside the first token", () => {
    expect(detectTrigger("/review src", 4)).toMatchObject({
      mode: "slash",
      query: "rev",
      tokenEnd: 4,
    });
  });

  it("targets later slash tokens independently", () => {
    expect(detectTrigger("hi /cmd", 7)).toMatchObject({ tokenStart: 3, query: "cmd" });
    expect(detectTrigger("hi\n/cmd", 7)).toMatchObject({ tokenStart: 3, query: "cmd" });
    expect(detectTrigger("https://example.com", 8)).toBeNull();
  });
});

describe("rewriteIdeographicCommaTrigger", () => {
  it("turns a leading ideographic comma into the slash trigger", () => {
    expect(rewriteIdeographicCommaTrigger("、")).toBe("/");
    expect(rewriteIdeographicCommaTrigger("、rev")).toBe("/rev");
  });

  it("leaves the mark alone anywhere else in the draft", () => {
    expect(rewriteIdeographicCommaTrigger("你好、世界")).toBe("你好、世界");
    expect(rewriteIdeographicCommaTrigger("/cmd 、")).toBe("/cmd 、");
    expect(rewriteIdeographicCommaTrigger("")).toBe("");
  });

  it("opens the menu through the ordinary detector once rewritten", () => {
    const draft = rewriteIdeographicCommaTrigger("、rev");
    expect(detectTrigger(draft, draft.length)).toMatchObject({
      mode: "slash",
      query: "rev",
      tokenStart: 0,
    });
  });
});

describe("detectTrigger — file mode", () => {
  it("triggers on a bare @ at start", () => {
    expect(detectTrigger("@", 1)).toEqual({
      mode: "file",
      query: "",
      tokenStart: 0,
      tokenEnd: 1,
    });
  });

  it("triggers after whitespace and pi delimiters", () => {
    expect(detectTrigger("see @src/a", 10)).toMatchObject({
      mode: "file",
      query: "src/a",
      tokenStart: 4,
    });
    expect(detectTrigger("path=@conf", 10)).toMatchObject({ mode: "file", query: "conf" });
    expect(detectTrigger("a\t@x", 4)).toMatchObject({ mode: "file", query: "x" });
  });

  it("does not trigger on a mid-word @ (emails)", () => {
    expect(detectTrigger("mail a@b.com", 12)).toBeNull();
  });

  it("does not trigger when the cursor is outside the token", () => {
    expect(detectTrigger("@src ok", 7)).toBeNull();
  });

  it("supports the quoted form with spaces", () => {
    expect(detectTrigger('@"my file', 9)).toEqual({
      mode: "file",
      query: "my file",
      tokenStart: 0,
      tokenEnd: 9,
    });
    expect(detectTrigger('see @"a b/c', 11)).toMatchObject({
      mode: "file",
      query: "a b/c",
      tokenStart: 4,
    });
  });

  it("treats a just-opened quote as an empty query", () => {
    expect(detectTrigger('@"', 2)).toMatchObject({ mode: "file", query: "" });
  });

  it("closes after the quote is closed", () => {
    expect(detectTrigger('@"a b" next', 11)).toBeNull();
    expect(detectTrigger('@"a b" ', 7)).toBeNull();
  });

  it("keeps completing inside an inserted quoted directory", () => {
    const draft = '@"my dir/sr';
    expect(detectTrigger(draft, draft.length)).toMatchObject({
      mode: "file",
      query: "my dir/sr",
    });
  });

  it("returns null for out-of-range cursors", () => {
    expect(detectTrigger("@a", 5)).toBeNull();
    expect(detectTrigger("@a", -1)).toBeNull();
  });
});

describe("insert formatting", () => {
  it("formats commands with a trailing space", () => {
    expect(formatCommandInsert("review")).toBe("/review ");
  });

  it("formats plain files with a trailing space", () => {
    expect(formatFileInsert("src/a.ts", "file")).toBe("@src/a.ts ");
  });

  it("quotes files containing spaces", () => {
    expect(formatFileInsert("my file.md", "file")).toBe('@"my file.md" ');
  });

  it("leaves directories open for continued completion", () => {
    expect(formatFileInsert("src", "dir")).toBe("@src/");
    expect(formatFileInsert("my dir", "dir")).toBe('@"my dir/');
  });
});

describe("applyCompletion", () => {
  it("replaces the trigger token and moves the cursor", () => {
    const trigger = detectTrigger("see @sr tail", 7);
    expect(trigger).not.toBeNull();
    const result = applyCompletion(
      "see @sr tail",
      trigger!,
      formatFileInsert("src/a.ts", "file"),
    );
    expect(result.value).toBe("see @src/a.ts  tail");
    expect(result.cursor).toBe("see @src/a.ts ".length);
  });

  it("replaces a slash token from the start of the draft", () => {
    const trigger = detectTrigger("/rev", 4);
    const result = applyCompletion("/rev", trigger!, formatCommandInsert("review"));
    expect(result).toEqual({ value: "/review ", cursor: 8 });
  });

  it("chains directory completion into a deeper trigger", () => {
    const step1 = applyCompletion("@", detectTrigger("@", 1)!, formatFileInsert("src", "dir"));
    expect(step1.value).toBe("@src/");
    const next = detectTrigger(step1.value, step1.cursor);
    expect(next).toMatchObject({ mode: "file", query: "src/" });
  });
});

describe("compact file references", () => {
  it("derives leaf labels across path separators without changing unicode", () => {
    expect(fileReferenceLabel("src/components/Composer.tsx")).toBe("Composer.tsx");
    expect(fileReferenceLabel("C:\\work\\界面\\截图.png")).toBe("截图.png");
    expect(fileReferenceLabel("src/fallback.ts", "original name.ts")).toBe(
      "original name.ts",
    );
  });

  it("serializes canonical paths after the visible draft", () => {
    expect(
      serializeComposerFileReferences("inspect these", [
        { path: "src/a.ts" },
        { path: "/tmp/session scratch/image.png" },
      ]),
    ).toBe('inspect these\n@src/a.ts @"/tmp/session scratch/image.png"');
  });

  it("supports reference-only prompts and preserves duplicate paths", () => {
    expect(
      serializeComposerFileReferences("", [
        { path: "src/index.ts" },
        { path: "test/index.ts" },
      ]),
    ).toBe("@src/index.ts @test/index.ts");
  });

  it("resolves generated inline tokens in place and leaves chip references separate", () => {
    expect(
      serializeInlineComposerFileReferences("before @pasted-text.txt after", [
        { path: "/tmp/session/pasted/pasted-text.txt", token: "@pasted-text.txt" },
      ]),
    ).toBe("before @/tmp/session/pasted/pasted-text.txt after");
    expect(
      serializeComposerFileReferences("before @pasted-text.txt after", [
        { path: "/tmp/session/pasted/pasted-text.txt", token: "@pasted-text.txt" },
        { path: "src/a.ts" },
      ]),
    ).toBe(
      "before @/tmp/session/pasted/pasted-text.txt after\n@src/a.ts",
    );
  });

  it("does not serialize an inline reference after its token is removed", () => {
    expect(
      serializeComposerFileReferences("the token was removed", [
        { path: "/tmp/session/pasted/pasted-text.txt", token: "@pasted-text.txt" },
      ]),
    ).toBe("the token was removed");
  });

  it("keeps one separating space between adjacent sentinel chips", () => {
    expect(
      serializeInlineComposerFileReferences("\uE001\uE002 inspect", [
        { path: "src/a.ts", token: "\uE001" },
        { path: "src/b.ts", token: "\uE002" },
      ]),
    ).toBe("@src/a.ts @src/b.ts inspect");
  });

  it("keeps inline chips intact while enhancing their surrounding text", () => {
    const references = [{ path: "/tmp/image.png", token: "\uE001" }];
    const source = "\uE001make this clearer";
    expect(stripInlineComposerFileReferenceTokens(source, references)).toBe(
      "make this clearer",
    );
    expect(
      restoreInlineComposerFileReferenceTokens(
        source,
        "\uE001Make this much clearer",
        references,
      ),
    ).toBe("\uE001Make this much clearer");
    expect(
      restoreInlineComposerFileReferenceTokens(
        source,
        "Make this much clearer",
        references,
      ),
    ).toBe("\uE001Make this much clearer");
  });

  it("normalizes large-paste thresholds to the supported range", () => {
    expect(normalizeLargePasteThreshold(undefined)).toBe(600);
    expect(normalizeLargePasteThreshold(600)).toBe(600);
    expect(normalizeLargePasteThreshold(0)).toBe(600);
    expect(normalizeLargePasteThreshold(1_000_001)).toBe(600);
    expect(normalizeLargePasteThreshold(601)).toBe(601);
  });
});

describe("findAgentMentions — @agent delegation", () => {
  const catalog = new Set(["explorer", "code-reviewer"]);

  it("resolves a boundary @token that names a delegated agent", () => {
    expect(findAgentMentions("@explorer 修一下登录", catalog)).toEqual([
      { start: 0, end: 9, name: "explorer" },
    ]);
    expect(findAgentMentions("please ask @code-reviewer about this", catalog)).toEqual([
      { start: 11, end: 25, name: "code-reviewer" },
    ]);
  });

  it("never treats a path as an agent mention", () => {
    // `@` inside a token is not a boundary, and a slash means a path.
    expect(findAgentMentions("user@explorer", catalog)).toEqual([]);
    expect(findAgentMentions("@docs/explorer", catalog)).toEqual([]);
    expect(findAgentMentions('@"explorer notes"', catalog)).toEqual([]);
  });

  it("keeps sentence punctuation out of the resolved name", () => {
    const [mention] = findAgentMentions("@explorer,", catalog);
    expect(mention).toEqual({ start: 0, end: 9, name: "explorer" });
    expect(findAgentMentions("@explorer.", catalog)[0].name).toBe("explorer");
  });

  it("yields to a real file of the same name", () => {
    // An agent and a file both serialize to `@token`; the file wins.
    expect(findAgentMentions("@explorer", catalog, new Set(["explorer"]))).toEqual([]);
    expect(findAgentMentions("@explorer", catalog, new Set(["src/explorer"]))).toEqual([
      { start: 0, end: 9, name: "explorer" },
    ]);
  });

  it("leaves unknown names as ordinary text", () => {
    expect(findAgentMentions("@nosuchagent do it", catalog)).toEqual([]);
  });

  it("reports each agent once, in the order mentioned", () => {
    expect(
      findAgentMentions("@code-reviewer then @explorer then @code-reviewer", catalog).map(
        (mention) => mention.name,
      ),
    ).toEqual(["code-reviewer", "explorer"]);
  });
});

describe("serializeInlineComposerFileReferences — agent mentions", () => {
  const TOKEN = "\uE001";
  const agent = { path: "explorer", token: TOKEN, kind: "agent" as const };
  const file = { path: "src/a.ts", token: TOKEN, kind: "file" as const };

  it("keeps a mention readable as a token when text precedes it", () => {
    // The send-time resolver only reads an @token at a start or after
    // whitespace, so `look@explorer` would never resolve and the delegation
    // would silently not happen.
    expect(serializeInlineComposerFileReferences(`look${TOKEN}into this`, [agent])).toBe(
      "look @explorer into this",
    );
  });

  it("adds no space where one is not needed", () => {
    expect(serializeInlineComposerFileReferences(`${TOKEN}go`, [agent])).toBe("@explorer go");
    expect(serializeInlineComposerFileReferences(`see ${TOKEN}go`, [agent])).toBe(
      "see @explorer go",
    );
  });

  it("leaves file output byte-for-byte unchanged", () => {
    // Files never gained a leading space; that output predates the mention.
    expect(serializeInlineComposerFileReferences(`read${TOKEN}now`, [file])).toBe(
      "read@src/a.ts now",
    );
  });
});

describe("buildAgentDispatchInstruction", () => {
  it("names one agent and asks for Task before answering", () => {
    const instruction = buildAgentDispatchInstruction(["explorer"]);
    expect(instruction).toContain("Call the `Task` tool");
    expect(instruction).toContain('Agent: "explorer"');
    expect(instruction).toContain("TaskWait");
  });

  it("asks for one call per agent when several are mentioned", () => {
    const instruction = buildAgentDispatchInstruction(["explorer", "code-reviewer"]);
    expect(instruction).toContain("once per agent");
    expect(instruction).toContain('Agents: "explorer", "code-reviewer"');
  });
});

