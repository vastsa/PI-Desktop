import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { copyAgentRuntimeBundle } from "../scripts/runtime-bundle.mjs";
import { ensureDarwinSpawnHelperExecutable } from "../scripts/spawn-helper-permissions.mjs";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
const require = createRequire(import.meta.url);
const temporaryDirectories: string[] = [];
const runtimeManifest = { type: "module", name: "runtime-fixture", private: true };

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture() {
  const root = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "pi-host-packaging-"));
  temporaryDirectories.push(root);
  const app = join(root, "apps/pi-host");
  const runtime = join(root, "packages/agent-runtime/dist-bundle");
  const out = join(root, "release");
  const pty = join(app, "node_modules/node-pty");
  cpSync(scripts, join(app, "scripts"), { recursive: true });
  write(join(app, "package.json"), JSON.stringify({ version: "0.0.0-test", type: "module" }));
  write(join(app, "src/cli.ts"), 'console.log("fixture CLI");\n');
  write(join(root, "target/release/pi-desktop-host-core"), "fixture host-core\n");
  write(join(runtime, "package.json"), JSON.stringify(runtimeManifest));
  write(join(runtime, "sidecar.js"), `
import { marker } from "./chunks/shared.js";
export async function probe() {
  const { suffix } = await import("./chunks/lazy.js");
  return marker + suffix;
}
`);
  write(join(runtime, "chunks/shared.js"), 'export { marker } from "./nested/marker.js";\n');
  write(join(runtime, "chunks/nested/marker.js"), 'export const marker = "self-contained";\n');
  write(join(runtime, "chunks/lazy.js"), 'export { suffix } from "./nested/suffix.js";\n');
  write(join(runtime, "chunks/nested/suffix.js"), 'export const suffix = "-runtime";\n');
  write(join(runtime, "assets/fixture.txt"), "runtime asset\n");
  write(join(pty, "package.json"), JSON.stringify({ name: "node-pty", version: "1.1.0" }));
  symlinkSync(dirname(require.resolve("esbuild/package.json")), join(app, "node_modules/esbuild"), "junction");
  return { root, app, runtime, out, pty };
}

type Fixture = ReturnType<typeof fixture>;

function node(root: string, args: string[]) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, HOME: root, NODE_OPTIONS: "", NODE_PATH: "" },
    encoding: "utf8",
    timeout: 15_000,
  });
}

function bundle(f: Fixture, platform = "linux") {
  return node(f.root, [join(f.app, "scripts/bundle.mjs"), "--platform", platform, "--arch", process.arch, "--out", f.out]);
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pi-host packaging", () => {
  it("loads the copied entry and static/dynamic transitive chunks outside the workspace", () => {
    const f = fixture();
    const packaged = bundle(f);
    expect(packaged.status, packaged.stderr).toBe(0);
    // Remove build inputs and dependency links before starting isolated Node.
    rmSync(join(f.root, "packages"), { recursive: true });
    rmSync(join(f.root, "apps"), { recursive: true });
    const entry = pathToFileURL(join(f.out, "agent-runtime/sidecar.js")).href;
    const loaded = node(f.out, ["--no-experimental-detect-module", "--input-type=module", "-e", `const m = await import(${JSON.stringify(entry)}); console.log(await m.probe());`]);
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout.trim()).toBe("self-contained-runtime");
    expect(JSON.parse(readFileSync(join(f.out, "agent-runtime/package.json"), "utf8"))).toEqual(runtimeManifest);
    expect(readFileSync(join(f.out, "agent-runtime/assets/fixture.txt"), "utf8")).toBe("runtime asset\n");
  });

  it.each(["sidecar.js", "package.json", "chunks/shared.js", "chunks/nested/suffix.js"])("fails packaging when the runtime is missing %s", (missing) => {
    const f = fixture();
    rmSync(join(f.runtime, missing));
    const result = bundle(f);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toMatch(/(?:sidecar|agent-runtime).*?(?:missing|incomplete)/s);
    expect(result.stderr).toContain(missing);
  });

  it("rejects a runtime without an ESM manifest", () => {
    const f = fixture();
    write(join(f.runtime, "package.json"), '{"type":"commonjs"}');
    const result = bundle(f);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toMatch(/agent-runtime.*package\.json/s);
  });

  it("packages Linux PTYs without a macOS spawn-helper", () => {
    const f = fixture();
    write(join(f.pty, "build/Release/pty.node"), "fixture Linux native addon");
    const result = bundle(f, "linux");
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(f.out, "node_modules/node-pty/build/Release/pty.node"))).toBe(true);
    expect(existsSync(join(f.out, "node_modules/node-pty/build/Release/spawn-helper"))).toBe(false);
  });

  it.skipIf(process.platform === "win32").each([`prebuilds/darwin-${process.arch}`, "build/Release", "build/Debug"])("makes the Darwin spawn-helper executable in %s without changing the source", (nativeDir) => {
    const f = fixture();
    write(join(f.pty, nativeDir, "pty.node"), "fixture Darwin native addon");
    const sourceHelper = join(f.pty, nativeDir, "spawn-helper");
    write(sourceHelper, "#!/bin/sh\nprintf 'helper-ok'\n");
    const result = bundle(f, "darwin");
    expect(result.status, result.stderr).toBe(0);
    const helper = join(f.out, "node_modules/node-pty", nativeDir, "spawn-helper");
    expect(statSync(helper).mode & 0o777).toBe(0o755);
    expect(statSync(sourceHelper).mode & 0o111).toBe(0);
    const executed = spawnSync(helper, [], { cwd: f.out, encoding: "utf8", timeout: 5_000 });
    expect(executed.status, executed.stderr).toBe(0);
    expect(executed.stdout).toBe("helper-ok");
  });

  it("does not swallow a missing Darwin helper as an optional node-pty install", () => {
    const f = fixture();
    write(join(f.pty, "build/Release/pty.node"), "fixture Darwin native addon");
    const result = bundle(f, "darwin");
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toMatch(/node-pty.*spawn-helper.*missing/);
    expect(result.stderr).not.toContain("not installed");
  });

  it("keeps node-pty optional when it is not installed", () => {
    const f = fixture();
    rmSync(f.pty, { recursive: true });
    const result = bundle(f);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("node-pty not installed");
    expect(existsSync(join(f.out, "node_modules/node-pty"))).toBe(false);
  });
});

