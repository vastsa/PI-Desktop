# 09. Plugin Command Palette

> **Status — merged into global search.** The standalone command palette overlay was removed. Plugin (and built-in) commands now appear in the **Commands** section of the global search dialog, opened with `Cmd/Ctrl+Shift+P` (or `Cmd/Ctrl+K`). All rules below still apply to that section.

## 1. Goals

Provide a fast command entry point that unifies discovery and execution of built-in and plugin capabilities in a single searchable surface.

## 2. Entry point

Commands are surfaced inside the global search dialog (the "Commands" section). The same shortcut opens global search with the command list pre-populated:

- macOS: `Command + Shift + P` (also `Command + K`)
- Windows/Linux: `Ctrl + Shift + P` (also `Ctrl + K`)

Also configurable:
- Custom shortcut
- Launcher mode (later)

## 3. Command model

```ts
type CommandItem = {
 id: string
 title: string
 category?: string
 keywords?: string[]
 source: "builtin" | "plugin" | "extension"
 pluginId?: string
 extensionId?: string
}
```

## 4. Command sources

1. Built-in commands
 - New task
 - Compact conversation context
 - Switch to Agent / Plan / Goal
2. Loaded plugin runtime registrations (`pi.commands.register`), filtered by
   activation scope; the manifest provides declaration metadata
3. Trusted agent-extension commands (`source: "extension"`)

The Composer `/` catalog is separate and also includes skill and MCP entries;
not every Composer entry is a global-search command.

## 5. Search rules

The current `commandPaletteSearch` IPC lowercases the query and performs a
substring match over title, category, and joined keywords. Chinese keywords
are matched as text. An empty query returns the eligible list. Ordering is
built-in commands, loaded project-eligible plugin commands in registry order,
then trusted-extension commands. There is no command-specific recently-used
ranking, prefix score, configurable weighting, or plugin-name search field.
Do not depend on those earlier design suggestions as implemented behavior.

## 6. Execution flow

```text
open global search (Commands section)
 → input query
 → select command
 → execute
 → builtin handler
 → or plugin command bridge
 → close search / keep open (optional)
```

If the command needs a panel:
- Open PluginPanelHost after execution

If the command needs a permission:
- Go through the permission gateway first

## 7. UI structure

```text
-------------------------------------------------
[ search input ]
-------------------------------------------------
Commands
 New Task
 Compact Conversation Context
Demo
 Hello: Open Panel
Tools
 ...
-------------------------------------------------
Enter to run · Esc to close
-------------------------------------------------
```

Each item shows:
- Title
- Plugin badge for `source: "plugin"`; the current row does not promise a
  per-command shortcut hint

## 8. Empty state / errors

- No match: use the global search empty state after all result groups are empty
- Plugin command execution failed: toast + log
- Disabled plugin: its commands do not appear

## 9. Relationship to the Agent

The command surface (now part of global search) is not a replacement for the chat composer.
It is responsible for "launching actions"; chat is responsible for "conversational tasks".

Possible command to support:
- "Send the currently selected command result to the session" (later)

## 10. Acceptance

1. Shortcut opens global search with the Commands section
2. Built-in and plugin commands are searchable
3. Executing a plugin command succeeds
4. Commands disappear after a plugin is disabled
5. Substring matching and stable built-in/plugin/extension ordering follow
   `apps/desktop/electron/main/ipc/market-ipc.ts`; `CommandItem` comes from
   `packages/shared/src/types/composer.ts`
