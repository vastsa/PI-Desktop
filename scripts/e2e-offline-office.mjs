#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bindingForCustomModel } from "../packages/shared/dist/model-catalog.js";
import { IPC } from "../packages/shared/dist/protocol.js";
import { waitFor } from "./e2e/wait.mjs";

const appBin = process.env.PI_CODE_E2E_APP_BIN;
assert.ok(appBin, "Set PI_CODE_E2E_APP_BIN to the installed Pie Code binary.");
assert.equal(process.platform + "/" + process.arch, "linux/arm64");
assert.ok(Object.values(networkInterfaces()).flat().every((address) => address.internal),
  "Run in an isolated network namespace with only loopback enabled.");

const root = await mkdtemp(join(tmpdir(), "pie-office-e2e-"));
const workspace = join(root, "project");
const resources = join(dirname(appBin), "resources");
const wxRuntime = join(resources, "wx-runtime");
const python = join(resources, "office-runtime/python/bin/python3.12");
const launcher = join(resources, "plugins/pie.offline-office/word/word.sh");
const model = "offline-office-fixture";
const created = "新建 样例.docx";
const original = "原始 样例.docx";
const edited = "另存 样例.docx";
const marker = "OFFLINE_OFFICE_FIXTURE_COMPLETE";
const requests = [];
const before = "跨格式文字";
const after = "替换内容";
const untouched = "不修改的中文段落";
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const word = {
  skill: "word", output: created,
  commands: [
    `create ${quote(created)} '中文标题' < body.txt`,
    `extract ${quote(original)}`,
    `replace ${[original, edited, before, after].map(quote).join(" ")}`,
  ],
  verify(stdout) {
    assert.ok(stdout.includes(untouched));
  },
};
const excel = {
  skill: "excel", output: "新建 样例.xlsx", input: "原始 样例.xlsx",
  commands: [
    `create '新建 样例.xlsx' '销售 数据' < rows.json`,
    `read '新建 样例.xlsx' '销售 数据'`,
    `edit '原始 样例.xlsx' '另存 样例.xlsx' '销售 数据' 'B2' '160'`,
    `recalc '另存 样例.xlsx' '重算 样例.xlsx'`,
    `read '重算 样例.xlsx' '销售 数据'`,
  ],
  verify(stdout) {
    const tables = stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    assert.deepEqual(tables, [
      { columns: ["项目", "金额"], data: [["甲", 150], ["乙", 100]] },
      { columns: ["项目", "金额", "合计", "工时", "整列合计"], data: [["甲", 160, 260, 99000, 260], ["乙", 100, "", "", ""]] },
    ]);
  },
};
const pptBody = "新建正文含中文";
const pptUntouched = "不修改的第二页";
const hiddenPptText = "隐藏形状中的文字";
const ambiguousPptCopy = "有歧义的 副本.pptx";
const ppt = {
  skill: "ppt", output: "新建 样例.pptx", input: "原始 样例.pptx", edited: "另存 样例.pptx",
  get commands() {
    return [
      `create -- ${quote(this.output)} < slides.json`,
      `extract -- ${quote(this.output)}`,
      `extract -- ${quote(this.input)}`,
      `replace -- ${[this.input, this.edited, "1", before, after].map(quote).join(" ")}`,
      `extract -- ${quote(this.edited)}`,
    ];
  },
  get rejectedCommand() {
    return `replace -- ${[this.input, ambiguousPptCopy, "1", "1", after].map(quote).join(" ")}`;
  },
  verify(stdout, stderr) {
    assert.ok(stdout.includes(`Slide 1\n中文标题\n${pptBody}\n\nSlide 2\n新建第二页\n可编辑正文`),
      "The Agent must see text from both slides of the created deck.");
    assert.ok(stdout.includes(`Slide 1\n原件首页\n${before}，保留后缀\n1\n页码 1\n\nSlide 2\n${pptUntouched}\n${before}`),
      "The Agent must see text from the original deck.");
    assert.ok(stdout.includes(`Slide 1\n原件首页\n${after}，保留后缀\n1\n页码 1\n\nSlide 2\n${pptUntouched}\n${before}`),
      "The Agent must see the edited first slide and untouched second slide in the saved copy.");
    assert.ok(!stdout.includes(hiddenPptText), "Hidden shape text must not reach the Agent.");
    assert.match(stderr, /Text occurs more than once on this slide/);
  },
};
const wx = {
  skill: "wx", output: "WX 排版 Markdown", input: "WX 原稿.md", docx: "WX 原稿.docx",
  docxOutput: "WX 排版 Word", reviewOutput: "WX 独立审查",
  get commands() {
    return [
      `convert ${[this.input, this.output].map(quote).join(" ")}`,
      `convert ${[this.docx, this.docxOutput].map(quote).join(" ")}`,
      `review ${[this.docx, this.reviewOutput].map(quote).join(" ")}`,
    ];
  },
  get rejectedCommand() {
    return `review ${[this.docx, this.output].map(quote).join(" ")}`;
  },
  verify(stdout, stderr) {
    assert.match(stdout, /Review complete: \d+(?:\.\d+)?\/100/);
    assert.match(stderr, /File exists/);
  },
};
const scenarios = [word, excel, ppt, wx];
const skillId = (scenario) => `pie.offline-office/${scenario.skill}`;
const toolText = (content) => Array.isArray(content)
  ? content.map((part) => part.text ?? "").join("\n")
  : String(content);
