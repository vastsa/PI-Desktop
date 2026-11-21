import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { bundleAgentRuntime } from "./bundle.mjs";

const source = join(fileURLToPath(new URL("../", import.meta.url)), "src", "codemode");

// Same layout-defining options as the sidecar build in bundle.mjs: split
// chunks under chunks/, and the bundled-node define that selects packaged
// asset resolution.
const probeOptions = (outdir, entry) => ({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  minify: true,
  splitting: true,
  outdir,
  entryNames: "codemode-probe",
  chunkNames: "chunks/[name]-[hash]",
  define: { PI_BUNDLED_NODE: "true" },
  banner: { js: "import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);" },
});

const probe = `
const { NestedToolRunner } = await import(${JSON.stringify(join(source, "nested-calls.ts"))});
const { createCodemodeTool } = await import(${JSON.stringify(join(source, "tool.ts"))});
const events = [];
const read = {
  name: "Read", label: "Read", description: "Read a file", executionMode: "parallel",
  parameters: { type: "object", properties: {} },
  execute: async () => ({ content: [{ type: "text", text: "bundled" }], details: {} }),
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const host = {
  tools: () => [read],
  hooks: () => ({}),
  issuingMessage: (toolCall) => ({ role: "assistant", content: [toolCall], api: "x", provider: "x", model: "x", usage, stopReason: "toolUse", timestamp: 0 }),
  emit: (event) => events.push(event.type),
  track() {}, untrack() {}, settleBatch() {},
};
const tool = createCodemodeTool({ runner: new NestedToolRunner(host), callableTools: () => [read] });
const result = await tool.execute("probe", { code: 'return (await tools.Read({})) + ":" + (6 * 7);' });
console.log("CODEMODE_PROBE " + JSON.stringify({
  text: result.content.map((block) => block.text ?? "").join("\\n"),
  isError: result.isError === true,
  events,
}));
`;

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
}

it("runs a codemode script from the packaged bundle outside node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-codemode-"));
  const bundle = join(root, "resources", "agent-runtime");
  try {
    await bundleAgentRuntime(bundle);
    expect(existsSync(join(bundle, "chunks", "codemode-worker.js"))).toBe(true);
    expect(existsSync(join(bundle, "chunks", "quickjs.wasm"))).toBe(true);
    // No node_modules may be reachable from the packaged layout.
    for (let directory = bundle; directory !== dirname(directory); directory = dirname(directory)) {
      expect(existsSync(join(directory, "node_modules"))).toBe(false);
    }

    const entry = join(root, "probe-entry.mjs");
    await writeFile(entry, probe);
    await build(probeOptions(bundle, entry));
    await rm(entry);

    const env = { ...process.env };
    delete env.NODE_PATH;
    const { code, output } = await run(process.execPath, [join(bundle, "codemode-probe.js")], { cwd: bundle, env });
    expect(code, output).toBe(0);
    const line = output.split(/\r?\n/).find((item) => item.startsWith("CODEMODE_PROBE "));
    expect(line, output).toBeTruthy();
    const result = JSON.parse(line.slice("CODEMODE_PROBE ".length));
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Script completed");
    expect(result.text).toContain("bundled:42");
    expect(result.events).toEqual(["tool_start", "tool_end"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
