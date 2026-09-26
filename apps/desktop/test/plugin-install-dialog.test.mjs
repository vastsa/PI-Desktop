import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readPluginsSourceSync } from "./helpers/source-contracts.mjs";
import { loadStyles } from "./helpers/styles.mjs";
import {
  canCancelInstall,
  formatTransfer,
  isInstallCancelled,
  newInstallJob,
  nextInstallSample,
  withInstallProgress,
} from "../src/features/plugins/install-progress.ts";
import { de } from "../../../packages/i18n/src/locales/de/index.ts";
import { en } from "../../../packages/i18n/src/locales/en/index.ts";
import { es } from "../../../packages/i18n/src/locales/es/index.ts";
import { fr } from "../../../packages/i18n/src/locales/fr/index.ts";
import { ko } from "../../../packages/i18n/src/locales/ko/index.ts";
import { ptBR } from "../../../packages/i18n/src/locales/pt-BR/index.ts";
import { tr } from "../../../packages/i18n/src/locales/tr/index.ts";
import { zhCN } from "../../../packages/i18n/src/locales/zh-CN/index.ts";
import { zhTW } from "../../../packages/i18n/src/locales/zh-TW/index.ts";

const catalogs = { en, "zh-CN": zhCN, "zh-TW": zhTW, de, es, fr, ko, "pt-BR": ptBR, tr };

const here = dirname(fileURLToPath(import.meta.url));
const dialogSrc = readFileSync(
  join(here, "../src/components/plugins/PluginInstallDialog.tsx"),
  "utf8",
);
const dialogsSrc = readFileSync(join(here, "../src/features/plugins/PluginDialogs.tsx"), "utf8");
const pageSrc = readPluginsSourceSync();
const pluginsCss = readFileSync(join(here, "../src/styles/plugins.css"), "utf8");
const styles = await loadStyles();

function lookup(catalog, key) {
  return key.split(".").reduce((node, part) => (node == null ? undefined : node[part]), catalog);
}

function request(overrides = {}) {
  return {
    id: "acme.todo",
    name: "Acme Todo",
    version: "1.2.0",
    autoUpdate: false,
    grantedPermissions: ["notify"],
    ...overrides,
  };
}

function report(overrides = {}) {
  return {
    pluginId: "acme.todo",
    version: "1.2.0",
    phase: "download",
    ...overrides,
  };
}

test("the install dialog opens on resolve before the first report arrives", () => {
  const job = newInstallJob(request());

  assert.equal(job.status, "running");
  // A slow resolve is the step that has nothing to report, so the dialog shows
  // it from the click rather than waiting for an event.
  assert.equal(job.phase, "resolve");
  assert.deepEqual(
    [job.attempt, job.attempts, job.receivedBytes, job.totalBytes, job.speed],
    [0, 0, 0, 0, 0],
  );
  assert.deepEqual(job.tried, []);
  assert.equal(dialogSrc.includes('resolve: "plugins.installPhase.resolve"'), true);
});