let scenario = word;
let connected;
let desktop;
let log = "";
let modelError;

const provider = createServer(async (req, res) => {
  try {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ data: [{ id: model }] }));
    }
    assert.equal(req.url, "/v1/chat/completions");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    requests.push(request);
    const system = request.messages.filter((message) => ["system", "developer"].includes(message.role));
    const id = skillId(scenario);
    const enabled = JSON.stringify(system).includes(id);
    const tools = request.tools.map((tool) => tool.function.name);
    const skill = request.messages.find((message) => message.role === "tool" &&
      toolText(message.content).includes("Location: ") && toolText(message.content).includes(id));
    let tool;
    if (enabled && !skill) {
      assert.ok(tools.includes("Skill"));
      tool = { name: "Skill", arguments: JSON.stringify({ id }) };
    } else if (skill && !request.messages.some((message) =>
      message.tool_calls?.some((call) => call.function.name === "Bash"))) {
      const location = /Location: ([^\n]+\/SKILL\.md)/.exec(toolText(skill.content))?.[1];
      assert.equal(location, join(resources, "plugins/pie.offline-office", scenario.skill, "SKILL.md"));
      const launcher = "/bin/sh " + quote(join(dirname(location), `${scenario.skill}.sh`));
      const commands = scenario.commands.map((args) => `${launcher} ${args}`);
      if (scenario.rejectedCommand) commands.push(`! ${launcher} ${scenario.rejectedCommand}`);
      const command = commands.join(" && ");
      assert.ok(tools.includes("Bash"));
      tool = { name: "Bash", arguments: JSON.stringify({ command }) };
    }
    const delta = tool ? { role: "assistant", tool_calls: [{
      index: 0, id: scenario.skill + "_" + tool.name, type: "function", function: tool,
    }] } : { role: "assistant", content: marker };
    const frame = (change, reason) => "data: " + JSON.stringify({
      id: "office-fixture", object: "chat.completion.chunk", created: 1, model,
      choices: [{ index: 0, delta: change, finish_reason: reason }],
    }) + "\n\n";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(frame(delta, null) + frame({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
  } catch (error) {
    modelError = error;
    res.writeHead(500).end("Invalid fixture request");
  }
});

