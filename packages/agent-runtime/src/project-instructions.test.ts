import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadInstructionChain,
  loadProjectInstructions,
  type ProjectInstructions,
} from "./project-instructions.js";
import { projectInstructionsPrompt } from "./project-instructions-prompt.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("loadProjectInstructions", () => {
  it("loads a non-empty workspace-root AGENTS.md", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    await writeFile(join(root, "AGENTS.md"), "Use pnpm for package commands.\n");

    await expect(loadProjectInstructions(root)).resolves.toEqual({
      entries: [{ source: "AGENTS.md", content: "Use pnpm for package commands." }],
    });
  });

  it("layers root and nested instructions with stable slash-normalized sources", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    await mkdir(join(root, "packages", "api"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Use the root convention.");
    await writeFile(join(root, "packages", "AGENTS.md"), "Use package rules.");
    await writeFile(join(root, "packages", "api", "AGENTS.md"), "Use API rules.");

    await expect(
      loadProjectInstructions(root, "packages/api/handler.ts"),
    ).resolves.toEqual({
      entries: [
        { source: "AGENTS.md", content: "Use the root convention." },
        { source: "packages/AGENTS.md", content: "Use package rules." },
        { source: "packages/api/AGENTS.md", content: "Use API rules." },
      ],
    });
  });

  it("prefers AGENTS.override.md within a directory", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    await writeFile(join(root, "AGENTS.md"), "Use shared rules.");
    await writeFile(join(root, "AGENTS.override.md"), "Use local override.");

    await expect(loadProjectInstructions(root)).resolves.toEqual({
      entries: [
        { source: "AGENTS.override.md", content: "Use local override." },
      ],
    });
  });

  it("uses Claude-compatible files only when no AGENTS file exists", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    await writeFile(join(root, "CLAUDE.md"), "Use Claude-compatible rules.");

    await expect(loadProjectInstructions(root)).resolves.toEqual({
      entries: [
        { source: "CLAUDE.md", content: "Use Claude-compatible rules." },
      ],
    });
  });

  it("prefers AGENTS.md over Claude-compatible files", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    await writeFile(join(root, "AGENTS.md"), "Use AGENTS rules.");
    await writeFile(join(root, "CLAUDE.md"), "Use Claude rules.");

    await expect(loadProjectInstructions(root)).resolves.toEqual({
      entries: [{ source: "AGENTS.md", content: "Use AGENTS rules." }],
    });
  });

  it("caps the complete chain at 32 KiB without splitting UTF-8 characters", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    await writeFile(join(root, "AGENTS.md"), "中".repeat(20_000));

    const loaded = await loadProjectInstructions(root);
    expect(Buffer.byteLength(loaded!.entries[0].content, "utf8")).toBeLessThanOrEqual(
      32 * 1024,
    );
    expect(loaded!.entries[0].content.endsWith("中")).toBe(true);
  });

  it("treats missing and blank project instructions as absent", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    await expect(loadProjectInstructions(root)).resolves.toBeUndefined();

    await writeFile(join(root, "AGENTS.md"), " \n\t ");
    await expect(loadProjectInstructions(root)).resolves.toBeUndefined();
    await expect(loadProjectInstructions(root, "../outside/file.ts")).resolves.toBeUndefined();
  });

  it("falls back to the project-root chain for a target outside the workspace", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-outside-"));
    await writeFile(join(root, "AGENTS.md"), "Use root conventions.");
    await writeFile(join(outside, "AGENTS.md"), "Use outside rules.");

    try {
      await expect(
        loadProjectInstructions(root, join(outside, "attached.txt")),
      ).resolves.toEqual({
        entries: [{ source: "AGENTS.md", content: "Use root conventions." }],
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("uses the project-root chain when the workspace root itself is the target", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    await writeFile(join(root, "AGENTS.md"), "Use root conventions.");

    await expect(loadProjectInstructions(root, root)).resolves.toEqual({
      entries: [{ source: "AGENTS.md", content: "Use root conventions." }],
    });
  });

  it("does not fabricate instructions without a project or a project-root file", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));

    await expect(
      loadProjectInstructions(root, join(root, "..", "outside", "attached.txt")),
    ).resolves.toBeUndefined();
    await expect(
      loadProjectInstructions(undefined, join(root, "..", "outside", "attached.txt")),
    ).resolves.toBeUndefined();
  });
});

describe("loadInstructionChain", () => {
  it("loads global instructions before project instructions", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    const globalPath = join(root, "global-AGENTS.md");
    await writeFile(globalPath, "Use global conventions.");
    await writeFile(join(root, "AGENTS.md"), "Use project conventions.");

    await expect(loadInstructionChain(root, undefined, globalPath)).resolves.toEqual({
      entries: [
        { source: "~/.pi/agent/AGENTS.md", content: "Use global conventions." },
        { source: "AGENTS.md", content: "Use project conventions." },
      ],
    });
  });

  it("keeps the global and root entries when the target is outside the workspace", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    const globalPath = join(root, "global-AGENTS.md");
    await writeFile(globalPath, "Use global conventions.");
    await writeFile(join(root, "AGENTS.md"), "Use project conventions.");

    await expect(
      loadInstructionChain(root, join(root, "..", "outside", "attached.txt"), globalPath),
    ).resolves.toEqual({
      entries: [
        { source: "~/.pi/agent/AGENTS.md", content: "Use global conventions." },
        { source: "AGENTS.md", content: "Use project conventions." },
      ],
    });
  });

  it("shares the 32 KiB byte budget between global and project instructions", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    const globalPath = join(root, "global-AGENTS.md");
    await writeFile(globalPath, "a".repeat(32 * 1024));
    await writeFile(join(root, "AGENTS.md"), "Use project conventions.");

    await expect(loadInstructionChain(root, undefined, globalPath)).resolves.toEqual({
      entries: [{ source: "~/.pi/agent/AGENTS.md", content: "a".repeat(32 * 1024) }],
    });
  });
});

describe("projectInstructionsPrompt", () => {
  it("labels instruction sources and makes later entries authoritative", () => {
    const instructions: ProjectInstructions = {
      entries: [
        { source: "AGENTS.md", content: "Run unit tests." },
        { source: "packages/api/AGENTS.md", content: "Run API tests." },
      ],
    };

    expect(projectInstructionsPrompt(instructions)).toContain(
      "## AGENTS.md\n\nRun unit tests.",
    );
    expect(projectInstructionsPrompt(instructions)).toContain(
      "## packages/api/AGENTS.md\n\nRun API tests.",
    );
  });
});
