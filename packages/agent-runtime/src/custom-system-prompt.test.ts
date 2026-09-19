import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  customSystemPromptDirs,
  loadCustomSystemPrompt,
} from "./custom-system-prompt.js";

let root: string | undefined;
let globalDir: string | undefined;

afterEach(async () => {
  for (const dir of [root, globalDir]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  root = undefined;
  globalDir = undefined;
});

async function fixture(files: Record<string, string>) {
  root = await mkdtemp(join(tmpdir(), "pi-desktop-csp-"));
  globalDir = await mkdtemp(join(tmpdir(), "pi-desktop-csp-global-"));
  for (const [name, content] of Object.entries(files)) {
    const dir = name.startsWith("global/")
      ? globalDir!
      : root!;
    const relative = name.startsWith("global/") ? name.slice("global/".length) : name;
    const target = join(dir, relative);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
}

describe("loadCustomSystemPrompt", () => {
  it("returns undefined without any files", async () => {
    await fixture({});
    await expect(
      loadCustomSystemPrompt(root, { project: join(root!, ".pi"), global: globalDir! }),
    ).resolves.toBeUndefined();
  });

  it("reads the global SYSTEM.md and APPEND_SYSTEM.md", async () => {
    await fixture({ "global/SYSTEM.md": "  Custom persona.\n" });
    await expect(
      loadCustomSystemPrompt(root, { project: join(root!, ".pi"), global: globalDir! }),
    ).resolves.toEqual({ replace: "Custom persona." });
  });

  it("reads the global APPEND_SYSTEM.md independently", async () => {
    await fixture({ "global/APPEND_SYSTEM.md": "Always cite sources." });
    await expect(
      loadCustomSystemPrompt(root, { project: join(root!, ".pi"), global: globalDir! }),
    ).resolves.toEqual({ append: "Always cite sources." });
  });

  it("reads both files when both exist", async () => {
    await fixture({
      "global/SYSTEM.md": "Custom persona.",
      "global/APPEND_SYSTEM.md": "Also cite sources.",
    });
    await expect(
      loadCustomSystemPrompt(root, { project: join(root!, ".pi"), global: globalDir! }),
    ).resolves.toEqual({ replace: "Custom persona.", append: "Also cite sources." });
  });

  it("prefers the project file over the global one per kind", async () => {
    await fixture({
      ".pi/SYSTEM.md": "Project persona.",
      "global/SYSTEM.md": "Global persona.",
      "global/APPEND_SYSTEM.md": "Global appendix.",
    });
    await expect(
      loadCustomSystemPrompt(root, { project: join(root!, ".pi"), global: globalDir! }),
    ).resolves.toEqual({ replace: "Project persona.", append: "Global appendix." });
  });

  it("treats a whitespace-only file as absent and falls back", async () => {
    await fixture({
      ".pi/SYSTEM.md": "   \n\t\n",
      "global/SYSTEM.md": "Global persona.",
    });
    await expect(
      loadCustomSystemPrompt(root, { project: join(root!, ".pi"), global: globalDir! }),
    ).resolves.toEqual({ replace: "Global persona." });
  });

  it("caps content at 64 KiB without splitting UTF-8 characters", async () => {
    await fixture({ "global/APPEND_SYSTEM.md": "ü".repeat(70_000) });
    const loaded = await loadCustomSystemPrompt(root, {
      project: join(root!, ".pi"),
      global: globalDir!,
    });
    expect(Buffer.byteLength(loaded!.append!, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(loaded!.append!.endsWith("ü")).toBe(true);
  });

  it("works without a workspace root (global only)", async () => {
    await fixture({ "global/SYSTEM.md": "Global persona." });
    await expect(
      loadCustomSystemPrompt(null, { global: globalDir! }),
    ).resolves.toEqual({ replace: "Global persona." });
  });
});

describe("customSystemPromptDirs", () => {
  it("omits the project dir without a workspace root", () => {
    expect(customSystemPromptDirs(null).project).toBeUndefined();
    expect(customSystemPromptDirs("  ").project).toBeUndefined();
  });

  it("points the project dir at <workspace>/.pi", () => {
    expect(customSystemPromptDirs("/w").project).toBe(join("/w", ".pi"));
  });
});