async function boot() {
  log = "";
  desktop = spawn(appBin, ["--remote-debugging-port=0", "--user-data-dir=" + join(root, "profile")], {
    cwd: dirname(appBin),
    env: {
      PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      HOME: root, PI_DESKTOP_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: join(root, "agent"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [desktop.stdout, desktop.stderr]) stream.on("data", (chunk) => { log += chunk; });
  let page;
  await waitFor(async () => {
    if (desktop.exitCode !== null) throw new Error("Pie Code quit before opening its window.");
    const port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(log)?.[1];
    if (!port) return false;
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((result) => result.json());
    page = pages.find((entry) => entry.type === "page" && /renderer\/index\.html$/.test(entry.url));
    return page;
  }, 30_000, "Pie Code window", 200);
  connected = new WebSocket(page.webSocketDebuggerUrl);
  await once(connected, "open");
  let seq = 0;
  const evaluate = async (expression) => {
    const call = ++seq;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connected.removeEventListener("message", receive);
        reject(new Error("Desktop evaluation timed out."));
      }, 10_000);
      function receive(event) {
        const result = JSON.parse(event.data);
        if (result.id !== call) return;
        connected.removeEventListener("message", receive);
        clearTimeout(timer);
        resolve(result);
      }
      connected.addEventListener("message", receive);
    });
    connected.send(JSON.stringify({
      id: call, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true },
    }));
    const result = await reply;
    assert.ok(result.result && !result.result.exceptionDetails, JSON.stringify(result));
    return result.result.result.value;
  };
  const wire = (channel, ...args) => evaluate("window.piDesktop?.invoke(... " + JSON.stringify([channel, ...args]) + ")");
  await waitFor(async () => (await wire(IPC.invoke.appGetVersion))?.data?.hostVersion, 30_000, "Host ready", 200);
  const invoke = async (channel, ...args) => {
    const result = await wire(channel, ...args);
    assert.equal(result?.ok, true, channel + ": " + JSON.stringify(result));
    return result.data;
  };
  return { evaluate, invoke };
}

async function stop() {
  connected?.close();
  if (!desktop || desktop.exitCode !== null || desktop.signalCode !== null) return;
  const exited = once(desktop, "exit");
  desktop.kill("SIGTERM");
  const force = setTimeout(() => desktop.kill("SIGKILL"), 5_000);
  try { await exited; } finally { clearTimeout(force); }
}

async function selectOffice({ evaluate }, enabled) {
  const targetClass = enabled ? "is-global" : "is-off";
  const label = enabled ? "Everywhere" : "Off";
  const row = `[...document.querySelectorAll(".plugins-row")].find(
    el => el.querySelector(".plugins-row-id")?.textContent === "pie.offline-office")`;
  await waitFor(() => evaluate(`(() => {
    if ((${row})?.getClientRects().length) return true;
    const nav = document.querySelector('[data-nav=plugins]');
    if (!nav) return false;
    nav.click(); return true;
  })()`), 20_000, "Extensions navigation");
  await waitFor(() => evaluate(`(${row})?.querySelector(".plugins-row-name")?.textContent === "Offline Office"`),
    20_000, "English extension name");
  await waitFor(() => evaluate(`(() => {
    const trigger = (${row})?.querySelector(".scope-compact-trigger");
    if (!trigger) return false;
    trigger.click(); return true;
  })()`), 20_000, "bundled Offline Office card");
  await waitFor(() => evaluate(`(() => {
    const option = [...document.querySelectorAll(".scope-compact-option")]
      .find(el => el.getAttribute("aria-label") === ${JSON.stringify(label)});
    if (!option) return false;
    option.click(); return true;
  })()`), 20_000, "extension scope " + label);
  await waitFor(() => evaluate(`Boolean((${row})?.querySelector(".scope-compact-trigger.${targetClass}"))`),
    20_000, "extension state " + label);
}

