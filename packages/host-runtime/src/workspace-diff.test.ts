import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { collectWorkspaceDiff } from "./workspace-diff.js";

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];

function shellQuote(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, { cwd, encoding: "utf8" });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("collectWorkspaceDiff", () => {
  it("does not execute a repository-configured fsmonitor command", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-workspace-diff-fsmonitor-"));
    tempDirs.push(tempRoot);
    const root = join(tempRoot, "repo");
    await mkdir(root);

    await runGit(root, ["init", "--quiet"]);
    await runGit(root, ["config", "user.name", "Workspace diff test"]);
    await runGit(root, ["config", "user.email", "workspace-diff@example.invalid"]);
    await writeFile(join(root, "tracked.txt"), "content\n", "utf8");
    await runGit(root, ["add", "tracked.txt"]);
    await runGit(root, ["commit", "--quiet", "-m", "initial"]);

    const marker = join(tempRoot, "fsmonitor-ran");
    const hook = join(tempRoot, "fsmonitor-hook.cjs");
    await writeFile(
      hook,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
      "utf8",
    );
    const command = `${shellQuote(process.execPath)} ${shellQuote(hook)}`;
    await runGit(root, ["config", "core.fsmonitor", command]);

    // Prove this Git build would execute the configured command without the
    // host runner's overrides, then clear the marker before testing the host.
    // Git may reject the helper's intentionally incomplete response afterward.
    await execFile("git", ["status", "--porcelain=v1", "-z"], {
      cwd: root,
      encoding: "utf8",
    }).catch(() => undefined);
    expect(existsSync(marker)).toBe(true);
    await rm(marker, { force: true });

    const diff = await collectWorkspaceDiff(root);

    expect(diff).toMatchObject({ repo: true, clean: true, files: [] });
    expect(existsSync(marker)).toBe(false);

    await runGit(root, ["config", "--unset", "core.fsmonitor"]);
    const injectedConfig = [
      ["GIT_CONFIG_COUNT", process.env.GIT_CONFIG_COUNT],
      ["GIT_CONFIG_KEY_0", process.env.GIT_CONFIG_KEY_0],
      ["GIT_CONFIG_VALUE_0", process.env.GIT_CONFIG_VALUE_0],
    ] as const;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
    process.env.GIT_CONFIG_VALUE_0 = command;
    try {
      const envDiff = await collectWorkspaceDiff(root);
      expect(envDiff).toMatchObject({ repo: true, clean: true, files: [] });
      expect(existsSync(marker)).toBe(false);
    } finally {
      for (const [key, value] of injectedConfig) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("does not execute repository-configured textconv commands", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-workspace-diff-textconv-"));
    tempDirs.push(tempRoot);
    const root = join(tempRoot, "repo");
    await mkdir(root);

    await runGit(root, ["init", "--quiet"]);
    await runGit(root, ["config", "user.name", "Workspace diff test"]);
    await runGit(root, ["config", "user.email", "workspace-diff@example.invalid"]);
    await writeFile(join(root, "tracked.txt"), "initial\n", "utf8");
    await runGit(root, ["add", "tracked.txt"]);
    await runGit(root, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(
      join(root, ".gitattributes"),
      "tracked.txt diff=probe\nuntracked.txt diff=probe\n",
      "utf8",
    );
    await runGit(root, ["add", ".gitattributes"]);
    await runGit(root, ["commit", "--quiet", "-m", "diff attributes"]);

    const marker = join(tempRoot, "textconv-ran");
    const command = join(tempRoot, "textconv.cjs");
    await writeFile(
      command,
      `const fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(marker)}, "ran\\n");\nprocess.stdout.write(fs.readFileSync(process.argv.at(-1)));\n`,
      "utf8",
    );
    const textconv = `${shellQuote(process.execPath)} ${shellQuote(command)}`;
    await runGit(root, ["config", "diff.probe.textconv", textconv]);
    await writeFile(join(root, "tracked.txt"), "changed\n", "utf8");
    await writeFile(join(root, "untracked.txt"), "new file\n", "utf8");

    // Prove the repository's textconv command is active before exercising the host.
    await execFile("git", ["diff", "--textconv", "--", "tracked.txt"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(existsSync(marker)).toBe(true);
    await rm(marker, { force: true });

    const diff = await collectWorkspaceDiff(root);

    expect(diff.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["tracked.txt", "untracked.txt"]),
    );
    expect(existsSync(marker)).toBe(false);
  });
});
