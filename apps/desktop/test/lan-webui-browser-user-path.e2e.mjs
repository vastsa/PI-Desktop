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
    ["/kit.js", { type: "text/javascript; charset=utf-8", body: await read("kit.js") }],
    ["/markdown.js", { type: "text/javascript; charset=utf-8", body: await read("markdown.js") }],
    ["/model-picker.js", { type: "text/javascript; charset=utf-8", body: await read("model-picker.js") }],
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
  const titles = (selector) => [...document.querySelectorAll(selector + " .row-title")].map((n) => n.textContent);
  const view = () => document.getElementById("app").dataset.view;
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
  // Home answers "what was I doing" first: recent conversations across projects.
  await wait(() => rowByTitle("Alpha"), "projects");
  result.projects = titles("#section-projects");
  result.recent = titles("#section-recent");
  result.recentScope = rowByTitle("Scratch").querySelector(".row-meta").textContent;

  // Searching re-renders the list but keeps the field focused with its text.
  const search = document.getElementById("list-search");
  search.focus();
  search.value = "Al";
  search.dispatchEvent(new Event("input"));
  await wait(() => rowByTitle("Alpha") && !rowByTitle("Beta"), "filtered projects");
  result.searchKept = document.activeElement?.id === "list-search" && document.activeElement.value === "Al";
  // One search covers conversations in every project too.
  document.activeElement.value = "login";
  document.activeElement.dispatchEvent(new Event("input"));
  await wait(() => rowByTitle("Fix login") && !rowByTitle("Alpha"), "conversation search");
  result.searchSessions = titles("#section-recent");
  document.activeElement.value = "";
  document.activeElement.dispatchEvent(new Event("input"));
  await wait(() => rowByTitle("Beta"), "cleared search");

  // A recent conversation opens straight from Home and renders safe Markdown.
  tap(rowByTitle("Scratch").querySelector(".row-main"));
  await wait(() => view() === "chat:s-tmp" && document.querySelector(".msg.md strong"), "rich transcript");
  const answer = [...document.querySelectorAll(".msg.md")].pop();
  result.markdown = {
    strong: answer.querySelector("strong")?.textContent,
    codeLang: answer.querySelector(".code-block .code-lang")?.textContent,
    code: answer.querySelector(".code-block pre code")?.textContent,
    items: answer.querySelectorAll("ul > li").length,
    links: [...answer.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.target, a.rel]),
    localLinkText: answer.textContent.includes("local"),
    image: answer.querySelector(".md-image")?.textContent,
    images: document.querySelectorAll("img").length,
    scripts: document.querySelectorAll("#app script").length,
    pwned: window.__pwned === true,
    rawHtmlShown: answer.textContent.includes("<script>"),
  };
  const steps = document.querySelector("details.steps");
  result.steps = { count: steps?.querySelector(".steps-count")?.textContent, names: steps?.querySelector(".steps-names")?.textContent, open: steps?.open };
  result.copyActions = document.querySelectorAll(".msg-actions button").length;
  result.leakedInSteps = document.body.textContent.includes("/secret/path");
  history.back();
  await wait(() => view() === "home" && rowByTitle("Alpha"), "back to home");

  const temporary = await wait(() => rowByTitle("Temporary conversations") ?? rowByTitle("临时会话"), "temporary entry");
  tap(temporary.querySelector(".row-main"));
  await wait(() => view() === "sessions:__temporary__" && rowByTitle("Scratch") && document.querySelector("main > button.primary"), "temporary conversations");
  history.back();
  await wait(() => view() === "home" && rowByTitle("Alpha"), "back to projects");

  // Open a project and see its sessions.
  tap(rowByTitle("Alpha").querySelector(".row-main"));
  await wait(() => view() === "sessions:g-a" && rowByTitle("Fix login"), "sessions");
  result.sessions = [...document.querySelectorAll(".row-title")].map((n) => n.textContent);
  result.projectHash = location.hash;
  result.strayText = [document.getElementById("app").innerText];

  // Archived items live behind one quiet entry, not a sticky filter.
  tap(document.querySelector(".footer-link"));
  await wait(() => view() === "sessions:g-a:archived" && document.querySelector(".empty"), "archived view");
  result.archivedHash = location.hash;
  history.back();
  await wait(() => view() === "sessions:g-a" && rowByTitle("Fix login"), "back from archived");

  // Organize from the row menu: pin.
  tap(rowByTitle("Fix login").querySelector(".row-more"));
  await wait(() => !document.getElementById("sheet").hidden, "sheet");
  tap(document.querySelectorAll("#sheet-actions button")[1]);
  await wait(() => rowByTitle("Fix login")?.querySelector(".row-meta"), "pinned meta");
  result.pinnedMeta = rowByTitle("Fix login").querySelector(".row-meta").textContent;

  // Rename inside the action sheet, without a native prompt.
  tap(rowByTitle("Fix login").querySelector(".row-more"));
  await wait(() => !document.getElementById("sheet").hidden, "sheet for rename");
  tap(document.querySelectorAll("#sheet-actions button")[0]);
  const rename = await wait(() => document.getElementById("rename-input"), "rename field");
  result.renameFocused = document.activeElement === rename && rename.value === "Fix login";
  rename.value = "Fix login flow";
  tap(document.querySelector("#sheet-actions button[type=submit]"));
  await wait(() => rowByTitle("Fix login flow"), "renamed row");
  result.sheetClosed = document.getElementById("sheet").hidden;

  // Closing the menu must let the next tap reach an existing conversation.
  tap(rowByTitle("Fix login flow").querySelector(".row-main"));
  await wait(() => document.querySelector(".msg.user")?.textContent.includes("hello"), "existing transcript");
  history.back();
  await wait(() => rowByTitle("Fix login flow"), "back from existing transcript");

  // Create a new conversation in this project and send a message.
  tap(document.querySelector("main > button.primary"));
  const input = await wait(() => document.getElementById("composer-input"), "composer");
  result.chatHash = location.hash;
  result.emptyChat = document.querySelector(".chat-empty-title")?.textContent;
  input.value = "hello from phone";
  input.dispatchEvent(new Event("input"));
  // Search and select a configured model before sending the same draft.
  tap(document.getElementById("model-trigger"));
  const modelSearch = await wait(() => document.querySelector("dialog[open] input:not([hidden])"), "model search");
  modelSearch.value = "steady";
  modelSearch.dispatchEvent(new Event("input"));
  const matches = document.querySelectorAll("dialog[open] .model-options button");
  result.modelMatches = Array.from(matches, (button) => button.querySelector(".model-option-name").textContent);
  tap(matches[0]);
  await wait(() => !document.querySelector("dialog[open]") && document.getElementById("model-trigger").textContent.includes("steady-chat"), "model saved");
  result.draftAfterModelChange = document.getElementById("composer-input").value;
  tap(document.getElementById("model-trigger"));
  result.checkedModel = (await wait(() => document.querySelector('dialog[open] button[aria-current="true"] .model-option-name'), "selected model")).textContent;
  tap(document.querySelector("dialog[open] .model-picker-header button"));
  tap(document.querySelector(".composer button.primary"));
  // The message shows at once, before the Host confirms it.
  result.optimistic = document.querySelector(".msg.user.pending")?.textContent.includes("hello from phone") === true;
  await wait(() => document.querySelector(".composer .stop") && document.querySelector(".working"), "sent");
  result.messages = [...document.querySelectorAll(".msg")].map((n) => n.className.split(" ")[1]);
  result.leaked = document.body.textContent.includes("/secret/path");
  result.strayText.push(document.getElementById("app").innerText);
  // While a reply runs: a working cue, and Stop is the only action until there is text.
  result.working = Boolean(document.querySelector(".working"));
  result.modelBusy = document.getElementById("model-trigger").disabled;
  result.composerRunning = {
    sendHidden: document.querySelector(".composer .send").hidden,
    stop: Boolean(document.querySelector(".composer .stop")?.offsetParent),
  };
  const follow = document.getElementById("composer-input");
  follow.value = "and then?";
  follow.dispatchEvent(new Event("input"));
  result.composerQueue = !document.querySelector(".composer .send").hidden;
  follow.value = "";
  follow.dispatchEvent(new Event("input"));

  // Phone layout: no horizontal scroll and touch-sized controls.
  result.horizontalScroll = document.documentElement.scrollWidth > window.innerWidth;
  result.smallTargets = [...document.querySelectorAll("button")].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).length;

  // Back returns to the project's session list.
  history.back();
  await wait(() => view() === "sessions:g-a" && rowByTitle("Fix login flow"), "back to sessions");
  result.backHash = location.hash;
  history.back();
  await wait(() => view() === "home" && rowByTitle("Alpha"), "back to projects");

  // From Home, New conversation only asks where it should live.
  tap(document.querySelector("main > button.primary"));
  await wait(() => !document.getElementById("sheet").hidden, "project picker");
  result.picker = [...document.querySelectorAll("#sheet-actions button:not(.cancel)")].map((b) => b.textContent);
  tap([...document.querySelectorAll("#sheet-actions button")].find((b) => b.textContent === "Beta"));
  await wait(() => view()?.startsWith("chat:s-new-2") && document.getElementById("composer-input"), "picked conversation");
  result.pickedHash = location.hash;
  history.back();
  await wait(() => view() === "home" && rowByTitle("Alpha"), "back home before sign-out");

  // Disconnecting asks first, because pairing again needs a new code.
  tap(document.querySelector(".signout"));
  await wait(() => !document.getElementById("sheet").hidden, "sign-out confirmation");
  result.stillSignedIn = !document.getElementById("pair-code");
  tap(document.querySelector("#sheet-actions button.danger"));
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
  assert.deepEqual(result.recent, ["Scratch", "Second root chat", "Fix login", "A plan"], "recent conversations span every project");
  assert.match(result.recentScope, /Temporary conversations|临时会话/, "a recent row names where it lives");
  assert.deepEqual(result.searchSessions, ["Fix login"]);
  assert.deepEqual(result.markdown, {
    strong: "all",
    codeLang: "sh",
    code: "pnpm test",
    items: 2,
    links: [["https://example.com/docs", "_blank", "noopener noreferrer"]],
    localLinkText: true,
    image: "diagram",
    images: 0,
    scripts: 0,
    pwned: false,
    rawHtmlShown: true,
  });
  assert.match(result.steps.count, /2/);
  assert.equal(result.steps.names, "Read, Bash");
  assert.equal(result.steps.open, false, "tool steps start folded");
  assert.equal(result.copyActions, 1, "copy sits under the last answer of the exchange");
  assert.equal(result.leakedInSteps, false);
  assert.equal(result.archivedHash, "#/p/g-a/archived");
  assert.deepEqual(result.sessions, ["Fix login", "A plan"]);
  assert.equal(result.projectHash, "#/p/g-a");
  assert.ok(result.pinnedMeta.length > 0, "the pinned label is shown");
  assert.equal(fake.meta.sessionMeta["s-a1"].pinned, true);
  assert.equal(result.searchKept, true, "a live search keeps the focused field and its text");
  assert.equal(result.renameFocused, true, "rename opens an in-page field with the current name");
  assert.equal(result.sheetClosed, true);
  assert.equal(fake.sessions.find((session) => session.id === "s-a1").title, "Fix login flow");
  assert.match(result.chatHash, /^#\/s\/s-new-1$/);
  assert.equal(result.emptyChat, "Alpha", "a new conversation shows where it will run");
  assert.deepEqual(result.modelMatches, ["Steady"]);
  assert.equal(result.draftAfterModelChange, "hello from phone");
  assert.equal(result.checkedModel, "Steady");
  assert.equal(result.modelBusy, true);
  assert.equal(fake.sessions.find(({ id }) => id === "s-new-1").modelId, "steady-chat");
  assert.equal(result.optimistic, true, "a sent message appears before the Host confirms it");
  assert.equal(result.working, true);
  assert.deepEqual(result.composerRunning, { sendHidden: true, stop: true });
  assert.equal(result.composerQueue, true, "typing while a reply runs offers to queue");
  assert.deepEqual(result.picker.slice(1), ["Alpha", "Beta"]);
  assert.match(result.picker[0], /Temporary conversations|临时会话/);
  assert.equal(result.pickedHash, "#/s/s-new-2");
  assert.deepEqual(fake.calls.filter(([channel]) => channel === "create").map(([, args]) => args[0]), [{ projectPath: "/work/a" }, { projectPath: "/work/b" }]);
  assert.equal(result.stillSignedIn, true, "sign-out waits for confirmation");
  assert.equal(fake.turns.length, 1);
  assert.equal(fake.turns[0].params.input.text, "hello from phone");
  assert.equal(fake.turns[0].params.sessionId, "s-new-1");
  assert.deepEqual(result.messages, ["user"], "the Host has not recorded the turn yet, so the optimistic bubble stays");
  assert.equal(result.leaked, false);
  for (const text of result.strayText) assert.doesNotMatch(text, /\bnull\b|undefined/, "no placeholder text leaks into the page");
  assert.equal(result.horizontalScroll, false);
  assert.equal(result.smallTargets, 0);
  assert.equal(result.backHash, "#/p/g-a");
  assert.equal(result.polledApproval, false);
  assert.equal(result.pairRequests, 1, "invalid input and a duplicate submit did not reach the listener");
  assert.equal(server.devices().length, 0, "browser sign-out revoked its device");
});

