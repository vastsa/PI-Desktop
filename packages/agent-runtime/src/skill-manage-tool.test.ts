import { describe, expect, it } from "vitest";
import { createSkillManageTool } from "./skill-manage-tool.js";

type Call = { method: string; params: Record<string, unknown> };

/**
 * Minimal skill store: records every RPC and answers the shapes the host
 * returns. The point of these tests is the mapping and the refusals, so the
 * fake stays deliberately dumb.
 */
function fakeHost(
  options: {
    body?: string | null;
    createError?: string;
    writeError?: string;
    deleteOk?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  return {
    calls,
    call: async <T>(method: string, params: unknown): Promise<T> => {
      const input = (params ?? {}) as Record<string, unknown>;
      calls.push({ method, params: input });
      switch (method) {
        case "skills.create":
          if (options.createError) throw new Error(options.createError);
          return { skill: { id: "new-skill", name: "new-skill" } } as T;
        case "skills.read":
          return {
            skill: options.body == null ? null : { id: input.id, name: input.id },
            body: options.body ?? null,
          } as T;
        case "skills.update":
          return { skill: { id: input.id, name: input.id } } as T;
        case "skills.writeFile":
        case "skills.removeFile":
          if (method === "skills.writeFile" && options.writeError) {
            throw new Error(options.writeError);
          }
          return { path: input.path } as T;
        case "skills.remove":
          return { ok: options.deleteOk ?? true } as T;
        default:
          throw new Error(`unexpected method ${method}`);
      }
    },
  };
}

async function run(host: ReturnType<typeof fakeHost>, params: Record<string, unknown>) {
  const tool = createSkillManageTool(host as never);
  const result = (await tool.execute("call-1", params as never, undefined as never)) as {
    content: { text: string }[];
    isError?: boolean;
    details?: Record<string, unknown>;
  };
  return { text: result.content.map((part) => part.text).join("\n"), result };
}

describe("skill_manage: create", () => {
  it("sends the name, description and body as one skill payload", async () => {
    const host = fakeHost();
    const { text, result } = await run(host, {
      action: "create",
      name: "add-npm-script",
      description: "Use when asked to add an npm script.",
      body: "## When to Use\n…",
    });
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0].method).toBe("skills.create");
    expect(host.calls[0].params).toEqual({
      skill: {
        name: "add-npm-script",
        description: "Use when asked to add an npm script.",
        body: "## When to Use\n…",
      },
    });
    expect(result.isError).toBeFalsy();
    // The host owns id derivation (a slug of the name), so the tool reports the
    // id that came back rather than echoing the requested name.
    expect(text).toContain("new-skill");
  });

  it("requires a name", async () => {
    const host = fakeHost();
    const { text } = await run(host, { action: "create", body: "x" });
    expect(host.calls).toHaveLength(0);
    expect(text).toContain("name");
  });

  it("turns a duplicate name into advice rather than a failure", async () => {
    const host = fakeHost({ createError: "SKILL_INVALID: a skill with this name already exists at this level" });
    const { text, result } = await run(host, { action: "create", name: "dup" });
    expect(result.isError).toBeFalsy();
    expect(text).toContain("Patch that skill instead");
    expect(result.details).toMatchObject({ errorCode: "SKILL_EXISTS" });
  });
});

