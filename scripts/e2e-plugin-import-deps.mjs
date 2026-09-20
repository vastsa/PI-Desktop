/**
 * Imported-extension dependency E2E (headless, installer boundary).
 *
 * E2E-PLUGIN-import-extension-installs-dependencies
 *   A generated import uses the real bounded npm installer, keeps dependency
 *   resolution registry-only, suppresses lifecycle scripts, and loads through
 *   the real trusted-extension runner.
 *
 * E2E-PLUGIN-import-extension-reports-missing-dependency
 *   Unsupported file/git/HTTP dependency sources fail before npm can run,
 *   remain visible as import errors, and leave no loadable node_modules.
 *
 * Fixture A uses the pinned, pure-JavaScript is-number@7.0.0 package. No
 * lifecycle scripts are allowed to run. Fixture B never accesses the network.
 */
import { createRequire, register } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));

const {
  generateImportedExtensionPlugin,
  installExtensionDependencies,
} = await import("../apps/desktop/electron/main/agent-extensions.ts");
const { TrustedExtensionRunner } = await import("../packages/agent-runtime/dist/index.js");
const { registerAgentExtensionIpc } = await import("../apps/desktop/electron/main/agent-extensions-ipc.ts");
const { readNpmPath, writeNpmPath } = await import("../apps/desktop/electron/main/npm-preferences.ts");
const { IPC } = await import("../packages/shared/dist/index.js");

const results = [];
function record(id, ok, detail = "") {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
}

function collectResolvedUrls(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectResolvedUrls(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "resolved" && typeof nested === "string" && nested.length > 0) output.push(nested);
    collectResolvedUrls(nested, output);
  }
  return output;
}

function writeExtensionSource(sourceRoot, packageJson) {
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(
    join(sourceRoot, "index.mjs"),
    `import isNumber from "is-number";\n\nexport default function (pi) {\n  if (!isNumber("42") || isNumber("not-a-number")) {\n    throw new Error("dependency did not load");\n  }\n  pi.registerCommand("dependency-loaded", {\n    description: "registered after dependency resolution",\n    handler: async () => {},\n  });\n}\n`,
    "utf8",
  );
  writeFileSync(join(sourceRoot, "package.json"), JSON.stringify(packageJson, null, 2) + "\n", "utf8");
}

function runnerBridge(cwd, publications) {
  return {
    sessionId: "e2e-plugin-import-deps",
    cwd,
    getModel: () => undefined,
    setModel: async () => false,
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => {},
    isIdle: () => true,
    abort: () => {},
    hasPendingMessages: () => false,
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getSessionName: () => undefined,
    setSessionName: () => {},
    sendUserMessage: () => {},
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    requestUi: async (extension, request) =>
      request.kind === "confirm"
        ? { kind: "confirm", value: false }
        : { kind: request.kind, value: undefined },
    publishCommands: (commands) => {
      publications.commands = commands;
    },
    publishDiagnostics: (diagnostics) => {
      publications.diagnostics = diagnostics;
    },
  };
}

