export const MCP_STDIO_LAUNCHER_PRESETS = ["npx", "uvx"] as const;
export type McpStdioLauncherPreset = (typeof MCP_STDIO_LAUNCHER_PRESETS)[number];
export type McpStdioLauncherChoice = McpStdioLauncherPreset | "custom";

export function mcpStdioLauncherChoice(command: string): McpStdioLauncherChoice {
  const name = command.trim().toLowerCase();
  if (name === "npx" || name === "uvx") return name;
  return "custom";
}
