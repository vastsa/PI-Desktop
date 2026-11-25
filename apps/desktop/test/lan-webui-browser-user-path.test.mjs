import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";
import { createLanServer, desktop } from "./helpers/lan-webui-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const resources = join(here, "../resources/lan-webui");

async function assets() {
  const read = (name) => readFile(join(resources, name), "utf8");
  return new Map([
    ["/index.html", { type: "text/html; charset=utf-8", body: await read("index.html") }],
    ["/app.js", { type: "text/javascript; charset=utf-8", body: await read("app.js") }],
    ["/locale.js", { type: "text/javascript; charset=utf-8", body: await read("locale.js") }],
    ["/styles.css", { type: "text/css; charset=utf-8", body: await read("styles.css") }],
  ]);
}

/** Runs inside the page: the phone user's journey, reported as JSON. */
const journey = String.raw`(async () => {
  const wait = async (fn, label) => {
    for (let i = 0; i < 200; i += 1) {
      const value = fn();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timed out waiting for " + label);
  };
  const rowByTitle = (title) => [...document.querySelectorAll(".row")].find((row) => row.querySelector(".row-title")?.textContent === title);
  const result = {};

  // Pair with the code shown on Desktop.
  const code = await wait(() => document.getElementById("pair-code"), "pair form");
  code.value = window.__code;
  document.querySelector(".pair button[type=submit]").click();

  // Desktop approves; the shared projects appear (the unshared one does not).
  await wait(() => rowByTitle("Alpha"), "projects");
  result.projects = [...document.querySelectorAll(".row-title")].map((n) => n.textContent);

  // Open a project and see its sessions.
  rowByTitle("Alpha").querySelector(".row-main").click();
  await wait(() => rowByTitle("Fix login"), "sessions");
  result.sessions = [...document.querySelectorAll(".row-title")].map((n) => n.textContent);
  result.projectHash = location.hash;
  result.strayText = [document.getElementById("app").innerText];

  // Organize from the row menu: pin.
  rowByTitle("Fix login").querySelector(".row-more").click();
  await wait(() => !document.getElementById("sheet").hidden, "sheet");
  document.querySelectorAll("#sheet-actions button")[1].click();
  await wait(() => rowByTitle("Fix login")?.querySelector(".row-meta"), "pinned meta");
  result.pinnedMeta = rowByTitle("Fix login").querySelector(".row-meta").textContent;

  // Create a new conversation in this project and send a message.
  document.querySelector("main > button.primary").click();
  const input = await wait(() => document.getElementById("composer-input"), "composer");
  result.chatHash = location.hash;
  input.value = "hello from phone";
  input.dispatchEvent(new Event("input"));
  document.querySelector(".composer button.primary").click();
  await wait(() => document.querySelectorAll(".msg").length >= 2 && input.isConnected === false || document.getElementById("composer-input")?.value === "", "sent");
  result.messages = [...document.querySelectorAll(".msg")].map((n) => n.className.split(" ")[1]);
  result.leaked = document.body.textContent.includes("/secret/path");
  result.strayText.push(document.getElementById("app").innerText);

  // Phone layout: no horizontal scroll and touch-sized controls.
  result.horizontalScroll = document.documentElement.scrollWidth > window.innerWidth;
  result.smallTargets = [...document.querySelectorAll("button")].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).length;

  // Back returns to the project's session list.
  history.back();
  await wait(() => rowByTitle("Fix login"), "back to sessions");
  result.backHash = location.hash;
  return JSON.stringify(result);
})()`;

test("a phone pairs, organizes, creates and sends through the real page", { timeout: 60_000 }, async (t) => {
  const { electronBinary } = resolveElectronBinary();
  const fake = desktop();
  const server = createLanServer({ handler: fake.workspace, assets: await assets() });
  const { port } = await server.start("127.0.0.1", 0);
  server.issueCode();
  const code = server.code().value;
  // Desktop-side approval as soon as the phone asks.
  const approver = setInterval(() => {
    const [pending] = server.pending();
    if (pending) server.confirm(pending.id, { projectIds: ["g-a"], temporary: false, chat: true, organize: true });
  }, 50);
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "lan-webui-ui-"));
  t.after(async () => {
    clearInterval(approver);
    await server.stop();
    fake.workspace.dispose();
    await rm(temp, { recursive: true, force: true });
  });
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await window.loadURL(${JSON.stringify(`http://127.0.0.1:${port}/`)});
    await window.webContents.executeJavaScript("window.__code = ${code};");
    const output = await window.webContents.executeJavaScript(${JSON.stringify(journey)});
    process.stdout.write("RESULT " + output + "\\n");
    app.exit(0);
  } catch (error) {
    process.stderr.write(String(error && error.stack || error) + "\\n");
    app.exit(1);
  }
});
`);
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exitCode, 0, stderr);
  const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
  assert.ok(line, stdout + stderr);
  const result = JSON.parse(line.slice(7));

  assert.deepEqual(result.projects, ["Alpha"]);
  assert.deepEqual(result.sessions, ["Fix login", "A plan"]);
  assert.equal(result.projectHash, "#/p/g-a");
  assert.ok(result.pinnedMeta.length > 0, "the pinned label is shown");
  assert.equal(fake.meta.sessionMeta["s-a1"].pinned, true);
  assert.match(result.chatHash, /^#\/s\/s-new-1$/);
  assert.equal(fake.turns.length, 1);
  assert.equal(fake.turns[0].params.input.text, "hello from phone");
  assert.equal(fake.turns[0].params.sessionId, "s-new-1");
  assert.ok(result.messages.includes("user") && result.messages.includes("assistant"));
  assert.equal(result.leaked, false);
  for (const text of result.strayText) assert.doesNotMatch(text, /\bnull\b|undefined/, "no placeholder text leaks into the page");
  assert.equal(result.horizontalScroll, false);
  assert.equal(result.smallTargets, 0);
  assert.equal(result.backHash, "#/p/g-a");
});
