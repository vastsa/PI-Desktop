/**
 * Known external agents and how to launch them.
 *
 * The settings screen needs a list to offer and a way to tell the user that a
 * command cannot be launched safely, so both live here rather than in the
 * renderer.
 *
 * Resolution is reported, not hidden: an agent that can only be started through
 * a shell is flagged, because a command that reaches cmd.exe is a materially
 * different thing from one that does not.
 */

import { resolveAcpExecutable, type ResolvedExecutable } from "./resolve.ts"

export type AcpAgentDefinition = {
  id: string
  label: string
  /** Executable name or absolute path. */
  command: string
  /** Arguments placed before anything else, typically `["acp"]`. */
  args: string[]
  /** Shown under the entry in settings. */
  hint?: string
}

export const KNOWN_ACP_AGENTS: readonly AcpAgentDefinition[] = [
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    args: ["acp"],
    hint: "Serves its own models and credentials over ACP.",
  },
]

export type AcpAgentValidation = {
  ok: boolean
  /** Blocking problems: the agent cannot be saved as written. */
  errors: string[]
  /** Non-blocking findings worth showing next to the field. */
  warnings: string[]
  resolution?: ResolvedExecutable
}

/** Characters that only matter if something ends up going through a shell. */
const SHELL_METACHARACTERS = /[&|<>^%!]/

export function validateAcpAgent(
  definition: Pick<AcpAgentDefinition, "command" | "args">,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): AcpAgentValidation {
  const errors: string[] = []
  const warnings: string[] = []

  const command = definition.command?.trim() ?? ""
  if (!command) {
    errors.push("Command is required.")
  } else if (/["\r\n\0]/.test(command)) {
    errors.push("Command contains a quote or a line break and cannot be launched.")
  }

  const args = definition.args ?? []
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    errors.push("Arguments must be a list of text values.")
  } else if (args.some((a) => /[\r\n\0]/.test(a))) {
    errors.push("Arguments must not contain line breaks.")
  } else if (platform === "win32" && command && SHELL_METACHARACTERS.test([command, ...args].join(" "))) {
    warnings.push("Contains shell metacharacters. They are only interpreted if a shell is required.")
  }

  if (errors.length > 0) return { ok: false, errors, warnings }

  const resolution = resolveAcpExecutable(command, env, platform)
  if (resolution.viaShell) {
    warnings.push(
      resolution.source === "comspec-fallback"
        ? `“${command}” was not found on PATH, so it would be started through the shell.`
        : `“${command}” is a shim that could not be resolved to a program, so it would be started through the shell.`,
    )
  }

  return { ok: true, errors, warnings, resolution }
}

export function findKnownAcpAgent(id: string): AcpAgentDefinition | undefined {
  return KNOWN_ACP_AGENTS.find((a) => a.id === id)
}
