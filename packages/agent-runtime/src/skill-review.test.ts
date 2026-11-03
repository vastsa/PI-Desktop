import { describe, expect, it } from "vitest";

import {
  buildSkillReviewUser,
  completionText,
  interpretProseSkip,
  normalizeSkillReview,
  parseSkillReview,
  readSkillReview,
  shrinkReviewUser,
  splitSkillDocument,
} from "./skill-review.js";

describe("splitSkillDocument", () => {
  it("reads name and description out of frontmatter", () => {
    const parts = splitSkillDocument(
      [
        "---",
        "name: release-a-checkout",
        "description: Ship a checkout without losing uncommitted work.",
        "---",
        "",
        "## When to Use",
        "When the branch is dirty.",
      ].join("\n"),
    );
    expect(parts.name).toBe("release-a-checkout");
    expect(parts.description).toBe("Ship a checkout without losing uncommitted work.");
    expect(parts.body).toContain("## When to Use");
    expect(parts.body).not.toContain("---");
  });

  it("falls back to the first body line when there is no frontmatter", () => {
    const parts = splitSkillDocument(
      ["# Rename a worktree", "", "Use git worktree move, never mv."].join("\n"),
      "rename-a-worktree",
    );
    expect(parts.name).toBe("rename-a-worktree");
    expect(parts.description).toBe("Use git worktree move, never mv.");
    expect(parts.body).toContain("# Rename a worktree");
  });

  it("strips quotes the model wrapped values in", () => {
    const parts = splitSkillDocument(
      ['---', 'name: "quoted-name"', "description: 'single quoted'", "---", "body"].join("\n"),
    );
    expect(parts.name).toBe("quoted-name");
    expect(parts.description).toBe("single quoted");
  });
});

describe("normalizeSkillReview", () => {
  it("keeps create, patch and write_file", () => {
    const decision = normalizeSkillReview({
      decision: "update",
      reason: "learned a checkout rule",
      ops: [
        { action: "create", name: "a-skill", content: "---\nname: a-skill\n---\nbody" },
        { action: "patch", name: "b-skill", old_string: "old", new_string: "new" },
        {
          action: "write_file",
          name: "c-skill",
          file_path: "references/x.md",
          content: "# X",
        },
      ],
    });
    expect(decision.decision).toBe("update");
    expect(decision.ops).toHaveLength(3);
    expect(decision.ops[0]).toMatchObject({ action: "create", name: "a-skill" });
    expect(decision.ops[1]).toMatchObject({ action: "patch", name: "b-skill" });
    expect(decision.ops[2]).toMatchObject({
      action: "write_file",
      name: "c-skill",
      file_path: "references/x.md",
    });
  });

  it("drops a write_file with no path or no content", () => {
    const decision = normalizeSkillReview({
      decision: "update",
      ops: [
        { action: "write_file", name: "a", file_path: "", content: "x" },
        { action: "write_file", name: "b", file_path: "references/y.md", content: "   " },
      ],
    });
    expect(decision.decision).toBe("skip");
  });

  it("degrades an update with no usable ops into skip", () => {
    const decision = normalizeSkillReview({
      decision: "update",
      ops: [{ action: "unknown_op", name: "x" }],
    });
    expect(decision.decision).toBe("skip");
    expect(decision.ops).toHaveLength(0);
  });

  it("drops a patch that would not change anything", () => {
    const decision = normalizeSkillReview({
      decision: "update",
      ops: [{ action: "patch", name: "a", old_string: "same", new_string: "same" }],
    });
    expect(decision.decision).toBe("skip");
  });

  it("treats anything that is not update as skip", () => {
    expect(normalizeSkillReview({ decision: "nonsense" }).decision).toBe("skip");
    expect(normalizeSkillReview(null).decision).toBe("skip");
  });
});

describe("parseSkillReview", () => {
  it("reads JSON out of a fenced block", () => {
    const text = [
      "Here you go:",
      "```json",
      '{"decision":"skip","reason":"one-off task","ops":[]}',
      "```",
    ].join("\n");
    const decision = parseSkillReview(text);
    expect(decision.decision).toBe("skip");
    expect(decision.reason).toBe("one-off task");
  });

  it("throws when the model emitted no JSON at all", () => {
    expect(() => parseSkillReview("I think we should skip this one.")).toThrow();
  });
});

