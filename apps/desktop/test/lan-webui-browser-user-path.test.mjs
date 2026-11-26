import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
  // A direct control.click() bypasses hit testing and misses full-page interceptors.
  const tap = (control) => {
    control.scrollIntoView({ block: "center" });
    const bounds = control.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    if (!hit || !control.contains(hit)) throw new Error("Pointer blocked by " + (hit?.id || hit?.className || "no target"));
    hit.click();
  };
  const result = {};

  // Pair with the code shown on Desktop.
  const code = await wait(() => document.getElementById("pair-code"), "pair form");
  code.value = "123";
  const form = document.querySelector(".pair");
  const submit = form.querySelector("button[type=submit]");
  tap(submit);
  await wait(() => /six digits|六位数字/.test(document.getElementById("pair-status").textContent), "client input validation");
  code.value = Array.from(window.__code, (digit) => String.fromCharCode(digit.charCodeAt(0) + 0xfee0)).join(" ");
  tap(submit);
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

  // Redeeming the code connects immediately, without a second Desktop action.
  await wait(() => rowByTitle("Alpha"), "projects");
  result.projects = [...document.querySelectorAll(".row-title")].map((n) => n.textContent);
  const temporary = await wait(() => rowByTitle("Temporary conversations") ?? rowByTitle("临时会话"), "temporary entry");
  tap(temporary.querySelector(".row-main"));
  await wait(() => rowByTitle("Scratch") && document.querySelector("main > button.primary"), "temporary conversations");
  history.back();
  await wait(() => rowByTitle("Alpha"), "back to projects");

  // Open a project and see its sessions.
  tap(rowByTitle("Alpha").querySelector(".row-main"));
  await wait(() => rowByTitle("Fix login"), "sessions");
  result.sessions = [...document.querySelectorAll(".row-title")].map((n) => n.textContent);
  result.projectHash = location.hash;
  result.strayText = [document.getElementById("app").innerText];

  // Organize from the row menu: pin.
  tap(rowByTitle("Fix login").querySelector(".row-more"));
  await wait(() => !document.getElementById("sheet").hidden, "sheet");
  tap(document.querySelectorAll("#sheet-actions button")[1]);
  await wait(() => rowByTitle("Fix login")?.querySelector(".row-meta"), "pinned meta");
  result.pinnedMeta = rowByTitle("Fix login").querySelector(".row-meta").textContent;

  // Closing the menu must let the next tap reach an existing conversation.
  tap(rowByTitle("Fix login").querySelector(".row-main"));
  await wait(() => document.querySelector(".msg.user")?.textContent.includes("hello"), "existing transcript");
  history.back();
  await wait(() => rowByTitle("Fix login"), "back from existing transcript");

  // Create a new conversation in this project and send a message.
  tap(document.querySelector("main > button.primary"));
  const input = await wait(() => document.getElementById("composer-input"), "composer");
  result.chatHash = location.hash;
  input.value = "hello from phone";
  input.dispatchEvent(new Event("input"));
  tap(document.querySelector(".composer button.primary"));
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
  history.back();
  await wait(() => rowByTitle("Alpha"), "back to projects before sign-out");
  tap(document.querySelector("main > button.link"));
  await wait(() => document.getElementById("pair-code"), "sign-out returns to pairing");
  result.polledApproval = performance.getEntriesByType("resource").some((entry) => new URL(entry.name).pathname === "/pair/status");
  result.pairRequests = performance.getEntriesByType("resource").filter((entry) => new URL(entry.name).pathname === "/pair").length;
  return JSON.stringify(result);
})()`;

async function runPhone(t, script, { scan = false, blockCookie = false } = {}) {
  const { electronBinary } = resolveElectronBinary();
  const fake = desktop();
  const server = createLanServer({ handler: fake.workspace, assets: await assets() });
  const { port } = await server.start("127.0.0.1", 0);
  server.issueCode();
  const code = server.code().value;
  const origin = `http://127.0.0.1:${port}`;
  const entry = `${origin}/${scan ? `#pair=${code}` : ""}`;
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "lan-webui-ui-"));
  t.after(async () => {
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
    if (${blockCookie}) {
      window.webContents.session.webRequest.onHeadersReceived({ urls: [${JSON.stringify(`${origin}/pair`)}] }, (details, reply) => {
        const responseHeaders = Object.fromEntries(Object.entries(details.responseHeaders ?? {}).filter(([key]) => key.toLowerCase() !== "set-cookie"));
        reply({ responseHeaders });
      });
    }
    await window.loadURL(${JSON.stringify(entry)});
    await window.webContents.executeJavaScript(${JSON.stringify(`window.__code = ${JSON.stringify(code)};`)});
    const output = await window.webContents.executeJavaScript(${JSON.stringify(script)});
    process.stdout.write("RESULT " + output + "\\n");
    app.exit(0);
  } catch (error) {
    process.stderr.write(String(error && error.stack || error) + "\\n");
    app.exit(1);
  }
});
`);
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, signal: t.signal });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [exitCode] = await once(child, "close");
  assert.equal(exitCode, 0, stderr);
  const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
  assert.ok(line, stdout + stderr);
  return { result: JSON.parse(line.slice(7)), fake, server };
}

test("a phone pairs with a formatted paste, uses projects and conversations, and signs out", { timeout: 60_000 }, async (t) => {
  const { result, fake, server } = await runPhone(t, journey);

  assert.match(result.projects[0], /^(Temporary conversations|临时会话)$/);
  assert.deepEqual(result.projects.slice(1), ["Alpha", "Beta"]);
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
  assert.equal(result.polledApproval, false);
  assert.equal(result.pairRequests, 1, "invalid input and a duplicate submit did not reach the listener");
  assert.equal(server.devices().length, 0, "browser sign-out revoked its device");
});

const scanJourney = String.raw`(async () => {
  const field = () => document.getElementById("pair-code");
  async function wait(check) {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      if (check()) return;
      await new Promise(requestAnimationFrame);
    }
    throw new Error("Scanned code did not advance the pairing flow");
  }
  await wait(() => field()?.value === window.__code && !location.hash);
  const other = window.__code === "000000" ? "111111" : "000000";
  location.hash = "#pair=" + other;
  await wait(() => field()?.value === other && !location.hash);
  location.hash = "#pair=" + window.__code;
  await wait(() => field()?.value === window.__code && !location.hash);
  const submittedEarly = performance.getEntriesByType("resource").some((entry) => new URL(entry.name).pathname === "/pair");
  document.querySelector('.pair button[type="submit"]').click();
  await wait(() => [...document.querySelectorAll(".row-title")].some((row) => row.textContent === "Alpha"));
  return JSON.stringify({ submittedEarly, fragment: location.hash });
})()`;

test("a scanned fragment prefills and clears without redeeming the code until submit", { timeout: 60_000 }, async (t) => {
  const { result, server } = await runPhone(t, scanJourney, { scan: true });
  assert.deepEqual(result, { submittedEarly: false, fragment: "" });
  assert.equal(server.devices().length, 1);
});

const rejectedCookieJourney = String.raw`(async () => {
  const deadline = performance.now() + 5000;
  const input = () => document.getElementById("pair-code");
  while (!input()?.value && performance.now() < deadline) await new Promise(requestAnimationFrame);
  document.querySelector('.pair button[type="submit"]').click();
  while (performance.now() < deadline) {
    const status = document.getElementById("pair-status")?.textContent;
    if (/cookies|Cookie/.test(status ?? "")) return JSON.stringify({ prompted: true, cleared: input().value === "" });
    await new Promise(requestAnimationFrame);
  }
  throw new Error("A rejected session cookie did not show an actionable pairing error");
})()`;

test("a browser that rejects the session cookie gets an actionable pairing error", { timeout: 60_000 }, async (t) => {
  const { result, server } = await runPhone(t, rejectedCookieJourney, { scan: true, blockCookie: true });
  assert.deepEqual(result, { prompted: true, cleared: true });
  assert.equal(server.code(), null, "the one-time code was accepted, not retried");
});

test("a legacy pending response tells the user to restart the desktop", { timeout: 60_000 }, async (t) => {
  const script = String.raw`(async () => {
    const field = () => document.getElementById("pair-code");
    const deadline = performance.now() + 5000;
    while (!field() && performance.now() < deadline) await new Promise(requestAnimationFrame);
    const request = window.fetch.bind(window);
    window.fetch = (path, options) => path === "/pair"
      ? Promise.resolve(Response.json({ state: "pending" })) : request(path, options);
    field().value = window.__code;
    document.querySelector('.pair button[type="submit"]').click();
    while (performance.now() < deadline) {
      const status = document.getElementById("pair-status")?.textContent ?? "";
      if (/Restart PI-Desktop|重启 PI-Desktop/.test(status)) return JSON.stringify(true);
      await new Promise(requestAnimationFrame);
    }
    throw new Error("Missing restart guidance for the old pairing response");
  })()`;
  assert.equal((await runPhone(t, script)).result, true);
});
