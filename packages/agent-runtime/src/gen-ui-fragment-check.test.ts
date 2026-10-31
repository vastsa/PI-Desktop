import { describe, expect, it } from "vitest";
import { checkGenUiFragment, genUiFragmentCheckNote, isGenUiFragmentPath } from "./gen-ui-fragment-check.js";

describe("isGenUiFragmentPath", () => {
  const dir = "/data/visualizations/sess_1";

  it("accepts an absolute .html file directly in the session directory", () => {
    expect(isGenUiFragmentPath(`${dir}/sales.html`, dir)).toBe(true);
    expect(isGenUiFragmentPath(`${dir}/Sales.HTML`, dir)).toBe(true);
  });

  it("rejects other files, other directories, and relative paths", () => {
    expect(isGenUiFragmentPath(`${dir}/notes.md`, dir)).toBe(false);
    expect(isGenUiFragmentPath(`${dir}/nested/a.html`, dir)).toBe(false);
    expect(isGenUiFragmentPath(`${dir}/../sess_2/a.html`, dir)).toBe(false);
    expect(isGenUiFragmentPath("/project/index.html", dir)).toBe(false);
    expect(isGenUiFragmentPath("sales.html", dir)).toBe(false);
    expect(isGenUiFragmentPath(`${dir}/a.html`, undefined)).toBe(false);
    expect(isGenUiFragmentPath(42, dir)).toBe(false);
  });
});

describe("checkGenUiFragment", () => {
  it("passes a well-formed fragment", () => {
    const fragment = `<div id="sales"></div><button id="more">More</button>
<script>
const c = viz.render("sales", { mark: "line", data: [], x: "m", y: "v" });
document.getElementById("more").onclick = () => c.update({ data: [] });
document.querySelector("#sales");
</script>`;
    expect(checkGenUiFragment(fragment)).toEqual([]);
  });

  it("reports a container id the fragment never defines, listing the ids it has", () => {
    // The blank card seen in a live model run: the chart targeted "sb-bar".
    const issues = checkGenUiFragment(`<div id="sb-chart"></div><script>viz.render("sb-bar", { mark: "bar" });</script>`);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('element id "sb-bar"');
    expect(issues[0]).toContain('"sb-chart"');
  });

  it("checks viz.chart, getElementById, and #id querySelector targets", () => {
    const issues = checkGenUiFragment(
      `<script>viz.chart("#a", () => {}); document.getElementById('b'); document.querySelector("#c");</script>`,
    );
    expect(issues.map((issue) => issue.match(/element id "(\w+)"/)?.[1])).toEqual(["a", "b", "c"]);
  });

  it("counts ids a script creates itself and ignores dynamic ids", () => {
    const fragment = `<script>
const el = document.createElement("div"); el.id = "made"; document.body.append(el);
d3.select("body").append("div").attr("id", "d3made");
viz.render("made", {}); viz.render("d3made", {});
viz.render(\`chart-\${n}\`, {}); document.getElementById(name);
</script>`;
    expect(checkGenUiFragment(fragment)).toEqual([]);
  });

  it("reports a script that does not parse without running it", () => {
    const issues = checkGenUiFragment(`<div id="x"></div><script>globalThis.ran = true; const a = ;</script>`);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^Script 1 does not parse: /);
    expect((globalThis as { ran?: boolean }).ran).toBeUndefined();
  });

  it("skips external, JSON, and module scripts for syntax checks", () => {
    const fragment = `<div id="x"></div>
<script src="pi-genui://assets/x.js"></script>
<script type="application/json">{ not js </script>
<script type="module">import x from "y"; viz.render("x", {});</script>`;
    expect(checkGenUiFragment(fragment)).toEqual([]);
  });

  it("ignores ids that only appear inside script text when collecting markup ids", () => {
    const issues = checkGenUiFragment(`<script>const html = '<div id="fake"></div>'; viz.render("fake", {});</script>`);
    expect(issues).toHaveLength(1);
  });

  it("bounds the number of reported issues", () => {
    const calls = Array.from({ length: 9 }, (_, i) => `viz.render("m${i}", {});`).join("");
    expect(checkGenUiFragment(`<script>${calls}</script>`)).toHaveLength(5);
  });
});

describe("genUiFragmentCheckNote", () => {
  it("asks for one Edit and lists each issue", () => {
    const note = genUiFragmentCheckNote(["first", "second"]);
    expect(note).toContain("Fix them with one Edit, then reply:");
    expect(note).toContain("- first\n- second");
  });
});
