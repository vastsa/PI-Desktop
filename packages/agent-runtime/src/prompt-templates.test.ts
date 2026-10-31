import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  composerTemplateDirs,
  expandSlashInvocation,
  loadComposerTemplates,
} from "./prompt-templates.js";

describe("expandSlashInvocation", () => {
  const templates = [
    { name: "review", content: "Review $1 with focus on $2." },
    { name: "fix", content: "Fix the following:\n$ARGUMENTS" },
    { name: "all", content: "First: $1, rest: ${@:2}" },
    { name: "plain", content: "Summarize the current diff." },
  ];

  it("substitutes positional args", () => {
    expect(expandSlashInvocation("/review src/a.ts perf", templates)).toEqual({
      expanded: "Review src/a.ts with focus on perf.",
      command: "/review src/a.ts perf",
    });
  });

  it("substitutes $ARGUMENTS with the joined args", () => {
    expect(expandSlashInvocation("/fix a b c", templates)?.expanded).toBe(
      "Fix the following:\na b c",
    );
  });

  it("handles quoted args and ${@:N} slices", () => {
    expect(expandSlashInvocation('/all "x y" b c', templates)?.expanded).toBe(
      "First: x y, rest: b c",
    );
  });

  it.each(['""', "''"])("keeps an empty quoted argument %s without shifting later positions", (empty) => {
    const template = { name: "defaults", content: "first=${1:-fallback}; second=$2; tail=${@:2}" };
    const command = `/defaults ${empty} next last`;
    expect(expandSlashInvocation(command, [template])).toEqual({
      expanded: "first=fallback; second=next; tail=next last", command,
    });
    expect(expandSlashInvocation(`/defaults first ${empty}`, [template])?.expanded)
      .toBe("first=first; second=; tail=");
  });

  it("preserves pi's default placeholders without recursively expanding arguments", () => {
    const template = {
      name: "defaults",
      content: "${1:-fallback} ${@:-no args} $2 $1",
    };
    expect(expandSlashInvocation('/defaults "$2" "$1"', [template])?.expanded)
      .toBe("$2 $2 $1 $1 $2");
    expect(expandSlashInvocation("/defaults", [template])?.expanded)
      .toBe("fallback no args  ");
  });

  it("drops missing positional args to empty strings", () => {
    expect(expandSlashInvocation("/review one", templates)?.expanded).toBe(
      "Review one with focus on .",
    );
  });

  it("appends args to placeholder-free templates instead of dropping them", () => {
    expect(expandSlashInvocation("/plain also check tests", templates)?.expanded).toBe(
      "Summarize the current diff.\n\nalso check tests",
    );
    expect(expandSlashInvocation("/plain", templates)?.expanded).toBe(
      "Summarize the current diff.",
    );
  });

  it("folds newlines into the argument string", () => {
    expect(expandSlashInvocation("/fix a\nb", templates)?.expanded).toBe(
      "Fix the following:\na b",
    );
  });

  it("returns null for unknown names and non-slash drafts", () => {
    expect(expandSlashInvocation("/nope args", templates)).toBeNull();
    expect(expandSlashInvocation("plain text", templates)).toBeNull();
    expect(expandSlashInvocation("/", templates)).toBeNull();
  });
});

describe("loadComposerTemplates", () => {
  let root: string;
  let projectDir: string;
  let userDir: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-templates-"));
    projectDir = join(root, "project-prompts");
    userDir = join(root, "user-prompts");
    await mkdir(projectDir, { recursive: true });
    await mkdir(userDir, { recursive: true });
    await writeFile(
      join(projectDir, "review.md"),
      '---\ndescription: Project review\nargument-hint: "<file> [focus]"\n---\nReview $1.',
    );
    await writeFile(join(userDir, "review.md"), "User review $1.");
    await writeFile(
      join(userDir, "explain.md"),
      "Explain the selected code in plain language for a newcomer.",
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("derives basename names, shadows user templates, and extracts hints", async () => {
    const { templates } = await loadComposerTemplates(root, {
      project: projectDir,
      user: userDir,
    });
    const names = templates.map((t) => t.name).sort();
    expect(names).toEqual(["explain", "review"]);
    expect(templates.every((template) => !/[\\/]/.test(template.name))).toBe(true);

    const review = templates.find((t) => t.name === "review")!;
    expect(review.source).toBe("project");
    expect(review.content).toBe("Review $1.");
    expect(review.description).toBe("Project review");
    expect(review.argumentHint).toBe("<file> [focus]");

    const explain = templates.find((t) => t.name === "explain")!;
    expect(explain.source).toBe("user");
    // Description falls back to the first body line, truncated to 60 chars.
    expect(explain.description).toBe(
      "Explain the selected code in plain language for a newcomer.".slice(0, 60),
    );
  });

  it("degrades to an empty list when directories are missing", async () => {
    const { templates, diagnostics } = await loadComposerTemplates(root, {
      project: join(root, "absent-a"),
      user: join(root, "absent-b"),
    });
    expect(templates).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("derives the project dir from the workspace root", () => {
    const dirs = composerTemplateDirs("/tmp/ws");
    expect(dirs.project).toBe(join("/tmp/ws", ".pi", "prompts"));
    expect(dirs.user.endsWith(join(".pi", "agent", "prompts"))).toBe(true);
    expect(composerTemplateDirs(null).project).toBeUndefined();
  });
});