describe("skill_manage: patch", () => {
  it("replaces exactly one span and writes the whole document back", async () => {
    const host = fakeHost({ body: "# Skill\n\nfirst line\nsecond line\n" });
    const { text } = await run(host, {
      action: "patch",
      name: "my-skill",
      old_string: "first line",
      new_string: "FIRST line",
    });
    expect(host.calls.map((call) => call.method)).toEqual(["skills.read", "skills.update"]);
    expect(host.calls[1].params).toEqual({
      id: "my-skill",
      skill: { body: "# Skill\n\nFIRST line\nsecond line\n" },
    });
    expect(text).toContain("Patched");
  });

  it("refuses an absent old_string without touching the store", async () => {
    const host = fakeHost({ body: "# Skill\n\nonly line\n" });
    const { text, result } = await run(host, {
      action: "patch",
      name: "my-skill",
      old_string: "missing",
      new_string: "x",
    });
    expect(host.calls.map((call) => call.method)).toEqual(["skills.read"]);
    expect(result.details).toMatchObject({ errorCode: "SKILL_NO_MATCH" });
    expect(text).toContain("does not occur");
  });

  it("refuses an ambiguous old_string", async () => {
    const host = fakeHost({ body: "same\nsame\n" });
    const { text, result } = await run(host, {
      action: "patch",
      name: "my-skill",
      old_string: "same",
      new_string: "x",
    });
    expect(host.calls.map((call) => call.method)).toEqual(["skills.read"]);
    expect(result.details).toMatchObject({ errorCode: "SKILL_AMBIGUOUS_MATCH" });
    expect(text).toContain("exactly one span");
  });

  it("refuses an id the library does not hold", async () => {
    const host = fakeHost({ body: null });
    const { result } = await run(host, {
      action: "patch",
      name: "ghost",
      old_string: "a",
      new_string: "b",
    });
    expect(result.details).toMatchObject({ errorCode: "SKILL_NOT_FOUND" });
  });

  it("requires both sides of the replacement", async () => {
    const host = fakeHost({ body: "x" });
    expect((await run(host, { action: "patch", name: "s", new_string: "y" })).result.details)
      .toMatchObject({ errorCode: "SKILL_MISSING_OLD_STRING" });
    expect((await run(host, { action: "patch", name: "s", old_string: "x" })).result.details)
      .toMatchObject({ errorCode: "SKILL_MISSING_NEW_STRING" });
    expect(host.calls).toHaveLength(0);
  });
});

describe("skill_manage: reference files", () => {
  it("writes one reference and reports where it landed", async () => {
    const host = fakeHost();
    const { text } = await run(host, {
      action: "write_file",
      name: "my-skill",
      file_path: "references/pitfalls.md",
      content: "# Pitfalls\n",
    });
    expect(host.calls[0]).toEqual({
      method: "skills.writeFile",
      params: { id: "my-skill", path: "references/pitfalls.md", content: "# Pitfalls\n" },
    });
    expect(text).toContain("references/pitfalls.md");
  });

  it("surfaces the host's path rule as a refusal the model can fix", async () => {
    const host = fakeHost({
      writeError: "SKILL_INVALID: resource path must be references/<name>.md",
    });
    const { text, result } = await run(host, {
      action: "write_file",
      name: "my-skill",
      file_path: "../escape.md",
      content: "x",
    });
    expect(result.isError).toBeFalsy();
    expect(result.details).toMatchObject({ errorCode: "SKILL_INVALID_PATH" });
    expect(text).toContain("references/<name>.md");
  });

  it("removes one reference", async () => {
    const host = fakeHost();
    const { text } = await run(host, {
      action: "remove_file",
      name: "my-skill",
      file_path: "references/old.md",
    });
    expect(host.calls[0]).toEqual({
      method: "skills.removeFile",
      params: { id: "my-skill", path: "references/old.md" },
    });
    expect(text).toContain("Removed");
  });

  it("requires a path on both reference actions", async () => {
    const host = fakeHost();
    expect((await run(host, { action: "write_file", name: "s", content: "x" })).result.details)
      .toMatchObject({ errorCode: "SKILL_MISSING_PATH" });
    expect((await run(host, { action: "remove_file", name: "s" })).result.details)
      .toMatchObject({ errorCode: "SKILL_MISSING_PATH" });
    expect(host.calls).toHaveLength(0);
  });
});

describe("skill_manage: delete", () => {
  it("deletes a whole skill", async () => {
    const host = fakeHost();
    const { text } = await run(host, { action: "delete", name: "my-skill" });
    expect(host.calls[0]).toEqual({ method: "skills.remove", params: { id: "my-skill" } });
    expect(text).toContain("Deleted");
  });

  it("reports an id the library does not hold", async () => {
    const host = fakeHost({ deleteOk: false });
    const { result } = await run(host, { action: "delete", name: "ghost" });
    expect(result.details).toMatchObject({ errorCode: "SKILL_NOT_FOUND" });
  });
});

describe("skill_manage: arguments", () => {
  it("refuses an unknown action without calling the host", async () => {
    const host = fakeHost();
    const { text, result } = await run(host, { action: "rename", name: "s" });
    expect(host.calls).toHaveLength(0);
    expect(result.details).toMatchObject({ errorCode: "SKILL_INVALID_ACTION" });
    expect(text).toContain("must be one of");
  });

  it("keeps a host write failure as a real error result", async () => {
    const host = fakeHost({ createError: "disk on fire" });
    const { result } = await run(host, { action: "create", name: "x" });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ errorCode: "SKILL_CREATE_FAILED" });
  });
});
