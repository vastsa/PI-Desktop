import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const plugin = new URL("../resources/offline-office/", import.meta.url);
const source = "-原始 演示.pptx";
const edited = "另存 演示.pptx";

test("the bundled extension advertises PPT and its launcher requires the bundled Python", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pie-ppt-launcher-"));
  try {
    const installed = join(root, "plugins", "pie.offline-office");
    await cp(plugin, installed, { recursive: true });
    const manifest = JSON.parse(await readFile(join(installed, "manifest.json"), "utf8"));
    const skill = manifest.contributes.skills.find(({ id }) => id === "ppt");
    assert.equal(skill?.path, "ppt/SKILL.md");
    assert.match(await readFile(join(installed, skill.path), "utf8"), /Offline PowerPoint/);
    const result = spawnSync("/bin/sh", [join(installed, "ppt", "ppt.sh"), "extract", source], {
      cwd: root, env: { PATH: "" }, encoding: "utf8",
    });
    assert.equal(result.status, 1, result.error?.message ?? result.stderr);
    assert.match(result.stderr, /bundled Office Runtime is missing/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function withPowerPoint(t, verify) {
  const check = spawnSync("python3", ["-c", "import pptx"]);
  if (check.status !== 0) {
    t.skip("Python 3 with python-pptx is available in the Office Runtime, not this host.");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "pie-ppt-roundtrip-"));
  const script = fileURLToPath(new URL("ppt/presentation.py", plugin));
  const run = (args, input) => spawnSync("python3", ["-B", "-X", "utf8", ...args], {
    cwd: root, input, encoding: "utf8",
  });
  const success = (result) => {
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout;
  };
  const ppt = (operation, ...args) => run([script, operation, "--", ...args]);
  const inspect = (program, ...args) => success(run(["-c", program, ...args]));
  try {
    await verify({ root, run, inspect, ppt, script, success });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("PPT creates editable slides, extracts them in deck order and saves just the selected slide", (t) =>
  withPowerPoint(t, async ({ root, run, inspect, ppt, script, success }) => {
    const slides = JSON.stringify([
      { title: "第二页标题", body: "这段内容保留，重复词" },
      { title: "首页标题", body: "重复词，保留后缀" },
    ]);
    success(run([script, "create", "--", source], slides));
    inspect(`from pptx import Presentation
from pptx.util import Inches
import sys
p = Presentation(sys.argv[1])
assert [(s.shapes.title.text, s.placeholders[1].text) for s in p.slides] == [
    ("第二页标题", "这段内容保留，重复词"), ("首页标题", "重复词，保留后缀")]
first, second = list(p.slides._sldIdLst)
p.slides._sldIdLst.insert(0, second)
para = p.slides[0].placeholders[1].text_frame.paragraphs[0]
para.runs[0].text = "重复"
para.runs[0].font.bold = True
suffix = para.add_run()
suffix.text = "词，保留后缀"
suffix.font.italic = True
para.add_line_break()
para.add_run().text = "换行"
shapes = p.slides[0].shapes
group = shapes.add_group_shape()
group.shapes.add_textbox(0, 0, Inches(2), Inches(1)).text = "组合文字"
table = shapes.add_table(1, 2, 0, 0, Inches(4), Inches(1)).table
table.cell(0, 0).text = "表格文字，保留后缀"
table.cell(0, 1).text = "-文字"
p.save(sys.argv[1])`, source);
    const original = await readFile(join(root, source));
    const extracted = success(ppt("extract", source));
    assert.match(extracted, /Slide 1\n首页标题\n重复词，保留后缀\n换行\n组合文字\n表格文字，保留后缀\n-文字\n\nSlide 2\n第二页标题\n这段内容保留，重复词/);
    success(ppt("replace", source, edited, "1", "重复词", "已修改"));
    assert.match(success(ppt("extract", edited)), /首页标题\n已修改，保留后缀/);
    assert.deepEqual(await readFile(join(root, source)), original);
    inspect(`from pptx import Presentation
from zipfile import ZipFile
import sys
source, output = sys.argv[1:]
deck = Presentation(output)
assert len(deck.slides) == 2
para = deck.slides[0].placeholders[1].text_frame.paragraphs[0]
assert [r.text for r in para.runs] == ["已修改", "，保留后缀", "换行"], [r.text for r in para.runs]
assert para.runs[0].font.bold and para.runs[1].font.italic
assert deck.slides[1].shapes.title.text == "第二页标题"
with ZipFile(source) as before, ZipFile(output) as after:
    assert before.namelist() == after.namelist()
    assert [name for name in before.namelist() if before.read(name) != after.read(name)] == ["ppt/slides/slide2.xml"]`, source, edited);

    const existing = await readFile(join(root, edited));
    success(ppt("replace", source, "表格 副本.pptx", "1", "-文字", "-已修改"));
    assert.match(success(ppt("extract", "表格 副本.pptx")), /表格文字，保留后缀\n-已修改/);
    for (const name of [source, edited]) {
      const result = ppt("replace", source, name, "1", "重复词", "不会覆盖");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Output already exists/);
      assert.match(run([script, "create", "--", name], slides).stderr, /Output already exists/);
    }
    for (const [page, old, error] of [
      ["3", "重复词", /out of range/i],
      ["1", "后缀换行", /Text was not found/],
      ["1", "保留后缀", /Text occurs more than once/],
    ]) {
      const result = ppt("replace", source, "无效 副本.pptx", page, old, "未写入");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, error);
      await assert.rejects(stat(join(root, "无效 副本.pptx")), { code: "ENOENT" });
    }
    assert.deepEqual(await readFile(join(root, source)), original);
    assert.deepEqual(await readFile(join(root, edited)), existing);

    await writeFile(join(root, "无效 文件.pptx"), "not a zip");
    const bad = ppt("extract", "无效 文件.pptx");
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /PowerPoint operation failed/);
  }));

test("PPT excludes hidden shapes and recognizes visible read-only fields", (t) =>
  withPowerPoint(t, async ({ root, inspect, ppt, success }) => {
    inspect(`from pptx import Presentation
from pptx.oxml import parse_xml
from pptx.oxml.ns import qn
from pptx.util import Inches
import sys

deck = Presentation()
slide = deck.slides.add_slide(deck.slide_layouts[6])
shapes = slide.shapes
def box(collection, text):
    shape = collection.add_textbox(0, 0, Inches(3), Inches(1))
    shape.text = text
    return shape
def hide(shape, value):
    shape._element.find(".//" + qn("p:cNvPr")).set("hidden", value)

box(shapes, "可见正文")
hide(box(shapes, "隐藏文本"), "true")
group = shapes.add_group_shape()
box(group.shapes, "可见正文")
hide(group, "1")
box(shapes, "1")
footer = box(shapes, "Page ")
footer.text_frame.paragraphs[0]._p.append(parse_xml(
    '<a:fld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'id="{9AE197BA-8C2B-4FC0-AFA6-C3138E0160A1}" type="slidenum"><a:t>1</a:t></a:fld>'))
deck.save(sys.argv[1])`, source);

    await t.test("omits hidden text without treating it as a duplicate", () => {
      assert.equal(success(ppt("extract", source)), "Slide 1\n可见正文\n1\nPage 1\n");
      success(ppt("replace", source, "可见 副本.pptx", "1", "可见正文", "改写正文"));
      assert.equal(success(ppt("extract", "可见 副本.pptx")), "Slide 1\n改写正文\n1\nPage 1\n");
    });

    await t.test("counts page numbers for uniqueness and refuses to edit a field", async () => {
      for (const [old, message] of [["1", /Text occurs more than once/], ["Page 1", /read-only field/i]]) {
        const result = ppt("replace", source, edited, "1", old, "不会写入");
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, message);
        await assert.rejects(stat(join(root, edited)), { code: "ENOENT" });
      }
    });
  }));

test("PPT rejects duplicate package parts and checks the expanded size before reading slides", (t) =>
  withPowerPoint(t, async ({ inspect, ppt, script }) => {
    inspect(`from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile
from pptx import Presentation
import sys

source, script = sys.argv[1:]
sys.path.insert(0, str(Path(script).parent))
from presentation import check_package

deck = Presentation()
deck.slides.add_slide(deck.slide_layouts[1])
deck.save(source)
with ZipFile(source) as archive:
    size = sum(part.file_size for part in archive.infolist())
    with patch("presentation.MAX_EXPANDED_SIZE", size):
        check_package(archive)
    with patch("presentation.MAX_EXPANDED_SIZE", size - 1):
        try:
            check_package(archive)
        except ValueError as error:
            assert str(error) == "Expanded presentation exceeds 256 MiB."
        else:
            raise AssertionError("An archive above the expanded-size limit was accepted")
with ZipFile(source, "a") as archive:
    archive.writestr("docProps/custom-note.txt", "first")
    archive.writestr("docProps/custom-note.txt", "second")`, source, script);

    const result = ppt("extract", source);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duplicate package parts/i);
  }));
