/**
 * Provider-facing normalisation of tool parameter schemas.
 *
 * `Read`, `Glob`, `Grep`, and `BrowserPreview` declare their canonical argument
 * as `Type.Optional` so the `file_path` / `query` alias spelling validates too;
 * "exactly one spelling" is enforced by `requireAliasedParams` at execute time
 * instead (D273). TypeBox 1.x then omits `required` altogether when no property
 * is required, and the OpenAI chat/completions adapter forwards `parameters`
 * verbatim while only the Anthropic adapter fills `required ?? []`. A relay that
 * decodes the missing key into a nil slice rejects the whole request with
 * `Invalid schema for function 'Read': null is not of type "array"` (#864).
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * Spell out `required` on an object tool schema before it reaches the provider.
 *
 * For an object schema an absent `required` already means "nothing is
 * required", so writing `[]` states the same contract explicitly and changes no
 * tool's accepted arguments. Applied when the tool catalogue is built, so the
 * session agent and a delegated `Task` run send one declaration, and plugin,
 * skill, mode, delegation, extension, and ToolSearch schemas are covered by the
 * same pass. A non-object or already-normalised schema is returned untouched.
 */
export function withExplicitRequired(tool: AgentTool): AgentTool {
  const parameters = tool.parameters as {
    type?: unknown;
    required?: unknown;
  };
  if (parameters.type !== "object" || parameters.required !== undefined) {
    return tool;
  }
  return {
    ...tool,
    parameters: Object.assign({}, tool.parameters, {
      required: [],
    }) as AgentTool["parameters"],
  };
}