describe("buildSkillReviewUser", () => {
  it("includes the catalog, existing bodies and the transcript", () => {
    const user = buildSkillReviewUser({
      workspace: "D:/work/repo",
      toolCallCount: 12,
      learnedCatalog: [{ name: "a-skill", description: "Does A." }],
      skillBodies: [{ name: "a-skill", content: "## Procedure\n1. do it" }],
      messages: [
        { role: "user", content: "ship it" },
        { role: "assistant", content: "ran bash", toolName: "bash" },
      ],
    });
    expect(user).toContain("D:/work/repo");
    expect(user).toContain("Tool calls this turn: 12");
    expect(user).toContain("- a-skill: Does A.");
    expect(user).toContain("----- existing skill a-skill -----");
    expect(user).toContain("## assistant (bash)");
  });

  it("says so when the library is still empty", () => {
    const user = buildSkillReviewUser({
      learnedCatalog: [],
      skillBodies: [],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(user).toContain("(none yet)");
  });
});

describe("shrinkReviewUser", () => {
  it("leaves a short message alone", () => {
    expect(shrinkReviewUser("short", 100)).toBe("short");
  });

  it("keeps the head and the tail when over budget", () => {
    const text = "H".repeat(100) + "M".repeat(5000) + "T".repeat(100);
    const shrunk = shrinkReviewUser(text, 1000);
    expect(shrunk.length).toBeLessThan(text.length);
    expect(shrunk).toContain("truncated for retry");
    expect(shrunk.startsWith("H")).toBe(true);
    expect(shrunk.endsWith("T")).toBe(true);
  });
});

describe("completionText", () => {
  it("unwraps the shapes a completion layer can return", () => {
    expect(completionText("plain")).toBe("plain");
    expect(completionText({ text: "from text" })).toBe("from text");
    expect(completionText({ content: "from content" })).toBe("from content");
    expect(completionText({ content: [{ text: "a" }, { text: "b" }] })).toBe("ab");
    expect(completionText(null)).toBe("");
  });
});

describe("interpretProseSkip", () => {
  it("reads an English refusal as skip", () => {
    const decision = interpretProseSkip("Nothing worth saving from this turn.");
    expect(decision?.decision).toBe("skip");
    expect(decision?.ops).toHaveLength(0);
  });

  it("reads a Chinese refusal as skip", () => {
    const decision = interpretProseSkip("这轮没什么可沉淀的内容，跳过。");
    expect(decision?.decision).toBe("skip");
  });

  it("returns null when the prose is not a refusal", () => {
    expect(interpretProseSkip("Here is the skill you asked for: do X then Y.")).toBeNull();
  });

  it("never reads a long delivery report as a refusal", () => {
    // A finished task that documents what it did is exactly the case the review
    // exists for; treating it as "nothing to learn" silently discards the turn.
    const report = [
      "脚本已完成并全部测试通过。最终结果：",
      "",
      "## 交付物（都在 D:/Code/PI-Desktop-main/）",
      "| 文件 | 说明 |",
      "|---|---|",
      "| Convert-PngToWebp.ps1 | 主脚本（UTF-8 带 BOM 保存，必须如此） |",
      "| TROUBLESHOOTING.md | 9 个踩坑记录及根因分析 |",
      "| testdata/ | 测试目录，含 RGBA、透明、16-bit 样例 |",
      "",
      "## 关键坑",
      "1. 脚本必须存为 UTF-8 with BOM，否则 PowerShell 按 GBK 读中文注释会乱码。",
      "2. ASCII 编码会把中文路径变成问号，触发 WinError 123。",
      "3. ConvertTo-Json 对单元素数组会退化成标量，报 string indices must be integers。",
      "4. PowerShell 5.1 不显示子进程 stderr 的 traceback，除非加 -RedirectStandardError。",
      "",
      "## 验证",
      "RGBA、透明、16-bit 全部通过，没有任何 skip 残留；回滚脚本已实测可还原。",
    ].join("\n");
    expect(report.length).toBeGreaterThan(400);
    expect(interpretProseSkip(report)).toBeNull();
  });

  it("treats empty output as skip", () => {
    expect(interpretProseSkip("")?.decision).toBe("skip");
  });
});

describe("readSkillReview", () => {
  it("prefers a real JSON decision over the phrase list", () => {
    const decision = readSkillReview('{"decision":"skip","reason":"one-off"}');
    expect(decision?.decision).toBe("skip");
    expect(decision?.reason).toBe("one-off");
  });

  it("falls back to prose when there is no JSON", () => {
    expect(readSkillReview("No skill needed here.")?.decision).toBe("skip");
  });

  it("returns null when it is neither JSON nor a refusal", () => {
    expect(readSkillReview("Let me explain my reasoning in detail.")).toBeNull();
  });

  it("survives a trailing comma the model left behind", () => {
    const decision = readSkillReview('{"decision":"skip","reason":"x","ops":[],}');
    expect(decision?.decision).toBe("skip");
  });
});
