import { CANONICAL_TOOL_NAMES, normalizeToolName } from "@pi-desktop/shared";

export type ToolAction =
  | "read"
  | "list"
  | "search"
  | "write"
  | "edit"
  | "run"
  | "fetch"
  | "fork"
  | "delegate"
  | "use";

const SUMMARY_KEYS: Record<ToolAction, string[]> = {
  read: ["path", "file_path", "filePath"],
  list: ["path", "pattern", "glob"],
  search: ["query", "pattern", "path"],
  write: ["path", "file_path", "filePath"],
  edit: ["path", "file_path", "filePath"],
  run: ["command", "cmd"],
  fetch: ["url", "query"],
  fork: ["prompt", "task", "description", "name"],
  // `description` is the short label the model writes for the delegation; the
  // `task` brief is a paragraph and belongs in the expanded detail. A lifecycle
  // tool (ADR 0089) carries only delegation ids, which read as bare UUIDs, so
  // it summarizes from the agent names in its own result roster instead (D268).
  delegate: ["description", "agent"],
  use: [
    "command",
    "cmd",
    "path",
    "file_path",
    "filePath",
    "url",
    "query",
    "pattern",
    "prompt",
  ],
};

function compact(value: string, limit = 220) {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > limit
    ? `${singleLine.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
    : singleLine;
}

export function formatToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** The bare tool name: any provider namespace dropped, matched loosely. */
function bareToolName(toolName?: string): string {
  return (toolName || "")
    .split(".")
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * The canonical identity of a tool call: the provider namespace and surrounding
 * whitespace dropped, then resolved through the one normalizer
 * `@pi-desktop/shared` owns (D621).
 *
 * `Read`, `READ` and `read` are one tool and all three answer `read`. A name
 * that is not ours — `plugin_*`, `mcp_*`, an MCP-reported name, a
 * provider-namespaced `functions.exec_command` — has no canonical spelling to
 * map to and comes back unchanged. Everything below keys on this value rather
 * than on whatever spelling happened to reach the transcript.
 */
export function canonicalToolName(toolName?: string): string {
  return normalizeToolName(
    (toolName || "")
      .split(".")
      .pop()!
      .trim(),
  );
}

/** The tool that STARTS a subagent (ADR 0062). The lifecycle tools of ADR 0089
 * (`task_wait`/`task_list`/`task_stop`) drive an existing delegation and are not
 * delegation activity items themselves. */
export function isDelegationStartTool(toolName?: string): boolean {
  if (canonicalToolName(toolName) === "task") return true;
  // A host that namespaces its own delegation tool is matched loosely.
  return bareToolName(toolName) === "subagent";
}

/**
 * Which lifecycle tool this row is (ADR 0089), or `null` for the `task` start
 * call and every non-delegation tool. The three lifecycle rows report on
 * subagents rather than doing workspace work, so the transcript presents them
 * as subagent rows rather than as generic tool calls (D268).
 */
export type DelegationLifecycleKind = "wait" | "list" | "stop";

export function delegationLifecycleKind(
  toolName?: string,
): DelegationLifecycleKind | null {
  switch (canonicalToolName(toolName)) {
    case "task_wait":
      return "wait";
    case "task_list":
      return "list";
    case "task_stop":
      return "stop";
    default:
      return null;
  }
}

export function getToolAction(toolName?: string): ToolAction {
  // Identity first (D621): one of our tools is answered from its canonical name,
  // so `Read`, `read` and `READ` are one row. Anything else keeps the loose
  // suffix matching below, which is how a plugin or MCP tool that borrows a
  // familiar verb still gets a sensible presentation.
  const normalized = canonicalToolName(toolName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  const matches = (aliases: string[]) =>
    aliases.some(
      (alias) => normalized === alias || normalized.endsWith(alias),
    );
  // Delegation (ADR 0062, ADR 0089) is matched on the exact name, minus any
  // provider namespace: a plugin tool called "CreateTask" is not a subagent
  // call and keeps its generic presentation.
  if (isDelegationStartTool(toolName) || delegationLifecycleKind(toolName)) {
    return "delegate";
  }
  if (matches(["websearch", "searchquery", "fetch", "http", "browser"])) {
    return "fetch";
  }
  if (matches(["read", "readfile", "fileread"])) return "read";
  if (matches(["glob", "list", "listfiles", "findfiles"])) return "list";
  if (matches(["grep", "rg", "search", "searchfiles"])) return "search";
  if (matches(["write", "writefile", "createfile"])) return "write";
  if (matches(["edit", "editfile", "applypatch", "patch"])) return "edit";
  if (matches(["fork", "forkagent", "forktask", "forksession"])) {
    return "fork";
  }
  if (
    matches(["bash", "shell", "exec", "execcommand", "runcommand", "terminal"])
  ) {
    return "run";
  }
  return "use";
}

/**
 * The label the transcript row, the permission card and the tooltip show for a
 * tool call. Identity is the canonical name; this is only how it is spelled for
 * a reader, so moving the wire name to lowercase (`read`, `task_wait`) changes
 * no label at all (D621): `read` → `Read`, `task_wait` → `Task Wait`, and the
 * legacy `Read` / `TaskWait` spellings render exactly the same.
 *
 * A third-party tool keeps its own words (`plugin_tasks_list` → `Tasks List`).
 */
export function getToolDisplayName(toolName?: string) {
  const raw = canonicalToolName(toolName).replace(/^plugin[_-]/i, "");
  const spaced = raw
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!spaced) return "";
  return spaced.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * The name to show a user for a tool that is not a transcript row — the
 * permission prompt, a tooltip, a settings chip. Ours reads as its capitalized
 * label (`read` → `Read`, `task_wait` → `Task Wait`), which is what the prompt
 * showed before the wire name moved to lowercase.
 *
 * A third-party name is left exactly as the server reported it: rewriting
 * someone else's identity in a prompt the user is asked to approve would hide
 * which tool is actually asking.
 */
export function getToolPromptName(toolName?: string): string {
  const raw = (toolName || "").trim();
  const canonical = canonicalToolName(raw);
  return CANONICAL_TOOL_NAMES.includes(canonical)
    ? getToolDisplayName(canonical)
    : raw;
}

/**
 * Renders a summarizable argument. A plain string is itself; a list of strings
 * is joined, because `task_wait`/`task_stop` summarize by their `delegationIds`
 * list (ADR 0089) and everything else summarizes by a scalar.
 */
function summaryText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value.join(", ");
  }
  return "";
}

/**
 * Which argument the collapsed row summary is showing, so expanded detail
 * blocks can skip repeating it.
 */
export function getToolSummaryKey(
  toolName: string | undefined,
  args: unknown,
): string | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const key of SUMMARY_KEYS[getToolAction(toolName)]) {
    if (summaryText(record[key]).trim()) return key;
  }
  return null;
}

/**
 * The whole argument the collapsed row summarizes, unwrapped and untrimmed.
 * The summary is squeezed onto one line to fit the row; a reader copying a
 * multi-line command out of the head needs it the way it was written (D226).
 */
export function getToolSummaryValue(
  toolName: string | undefined,
  args: unknown,
): string {
  const key = getToolSummaryKey(toolName, args);
  if (!key) return "";
  return summaryText((args as Record<string, unknown>)[key]);
}

export function getToolSummary(toolName: string | undefined, args: unknown) {
  const action = getToolAction(toolName);
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    const key = getToolSummaryKey(toolName, args);
    if (key) return compact(summaryText(record[key]));
    const fallback = formatToolValue(record);
    if (fallback && fallback !== "{}") return compact(fallback);
  }
  if (action === "use") return getToolDisplayName(toolName);
  return "";
}

export function formatToolDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (remainingSeconds > 0) parts.push(`${remainingSeconds}s`);
  if (parts.length === 0) parts.push("0s");

  return parts.join(" ");
}