async function main() {
const tempRoot = mkdtempSync(join(tmpdir(), "pi-desktop-plugin-import-deps-e2e-"));
try {
  // ── E2E-PLUGIN-import-extension-installs-dependencies ──────────────────
  {
    const sourceRoot = join(tempRoot, "dependency-extension");
    const importRoot = join(tempRoot, "imported");
    rmSync(sourceRoot, { recursive: true, force: true });
    writeExtensionSource(sourceRoot, {
      name: "dependency-extension",
      version: "1.0.0",
      workspaces: ["packages/*"],
      pi: { extensions: ["index.mjs"] },
      dependencies: { "is-number": "7.0.0" },
      scripts: {
        install: "node -e \"require('node:fs').writeFileSync('install-ran.txt', 'ran')\"",
      },
    });

    let runner;
    try {
      const generated = generateImportedExtensionPlugin(sourceRoot, importRoot);
      const copiedPackage = JSON.parse(readFileSync(join(generated.path, "package.json"), "utf8"));
      const workspacesStripped = !Object.hasOwn(copiedPackage, "workspaces");
      const install = await installExtensionDependencies(generated.path, { timeoutMs: 90_000 });
      const lockfilePath = join(generated.path, "package-lock.json");
      const lockfile = existsSync(lockfilePath)
        ? JSON.parse(readFileSync(lockfilePath, "utf8"))
        : undefined;
      const resolvedUrls = lockfile ? collectResolvedUrls(lockfile) : [];
      const registryOnly =
        resolvedUrls.length > 0 &&
        resolvedUrls.every((url) => url.startsWith("https://registry.npmjs.org/"));
      const nodeModulesCreated =
        existsSync(join(generated.path, "node_modules", "is-number", "index.js"));
      const lifecycleSuppressed = !existsSync(join(generated.path, "install-ran.txt"));

      const publications = { commands: [], diagnostics: [] };
      const entry = resolve(generated.path, generated.entries[0]);
      runner = new TrustedExtensionRunner({
        specs: [{ id: entry, entry, label: "dependency-extension", source: "manual", root: generated.path }],
        bridge: runnerBridge(generated.path, publications),
      });
      const [report] = await runner.load();
      const loaded =
        report?.state === "loaded" &&
        report.commandNames.includes("dependency-loaded") &&
        publications.commands.some((command) => command.name === "dependency-loaded") &&
        runner.getDiagnostics().length === 0;

      const ok =
        install.state === "installed" &&
        workspacesStripped &&
        registryOnly &&
        nodeModulesCreated &&
        lifecycleSuppressed &&
        loaded;
      record(
        "E2E-PLUGIN-import-extension-installs-dependencies",
        ok,
        ok
          ? `is-number@7.0.0 installed from ${resolvedUrls.length} registry URL(s); extension loaded`
          : JSON.stringify({
              install,
              workspacesStripped,
              registryOnly,
              resolvedUrls,
              nodeModulesCreated,
              lifecycleSuppressed,
              report,
              diagnostics: runner.getDiagnostics(),
            }),
      );
    } finally {
      await runner?.dispose();
    }
  }

  // ── E2E-PLUGIN-import-extension-recovers-missing-npm ──────────────────
  {
    const id = "E2E-PLUGIN-import-extension-recovers-missing-npm";
    const inheritedPath = process.env.PATH;
    try {
      const name = process.platform === "win32" ? "npm.cmd" : "npm";
      const npmPath = (inheritedPath ?? "").split(delimiter)
        .filter((directory) => isAbsolute(directory))
        .map((directory) => join(directory, name)).find((path) => existsSync(path));
      if (!npmPath) throw new Error("The E2E requires npm on the original PATH");
      const sourceRoot = join(tempRoot, "picker-source");
      const importRoot = join(tempRoot, "picker-imported");
      const dataDir = join(tempRoot, "picker-data");
      const emptyPath = join(tempRoot, "empty-bin");
      mkdirSync(emptyPath);
      writeExtensionSource(sourceRoot, {
        name: "picker-extension", version: "1.0.0",
        pi: { extensions: ["index.mjs"] }, dependencies: { "is-number": "7.0.0" },
        scripts: { install: "node -e \"require('node:fs').writeFileSync('install-ran.txt', 'ran')\"" },
      });
      const handlers = new Map();
      let sourcePicks = 0;
      let npmPicks = 0;
      let prompts = 0;
      let loads = 0;
      let dependencyLoaded = false;
      process.env.PATH = emptyPath;
      registerAgentExtensionIpc({
        handle: (channel, handler) => handlers.set(channel, handler),
        bridge: { respond: () => true },
        window: () => null,
        getLocale: () => "en",
        getNpmPath: () => readNpmPath(dataDir),
        setNpmPath: (path) => writeNpmPath(dataDir, path),
        importRoot,
        dialogs: {
          async showMessageBox() { prompts++; return { response: 1 }; },
          async showOpenDialog(options) {
            if (options.properties.includes("openDirectory")) {
              sourcePicks++;
              return { canceled: false, filePaths: [sourceRoot] };
            }
            if (++npmPicks > 1) throw new Error("npm selection did not recover installation");
            return { canceled: false, filePaths: [npmPath] };
          },
        },
        loadDevPlugin: async (path) => {
          loads++;
          const require = createRequire(join(path, "package.json"));
          dependencyLoaded = require("is-number")("42");
          return { path };
        },
        runCommand: async () => ({ handled: true }),
      });
      const result = await handlers.get(IPC.invoke.pluginImportExtension)();
      const lockfile = JSON.parse(readFileSync(join(result.path, "package-lock.json"), "utf8"));
      const urls = collectResolvedUrls(lockfile);
      const ok = result.dependencies.state === "installed" && dependencyLoaded &&
        sourcePicks === 1 && npmPicks === 1 && prompts === 1 && loads === 1 &&
        readdirSync(importRoot).length === 1 && readNpmPath(dataDir) === npmPath &&
        process.env.PATH === emptyPath && !existsSync(join(result.path, "install-ran.txt")) &&
        urls.length > 0 && urls.every((url) => url.startsWith("https://registry.npmjs.org/"));
      record(id, ok, ok ? "native-dialog boundary selected npm; real install recovered with isolated PATH" :
        JSON.stringify({ dependencies: result.dependencies, sourcePicks, npmPicks, prompts, loads, dependencyLoaded }));
    } catch (error) {
      record(id, false, error instanceof Error ? error.message : String(error));
    } finally {
      if (inheritedPath === undefined) delete process.env.PATH;
      else process.env.PATH = inheritedPath;
    }
  }

  // ── E2E-PLUGIN-import-extension-reports-missing-dependency ──────────────
  {
    const invalidSources = [
      ["file", "file:../outside"],
      ["git", "git+https://example.com/acme/unsafe.git"],
      ["http", "https://example.com/acme/unsafe.tgz"],
    ];
    const failures = [];
    for (const [label, spec] of invalidSources) {
      const sourceRoot = join(tempRoot, `invalid-${label}`);
      const importRoot = join(tempRoot, `imported-${label}`);
      writeExtensionSource(sourceRoot, {
        name: `invalid-${label}`,
        version: "1.0.0",
        pi: { extensions: ["index.mjs"] },
        dependencies: { "unsafe-dependency": spec },
      });
      const generated = generateImportedExtensionPlugin(sourceRoot, importRoot);
      const result = await installExtensionDependencies(generated.path, { timeoutMs: 10_000 });
      failures.push({
        label,
        result,
        surfaced: result.state === "failed" && /non-registry spec/.test(result.error),
        pluginStillRegistered: existsSync(join(generated.path, "manifest.json")),
        noNodeModules: !existsSync(join(generated.path, "node_modules")),
        noGeneratedLockfile: !existsSync(join(generated.path, "package-lock.json")),
      });
    }
    const ok = failures.every(
      ({ surfaced, pluginStillRegistered, noNodeModules, noGeneratedLockfile }) =>
        surfaced && pluginStillRegistered && noNodeModules && noGeneratedLockfile,
    );
    record(
      "E2E-PLUGIN-import-extension-reports-missing-dependency",
      ok,
      ok ? "file:, git, and HTTP sources rejected before npm" : JSON.stringify(failures),
    );
  }
} catch (error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  if (!results.some((result) => result.id === "E2E-PLUGIN-import-extension-installs-dependencies")) {
    record("E2E-PLUGIN-import-extension-installs-dependencies", false, detail);
  } else if (!results.some((result) => result.id === "E2E-PLUGIN-import-extension-reports-missing-dependency")) {
    record("E2E-PLUGIN-import-extension-reports-missing-dependency", false, detail);
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
}

main().then(() => {
  const failed = results.filter((result) => !result.ok);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
});
