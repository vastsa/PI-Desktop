/** Shared public types grouped by the owning application domain. */
export type CommandItem = {
  id: string;
  title: string;
  category?: string;
  keywords?: string[];
  source: "builtin" | "plugin" | "extension";
  pluginId?: string;
  /** Trusted extension that registered the command (`source: "extension"`). */
  extensionId?: string;
};

/** One entry of the composer "/" menu, merged from command and skill sources (D123). */
export type ComposerCommand = {
  /** Slash name typed after "/"; unique across the merged list. */
  name: string;
  kind: "template" | "builtin" | "plugin" | "extension" | "skill" | "mcp";
  /** Display title (templates use their name). */
  title: string;
  description?: string;
  /** Template frontmatter `argument-hint`, shown as ghost text. */
  argumentHint?: string;
  /** Template provenance; project templates override user-global ones. */
  source?: "project" | "user";
  /** Palette command id for builtin/plugin execution. */
  id?: string;
  /** Skill id passed to the model's Skill tool. */
  skillId?: string;
  /** Active user MCP server selected for this prompt. */
  mcpServerId?: string;
  /** Exact host tool name, absent for a whole-server selection. */
  mcpToolName?: string;
};

/** One clipboard file transferred from the renderer to the composer bridge. */
export type ComposerPasteFile = {
  name?: string;
  mimeType?: string;
  /** Set for generated large-text pastes so history can retain the text. */
  recordHistory?: boolean;
  data: ArrayBuffer;
};

/** One pasted item: an original disk-file reference or a materialized payload. */
export type ComposerPastedFile = {
  /** Durable main-owned selection record; contents are read only through tools. */
  localReference?: string;
  /** Canonical original path for references, or a unique session scratch path. */
  path: string;
  /** Sanitized original leaf name used only for compact composer display. */
  name: string;
  kind: "image" | "file";
  mimeType: string;
  size: number;
};
