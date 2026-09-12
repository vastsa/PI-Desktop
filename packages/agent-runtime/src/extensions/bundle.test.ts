/**
 * E2E-245 contract: the single-file sidecar bundle (esbuild, same flags as
 * `pnpm bundle`) must load a TypeScript extension through jiti from a
 * directory with no node_modules, with the kernel packages reachable through
 * virtual modules.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