test("late history stays with its chat while the current chat can page through a refresh", { timeout: 60_000 }, async (t) => {
  const script = String.raw`(async () => {
    const wait = async (check) => {
      const deadline = performance.now() + 5000;
      while (!check()) {
        if (performance.now() > deadline) throw new Error("Timed out: " + check);
        await new Promise(requestAnimationFrame);
      }
    };
    const older = () => document.querySelector(".load-older");
    const messages = () => document.querySelector(".messages").textContent;
    const view = () => document.getElementById("app").dataset.view;
    let events;
    window.EventSource = class extends EventSource {
      constructor(url) { super(url); events = this; }
    };
    const refresh = async () => {
      const button = older();
      events.dispatchEvent(new MessageEvent("change", { data: "{}" }));
      await wait(() => older() && older() !== button);
    };
    const pages = new Map();
    const request = window.fetch.bind(window);
    window.fetch = async (path, options) => {
      const url = new URL(path, location.href);
      const id = url.pathname.split("/")[3];
      if (url.pathname.endsWith("/history")) {
        return new Promise((resolve) => pages.set(id, {
          cursor: url.searchParams.get("cursor"),
          finish: (text, nextCursor) => resolve(Response.json({ items: [{ id: text, role: "user", text }], nextCursor })),
        }));
      }
      const response = await request(path, options);
      if (path === "/v1/sessions/s-a1" || path === "/v1/sessions/s-b1") {
        const detail = await response.json();
        detail.messages.nextCursor = id === "s-a1" ? "80" : "40";
        return Response.json(detail);
      }
      return response;
    };

    await wait(() => document.getElementById("pair-code")?.value === window.__code);
    document.querySelector('.pair button[type="submit"]').click();
    await wait(() => view() === "home");
    location.hash = "#/s/s-a1";
    await wait(() => view() === "chat:s-a1" && older());
    older().click();
    await wait(() => pages.has("s-a1"));
    location.hash = "#/s/s-b1";
    await wait(() => view() === "chat:s-b1" && older());
    pages.get("s-a1").finish("Older message from A", "70");
    await refresh();
    const showedA = messages().includes("Older message from A");

    older().click();
    await wait(() => pages.has("s-b1"));
    await refresh();
    pages.get("s-b1").finish("Older message from B", null);
    await wait(() => messages().includes("Older message from B"));
    return JSON.stringify({ showedA, cursor: pages.get("s-b1").cursor, hasMore: Boolean(older()) });
  })()`;
  const { result } = await runPhone(t, script, { scan: true });
  assert.deepEqual(result, { showedA: false, cursor: "40", hasMore: false });
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

test("the shipped Markdown renderer keeps GFM structure and defuses unsafe input", { timeout: 60_000 }, async (t) => {
  const script = String.raw`(async () => {
    while (!window.LanMarkdown) await new Promise(requestAnimationFrame);
    const options = { labels: { copyCode: "Copy code", image: "Image" }, onCopy() {} };
    const html = (source) => {
      const box = document.createElement("div");
      box.append(window.LanMarkdown.render(source, options));
      return box.innerHTML;
    };
    return JSON.stringify({
      nested: html("- a\n  - b\n- c"),
      ordered: html("3. x\n4. y"),
      table: html("| a | b |\n|:-|-:|\n| 1 \\| 2 | ${"`"}x|y${"`"} |"),
      inlineFence: html("${"```"}code${"```"} stays inline"),
      unterminated: html("${"```"}js\nlet a = 1;"),
      quote: html("> **hi**\n> there"),
      unsafeLink: html("[x](javascript:alert(1)) [y](https://ok.test/a)"),
      arithmetic: html("2 * 3 * 4"),
      bareUrl: html("see https://ok.test/path."),
      heading: html("## Title ##"),
      softBreak: html("one\ntwo  \nthree"),
    });
  })()`;
  const { result } = await runPhone(t, script);
  assert.equal(result.nested, "<ul><li><p>a</p><ul><li><p>b</p></li></ul></li><li><p>c</p></li></ul>");
  assert.equal(result.ordered, '<ol start="3"><li><p>x</p></li><li><p>y</p></li></ol>');
  assert.match(result.table, /^<div class="table-wrap"><table><thead><tr><th>a<\/th><th class="align-right">b<\/th><\/tr><\/thead>/);
  assert.match(result.table, /<tbody><tr><td>1 \| 2<\/td><td class="align-right"><code>x\|y<\/code><\/td><\/tr><\/tbody>/);
  assert.equal(result.inlineFence, "<p><code>code</code> stays inline</p>");
  assert.match(result.unterminated, /<span class="code-lang">js<\/span>.*<pre><code>let a = 1;<\/code><\/pre>/);
  assert.equal(result.quote, "<blockquote><p><strong>hi</strong>\nthere</p></blockquote>");
  assert.equal(result.unsafeLink, '<p><span>x</span> <a href="https://ok.test/a" target="_blank" rel="noopener noreferrer">y</a></p>');
  assert.equal(result.arithmetic, "<p>2 * 3 * 4</p>");
  assert.equal(result.bareUrl, '<p>see <a href="https://ok.test/path" target="_blank" rel="noopener noreferrer">https://ok.test/path</a>.</p>');
  assert.equal(result.heading, "<h2>Title</h2>");
  assert.equal(result.softBreak, "<p>one\ntwo<br>three</p>");
});
