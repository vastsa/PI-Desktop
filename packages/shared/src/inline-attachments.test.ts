import { describe, expect, it } from "vitest";
import {
  formatPromptPathText,
  locateInlinePromptPaths,
  splitInlineContent,
} from "./inline-attachments.js";

const image = (path: string, extra: { inlinePath?: string } = {}) => ({
  kind: "image" as const,
  name: path.split("/").at(-1) ?? path,
  path,
  ...extra,
});

describe("inline prompt attachment placement", () => {
  it("formats the path text a prompt names an attachment with", () => {
    expect(formatPromptPathText("/scratch/a.png")).toBe("@/scratch/a.png");
    expect(formatPromptPathText("/scratch/a b.png")).toBe('@"/scratch/a b.png"');
  });

  it("locates each path from the previous match, in order", () => {
    const located = locateInlinePromptPaths("see @/a.png then @/b.png", [
      "/a.png",
      "/b.png",
    ]);
    expect(located).toEqual([
      { start: 4, end: 11 },
      { start: 17, end: 24 },
    ]);
  });

  it("keeps a repeated path's second use unmatched", () => {
    const located = locateInlinePromptPaths("@/a.png and @/a.png", ["/a.png", "/a.png"]);
    expect(located[0]).toEqual({ start: 0, end: 7 });
    expect(located[1]).toEqual({ start: 12, end: 19 });
    expect(
      locateInlinePromptPaths("@/a.png", ["/a.png", "/a.png"])[1],
    ).toBeNull();
  });

  it("reports a path the prompt does not name inline", () => {
    expect(locateInlinePromptPaths("no paths here", ["/a.png"])).toEqual([null]);
    expect(locateInlinePromptPaths("no paths here", [undefined])).toEqual([null]);
  });

  it("splits a prompt into ordered text runs and attachments", () => {
    const first = image("/scratch/a.png", { inlinePath: "@/scratch/a.png" });
    const second = image("/scratch/b.png", { inlinePath: "@/scratch/b.png" });
    const { parts, trailing } = splitInlineContent(
      "compare @/scratch/a.png with @/scratch/b.png now",
      [first, second],
    );
    expect(trailing).toEqual([]);
    expect(parts).toEqual([
      { kind: "text", text: "compare ", start: 0, end: 8 },
      { kind: "attachment", attachment: first, start: 8, end: 23 },
      { kind: "text", text: " with ", start: 23, end: 29 },
      { kind: "attachment", attachment: second, start: 29, end: 44 },
      { kind: "text", text: " now", start: 44, end: 48 },
    ]);
  });

  it("keeps an attachment the prompt does not name inline trailing", () => {
    const inline = image("/scratch/a.png", { inlinePath: "@/scratch/a.png" });
    const detached = image("/scratch/b.png");
    const { parts, trailing } = splitInlineContent("look @/scratch/a.png", [
      inline,
      detached,
    ]);
    expect(trailing).toEqual([detached]);
    expect(parts.map((part) => part.kind)).toEqual(["text", "attachment"]);
  });

  it("keeps the prompt text intact, including an image-only draft", () => {
    const only = image("/scratch/a.png", { inlinePath: "@/scratch/a.png" });
    expect(splitInlineContent("@/scratch/a.png", [only]).parts).toEqual([
      { kind: "attachment", attachment: only, start: 0, end: 15 },
    ]);
    const { parts } = splitInlineContent("", [image("/scratch/b.png")]);
    expect(parts).toEqual([]);
  });
  it("splits nothing for a prompt without attachments", () => {
    expect(splitInlineContent("plain prompt", []).parts).toEqual([
      { kind: "text", text: "plain prompt", start: 0, end: 12 },
    ]);
    expect(splitInlineContent("", []).parts).toEqual([]);
  });
});