async function runTurn({ invoke }, providerId, current, enabled) {
  scenario = current;
  modelError = undefined;
  const id = skillId(current);
  requests.length = 0;
  const { session } = await invoke(IPC.invoke.sessionCreate, {
    title: `${current.skill} fixture`, projectPath: workspace, mode: "agent", providerId, modelId: model,
  });
  await invoke(IPC.invoke.agentPrompt, {
    sessionId: session.id, content: `Perform the offline ${current.skill} fixture.`, permissionMode: "ask",
  });
  if (enabled) {
    let permission;
    await waitFor(async () => {
      if (modelError) throw modelError;
      const pending = await invoke(IPC.invoke.pendingInteractive, { sessionId: session.id });
      permission = pending.permissions.find((entry) => entry.toolName === "Bash");
      return permission;
    }, 25_000, "normal Bash approval", 150);
    await assert.rejects(stat(join(workspace, current.output)), { code: "ENOENT" });
    await invoke(IPC.invoke.toolResolvePermission, { requestId: permission.requestId, decision: "allow-once" });
  }
  await waitFor(async () => {
    if (modelError) throw modelError;
    return JSON.stringify(await invoke(IPC.invoke.sessionGet, session.id)).includes(marker);
  }, 45_000, `${current.skill} turn completion`, 150);
  assert.equal(JSON.stringify(requests[0]?.messages).includes(id), enabled);
  if (enabled) {
    const reply = requests.flatMap(({ messages }) => messages).find((message) =>
      message.role === "tool" && message.tool_call_id === `${current.skill}_Bash`);
    assert.ok(reply, `Missing Bash result for ${current.skill}`);
    const { exitCode, stdout, stderr } = JSON.parse(toolText(reply.content));
    assert.equal(exitCode, 0, stderr);
    current.verify(stdout, stderr);
  }
}