test("the page subscribes to install progress and cleans the subscription up", () => {
  // The effect returns what `onPluginInstallProgress` returns, which is the
  // unsubscribe function: the listener must not outlive the page.
  assert.match(pageSrc, /useEffect\(\(\) => \{\s*return api\.onPluginInstallProgress\(/);
  assert.match(pageSrc, /api\.onPluginInstallProgress\(\(event\) => \{/);
  // Reports for another plugin must not move this dialog.
  assert.match(pageSrc, /job\.request\.id !== event\.pluginId/);
});

test("only a download that is still running can be cancelled", () => {
  const job = newInstallJob(request());

  assert.equal(canCancelInstall(job), true, "resolve is still interruptible");
  assert.equal(canCancelInstall({ ...job, phase: "download" }), true);
  assert.equal(
    canCancelInstall({ ...job, phase: "verify" }),
    false,
    "the last safe stop is behind the download",
  );
  assert.equal(canCancelInstall({ ...job, phase: "install" }), false);
  assert.equal(canCancelInstall({ ...job, phase: "enable" }), false);
  assert.equal(canCancelInstall({ ...job, phase: "download", cancelling: true }), false);
  assert.equal(canCancelInstall({ ...job, phase: "download", status: "failed" }), false);

  // One click is one request: the button reads this, and the handler refuses a
  // second call while the host is answering the first.
  assert.match(dialogSrc, /const stoppable = canCancelInstall\(job\)/);
  assert.match(dialogSrc, /disabled=\{!stoppable\}/);
  assert.match(pageSrc, /if \(!job \|\| !canCancelInstall\(job\)\) return;/);
  assert.match(pageSrc, /api\.marketCancelInstall\(job\.request\.id\)/);
  assert.match(dialogSrc, /plugins\.installCancelling/);
});

test("progress reports fill in the mirror, the bytes and the transfer speed", () => {
  const job = newInstallJob(request());
  const first = nextInstallSample(
    null,
    report({ receivedBytes: 0, totalBytes: 4096, attempt: 2, attempts: 3, source: "cnb" }),
    1_000,
  );
  assert.equal(first.speed, 0, "a first report is only a baseline");

  const second = nextInstallSample(
    first,
    report({ receivedBytes: 1024, totalBytes: 4096, attempt: 2, attempts: 3, source: "cnb" }),
    2_000,
  );
  assert.equal(second.speed, 1024, "1024 bytes in one second");

  const filled = withInstallProgress(
    job,
    report({ receivedBytes: 1024, totalBytes: 4096, attempt: 2, attempts: 3, source: "cnb" }),
    second,
  );
  assert.equal(filled.phase, "download");
  assert.equal(filled.source, "cnb");
  assert.deepEqual([filled.attempt, filled.attempts], [2, 3]);
  assert.deepEqual([filled.receivedBytes, filled.totalBytes], [1024, 4096]);
  assert.equal(filled.speed, 1024);

  // A new mirror counts from zero again, so it starts a fresh reading instead of
  // dividing a smaller number by the previous mirror's elapsed time.
  assert.equal(
    nextInstallSample(second, report({ receivedBytes: 0, attempt: 3, attempts: 3 }), 3_000).speed,
    0,
  );
  assert.equal(formatTransfer(1024), "1.0 KB");
  assert.equal(formatTransfer(0), "0 B");
});

test("a failure report carries the mirrors that were tried", () => {
  const job = newInstallJob(request());
  const terminal = report({
    error: "PLUGIN_NETWORK: every mirror refused",
    tried: [
      { source: "cnb", url: "https://cnb.example/acme.tgz", error: "PLUGIN_NETWORK: 502" },
      { source: "github", url: "https://github.example/acme.tgz", error: null },
    ],
  });
  const failed = withInstallProgress(job, terminal, { attempt: 0, received: 0, at: 0, speed: 0 });

  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "PLUGIN_NETWORK: every mirror refused");
  assert.equal(failed.tried.length, 2);
  assert.equal(failed.tried[0].source, "cnb");
  assert.equal(failed.tried[0].url, "https://cnb.example/acme.tgz");

  // The request can reject before the terminal report lands: the report
  // completes the failure instead of erasing what the rejection already showed.
  const rejected = { ...job, status: "failed", error: "PLUGIN_NETWORK: boom" };
  const merged = withInstallProgress(rejected, terminal, { attempt: 0, received: 0, at: 0, speed: 0 });
  assert.equal(merged.tried.length, 2);
  assert.equal(merged.error, "PLUGIN_NETWORK: every mirror refused");

  assert.equal(isInstallCancelled("PLUGIN_CANCELLED: the install was cancelled"), true);
  const cancellation = new Error("PLUGIN_CANCELLED: the install was cancelled");
  cancellation.code = "PLUGIN_CANCELLED";
  assert.equal(isInstallCancelled(cancellation), true);
  assert.equal(isInstallCancelled(new Error("PLUGIN_NETWORK: 502")), false);
  // A cancellation closes the dialog quietly in both places it can surface.
  assert.match(pageSrc, /if \(event\.error && isInstallCancelled\(event\.error\)\)/);
  assert.match(pageSrc, /if \(isInstallCancelled\(e\)\) \{/);
});

test("the dialog renders the phase, the progress bar and the tried mirrors", () => {
  assert.match(dialogSrc, /phase === "download" && job\.attempts > 0/);
  assert.match(dialogSrc, /plugins\.installMirror", \{/);
  assert.match(dialogSrc, /role="progressbar"/);
  assert.match(dialogSrc, /!determinate && "is-indeterminate"/);
  assert.match(dialogSrc, /style=\{determinate \? \{ width: `\$\{percent\}%` \} : undefined\}/);
  assert.match(dialogSrc, /plugins\.installReceived/);
  assert.match(dialogSrc, /plugins\.installSpeed/);
  assert.match(dialogSrc, /formatTransfer\(job\.speed\)/);

  // A failure lists every mirror with the error it answered, and the URL behind
  // a disclosure rather than in the way.
  assert.match(dialogSrc, /job\.tried\.map\(\(mirror, index\) => \(/);
  assert.match(dialogSrc, /<details className="plugins-install-mirror">/);
  assert.match(dialogSrc, /<code className="plugins-install-mirror-url">\{mirror\.url\}<\/code>/);
  assert.match(dialogSrc, /plugins\.installCopyDetails/);
  assert.match(dialogSrc, /navigator\.clipboard\.writeText\(lines\.join\("\\n"\)\)/);
  assert.match(dialogSrc, /onClick=\{\(\) => void onRetry\(\)\}/);
  assert.match(dialogSrc, /plugins\.installClose/);

  // The page owns the state and the calls the dialog makes, and renders it
  // beside the permission review it follows.
  assert.match(dialogsSrc, /<PluginInstallDialog/);
  assert.match(dialogsSrc, /onCancel=\{cancelInstallDownload\}/);
  assert.match(dialogsSrc, /onRetry=\{retryInstall\}/);
  assert.match(dialogsSrc, /onClose=\{closeInstallDialog\}/);
});

test("a successful install is dismissed on its own unless the pointer is on it", () => {
  assert.match(dialogSrc, /const SUCCESS_DWELL_MS = 2000;/);
  assert.match(dialogSrc, /if \(job\.status !== "success" \|\| hovered\) return;/);
  assert.match(dialogSrc, /window\.setTimeout\(\(\) => closeRef\.current\(\), SUCCESS_DWELL_MS\)/);
  assert.match(dialogSrc, /onPointerEnter=\{\(\) => setHovered\(true\)\}/);
  assert.match(dialogSrc, /onPointerLeave=\{\(\) => setHovered\(false\)\}/);
});

test("Escape dismisses a finished install but never a running download", () => {
  assert.match(
    dialogSrc,
    /const escapeLocked = running && \(job\.phase === "resolve" \|\| job\.phase === "download"\);/,
  );
  assert.match(dialogSrc, /if \(escapeLocked\) return;/);
  assert.match(dialogSrc, /if \(event\.key === "Escape"\) closeRef\.current\(\);/);
  // The dialog reuses the page's modal primitives instead of a second skin.
  assert.match(dialogSrc, /className="plugins-modal-backdrop"/);
  assert.match(dialogSrc, /className="plugins-modal plugins-install-modal"/);
  assert.match(dialogSrc, /className="plugins-modal-actions"/);
});

test("the install dialog is mounted above the route and sidebar stacking contexts", () => {
  assert.match(dialogSrc, /portalOverlay\(/);
  assert.match(
    dialogSrc,
    /return portalOverlay\(\s*<div className="plugins-modal-backdrop"/,
  );
  assert.match(
    pluginsCss,
    /#pi-desktop-overlays > \.plugins-modal-backdrop\s*\{[^}]*pointer-events:\s*auto;/,
  );
});

test("install dialog copy exists in every shipped locale", () => {
  const keys = [
    "plugins.installDialogTitle",
    "plugins.installPhase.resolve",
    "plugins.installPhase.download",
    "plugins.installPhase.verify",
    "plugins.installPhase.install",
    "plugins.installPhase.enable",
    "plugins.installMirror",
    "plugins.installMirrorUnknown",
    "plugins.installProgressLabel",
    "plugins.installReceived",
    "plugins.installReceivedUnknown",
    "plugins.installSpeed",
    "plugins.installCancel",
    "plugins.installCancelling",
    "plugins.installSuccess",
    "plugins.installFailed",
    "plugins.installTriedTitle",
    "plugins.installRetry",
    "plugins.installClose",
    "plugins.installCopyDetails",
    "plugins.installCopied",
    "plugins.installCopyFailed",
  ];
  const missing = Object.fromEntries(Object.keys(catalogs).map((id) => [id, []]));
  for (const key of keys) {
    for (const [id, catalog] of Object.entries(catalogs)) {
      if (typeof lookup(catalog, key) !== "string") missing[id].push(key);
    }
  }
  assert.deepEqual(missing, Object.fromEntries(Object.keys(catalogs).map((id) => [id, []])));
  // The phase label is resolved by key at render time, so the companion test
  // that scans literal `t("…")` calls cannot see these five.
  assert.match(dialogSrc, /PHASE_KEYS\[job\.phase\]/);
  assert.match(dialogSrc, /t\(PHASE_KEYS\[job\.phase\]\)/);
});

test("install dialog styles use design tokens and honour reduced motion", () => {
  const start = styles.indexOf(".plugins-install-modal {");
  assert.ok(start >= 0, "install dialog styles are missing");
  const section = pluginsCss.slice(pluginsCss.indexOf(".plugins-install-modal"));

  assert.match(section, /\.plugins-install-bar-fill\s*\{[^}]*background:\s*var\(--ds-accent\)/);
  assert.match(section, /\.plugins-install-outcome\.is-success\s*\{[^}]*var\(--ds-success\)/);
  assert.match(section, /\.plugins-install-error\s*\{[^}]*var\(--ds-error\)/);
  assert.match(section, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(section, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(section, /rgba?\(/);
  assert.match(styles, /\.plugins-install-mirror-url\s*\{/);
});
