#!/usr/bin/env node
/** Real React/Chromium regression for E2E-083's stable completed activity groups. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(
  join(root, "packages/agent-runtime/package.json"),
);
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-transcript-render-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/transcript-render.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"DEV":false,"MODE":"production"}',
    },
    // Styles are outside the render-count contract; component and hook code is real.
    loader: { ".css": "empty" },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      // The fixture lives outside the desktop package; use its React instance.
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
    plugins: [
      {
        name: "local-url-assets",
        setup(build) {
          // Composer imports the dormant voice worklet via Vite's ?url form.
          // Preserve a real local asset URL; this fixture never activates voice.
          build.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
            path: join(resolveDir, path.slice(0, -4)), namespace: "local-url-asset",
          }));
          build.onLoad({ filter: /.*/, namespace: "local-url-asset" }, async ({ path }) => ({
            contents: await readFile(path), loader: "file",
          }));
        },
      },
      {
        name: "count-activity-group-renders",
        setup(build) {
          build.onLoad(
            { filter: /[/\\]ActivityGroup\.tsx$/ },
            async ({ path }) => {
              const source = await readFile(path, "utf8");
              const marker = "}: ActivityGroupProps) {";
              assert.equal(
                source.split(marker).length,
                2,
                "ActivityGroup instrumentation boundary changed",
              );
              return {
                contents: source.replace(
                  marker,
                  `${marker}\n  (globalThis.__activityGroupRenders ??= []).push(items[0]?.message.id);`,
                ),
                loader: "tsx",
              };
            },
          );
        },
      },
    ],
  });
  // The runtime-status scenario measures real geometry, so the page needs the
  // app's built stylesheet: the Tailwind reset, the design tokens (the
  // indicator's own type scale), and the transcript layers live there.
  const renderer = join(root, "apps/desktop/out/renderer");
  const appHtml = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...appHtml.matchAll(/href="([^" ]+\.css)"/g)].map(
    (match) => match[1],
  );
  assert(
    css.length,
    "Build the app with pnpm build:js before running this check",
  );
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  // The scenario measures a rule that only exists in the built stylesheet, so a
  // stale build must fail loudly instead of passing against an older CSS file.
  const laneSource = await readFile(
    join(root, "apps/desktop/src/styles/chat-shell.css"),
    "utf8",
  );
  // Comments inside the rule describe intent; only its declarations are compared.
  const laneRule = laneSource
    .match(/\.transcript-runtime-status \{([\s\S]*?)\}/)?.[1]
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert(
    laneRule,
    "chat-shell.css declares no .transcript-runtime-status rule",
  );
  const builtCss = (
    await Promise.all(css.map((path) => readFile(join(renderer, path), "utf8")))
  )
    .join("\n")
    .replace(/\s+/g, "");
  const builtRule = builtCss.match(
    /\.transcript-runtime-status\{([^}]*)\}/,
  )?.[1];
  assert(
    builtRule,
    "the built stylesheet predates the runtime status lane; build with pnpm build:js",
  );
  // The scenario measures a rule that lives in the built stylesheet, so the two
  // copies have to agree: a build still carrying a declaration the source has
  // dropped (or missing one the source added) must fail here rather than pass a
  // geometry check against CSS that no longer describes the source.
  const declarations = (rule) =>
    new Set(rule.replace(/\s+/g, "").split(";").filter(Boolean));
  const sourceDeclarations = declarations(laneRule);
  const builtDeclarations = declarations(builtRule);
  const drift = [
    ...[...builtDeclarations].filter((value) => !sourceDeclarations.has(value)),
    ...[...sourceDeclarations].filter((value) => !builtDeclarations.has(value)),
  ];
  assert(
    drift.length === 0,
    `the built stylesheet is stale (${drift.join(", ")}); build with pnpm build:js`,
  );
  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:"><title>Transcript render regression</title>${css
      .map((path) => `<link rel="stylesheet" href="${path}">`)
      .join("")}<script src="renderer.js"></script>`,
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));

// Each scenario runs as its own bounded phase so a stalled renderer names the
// phase that stalled instead of dying at the harness kill with no output.
const PHASE_TIMEOUT_MS = 90000;

function describe(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  return error.stack || error.message || String(error);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const report = (line) => process.stderr.write(line + "\\n");
  // stdout is a pipe; app.exit() would truncate a buffered write, so the probe
  // line is flushed first and only then does the process exit.
  const finish = (payload) => {
    process.stdout.write("TRANSCRIPT_RENDER_PROBE " + JSON.stringify(payload) + "\\n", () => app.exit(0));
  };
  // Renderer console forwarding has to survive both the legacy (event, level,
  // message) and the modern (event.message) signatures, or a renderer error is
  // silently lost and the harness only sees a timeout.
  window.webContents.on("console-message", (event, level, message) => {
    const text = typeof message === "string" && message.length > 0
      ? message
      : event && typeof event === "object" && typeof event.message === "string" ? event.message : "";
    if (text) report("TRANSCRIPT_E2E_RENDERER " + text);
  });
  window.webContents.on("render-process-gone", (_event, details) => report("TRANSCRIPT_E2E_RENDER_GONE " + JSON.stringify(details)));
  window.webContents.on("unresponsive", () => report("TRANSCRIPT_E2E_UNRESPONSIVE"));
  window.webContents.on("did-fail-load", (_event, code, description) => report("TRANSCRIPT_E2E_LOAD_FAILED " + code + " " + description));

  const withTimeout = (promise, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("phase " + label + " timed out after " + PHASE_TIMEOUT_MS + "ms")), PHASE_TIMEOUT_MS);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });

  const phases = [
    ["render", "globalThis.transcriptRenderProbe()"],
    ["runtimeSlot", "globalThis.transcriptRuntimeSlotProbe()"],
    ["smoothText", "globalThis.smoothTextThrottleProbe()"],
    ["longHistory", "globalThis.transcriptLongHistoryProbe()"],
  ];
  const outcomes = { render: null, runtimeSlot: null, smoothText: null, longHistory: null };
  const phaseStatus = () => Object.fromEntries(Object.entries(outcomes).map(([name, value]) => [name, value ? value.ok === true : null]));
  const phaseErrors = () => Object.fromEntries(Object.entries(outcomes).filter(([, value]) => value && value.ok !== true).map(([name, value]) => [name, value.error]));

  const runPhase = async (name, expression) => {
    report("TRANSCRIPT_E2E_PHASE " + name + " start");
    const outcome = await withTimeout(window.webContents.executeJavaScript(
      "(async () => { try { return { ok: true, value: await (" + expression + ") }; } catch (error) { return { ok: false, error: (error && (error.stack || error.message)) || String(error) }; } })()"
    ), name);
    report("TRANSCRIPT_E2E_PHASE " + name + (outcome && outcome.ok === true ? " done" : " failed: " + JSON.stringify(outcome)));
    return outcome;
  };

  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    await window.webContents.executeJavaScript("window.addEventListener('error', event => console.error(event.error?.stack ?? event.message)); window.addEventListener('unhandledrejection', event => console.error(event.reason?.stack ?? String(event.reason)));");
    for (const [name, expression] of phases) {
      outcomes[name] = await runPhase(name, expression);
      if (!outcomes[name] || outcomes[name].ok !== true) break;
    }
    const render = outcomes.render && outcomes.render.ok === true ? outcomes.render.value : {};
    const runtimeSlot = outcomes.runtimeSlot && outcomes.runtimeSlot.ok === true ? outcomes.runtimeSlot.value : undefined;
    const smoothText = outcomes.smoothText && outcomes.smoothText.ok === true ? outcomes.smoothText.value : undefined;
    const longHistory = outcomes.longHistory && outcomes.longHistory.ok === true ? outcomes.longHistory.value : undefined;
    let contextOverflowRecovery;
    if (render.ok === true && runtimeSlot?.ok === true && smoothText?.ok === true && longHistory?.ok === true) {
      contextOverflowRecovery = await require(${JSON.stringify(join(root, "scripts/e2e/context-overflow-recovery.cjs"))})(window);
    }
    finish({
      ...render, runtimeSlot, smoothText, longHistory, contextOverflowRecovery,
      phases: phaseStatus(), phaseErrors: phaseErrors(),
      ok: Boolean(render.ok && runtimeSlot?.ok && smoothText?.ok && longHistory?.ok && contextOverflowRecovery?.ok),
    });
  } catch (error) {
    finish({ ok: false, error: describe(error), phases: phaseStatus(), phaseErrors: phaseErrors() });
  }
});
`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output += data;
    });
  // Each phase is bounded inside main.cjs (90s), so this cap only has to cover
  // four phases plus the recovery scenario.
  const timeout = setTimeout(() => {
    console.error("TRANSCRIPT_E2E_HARNESS_TIMEOUT");
    child.kill("SIGKILL");
  }, 240_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  const lines = output.split(/\r?\n/);
  const line = lines.find((entry) => entry.startsWith("TRANSCRIPT_RENDER_PROBE "));
  const markers = lines.filter((entry) => entry.includes("TRANSCRIPT_E2E_"));
  assert(
    line,
    `renderer returned no probe result (exit=${code}).\n${markers.slice(-40).join("\n")}\n${output.slice(-4000)}`,
  );
  const result = JSON.parse(line.slice("TRANSCRIPT_RENDER_PROBE ".length));
  console.log("TRANSCRIPT_RENDER_PROBE " + JSON.stringify(result));
  assert.equal(code, 0, `${markers.slice(-40).join("\n")}\n${output.slice(-6000)}`);
  assert.equal(
    result.ok,
    true,
    `transcript scenario failed; phases=${JSON.stringify(result.phases)} phaseErrors=${JSON.stringify(result.phaseErrors)}`,
  );
  // The merged result above already carries the geometry snapshots; this turns
  // a failed scenario into a message that names the checks that failed.
  // check can be read from the scenario output alone.
  assert.equal(
    result.runtimeSlot?.ok,
    true,
    `runtime status slot scenario failed: ${JSON.stringify(result.runtimeSlot?.failures)}`,
  );
  assert.equal(
    result.turnProcess?.ok,
    true,
    `turn process scenario failed: ${JSON.stringify(result.turnProcess?.checks)}`,
  );
  assert.equal(
    result.smoothText?.ok,
    true,
    `smooth text cadence scenario failed: ${JSON.stringify(result.smoothText)}`,
  );
  assert.equal(
    result.contextOverflowRecovery?.ok,
    true,
    `context overflow recovery scenario failed: ${JSON.stringify(result.contextOverflowRecovery)}`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
