import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverExtensionsInDir,
  discoverManualPath,
  discoverTrustedExtensions,
  resolveExtensionEntries,
} from "./discovery.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-ext-discovery-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function file(path: string, content = "export default function () {}\n") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

describe("discovery", () => {
  it("finds loose files, index directories, and pi manifests one level deep", () => {
    const ext = join(root, "extensions");
    file(join(ext, "hello.ts"));
    file(join(ext, "notes.md"), "# not an extension");
    file(join(ext, "typed.d.ts"), "export {}");
    file(join(ext, "dir-index", "index.js"));
    file(join(ext, "pkg", "src", "a.ts"));
    file(join(ext, "pkg", "src", "b.ts"));
    file(
      join(ext, "pkg", "package.json"),
      JSON.stringify({ name: "@acme/pack", pi: { extensions: ["src/a.ts", "src/b.ts", "missing.ts"] } }),
    );
    file(join(ext, "deep", "nested", "index.ts"));

    const specs = discoverExtensionsInDir(ext, "user");
    expect(specs.map((s) => [s.label, s.source])).toEqual([
      ["dir-index", "user"],
      ["hello", "user"],
      ["@acme/pack/a", "user"],
      ["@acme/pack/b", "user"],
    ]);
    expect(specs.every((s) => s.root === ext)).toBe(true);
  });

  it("resolves entries with manifest precedence over index files", () => {
    const dir = join(root, "pkg");
    file(join(dir, "index.ts"));
    file(join(dir, "main.ts"));
    file(join(dir, "package.json"), JSON.stringify({ pi: { extensions: ["main.ts"] } }));
    expect(resolveExtensionEntries(dir)).toEqual([join(dir, "main.ts")]);
    expect(resolveExtensionEntries(join(root, "nowhere"))).toBeUndefined();
  });

  it("orders user, project, manual and dedupes by realpath", () => {
    const agentDir = join(root, "agent");
    const project = join(root, "proj");
    file(join(agentDir, "extensions", "a.ts"));
    file(join(project, ".pi", "extensions", "b.ts"));
    const manualFile = join(root, "manual", "c.ts");
    file(manualFile);
    const specs = discoverTrustedExtensions({
      agentDir,
      projectPath: project,
      manualPaths: [manualFile, join(agentDir, "extensions", "a.ts")],
    });
    expect(specs.map((s) => [s.label, s.source])).toEqual([
      ["a", "user"],
      ["b", "project"],
      ["c", "manual"],
    ]);
  });

  it("treats a manual directory as a package or a loose folder", () => {
    const pkg = join(root, "pkg");
    file(join(pkg, "index.ts"));
    expect(discoverManualPath(pkg).map((s) => s.label)).toEqual(["pkg"]);
    const loose = join(root, "loose");
    file(join(loose, "x.ts"));
    file(join(loose, "y.js"));
    expect(discoverManualPath(loose).map((s) => s.label)).toEqual(["x", "y"]);
    expect(discoverManualPath(join(root, "missing"))).toEqual([]);
  });
});
