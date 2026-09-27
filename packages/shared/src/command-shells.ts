export const COMMAND_SHELL_IDS = [
  "windows-powershell",
  "cmd",
  "git-bash",
  "bash",
] as const;

export type CommandShellId = (typeof COMMAND_SHELL_IDS)[number];

export const COMMAND_SHELL_DIALECTS = ["powershell", "cmd", "posix"] as const;
export type CommandShellDialect = (typeof COMMAND_SHELL_DIALECTS)[number];

export type CommandShellOption = {
  id: CommandShellId;
  label: string;
  dialect: CommandShellDialect;
  available: boolean;
  isDefault: boolean;
};

export type CommandShellCatalog = {
  configuredId: CommandShellId | null;
  effective: CommandShellOption | null;
  fallback: boolean;
  choices: CommandShellOption[];
};

export type CommandShellOutputStream = "stdout" | "stderr";

/** Host notification emitted while a Bash protocol tool is running. */
export type ToolsOutputParams = {
  sessionId: string;
  toolCallId: string;
  commandShellId: CommandShellId;
  stream: CommandShellOutputStream;
  chunk: string;
};

export type ToolsOutputNotification = ToolsOutputParams;

export function isCommandShellOutputStream(
  value: unknown,
): value is CommandShellOutputStream {
  return value === "stdout" || value === "stderr";
}

export function isToolsOutputParams(value: unknown): value is ToolsOutputParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const output = value as Record<string, unknown>;
  return (
    typeof output.sessionId === "string" &&
    typeof output.toolCallId === "string" &&
    isCommandShellId(output.commandShellId) &&
    isCommandShellOutputStream(output.stream) &&
    typeof output.chunk === "string"
  );
}

export function isCommandShellId(value: unknown): value is CommandShellId {
  return (
    typeof value === "string" &&
    (COMMAND_SHELL_IDS as readonly string[]).includes(value)
  );
}

export function commandShellDialect(id: CommandShellId): CommandShellDialect {
  switch (id) {
    case "windows-powershell":
      return "powershell";
    case "cmd":
      return "cmd";
    case "git-bash":
    case "bash":
      return "posix";
  }
}

export function isCommandShellOption(value: unknown): value is CommandShellOption {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const option = value as Record<string, unknown>;
  if (
    !isCommandShellId(option.id) ||
    option.dialect !== commandShellDialect(option.id) ||
    typeof option.label !== "string" ||
    option.label.trim().length === 0 ||
    typeof option.available !== "boolean" ||
    typeof option.isDefault !== "boolean"
  ) {
    return false;
  }
  return true;
}

export function isCommandShellCatalog(value: unknown): value is CommandShellCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const catalog = value as Record<string, unknown>;
  return (
    (catalog.configuredId === null || isCommandShellId(catalog.configuredId)) &&
    (catalog.effective === null || isCommandShellOption(catalog.effective)) &&
    typeof catalog.fallback === "boolean" &&
    Array.isArray(catalog.choices) &&
    catalog.choices.every(isCommandShellOption)
  );
}

/** Defaults preserve the host's native shell on Windows and POSIX Bash elsewhere. */
export function defaultCommandShellForPlatform(platform: string): CommandShellId {
  return platform === "win32" ? "windows-powershell" : "bash";
}
