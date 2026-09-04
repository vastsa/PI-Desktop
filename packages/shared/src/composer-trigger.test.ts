import { describe, expect, it } from "vitest";
import {
  applyCompletion,
  detectTrigger,
  fileReferenceLabel,
  formatCommandInsert,
  formatFileInsert,
  normalizeLargePasteThreshold,
  serializeComposerFileReferences,
  serializeInlineComposerFileReferences,
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

  it("never triggers mid-draft or on later lines", () => {
    expect(detectTrigger("hi /cmd", 7)).toBeNull();
    expect(detectTrigger("hi\n/cmd", 7)).toBeNull();
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

  it("normalizes large-paste thresholds to the supported range", () => {
    expect(normalizeLargePasteThreshold(undefined)).toBe(600);
    expect(normalizeLargePasteThreshold(600)).toBe(600);
    expect(normalizeLargePasteThreshold(0)).toBe(600);
    expect(normalizeLargePasteThreshold(1_000_001)).toBe(600);
    expect(normalizeLargePasteThreshold(601)).toBe(601);
  });
});
