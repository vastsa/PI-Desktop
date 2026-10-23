import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHostOperations } from "./host-operations.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pi-plugin-remote-")));
  temporary.push(home);
  const root = join(home, "repo");
  const data = join(home, "host-data");
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(data);
  await writeFile(join(root, "docs", "guide.md"), "remote guide\n");
  await writeFile(join(root, "other.txt"), "outside declared scope");
  await writeFile(join(root, ".env"), "private fixture");
  await writeFile(join(data, "tokens.json"), "private host fixture");
  const operations = createHostOperations({
    getHost: () => null,
    runtime: { compact: async () => ({ accepted: true }), isBusy: () => false },
    browseRoot: home,
    dataDir: data,
  });
  expect(operations.workspacePluginFiles, "Host must offer a separate scoped plugin read service").toBeDefined();
  const read = (operation: "list" | "preview", ref = "", scope = ["**"], path = root) =>
    operations.workspacePluginFiles!.read({ path, ref, operation, scope });
  return { home, root, data, read };
}

it("lists nested remote directories and previews text with real metadata", { timeout: 60_000 }, async () => {
  const { root, read } = await fixture();
  const listed = await read("list", "docs");
  expect(listed).toMatchObject({ kind: "list", entries: [{ name: "guide.md", path: "docs/guide.md", isDirectory: false, size: 13 }] });
  const preview = await read("preview", "docs/guide.md");
  expect(preview).toMatchObject({ kind: "text", content: "remote guide\n", size: 13, mtimeMs: expect.any(Number) });
  expect((preview as { mtimeMs: number }).mtimeMs).toBeGreaterThan(0);
  expect(await read("list")).not.toHaveProperty("entries.0.name", ".env");
  expect(JSON.stringify(await read("list"))).not.toContain('".env"');
  await writeFile(join(root, "image.png"), Buffer.from([137, 80, 78, 71]));
  expect(await read("preview", "image.png")).toMatchObject({ kind: "image", dataUrl: "data:image/png;base64,iVBORw==", size: 4 });
});

it("enforces scope on both the requested and canonical file", { timeout: 60_000 }, async () => {
  const { root, read } = await fixture();
  await symlink(join(root, "other.txt"), join(root, "docs", "alias.txt"));
  expect(await read("list", "docs", ["docs/**"])).toMatchObject({ entries: [{ name: "guide.md" }] });
  expect(JSON.stringify(await read("list", "docs", ["docs/**"]))).not.toContain("alias.txt");
  await expect(read("preview", "docs/alias.txt", ["docs/**"])).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
  await expect(read("preview", "other.txt", ["docs/**"])).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
  expect(await read("list", "docs", [])).toMatchObject({ entries: [] });
});

it("caps a remote directory listing at the plugin SDK limit", { timeout: 60_000 }, async () => {
  const { root, read } = await fixture();
  await Promise.all(Array.from({ length: 1005 }, (_, index) =>
    writeFile(join(root, `item-${String(index).padStart(4, "0")}.txt`), ""),
  ));
  const result = await read("list", "", ["**"]);
  expect(result).toMatchObject({ kind: "list" });
  if (result.kind !== "list") throw new Error("expected a directory listing");
  expect(result.entries).toHaveLength(1000);
});

it("refuses credentials, escaped links, protected Host data and browse-root escapes", { timeout: 60_000 }, async () => {
  const { home, root, data, read } = await fixture();
  await symlink(join(root, ".env"), join(root, "docs", "credential.txt"));
  await symlink(data, join(root, "host-link"));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "pi-plugin-outside-")));
  temporary.push(outside);
  await writeFile(join(outside, "other.txt"), "outside");
  await symlink(join(outside, "other.txt"), join(root, "escape.txt"));
  for (const ref of [".env", "docs/credential.txt", "escape.txt", "host-link/tokens.json", "../host-data/tokens.json", "/etc/passwd", "C:\\secrets.txt", "docs/\u0000bad"]) {
    await expect(read("preview", ref)).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|INVALID_ARGUMENT/) });
  }
  for (const path of [data, outside]) {
    await expect(read("list", "", ["**"], path)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
  }
  expect(JSON.stringify(await read("list"))).not.toMatch(/escape.txt|host-link/);
  expect(JSON.stringify(await read("list", "docs"))).not.toContain("credential.txt");
  expect(home).not.toBe(outside);
});

it("returns explicit oversized/binary results and missing-file errors", { timeout: 60_000 }, async () => {
  const { root, read } = await fixture();
  await writeFile(join(root, "large.txt"), "x".repeat(512 * 1024 + 1));
  await writeFile(join(root, "binary.dat"), Buffer.from([1, 0, 2]));
  expect(await read("preview", "large.txt")).toMatchObject({ kind: "tooLarge", size: 512 * 1024 + 1 });
  expect(await read("preview", "binary.dat")).toMatchObject({ kind: "binary", size: 3 });
  await expect(read("preview", "missing.txt")).rejects.toMatchObject({ code: "REMOTE_PATH_NOT_FOUND" });
  await expect(read("preview", "docs")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});

it("refuses credential directories used as the workspace root, including aliases", { timeout: 60_000 }, async () => {
  const { home, read } = await fixture();
  const credentials = join(home, ".aws");
  const alias = join(home, "credential-alias");
  await mkdir(credentials);
  await writeFile(join(credentials, "credentials"), "private fixture");
  await symlink(credentials, alias);
  for (const path of [credentials, alias]) {
    await expect(read("list", "", ["**"], path)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(read("preview", "credentials", ["**"], path)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
  }
});
