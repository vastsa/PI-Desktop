import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceFiles } from "./workspace-files.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const fixture = async () => {
  const path = await mkdtemp(join(tmpdir(), "workspace-files-")); dirs.push(path);
  await mkdir(join(path, "src")); await writeFile(join(path, "src", "main.ts"), "remote source");
  return path;
};
describe("sessionless SSH file views", () => {
  it("lists, indexes, resolves shorthand and reads the chosen root with the local file contract", async () => {
    const path = await fixture(); const files = createWorkspaceFiles();
    expect(await files.read({ path, operation: "list" })).toMatchObject({ entries: [{ name: "src", kind: "dir" }] });
    expect(await files.read({ path, operation: "index" })).toMatchObject({ entries: [{ path: "src", kind: "dir" }, { path: "src/main.ts", kind: "file" }] });
    const resolved = await files.read({ path, operation: "resolve", ref: "main.ts" });
    expect(resolved).toMatchObject({ match: { relativePath: "src/main.ts", root: "workspace", absolutePath: join(await realpath(path), "src", "main.ts") } });
    expect(await files.read({ path, operation: "read", ref: "src/main.ts" })).toEqual({ kind: "text", content: "remote source", size: 13 });
  });
  it("does not fall back to this computer or cross symlink containment", async () => {
    const path = await fixture(); const outside = await fixture(); const files = createWorkspaceFiles();
    await symlink(join(outside, "src", "main.ts"), join(path, "escaped.ts"));
    await expect(files.read({ path, operation: "read", ref: join(outside, "src", "main.ts") })).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(files.read({ path, operation: "read", ref: "escaped.ts" })).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    expect(await files.read({ path, operation: "resolve", ref: join(outside, "src", "main.ts") })).toEqual({ match: null, reason: "outside-allowed-roots" });
  });
  it("supports canonical root aliases and refuses nonexistent/nonabsolute roots", async () => {
    const path = await fixture(); const link = `${path}-link`; dirs.push(link); await symlink(path, link);
    const files = createWorkspaceFiles();
    expect(await files.read({ path: link, operation: "read", ref: "src/main.ts" })).toMatchObject({ content: "remote source" });
    await expect(files.read({ path: "relative", operation: "list" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(files.read({ path: join(path, "missing"), operation: "list" })).rejects.toMatchObject({ code: "REMOTE_PATH_NOT_FOUND" });
  });
  it("loads repository instructions with precedence, no parent/global file, and bounded UTF-8 content", async () => {
    const path = await fixture(); const files = createWorkspaceFiles();
    expect(await files.read({ path, operation: "instructions" })).toEqual({ entries: [] });
    await writeFile(join(path, "CLAUDE.md"), "fallback");
    await writeFile(join(path, "AGENTS.md"), "repository");
    await writeFile(join(path, "AGENTS.override.md"), "override");
    expect(await files.read({ path, operation: "instructions" })).toEqual({ entries: [{ source: "AGENTS.override.md", content: "override" }] });
    await writeFile(join(path, "AGENTS.override.md"), "界".repeat(20_000));
    const loaded = await files.read({ path, operation: "instructions" }) as { entries: Array<{ source: string; content: string }> };
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]?.content).toContain("PI-Desktop truncated AGENTS.override.md");
    expect(Buffer.byteLength(loaded.entries[0]?.content ?? "")).toBeLessThan(33_000);
    expect(loaded.entries[0]?.content).not.toContain("�");
  });
  it("ignores repository instruction links escaping the explicit root", async () => {
    const path = await fixture(); const outside = await fixture();
    await writeFile(join(outside, "AGENTS.md"), "outside private instructions");
    await symlink(join(outside, "AGENTS.md"), join(path, "AGENTS.override.md"));
    await writeFile(join(path, "AGENTS.md"), "contained");
    expect(await createWorkspaceFiles().read({ path, operation: "instructions" })).toEqual({ entries: [{ source: "AGENTS.md", content: "contained" }] });
  });
});