describe("packaging helpers", () => {
  it("reports an absent runtime tree", async () => {
    const f = fixture();
    rmSync(f.runtime, { recursive: true });
    await expect(copyAgentRuntimeBundle(f.runtime, join(f.out, "agent-runtime"))).rejects.toThrow(/agent-runtime bundle missing or incomplete/);
  });

  it("validates Node builtins without executing or rewriting runtime code", async () => {
    const f = fixture();
    const code = 'import { readFileSync } from "node:fs"; throw new Error("must not execute"); export { readFileSync };\n';
    write(join(f.runtime, "sidecar.js"), code);
    await copyAgentRuntimeBundle(f.runtime, join(f.out, "agent-runtime"));
    expect(readFileSync(join(f.out, "agent-runtime/sidecar.js"), "utf8")).toBe(code);
  });

  it.each(["../outside.js", "esbuild"])("rejects a runtime dependency on %s outside its own tree", async (dependency) => {
    const f = fixture();
    write(join(f.runtime, "sidecar.js"), `import ${JSON.stringify(dependency)};\n`);
    await expect(copyAgentRuntimeBundle(f.runtime, join(f.out, "agent-runtime"))).rejects.toThrow(/Unbundled dependency|Module outside agent-runtime bundle/);
  });

  it("does not mask an incomplete build with stale destination chunks", async () => {
    const f = fixture();
    const destination = join(f.out, "agent-runtime");
    await copyAgentRuntimeBundle(f.runtime, destination);
    rmSync(join(f.runtime, "chunks/nested/suffix.js"));
    await expect(copyAgentRuntimeBundle(f.runtime, destination)).rejects.toThrow(/agent-runtime bundle missing or incomplete/);
    expect(existsSync(join(destination, "chunks/nested/suffix.js"))).toBe(false);
  });

  it.each(["linux", "win32"])("does not require a Darwin helper on %s", (platform) => {
    const f = fixture();
    expect(() => ensureDarwinSpawnHelperExecutable(f.pty, platform, process.arch)).not.toThrow();
  });

  it("does not accept a prebuild helper instead of the missing Release helper", () => {
    const f = fixture();
    write(join(f.pty, "build/Release/pty.node"), "fixture native addon");
    write(join(f.pty, `prebuilds/darwin-${process.arch}/spawn-helper`), "fixture helper");
    expect(() => ensureDarwinSpawnHelperExecutable(f.pty, "darwin", process.arch)).toThrow(/spawn-helper is missing.*Release/);
  });
});
