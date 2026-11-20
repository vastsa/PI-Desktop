/**
 * Isolated Electron user path for Settings → Connectors (ADR
 * github-connector, E2E-CONNECTOR-device-login-stores-no-renderer-secret).
 *
 * The page is the only place the user signs in to GitHub, so this drives it
 * the way a person would: tick the workflow option, connect with a device
 * code, see the account, disconnect, then take the pasted-token path. The
 * mocked preload stands in for Electron main and records every call.
 *
 * What it pins beyond "the buttons work": the renderer only ever receives an
 * account, scopes, and a state; a pasted token is handed to main once and is
 * gone from the page afterwards, whether main accepted it or not; and a page
 * that goes away while a code is waiting for approval cancels that login
 * instead of leaving main polling for it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixtureSource = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { ConnectorsSettings } from "../../apps/desktop/src/features/settings/pages/ConnectorsSettings";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const PASTED_TOKEN = "ghp_userPathFixtureToken0123456789";
const REJECTED_TOKEN = "ghp_userPathRejectedToken987654321";
const SIGNED_OUT = { connected: false, deviceLoginAvailable: true };
const OCTOCAT = {
  connected: true,
  deviceLoginAvailable: true,
  account: {
    login: "octocat",
    name: "The Octocat",
    avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
  },
  scopes: ["repo", "read:org", "workflow"],
  tokenKind: "oauth",
};

const apiCalls = [];
const listeners = new Map();
let status = SIGNED_OUT;
let loginCount = 0;
let tokenOutcome = "accept";

function emit(channel, payload) {
  for (const listener of [...(listeners.get(channel) ?? [])]) listener(payload);
}
function loginEvent(loginId, body) {
  emit("pi-desktop/github/event/login", { loginId, vendorId: "github-connector", ...body });
}
function changeTo(next) {
  status = next;
  emit("pi-desktop/github/event/changed", next);
}

window.piDesktop = {
  platform: "darwin",
  on(channel, listener) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(listener);
    return () => listeners.get(channel).delete(listener);
  },
  async invoke(channel, ...args) {
    const input = args[0];
    apiCalls.push({ channel, input });
    switch (channel) {
      case "pi-desktop/github/status":
        return { ok: true, data: status };
      case "pi-desktop/github/login/start":
        loginCount += 1;
        return { ok: true, data: { loginId: "login-" + loginCount } };
      case "pi-desktop/github/login/cancel":
        loginEvent(input, { kind: "cancelled" });
        return { ok: true, data: { ok: true } };
      case "pi-desktop/github/setToken": {
        if (tokenOutcome === "reject") {
          return {
            ok: false,
            error: { code: "GITHUB_INVALID_TOKEN", message: "MAIN PROCESS ENGLISH: invalid token" },
          };
        }
        const next = {
          connected: true,
          deviceLoginAvailable: status.deviceLoginAvailable,
          account: { login: "octocat" },
          scopes: ["read:user", "gist"],
          tokenKind: "pat",
        };
        changeTo(next);
        return { ok: true, data: next };
      }
      case "pi-desktop/github/disconnect": {
        const next = { connected: false, deviceLoginAvailable: status.deviceLoginAvailable };
        changeTo(next);
        return { ok: true, data: next };
      }
      default:
        throw new Error("Unexpected fixture IPC: " + channel);
    }
  },
};

await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});

function Harness() {
  const [round, setRound] = React.useState(0);
  window.__remount = () => setRound((value) => value + 1);
  return React.createElement(ConnectorsSettings, { key: round });
}
const rootNode = createRoot(document.getElementById("root"));
flushSync(() => rootNode.render(React.createElement(Harness)));

// A timer, not requestAnimationFrame: a window that is never shown gets about
// one frame a second, and nothing here needs a paint, only React's commits.
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
async function settle() { await tick(); await tick(); }
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    await settle();
    const value = predicate();
    if (value) return value;
  }
  throw new Error(message + "\n" + document.body.innerText.slice(0, 1200));
}
const text = () => document.body.innerText;
function button(label) {
  return [...document.querySelectorAll("button")]
    .find((candidate) => candidate.textContent.trim() === label);
}
function workflowCheckbox() {
  return [...document.querySelectorAll('label input[type="checkbox"]')].find((candidate) =>
    candidate.closest("label").textContent.includes("Allow changes to GitHub Actions workflow files"),
  );
}
function tokenInput() {
  return document.querySelector('input[name="githubToken"]');
}
function typeToken(value) {
  const input = tokenInput();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function openTokenForm() {
  const summary = [...document.querySelectorAll("summary")]
    .find((candidate) => candidate.textContent.includes("Use a personal access token instead"));
  if (!summary) throw new Error("the token disclosure is missing");
  if (!summary.parentElement.open) flushSync(() => summary.click());
}
const calls = (channel) => apiCalls.filter((call) => call.channel === channel);
const dialog = () => document.querySelector('[role="dialog"]');
async function remountWith(next) {
  status = next;
  flushSync(() => window.__remount());
  await settle();
  await settle();
}

window.githubConnectorProbe = async () => {
  // 1) Signed out: the workflow option is off, sign-in and the token form are offered.
  await waitFor(() => button("Connect GitHub"), "the Connect button did not appear");
  const notConnected = {
    pageExplainsGitHub: text().includes(
      "Pick repositories and branches for remote sessions, push branches, and open pull requests.",
    ),
    workflowOffByDefault: workflowCheckbox()?.checked === false,
    tokenFormOffered: text().includes("Use a personal access token instead"),
    tokenFormClosed: document.querySelector("details")?.open === false,
    noAccountShown: !text().includes("Connected as"),
    noDisconnect: !button("Disconnect"),
  };

  // 2) Connect sends the checkbox value, and the existing login dialog opens.
  flushSync(() => workflowCheckbox().click());
  flushSync(() => button("Connect GitHub").click());
  await waitFor(() => dialog(), "the login dialog did not open");
  await waitFor(() => calls("pi-desktop/github/login/start").length === 1, "login was not started");
  const startInput = calls("pi-desktop/github/login/start")[0].input;
  const dialogNamesGitHub = dialog().textContent.includes("Sign in to GitHub");

  loginEvent("login-1", {
    kind: "deviceCode",
    userCode: "WDJB-MJHT",
    verificationUri: "https://github.com/login/device",
    intervalSeconds: 5,
    expiresInSeconds: 900,
  });
  await waitFor(() => dialog()?.textContent.includes("WDJB-MJHT"), "the device code is not shown");
  const verificationLink = dialog().querySelector('a[href="https://github.com/login/device"]');

  // 3) done, then the status change: the dialog closes and the account shows.
  loginEvent("login-1", { kind: "done", providerId: "github-connector", accountLabel: "octocat" });
  changeTo(OCTOCAT);
  await waitFor(() => text().includes("Connected as octocat"), "the account did not appear");
  await waitFor(() => !dialog(), "the login dialog did not close");
  const avatar = document.querySelector("img");
  const connected = {
    scopesShown: text().includes("Scopes: repo, read:org, workflow"),
    avatarShown: avatar?.getAttribute("src") === OCTOCAT.account.avatarUrl,
    noMissingScopeWarning: !text().includes("This token lacks the repo scope"),
    noReauthBanner: !text().includes("GitHub rejected the saved token"),
    signInControlsGone: !button("Connect GitHub") && !tokenInput(),
    // Signed in through the OAuth App: revoking means removing the app.
    disconnectExplained:
      text().includes("To revoke it, remove the app in your GitHub settings.")
      && !text().includes("delete the token in your GitHub settings"),
    // A finished login is not cancelled a second time when its dialog closes.
    finishedLoginNotCancelled: calls("pi-desktop/github/login/cancel").length === 0,
  };

  // 4) Disconnect asks main and the page returns to signed out.
  flushSync(() => button("Disconnect").click());
  await waitFor(() => button("Connect GitHub"), "disconnect did not return to signed out");
  const disconnectCalled = calls("pi-desktop/github/disconnect").length === 1;

  // 5) The token path: a rejected token leaves nothing behind...
  openTokenForm();
  const inputIsPassword = tokenInput().type === "password";
  const inputAutocompleteOff = tokenInput().autocomplete === "off";
  const saveDisabledWhileEmpty = button("Save token").disabled === true;
  tokenOutcome = "reject";
  typeToken(REJECTED_TOKEN);
  await settle();
  flushSync(() => button("Save token").click());
  await waitFor(() => calls("pi-desktop/github/setToken").length === 1, "the token was not sent");
  await waitFor(() => button("Save token") && !text().includes("Connected as"), "page vanished");
  await settle();
  const toastTexts = () => useAppStore.getState().toasts.map((toast) => toast.message);
  await waitFor(() => toastTexts().length > 0, "the rejected token raised no toast");
  const rejected = {
    // The catalog's sentence for the code, not the text main sent.
    localizedToast: toastTexts().includes(
      flattenCatalog(catalogs.en)["errors.GITHUB_INVALID_TOKEN"],
    ) && !toastTexts().some((message) => message.includes("MAIN PROCESS ENGLISH")),
    sentOnce: calls("pi-desktop/github/setToken")[0].input.token === REJECTED_TOKEN,
    fieldCleared: tokenInput().value === "",
    stillSignedOut: !text().includes("Connected as"),
    notInPage: !document.documentElement.outerHTML.includes(REJECTED_TOKEN),
  };

  // ...and an accepted one connects, with the field cleared as well.
  tokenOutcome = "accept";
  typeToken("  " + PASTED_TOKEN + "  ");
  await settle();
  flushSync(() => button("Save token").click());
  await waitFor(() => text().includes("Connected as octocat"), "the pasted token did not connect");
  const accepted = {
    sentAsTyped: calls("pi-desktop/github/setToken")[1].input.token === "  " + PASTED_TOKEN + "  ",
    onlyTheTokenSent: Object.keys(calls("pi-desktop/github/setToken")[1].input).join() === "token",
    missingScopeWarned: text().includes(
      "This token lacks the repo scope, so private repositories and pushes will not work.",
    ),
    scopesShown: text().includes("Scopes: read:user, gist"),
    notInPage: !document.documentElement.outerHTML.includes(PASTED_TOKEN),
    formGone: !tokenInput(),
    // A pasted token has no app to remove: revoking means deleting the token.
    disconnectExplainedForToken:
      text().includes("To revoke it, delete the token in your GitHub settings.")
      && !text().includes("remove the app in your GitHub settings"),
  };

  // 6) A build without a client id offers only the token path.
  await remountWith({ connected: false, deviceLoginAvailable: false });
  await waitFor(
    () => text().includes("Sign-in with a code is not configured in this build."),
    "the device-unavailable note is missing",
  );
  const deviceUnavailable = {
    connectHidden: !button("Connect GitHub"),
    workflowOptionHidden: !workflowCheckbox(),
    tokenPathOffered: text().includes("Use a personal access token instead"),
  };

  // 7) A rejected stored token: the account stays visible with a way back in.
  await remountWith({ ...OCTOCAT, needsReauthentication: true });
  await waitFor(
    () => text().includes("GitHub rejected the saved token. Connect again."),
    "the re-authentication banner is missing",
  );
  const reauthentication = {
    accountStillShown: text().includes("Connected as octocat"),
    bannerIsAnAlert: Boolean(
      [...document.querySelectorAll('[role="alert"]')]
        .find((node) => node.textContent.includes("GitHub rejected the saved token")),
    ),
    canConnectAgain: Boolean(button("Connect GitHub")),
    canDisconnect: Boolean(button("Disconnect")),
  };

  // 7b) An avatar address that is not GitHub's avatar host is never loaded.
  const strayAvatars = [];
  for (const avatarUrl of [
    "https://evil.example/track.png",
    "https://avatars.githubusercontent.com.evil.example/u/1",
  ]) {
    await remountWith({ ...OCTOCAT, account: { ...OCTOCAT.account, avatarUrl } });
    await waitFor(() => text().includes("Connected as octocat"), "the account did not appear");
    strayAvatars.push({
      noImage: document.querySelectorAll("img").length === 0,
      placeholderShown: Boolean(document.querySelector(".connector-avatar svg")),
      notInPage: !document.documentElement.outerHTML.includes(avatarUrl),
    });
  }
  await remountWith({ ...OCTOCAT, needsReauthentication: true });
  await waitFor(() => button("Connect GitHub"), "the page did not come back");

  // 8) Leaving the page while a code waits for approval cancels that login.
  const cancelsBefore = calls("pi-desktop/github/login/cancel").length;
  flushSync(() => button("Connect GitHub").click());
  await waitFor(() => calls("pi-desktop/github/login/start").length === 2, "second login not started");
  await waitFor(() => dialog(), "the second login dialog did not open");
  const secondStartInput = calls("pi-desktop/github/login/start")[1].input;
  await remountWith(SIGNED_OUT);
  await waitFor(
    () => calls("pi-desktop/github/login/cancel").length === cancelsBefore + 1,
    "the pending login was not cancelled when the page went away",
  );
  const abandonedLoginCancelled =
    calls("pi-desktop/github/login/cancel").at(-1).input === "login-2" && !dialog();

  // 9) The dialog's own Cancel ends the login and closes it.
  await waitFor(() => button("Connect GitHub"), "the page did not come back");
  flushSync(() => button("Connect GitHub").click());
  await waitFor(() => dialog(), "the third login dialog did not open");
  await waitFor(() => calls("pi-desktop/github/login/start").length === 3, "third login not started");
  // While it waits, the status line and a failure are both the catalog's text.
  loginEvent("login-3", { kind: "progress", message: "Waiting for approval on GitHub…" });
  await waitFor(
    () => dialog()?.textContent.includes(
      flattenCatalog(catalogs.en)["settings.connectors.github.waitingForApproval"],
    ),
    "the waiting line is not shown",
  );
  loginEvent("login-3", {
    kind: "error",
    message: "MAIN PROCESS ENGLISH: auth failed",
    code: "GITHUB_AUTH_FAILED",
  });
  await waitFor(
    () => dialog()?.textContent.includes(flattenCatalog(catalogs.en)["errors.GITHUB_AUTH_FAILED"]),
    "the login error was not shown from the catalog",
  );
  const dialogErrorLocalized = !dialog().textContent.includes("MAIN PROCESS ENGLISH");
  flushSync(() => button("Cancel").click());
  await waitFor(() => !dialog(), "Cancel did not close the dialog");
  const cancelButtonCancels = calls("pi-desktop/github/login/cancel").at(-1).input === "login-3";

  const everything = JSON.stringify(apiCalls.filter((call) => call.channel !== "pi-desktop/github/setToken"));
  return {
    notConnected,
    startInput,
    dialogNamesGitHub,
    verificationLinkShown: Boolean(verificationLink),
    connected,
    disconnectCalled,
    inputIsPassword,
    inputAutocompleteOff,
    saveDisabledWhileEmpty,
    rejected,
    accepted,
    deviceUnavailable,
    reauthentication,
    strayAvatars,
    secondStartInput,
    abandonedLoginCancelled,
    cancelButtonCancels,
    dialogErrorLocalized,
    // Nothing but the two explicit setToken calls ever carried a token to main,
    // and no channel that could read one back exists on this page.
    tokenOnlyInSetToken: !everything.includes(PASTED_TOKEN) && !everything.includes(REJECTED_TOKEN),
    channelsUsed: [...new Set(apiCalls.map((call) => call.channel))].sort(),
  };
};
`;

test("Connectors signs in to GitHub by code or token and never keeps the token", {
  timeout: 90_000,
  skip:
    process.platform === "linux" && !process.env.DISPLAY
      ? "Isolated Electron UI test requires a display"
      : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.github-connector-ui-"));
  try {
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: join(root, "scripts", "e2e"),
        sourcefile: join(root, "scripts", "e2e", "github-connector-settings.jsx"),
        loader: "tsx",
      },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><body><div id="root"></div><script type="module" src="renderer.js"></script>',
    );
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.githubConnectorProbe()");
    console.log("GITHUB_CONNECTOR_PROBE " + JSON.stringify(result));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});
`,
    );

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 75_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("GITHUB_CONNECTOR_PROBE "));
    assert(line, output.slice(-6000));
    const result = JSON.parse(line.slice("GITHUB_CONNECTOR_PROBE ".length));
    assert.deepEqual(result, {
      notConnected: {
        pageExplainsGitHub: true,
        workflowOffByDefault: true,
        tokenFormOffered: true,
        tokenFormClosed: true,
        noAccountShown: true,
        noDisconnect: true,
      },
      startInput: { allowWorkflowScope: true },
      dialogNamesGitHub: true,
      verificationLinkShown: true,
      connected: {
        scopesShown: true,
        avatarShown: true,
        noMissingScopeWarning: true,
        noReauthBanner: true,
        signInControlsGone: true,
        disconnectExplained: true,
        finishedLoginNotCancelled: true,
      },
      disconnectCalled: true,
      inputIsPassword: true,
      inputAutocompleteOff: true,
      saveDisabledWhileEmpty: true,
      rejected: {
        localizedToast: true,
        sentOnce: true,
        fieldCleared: true,
        stillSignedOut: true,
        notInPage: true,
      },
      accepted: {
        sentAsTyped: true,
        onlyTheTokenSent: true,
        missingScopeWarned: true,
        scopesShown: true,
        notInPage: true,
        formGone: true,
        disconnectExplainedForToken: true,
      },
      deviceUnavailable: {
        connectHidden: true,
        workflowOptionHidden: true,
        tokenPathOffered: true,
      },
      reauthentication: {
        accountStillShown: true,
        bannerIsAnAlert: true,
        canConnectAgain: true,
        canDisconnect: true,
      },
      strayAvatars: [
        { noImage: true, placeholderShown: true, notInPage: true },
        { noImage: true, placeholderShown: true, notInPage: true },
      ],
      secondStartInput: { allowWorkflowScope: false },
      abandonedLoginCancelled: true,
      cancelButtonCancels: true,
      dialogErrorLocalized: true,
      tokenOnlyInSetToken: true,
      channelsUsed: [
        "pi-desktop/github/disconnect",
        "pi-desktop/github/login/cancel",
        "pi-desktop/github/login/start",
        "pi-desktop/github/setToken",
        "pi-desktop/github/status",
      ],
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
