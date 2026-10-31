import { describe, expect, it } from "vitest";
import {
  genUiLocationFromPath,
  genUiLocationFromUrl,
  genUiUrl,
  GEN_UI_MAX_FRAGMENT_BYTES,
  isGenUiFragmentReadResult,
  parseGenUiReferenceLine,
  splitGenUiReferences,
} from "./gen-ui.js";

const PATH = "/Users/me/.pi-desktop/visualizations/sess_01-A/chart.html";

describe("gen-ui references", () => {
  it("maps an absolute visualization path to a data-root-independent URL", () => {
    const location = genUiLocationFromPath(PATH);
    expect(location).toEqual({ sessionId: "sess_01-A", fileName: "chart.html" });
    const url = genUiUrl(location!);
    expect(url).toBe("pi-genui://session/sess_01-A/chart.html");
    expect(genUiLocationFromUrl(url)).toEqual(location);
    expect(genUiLocationFromPath("C:\\data\\visualizations\\s1\\a.html")).toEqual({
      sessionId: "s1",
      fileName: "a.html",
    });
  });

  it("rejects paths and URLs outside the contract", () => {
    for (const path of [
      "/tmp/chart.html",
      "/data/visualizations/s1/chart.js",
      "/data/visualizations/s1/sub/chart.html",
      "/data/visualizations/s.1/chart.html",
      "/data/visualizations/s1/.hidden.html",
    ]) {
      expect(genUiLocationFromPath(path)).toBeNull();
    }
    for (const url of [
      "pi-genui://session/s1/../x.html",
      "pi-genui://session/s1/%2E%2E%2Fx.html",
      "pi-genui://other/s1/a.html",
      "pi-genui://session/s1/a.html?x=1",
      "https://session/s1/a.html",
      "pi-genui://session/s1/a/b.html",
    ]) {
      expect(genUiLocationFromUrl(url)).toBeNull();
    }
  });

  it("parses a standalone reference line with an optional title", () => {
    expect(parseGenUiReferenceLine(`  ::visualize{"path":"${PATH}","title":" Chart "}`)).toEqual({
      path: PATH,
      title: "Chart",
      location: { sessionId: "sess_01-A", fileName: "chart.html" },
    });
    expect(parseGenUiReferenceLine('::visualize{"path":1}')).toBeNull();
    expect(parseGenUiReferenceLine("::visualize{not json}")).toBeNull();
    expect(parseGenUiReferenceLine(`see ::visualize{"path":"${PATH}"}`)).toBeNull();
  });

  it("splits references out of prose but never out of code blocks", () => {
    const line = `::visualize{"path":"${PATH}"}`;
    const markdown = [
      "Here is the chart.",
      "",
      "```text",
      line,
      "```",
      "",
      `    ${line}`,
      "",
      line,
      "",
    ].join("\n");
    const split = splitGenUiReferences(markdown);
    expect(split.references).toHaveLength(1);
    expect(split.content).toContain("```text\n" + line + "\n```");
    expect(split.content).toContain(`    ${line}`);
    expect(split.content.split(line)).toHaveLength(3);
  });

  it("accepts a reference the model wrapped alone in the reply's closing code block", () => {
    const line = `::visualize{"path":"${PATH}","title":"Chart"}`;
    for (const fence of ["```text", "```", "~~~"]) {
      const close = fence.startsWith("~") ? "~~~" : "```";
      const split = splitGenUiReferences(["Done.", "", fence, line, close, ""].join("\n"));
      expect(split.references.map(({ path, title }) => ({ path, title }))).toEqual([
        { path: PATH, title: "Chart" },
      ]);
      expect(split.content).toBe("Done.");
    }
    // A closing block with anything besides the reference stays code.
    const mixed = ["Syntax:", "", "```text", "# example", line, "```"].join("\n");
    expect(splitGenUiReferences(mixed).references).toEqual([]);
  });

  it("follows CommonMark fence boundaries around references", () => {
    const line = `::visualize{"path":"${PATH}"}`;
    // A closing fence is not an opener: an indented reference after it stays code.
    const indentedAfterClose = ["```", "code", "```", `    ${line}`, "```"].join("\n");
    expect(splitGenUiReferences(indentedAfterClose).references).toEqual([]);
    // A fence line with an info string cannot close an open block.
    const infoInside = ["```", "code", "```js", line, "```", "after"].join("\n");
    expect(splitGenUiReferences(infoInside).references).toEqual([]);
    // Backticks are legal in a ~~~ info string.
    const tildeInfo = ["~~~ a`b", line, "~~~", "after"].join("\n");
    expect(splitGenUiReferences(tildeInfo).references).toEqual([]);
  });

  it("accepts Windows paths copied with single backslashes", () => {
    const raw = String.raw`::visualize{"path":"C:\Users\me\AppData\pi\visualizations\s1\chart.html","title":"T"}`;
    const reference = parseGenUiReferenceLine(raw);
    expect(reference?.path).toBe(String.raw`C:\Users\me\AppData\pi\visualizations\s1\chart.html`);
    expect(reference?.location).toEqual({ sessionId: "s1", fileName: "chart.html" });
  });

  it("leaves content untouched when there is no reference", () => {
    const markdown = "plain ::visualize text\n\n\n";
    expect(splitGenUiReferences(markdown)).toEqual({ content: markdown, references: [] });
  });
});

describe("native visualization read contract", () => {
  it("accepts bounded bytes and fixed failures only", () => {
    for (const value of [{ ok: true, base64: "PHA+eDwvcD4=" }, { ok: true, base64: "" },
      { ok: false, code: "not-found" }, { ok: false, code: "too-large" }]) {
      expect(isGenUiFragmentReadResult(value)).toBe(true);
    }
    for (const value of [null, [], "bytes", { ok: true }, { ok: true, base64: "AA" },
      { ok: true, base64: "!!!!" }, { ok: true, base64: "====" },
      { ok: false, code: "private-path" }, { ok: false, code: "not-found", path: "/private" },
      { ok: true, base64: "A".repeat(Math.ceil(GEN_UI_MAX_FRAGMENT_BYTES / 3) * 4 + 4) }]) {
      expect(isGenUiFragmentReadResult(value)).toBe(false);
    }
  });
});
