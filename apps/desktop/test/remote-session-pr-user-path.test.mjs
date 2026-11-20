import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const chromium = ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { IPC } from "@pi-desktop/shared";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { RemoteSessionActions } from "./src/features/chat/session-target/RemoteSessionActions";

(async () => {
  const report = (body) => fetch("/result", { method: "POST", body });
  try {
    await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
      resources: { en: { translation: flattenCatalog(catalogs.en) } },
      interpolation: { escapeValue: false },
    });
    const old = { number: 7, url: "https://github.com/octo/repo/pull/7" };
    const replacement = { number: 8, url: "https://github.com/octo/repo/pull/8" };
    const opened = [];
    const created = [];
    let lookups = 0;
    let setPullRequest;
    window.piDesktop = {
      on() { return () => {}; },
      async invoke(channel, input) {
        let data;
        switch (channel) {
          case IPC.invoke.remoteHostList: data = { hosts: [] }; break;
          case IPC.invoke.remoteSessionGitStatus: data = { status: { reachable: true } }; break;
          case IPC.invoke.remoteSessionPullRequestFind:
            lookups++;
            data = { pullRequest: lookups === 1 ? old : null };
            break;
          case IPC.invoke.browserOpenExternal: opened.push(input.url); break;
          case IPC.invoke.remoteSessionPullRequestCreate:
            created.push(input);
            flushSync(() => setPullRequest(replacement));
            data = { pullRequest: replacement };
            break;
          default: throw new Error("Unexpected channel " + channel);
        }
        return { ok: true, data };
      },
    };
    function Surface() {
      const [pullRequest, update] = React.useState(old);
      setPullRequest = update;
      return <RemoteSessionActions sessionId="session" sessionTitle="Ship the fix" workspace={{
        hostKey: "host", repository: { owner: "octo", name: "repo" },
        baseBranch: "main", workBranch: "pi-desktop/abc", state: "ready", pullRequest,
      }} />;
    }
    const view = createRoot(document.querySelector("#root"));
    flushSync(() => view.render(<Surface />));
    const button = (label, container = document) => [...container.querySelectorAll("button")]
      .find((element) => element.textContent.trim() === label);
    async function until(read, description) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const value = read();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(description);
    }
    button("View PR #7").click();
    await until(() => opened.length === 1 && !button("View PR #7").disabled, "could not open an existing PR");
    button("View PR #7").click();
    const dialog = await until(() => document.querySelector('[role="dialog"]'), "could not replace closed PR");
    if (lookups !== 2 || opened.length !== 1) throw new Error("stale PR URL was opened");
    if (dialog.querySelector("input").value !== "Ship the fix") throw new Error("missing replacement title");
    button("Create pull request", dialog).click();
    await until(() => button("View PR #8"), "replacement PR was not shown");
    if (created.length !== 1 || created[0].sessionId !== "session") throw new Error("wrong replacement request");
    await report("PASS");
  } catch (error) {
    await report(error.stack ?? String(error));
  }
})();
`;

test("the session action rechecks the cached PR and can create a replacement", {
  skip: !chromium && "Chromium is unavailable",
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-remote-pr-"));
  const timer = new AbortController();
  let browser;
  let server;
  try {
    const bundle = await build({
      stdin: { contents: fixture, resolveDir: join(root, "apps/desktop"), loader: "tsx" },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const { promise: result, resolve: report } = Promise.withResolvers();
    server = createServer(async (req, res) => {
      if (req.url === "/result" && req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        res.end();
        report(Buffer.concat(chunks).toString());
      } else if (req.url === "/renderer.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end(bundle.outputFiles[0].contents);
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end('<div id="root"></div><script src="/renderer.js"></script>');
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    browser = spawn(chromium, ["--headless", "--no-sandbox", "--no-first-run", "--disable-gpu",
      "--disable-background-networking", "--disable-dev-shm-usage", "--no-proxy-server",
      `--user-data-dir=${join(temp, "browser")}`, `http://127.0.0.1:${server.address().port}/`],
    { stdio: "ignore" });
    const response = await Promise.race([
      result,
      once(browser, "exit").then(([code]) => { throw new Error(`Chromium exited early (${code})`); }),
      sleep(15_000, undefined, { signal: timer.signal }).then(() => { throw new Error("Renderer did not report its result"); }),
    ]);
    assert.equal(response, "PASS");
  } finally {
    timer.abort();
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = once(browser, "exit");
      browser.kill();
      await exited;
    }
    server?.closeAllConnections();
    await new Promise((resolve) => server ? server.close(resolve) : resolve());
    await rm(temp, { recursive: true, force: true });
  }
});
