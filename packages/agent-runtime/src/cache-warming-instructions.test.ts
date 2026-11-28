import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { matchesCacheWarmingInstructions } from "./cache-warming-instructions.js";
import { loadCustomSystemPrompt } from "./custom-system-prompt.js";
import { loadInstructionChain } from "./project-instructions.js";

it("compares worktree instructions and the custom prompt from its launch root", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-warming-instructions-"));
  try {
    const project = join(root, "project");
    const worktree = join(root, "worktree");
    await mkdir(join(project, ".pi"), { recursive: true });
    await mkdir(join(worktree, ".pi"), { recursive: true });
    const prompt = join(project, ".pi", "SYSTEM.md");
    await writeFile(prompt, "Project system prompt.");
    await writeFile(join(worktree, ".pi", "SYSTEM.md"), "Different worktree prompt.");
    await writeFile(join(worktree, "AGENTS.md"), "Worktree instructions.");
    const local = await loadInstructionChain(worktree);
    const supplied = await loadCustomSystemPrompt(project);
    const expected = { entries: [
      ...(local?.entries ?? []),
      { source: "ChatGPT Project folders", content: "Host group folder list" },
      { source: "ChatGPT Project instructions", content: "Host group instructions" },
    ] };
    expect(await matchesCacheWarmingInstructions(worktree, undefined, project, expected, supplied)).toBe(true);
    await writeFile(prompt, "Edited project prompt.");
    expect(await matchesCacheWarmingInstructions(worktree, undefined, project, expected, supplied)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
