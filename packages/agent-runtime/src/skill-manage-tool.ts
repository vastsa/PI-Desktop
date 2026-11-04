/**
 * The `skill_manage` tool: the agent writes its own skill library.
 *
 * The same shape as the `memory` tool, one level up. The model names an action
 * and the text to act on; the app's skill store performs it. Nothing here
 * touches the filesystem — every action is a `skills.*` RPC, so the runtime, the
 * UI and the background review all write through one implementation and one path
 * rule (`references/<name>.md`, validated host-side).
 *
 * `patch` reads the document here and applies the replacement locally rather
 * than asking the host to match on a string: "which occurrence did the model
 * mean" is exactly the kind of rule that must exist once, and it must be the one
 * the tests cover. The host still owns the write, so a patch cannot race a
 * review pass into a lost update any more than two RPCs can.
 *
 * A refused edit is reported as ordinary text, not a tool failure: the model
 * can fix its own argument and retry in the same turn (same convention as
 * `memory`).
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import type { RuntimeHost } from "./host-client.js";
import { SKILL_AUTHORING_GUIDE } from "./skill-review.js";

/** Host surface this tool needs: read, create, patch, and resource writes. */
export type SkillManageHost = Pick<RuntimeHost, "call">;

type SkillRecord = { id: string; name: string; path?: string };

const SKILL_MANAGE_DESCRIPTION = [
  "Read and edit your durable skill library: the SKILL.md documents that load into later sessions.",
  "",
  "Use it the moment a turn teaches you something reusable — a procedure, a pitfall, a decision rule, a command sequence that worked. Capture the rule, not the afternoon: name the class of problem, never the single issue.",
  "",
  "Actions:",
  "- `create` starts a new skill. Give `name` (lowercase-hyphenated) and `description` (one sentence: when to use it); `body` is the document. A name that already exists is refused — patch that skill instead.",
  "- `patch` replaces ONE span inside an existing skill's document. `old_string` must occur exactly once; copy it verbatim. This is the usual way to extend a skill you already have.",
  "- `write_file` adds `references/<topic>.md` beside the skill's SKILL.md. Prefer this for a self-contained lesson: it is a small write and cannot damage the document. Path must be `references/<name>.md`.",
  "- `remove_file` deletes one `references/<name>.md` that is wrong or superseded.",
  "- `delete` removes a whole skill. Only when its content now lives somewhere better.",
  "",
  "Never create a near-duplicate of a skill you already have: patch it, or add a reference to it.",
  "",
  SKILL_AUTHORING_GUIDE,
].join("\n");

const SKILL_MANAGE_PARAMETERS = Type.Object(
  {
    action: Type.Union(
      [
        Type.Literal("create"),
        Type.Literal("patch"),
        Type.Literal("write_file"),
        Type.Literal("remove_file"),
        Type.Literal("delete"),
      ],
      { description: "What to do with the library." },
    ),
    name: Type.String({
      description:
        "Skill id, exactly as listed in your Skills section. For `create`, the new skill's name.",
    }),
    description: Type.Optional(
      Type.String({
        description:
          "create only. ONE sentence, <=60 characters, `Use when <trigger>. <behavior>.` It is what later sessions index on.",
      }),
    ),
    body: Type.Optional(
      Type.String({ description: "create only. The SKILL.md document, without frontmatter." }),
    ),
    old_string: Type.Optional(
      Type.String({
        description: "patch only. Text copied verbatim from the skill document; must occur exactly once.",
      }),
    ),
    new_string: Type.Optional(
      Type.String({ description: "patch only. The replacement for old_string." }),
    ),
    file_path: Type.Optional(
      Type.String({
        description: "write_file / remove_file. Must be `references/<name>.md`.",
      }),
    ),
    content: Type.Optional(
      Type.String({ description: "write_file only. Markdown for the reference file." }),
    ),
  },
  { additionalProperties: false },
);

type RawParams = {
  action?: string;
  name?: string;
  description?: string;
  body?: string;
  old_string?: string;
  new_string?: string;
  file_path?: string;
  content?: string;
};