try {
  await assert.rejects(access(wxRuntime, constants.W_OK), (error) => ["EACCES", "EROFS"].includes(error.code),
    "Run against a read-only WX installation as a normal user.");
  await mkdir(workspace);
  await writeFile(join(workspace, "body.txt"), "新建正文含中文\n");
  const py = (script, ...args) => execFileSync(python, ["-I", "-B", "-X", "utf8", "-c", script, ...args], { cwd: workspace });
  const excelFixture = fileURLToPath(new URL("../apps/desktop/test/offline-office-excel.test.py", import.meta.url));
  const runExcelFixture = (mode) => execFileSync(python, ["-I", "-B", "-X", "utf8", excelFixture, mode], { cwd: workspace });
  runExcelFixture("fixture");
  const originalExcel = await readFile(join(workspace, excel.input));
  py(`from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
import sys
doc = Document()
doc.add_heading("原件标题", level=1)
p = doc.add_paragraph()
p.add_run("跨格式").bold = True
p.add_run("文字，保留后缀").italic = True
doc.add_paragraph(${JSON.stringify(untouched)})
p = doc.add_paragraph()
p.add_run("AB")._r.append(OxmlElement("w:noBreakHyphen"))
p.add_run("CD")
p = doc.add_paragraph()
p.add_run("甲")
tab = OxmlElement("w:ptab")
for key, value in {"alignment": "center", "relativeTo": "margin", "leader": "none"}.items():
    tab.set(qn("w:" + key), value)
p.add_run()._r.append(tab)
p.add_run("乙")
doc.save(sys.argv[1])`, original);
  const originalBytes = await readFile(join(workspace, original));
  const wxBody = "本段用于确认正文内容没有丢失。";
  const originalMarkdown = `# 离线办公技术说明\n\n## 1. 验证目标\n\n${wxBody}\n\n` +
    "## 2. 验证结果\n\n| 项目 | 结果 |\n| --- | --- |\n| 文件转换 | 通过 |\n";
  await writeFile(join(workspace, wx.input), originalMarkdown);
  py(`from docx import Document
import sys
doc = Document()
doc.add_heading("离线办公技术说明", level=0)
doc.add_heading("1. 验证目标", level=1)
doc.add_paragraph(${JSON.stringify(wxBody)})
doc.add_heading("2. 验证结果", level=1)
doc.add_paragraph("验证完成。")
doc.save(sys.argv[1])`, wx.docx);
  const originalWxDocx = await readFile(join(workspace, wx.docx));
  const wxCache = join(root, "data/offline-office/wx-0.21.3/deps/.wxdf-state.json");
  await assert.rejects(stat(wxCache), { code: "ENOENT" });
  await writeFile(join(workspace, "slides.json"), JSON.stringify([
    { title: "中文标题", body: pptBody }, { title: "新建第二页", body: "可编辑正文" },
  ]));
  py(`from pptx import Presentation
from pptx.oxml import parse_xml
from pptx.oxml.ns import qn
from pptx.util import Inches
import sys
deck = Presentation()
slide = deck.slides.add_slide(deck.slide_layouts[1])
slide.shapes.title.text = "原件首页"
para = slide.placeholders[1].text_frame.paragraphs[0]
para.add_run().text = "跨格式"
para.runs[0].font.bold = True
para.add_run().text = "文字，保留后缀"
def box(text):
    shape = slide.shapes.add_textbox(0, 0, Inches(2), Inches(1))
    shape.text = text
    return shape
box(${JSON.stringify(hiddenPptText)})._element.find(".//" + qn("p:cNvPr")).set("hidden", "1")
box("1")
footer = box("页码 ")
footer.text_frame.paragraphs[0]._p.append(parse_xml(
    '<a:fld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'id="{9AE197BA-8C2B-4FC0-AFA6-C3138E0160A1}" type="slidenum"><a:t>1</a:t></a:fld>'))
slide = deck.slides.add_slide(deck.slide_layouts[1])
slide.shapes.title.text = ${JSON.stringify(pptUntouched)}
slide.placeholders[1].text = ${JSON.stringify(before)}
deck.save(sys.argv[1])`, ppt.input);
  const originalPpt = await readFile(join(workspace, ppt.input));

  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const app = await boot();
  const row = async (current) => (await current.invoke(IPC.invoke.pluginList)).plugins.find((plugin) => plugin.id === "pie.offline-office");
  assert.equal((await row(app))?.bundled, true);
  assert.equal((await row(app))?.enabled, false);
  await app.invoke(IPC.invoke.settingsSet, { language: "en", defaultPermissionMode: "ask" });
  await app.invoke(IPC.invoke.projectSet, workspace);
  const { provider: configured } = await app.invoke(IPC.invoke.providersCreate, {
    name: "Office fixture", vendorKey: "custom", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    authKind: "none", apiStyle: "chat_completions", defaultModelId: model, models: [bindingForCustomModel(model)],
  });
  await selectOffice(app, true);
  for (const current of scenarios) {
    await waitFor(async () => (await app.invoke(IPC.invoke.composerCommands)).commands.some((command) => command.skillId === skillId(current)),
      15_000, `Office ${current.skill} skill registration`, 150);
    await runTurn(app, configured.id, current, true);
  }
  assert.equal(await readFile(join(workspace, wx.input), "utf8"), originalMarkdown);
  assert.deepEqual(await readFile(join(workspace, wx.docx)), originalWxDocx);
  assert.equal(JSON.parse(await readFile(wxCache, "utf8")).python_tag, "cp312");
  await assert.rejects(stat(join(wxRuntime, ".deps")), { code: "ENOENT" });
  await assert.rejects(stat(join(workspace, wx.output, "review.md")), { code: "ENOENT" });
  for (const directory of [wx.output, wx.docxOutput]) {
    const summary = JSON.parse(await readFile(join(workspace, directory, "audit.json"), "utf8")).public_summary;
    assert.equal(summary.status, "completed");
    assert.equal(summary.unexpected_styles_count, 0);
    const audits = Object.values(summary.audits).map((audit) => typeof audit === "string" ? audit : audit.status);
    assert.ok(audits.includes("passed") && audits.every((status) =>
      ["passed", "not_run", "not_applicable", "skipped"].includes(status)), JSON.stringify(summary));
    py(`from docx import Document
import sys
doc = Document(sys.argv[1])
assert any(${JSON.stringify(wxBody)} in para.text for para in doc.paragraphs)`, join(directory, "formatted.docx"));
  }
  const review = await readFile(join(workspace, wx.reviewOutput, "review.md"), "utf8");
  assert.match(review, /总分：\d+(?:\.\d+)?\/100/);
  assert.match(review, /## 问题清单/);
  assert.match(review, /## 整改建议[\s\S]*开头的手工编号多余，请删掉/);
  assert.deepEqual(await readFile(join(workspace, excel.input)), originalExcel);
  runExcelFixture("verify");
  assert.deepEqual(await readFile(join(workspace, ppt.input)), originalPpt);
  await assert.rejects(stat(join(workspace, ambiguousPptCopy)), { code: "ENOENT" });
  py(`from pptx import Presentation
from zipfile import ZipFile
import sys
created, original, edited = sys.argv[1:]
new, copy = Presentation(created), Presentation(edited)
assert [(s.shapes.title.text, s.placeholders[1].text) for s in new.slides] == [
    ("中文标题", ${JSON.stringify(pptBody)}), ("新建第二页", "可编辑正文")]
assert len(copy.slides) == 2 and copy.slides[0].shapes.title.text == "原件首页"
assert copy.slides[0].placeholders[1].text == "${after}，保留后缀"
assert copy.slides[0].placeholders[1].text_frame.paragraphs[0].runs[0].font.bold
assert copy.slides[1].shapes.title.text == ${JSON.stringify(pptUntouched)}
assert copy.slides[1].placeholders[1].text == ${JSON.stringify(before)}
with ZipFile(original) as a, ZipFile(edited) as b:
    assert a.namelist() == b.namelist()
    assert [part for part in a.namelist() if a.read(part) != b.read(part)] == ["ppt/slides/slide1.xml"]
`, ppt.output, ppt.input, ppt.edited);
  assert.deepEqual(await readFile(join(workspace, original)), originalBytes);
  py(`from docx import Document
from zipfile import ZipFile
import sys
created, original, edited = sys.argv[1:]
new, copy = Document(created), Document(edited)
assert [p.text for p in new.paragraphs] == ["中文标题", "新建正文含中文"]
assert new.paragraphs[0].style.name == "Heading 1"
assert [p.text for p in copy.paragraphs[:3]] == ["原件标题", "${after}，保留后缀", "${untouched}"]
assert [p._p.xml for p in copy.paragraphs[3:]] == [p._p.xml for p in Document(original).paragraphs[3:]]
assert copy.paragraphs[0].style.name == "Heading 1"
assert copy.paragraphs[1].runs[0].bold and copy.paragraphs[1].runs[1].italic
with ZipFile(original) as a, ZipFile(edited) as b:
    assert a.namelist() == b.namelist()
    assert all(a.read(part) == b.read(part) for part in a.namelist() if part != "word/document.xml")
`, created, original, edited);
  const rejected = "不能覆盖.docx";
  const tool = (operation, ...args) => execFileSync("/bin/sh", [launcher, operation, ...args], {
    cwd: workspace, encoding: "utf8", input: "should not overwrite", stdio: "pipe",
  });
  assert.ok(tool("extract", original).split("\n").includes("甲\t乙"));
  for (const separated of ["ABCD", "甲乙"]) {
    assert.throws(() => tool("replace", original, rejected, separated, "collapsed"), /Text was not found/);
    await assert.rejects(stat(join(workspace, rejected)), { code: "ENOENT" });
  }
  for (const [name, bytes] of [[original, originalBytes], [edited, await readFile(join(workspace, edited))]]) {
    assert.throws(() => tool("replace", original, name, before, after), /Output already exists/);
    assert.throws(() => tool("create", name, "Not a new document"), /Output already exists/);
    assert.deepEqual(await readFile(join(workspace, name)), bytes);
  }

  await selectOffice(app, false);
  await stop();
  const restarted = await boot();
  assert.equal((await row(restarted))?.enabled, false);
  for (const current of scenarios) await runTurn(restarted, configured.id, current, false);
  console.log("PASS: offline Office enablement, Bash approval, Word readback, Excel pandas read/write and formula cache 250 → 260, PowerPoint readback, WX first-use cache and conversion audits for Markdown and DOCX, independent WX review, source preservation, and disablement after restart");
} catch (error) {
  console.error(log.slice(-6000));
  const pluginLog = await readFile(join(root, "data/logs/app/plugin.log"), "utf8").catch(() => "");
  console.error(pluginLog.split("\n").filter((line) => line.includes("pie.offline-office")).slice(-12).join("\n"));
  console.error("Fixture requests:", requests.map((request) => ({
    roles: request.messages.map((message) => message.role),
    advertised: JSON.stringify(request.messages).includes(skillId(scenario)),
    calls: request.messages.flatMap((message) => message.tool_calls?.map((call) => call.function.name) ?? []),
    results: request.messages.filter((message) => message.role === "tool").map((message) => String(message.content).slice(0, 320)),
  })));
  throw error;
} finally {
  await stop();
  provider.close();
  provider.closeAllConnections();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
