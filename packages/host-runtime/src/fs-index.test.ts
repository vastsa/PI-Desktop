import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  FS_INDEX_MAX_ENTRIES,
  getWorkspaceFileIndex,
  searchWorkspaceFiles,
} from "./fs-index.js";

const DEEP_SCRIPT = "Assets/_Game/Scripts/Gameplay/Player/Controllers/FeatureController.cs";

const temps: string[] = [];
afterAll(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeFiles(root: string, paths: string[]): Promise<void> {
  for (let at = 0; at < paths.length; at += 500) {
    await Promise.all(
      paths.slice(at, at + 500).map(async (path) => {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), "x");
      }),
    );
  }
}

/** A Unity-like tree: more shallow assets than the snapshot holds, one deep script. */
async function largeTree(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temps.push(root);
  const assets = Array.from(
    { length: FS_INDEX_MAX_ENTRIES + 100 },
    (_, index) => `Assets/Art/Group${Math.floor(index / 300)}/asset_${index}.png`,
  );
  await writeFiles(root, [...assets, DEEP_SCRIPT, "node_modules/pkg/FeatureController.cs"]);
  return root;
}

function gitAvailable(): boolean {
  return spawnSync("git", ["--version"]).status === 0;
}

it("finds a deep file that the truncated snapshot leaves out", async () => {
  const root = await largeTree("pi-fs-search-walk-");

  const index = await getWorkspaceFileIndex(root);
  expect(index.truncated).toBe(true);
  expect(index.entries).toHaveLength(FS_INDEX_MAX_ENTRIES);
  expect(index.entries.some((entry) => entry.path === DEEP_SCRIPT)).toBe(false);

  const found = await searchWorkspaceFiles(root, "FeatureController");
  expect(found.truncated).toBe(false);
  expect(found.entries[0]).toEqual({ path: DEEP_SCRIPT, kind: "file" });
  expect(found.entries.some((entry) => entry.path.startsWith("node_modules/"))).toBe(false);
});

it("searches a git repository's full listing and keeps its ignore rules", async (ctx) => {
  if (!gitAvailable()) ctx.skip();
  const root = await largeTree("pi-fs-search-git-");
  await writeFiles(root, ["Generated/FeatureController.cs"]);
  await writeFile(join(root, ".gitignore"), "Generated/\n");
  expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);

  const index = await getWorkspaceFileIndex(root);
  expect(index.truncated).toBe(true);
  expect(index.entries.some((entry) => entry.path === DEEP_SCRIPT)).toBe(false);

  const found = await searchWorkspaceFiles(root, "FeatureController");
  expect(found.truncated).toBe(false);
  expect(found.entries.map((entry) => entry.path)).toEqual([DEEP_SCRIPT]);
});

it("returns directories and honors the result limit", async () => {
  const root = await largeTree("pi-fs-search-limit-");

  const dirs = await searchWorkspaceFiles(root, "Controllers");
  expect(dirs.entries[0]).toEqual({
    path: "Assets/_Game/Scripts/Gameplay/Player/Controllers",
    kind: "dir",
  });

  const limited = await searchWorkspaceFiles(root, "asset_", 5);
  expect(limited.entries).toHaveLength(5);
});