function text(
  message: string,
  details: Record<string, unknown> = {},
  isError?: boolean,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text" as const, text: message }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

/** A refusal the model can fix itself: report as text so it retries in-turn. */
function refused(message: string, errorCode: string) {
  return text(message, { errorCode });
}

async function createSkill(host: SkillManageHost, params: RawParams) {
  const name = params.name?.trim();
  if (!name) return refused("`name` is required to create a skill.", "SKILL_MISSING_NAME");
  try {
    const result = await host.call<{ skill?: SkillRecord }>("skills.create", {
      skill: {
        name,
        ...(params.description ? { description: params.description } : {}),
        ...(params.body ? { body: params.body } : {}),
      },
    });
    const id = result?.skill?.id ?? name;
    return text(
      `Created skill \`${id}\`. It is listed in your Skills section from the next session; patch it now to keep refining it.`,
      { id, action: "create" },
    );
  } catch (error) {
    const detail = String((error as { message?: string })?.message ?? error);
    // A duplicate name is the model's to resolve (patch it instead).
    if (/already exists/i.test(detail)) {
      return refused(`${detail} Patch that skill instead of creating a second one.`, "SKILL_EXISTS");
    }
    return text(`The skill was not created: ${detail}`, { errorCode: "SKILL_CREATE_FAILED" }, true);
  }
}

async function patchSkill(host: SkillManageHost, params: RawParams) {
  const id = params.name?.trim();
  const oldString = params.old_string;
  const newString = params.new_string;
  if (!id) return refused("`name` is required to patch a skill.", "SKILL_MISSING_NAME");
  if (!oldString) return refused("`old_string` is required to patch a skill.", "SKILL_MISSING_OLD_STRING");
  if (newString === undefined) {
    return refused("`new_string` is required to patch a skill (pass an empty string to delete).", "SKILL_MISSING_NEW_STRING");
  }
  const read = await host.call<{ skill?: SkillRecord | null; body?: string | null }>("skills.read", {
    id,
  });
  const body = read?.body ?? null;
  if (read?.skill == null || body == null) {
    return refused(`No skill with id \`${id}\` in the library. Use \`create\` for a new one.`, "SKILL_NOT_FOUND");
  }
  const occurrences = body.split(oldString).length - 1;
  if (occurrences === 0) {
    return refused(
      `\`old_string\` does not occur in \`${id}\`. Read the skill and copy an exact span from it.`,
      "SKILL_NO_MATCH",
    );
  }
  if (occurrences > 1) {
    return refused(
      `\`old_string\` occurs ${occurrences} times in \`${id}\`; it must select exactly one span. Include more surrounding text.`,
      "SKILL_AMBIGUOUS_MATCH",
    );
  }
  try {
    await host.call("skills.update", { id, skill: { body: body.replace(oldString, newString) } });
    return text(`Patched skill \`${id}\`.`, { id, action: "patch" });
  } catch (error) {
    const detail = String((error as { message?: string })?.message ?? error);
    return text(`The patch was not saved: ${detail}`, { errorCode: "SKILL_UPDATE_FAILED" }, true);
  }
}

async function writeResource(host: SkillManageHost, params: RawParams) {
  const id = params.name?.trim();
  const path = params.file_path?.trim();
  if (!id) return refused("`name` is required to write a reference file.", "SKILL_MISSING_NAME");
  if (!path) {
    return refused("`file_path` is required; it must look like `references/<topic>.md`.", "SKILL_MISSING_PATH");
  }
  if (params.content === undefined) {
    return refused("`content` is required to write a reference file.", "SKILL_MISSING_CONTENT");
  }
  try {
    const result = await host.call<{ path?: string }>("skills.writeFile", {
      id,
      path,
      content: params.content,
    });
    return text(`Wrote \`${result?.path ?? path}\` into skill \`${id}\`.`, {
      id,
      action: "write_file",
    });
  } catch (error) {
    const detail = String((error as { message?: string })?.message ?? error);
    // Path rule violations come back from the host and are the model's to fix.
    if (/SKILL_INVALID/.test(detail)) return refused(detail, "SKILL_INVALID_PATH");
    return text(`The reference file was not written: ${detail}`, { errorCode: "SKILL_WRITE_FAILED" }, true);
  }
}

async function removeResource(host: SkillManageHost, params: RawParams) {
  const id = params.name?.trim();
  const path = params.file_path?.trim();
  if (!id) return refused("`name` is required to remove a reference file.", "SKILL_MISSING_NAME");
  if (!path) {
    return refused("`file_path` is required; it must look like `references/<topic>.md`.", "SKILL_MISSING_PATH");
  }
  try {
    await host.call("skills.removeFile", { id, path });
    return text(`Removed \`${path}\` from skill \`${id}\`.`, { id, action: "remove_file" });
  } catch (error) {
    const detail = String((error as { message?: string })?.message ?? error);
    if (/SKILL_INVALID/.test(detail)) return refused(detail, "SKILL_INVALID_PATH");
    return text(`The reference file was not removed: ${detail}`, { errorCode: "SKILL_REMOVE_FAILED" }, true);
  }
}

async function deleteSkill(host: SkillManageHost, params: RawParams) {
  const id = params.name?.trim();
  if (!id) return refused("`name` is required to delete a skill.", "SKILL_MISSING_NAME");
  try {
    const result = await host.call<{ ok?: boolean }>("skills.remove", { id });
    if (!result?.ok) return refused(`No skill with id \`${id}\` in the library.`, "SKILL_NOT_FOUND");
    return text(`Deleted skill \`${id}\`.`, { id, action: "delete" });
  } catch (error) {
    const detail = String((error as { message?: string })?.message ?? error);
    return text(`The skill was not deleted: ${detail}`, { errorCode: "SKILL_DELETE_FAILED" }, true);
  }
}

/**
 * Build the `skill_manage` tool bound to one runtime host.
 *
 * One action per call, `create` first: the model is told to open the library
 * with `create` and refine it with `patch`, never to re-send a whole document
 * it could not see (the Skills section is a snapshot, like memory).
 */
export function createSkillManageTool(host: SkillManageHost): AgentTool {
  return {
    name: "skill_manage",
    label: "Skill",
    description: SKILL_MANAGE_DESCRIPTION,
    parameters: SKILL_MANAGE_PARAMETERS,
    executionMode: "sequential",
    execute: async (_toolCallId, rawParams) => {
      const params = (rawParams ?? {}) as RawParams;
      switch (params.action) {
        case "create":
          return createSkill(host, params);
        case "patch":
          return patchSkill(host, params);
        case "write_file":
          return writeResource(host, params);
        case "remove_file":
          return removeResource(host, params);
        case "delete":
          return deleteSkill(host, params);
        default:
          return refused(
            "`action` must be one of create, patch, write_file, remove_file, delete.",
            "SKILL_INVALID_ACTION",
          );
      }
    },
  };
}
