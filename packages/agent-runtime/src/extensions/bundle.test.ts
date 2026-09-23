/**
 * E2E-245 contract: the single-file sidecar bundle (esbuild, same flags as
 * `pnpm bundle`) must load a TypeScript extension through jiti from a
 * directory with no node_modules, with the kernel packages reachable through
 * virtual modules.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "pi-ext-bundle-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("bundled loader (E2E-245)", () => {
  it("loads a TypeScript extension from a bundle outside the repo", async () => {
    const entry = join(work, "entry.ts");
    writeFileSync(
      entry,
      `import { TrustedExtensionRunner } from ${JSON.stringify(resolve(here, "runner.ts"))};
const extension = process.argv[2];
const bridge = {
  sessionId: "s", cwd: process.cwd(), getModel: () => undefined, setModel: async () => true,
  getThinkingLevel: () => "off", setThinkingLevel: () => {}, isIdle: () => true, abort: () => {},
  hasPendingMessages: () => false, getContextUsage: () => undefined, compact: () => {},
  getSystemPrompt: () => "", getActiveTools: () => [], getAllTools: () => [], setActiveTools: () => {},
  getSessionName: () => undefined, setSessionName: () => {}, sendUserMessage: () => {},
  waitForIdle: async () => {}, newSession: async () => ({ cancelled: false }), fork: async () => ({ cancelled: false }),
  requestUi: async (_e: unknown, r: { kind: string }) => ({ kind: r.kind }), publishCommands: () => {}, publishDiagnostics: () => {},
};
const runner = new TrustedExtensionRunner({ specs: [{ id: extension, entry: extension, label: "typed", source: "user", root: process.cwd() }], bridge: bridge as any });
const [report] = await runner.load();
const [tool] = runner.getAgentTools();
const result = tool ? await tool.execute("1", { a: 20, b: 22 }) : undefined;
process.stdout.write(JSON.stringify({ state: report.state, diagnostics: runner.getDiagnostics(), text: result?.content[0] }));
`,
    );
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      minify: true,
      outfile: join(work, "bundle.mjs"),
      logLevel: "silent",
      banner: {
        js: "import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);",
      },
    });
    const extension = join(work, "typed.ts");
    writeFileSync(
      extension,
      `import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
interface P { a: number; b: number }
export default function (pi: any) {
  const unused: AgentMessage[] = [];
  pi.registerTool(defineTool({ name: "fx_add", description: "add", parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
    async execute(_id: string, p: P) { return { content: [{ type: "text", text: String(p.a + p.b + unused.length) }], details: {} }; } }));
}
`,
    );
    const out = execFileSync(process.execPath, [join(work, "bundle.mjs"), extension], {
      cwd: work,
      encoding: "utf8",
    });
    expect(JSON.parse(out)).toEqual({
      state: "loaded",
      diagnostics: [],
      text: { type: "text", text: "42" },
    });
  }, 30_000);
});

/**
 * Regression for the packaged install: pi-coding-agent's own extension loader
 * picks jiti `virtualModules` only for compiled or bundled Node distributions.
 * Every other Node build falls back to `require.resolve("typebox")` relative to
 * the importing file. A packaged sidecar lives in `resources/agent-runtime/`,
 * which has no `node_modules` above it, so without the bundled-Node define the
 * sidecar fails every native Pi extension with
 * `Cannot find module 'typebox'`.
 */
describe("packaged sidecar extension loader", () => {
  // pi-coding-agent ships an import-only export map, so locate its directory
  // through the workspace layout the sidecar bundle resolves from.
  const extensionLoader = resolve(
    here,
    "..",
    "..",
    "node_modules",
    "@earendil-works/pi-coding-agent",
    "dist",
    "core",
    "extensions",
    "loader.js",
  );

  /** The esbuild `--define:` flags the shipped bundle script carries. */
  function bundleDefines(): Record<string, string> {
    const manifest = JSON.parse(readFileSync(resolve(here, "..", "..", "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const defines: Record<string, string> = {};
    for (const [, name, value] of manifest.scripts.bundle.matchAll(/--define:([A-Za-z0-9_]+)=(\S+)/g)) {
      defines[name] = value;
    }
    return defines;
  }

  it("loads a typebox-importing extension from a bundle outside the repo", async () => {
    expect(existsSync(extensionLoader)).toBe(true);
    const entry = join(work, "entry.mjs");
    writeFileSync(
      entry,
      `import { createRequire } from "node:module";
import { loadExtensions } from ${JSON.stringify(extensionLoader)};
const [extension] = process.argv.slice(2);
const eventBus = { emit: () => {}, on: () => () => {}, off: () => {} };
const resolvesTypebox = (() => {
  try {
    createRequire(import.meta.url).resolve("typebox");
    return true;
  } catch {
    return false;
  }
})();
const loaded = await loadExtensions([extension], process.cwd(), eventBus, undefined);
process.stdout.write(JSON.stringify({ resolvesTypebox, loaded: loaded.extensions.length, errors: loaded.errors.map((error) => error.error) }));
`,
    );
    // `--platform`, `--format` and the banner are duplicated from the bundle
    // script on purpose; only `--define:` flags are read back from it, so a
    // future non-define flag in the script has to be mirrored here.
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      minify: true,
      outfile: join(work, "sidecar.js"),
      logLevel: "silent",
      define: bundleDefines(),
      banner: {
        js: "import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);",
      },
    });

    const extension = join(work, "typed.ts");
    writeFileSync(
      extension,
      `import { Type } from "typebox";
export default function (pi: any) {
  pi.registerTool({
    name: "fx_noop",
    description: "no-op",
    parameters: Type.Object({ a: Type.Number() }),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
}
`,
    );

    // vitest exports NODE_PATH into its workers and the child would inherit
    // the repository's node_modules through it. A packaged install has no such
    // fallback, so scrub it before running the bundle under test.
    const childEnv = { ...process.env };
    delete childEnv.NODE_PATH;
    const out = execFileSync(process.execPath, [join(work, "sidecar.js"), extension], {
      cwd: work,
      encoding: "utf8",
      env: childEnv,
    });
    const report = JSON.parse(out) as { resolvesTypebox: boolean; loaded: number; errors: string[] };
    expect(report.errors).toEqual([]);
    expect(report.loaded).toBe(1);
    // The child resolves `typebox` as soon as something above the bundle
    // provides it, and a `TMPDIR` inside the repository does, which would let
    // this case pass without the bundle define.
    expect(report.resolvesTypebox, "TMPDIR must lie outside any node_modules tree").toBe(false);
  }, 60_000);
});
