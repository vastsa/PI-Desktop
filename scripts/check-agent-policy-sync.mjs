#!/usr/bin/env node
/**
 * Agent policy mirror check: AGENTS.md and CLAUDE.md must stay in sync.
 *
 * Usage:
 *   node scripts/check-agent-policy-sync.mjs
 *   pnpm check:agent-policy
 *
 * AGENTS.md is the authoritative AI-agent policy. CLAUDE.md is the Claude Code
 * / Cowork entry point and a condensed mirror of the non-negotiables. Changing
 * one without the other is documentation drift and fails this gate.
 *
 * Enforced:
 *   1. Both files exist at the repository root.
 *   2. Both declare the same `Policy-Sync: <token>` revision near the top.
 *   3. CLAUDE.md names AGENTS.md as authoritative; AGENTS.md names CLAUDE.md
 *      as the Claude Code mirror that must stay synchronized.
 *   4. Shared non-negotiable policy anchors appear in both files (normalized
 *      whitespace, case-insensitive).
 *
 * When policy text changes:
 *   - update the affected file(s) so the non-negotiables remain aligned;
 *   - bump the `Policy-Sync:` token in BOTH files to the same new value;
 *   - run `pnpm check:agent-policy`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];

const read = (relPath) => {
  try {
    return readFileSync(path.join(root, relPath), "utf8");
  } catch {
    failures.push(`${relPath}: file is missing`);
    return null;
  }
};

const normalize = (text) =>
  text
    .replace(/[→↓]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const agentsRaw = read("AGENTS.md");
const claudeRaw = read("CLAUDE.md");
const agents = agentsRaw ? normalize(agentsRaw) : "";
const claude = claudeRaw ? normalize(claudeRaw) : "";

// Shared non-negotiables. Each anchor is a distinctive phrase (or alternate
// phrases) that must remain true in both the authoritative policy and the
// Claude Code mirror. Prefer stable wording over section titles.
/** @type {{ id: string, anyOf: string[] }[]} */
const REQUIRED_ANCHORS = [
  {
    id: "worktree-isolation",
    anyOf: ["1 request = 1 branch + 1 dedicated worktree"],
  },
  {
    id: "never-develop-on-main",
    anyOf: [
      "never develop on `main`",
      "never develop directly on `main`",
      "develop directly on `main`",
    ],
  },
  {
    id: "process-model",
    anyOf: [
      "renderer preload ipc electron main rust host core / node agent runtime",
    ],
  },
  {
    id: "sqlite-host-core-only",
    anyOf: [
      "sqlite remains owned exclusively by rust host-core",
      "sqlite is owned exclusively by rust host-core",
      "sqlite remains owned exclusively by rust `host-core`",
      "sqlite is owned exclusively by rust `host-core`",
    ],
  },
  {
    id: "main-thin-orchestrator",
    anyOf: ["electron main must remain a thin orchestrator", "electron main stays a thin orchestrator"],
  },
  {
    id: "no-local-main-before-e2e",
    anyOf: ["merge task → local main"],
  },
  {
    id: "pr-contains-latest-main",
    anyOf: ["do not open or update a PR that is behind `origin/main`"],
  },
  {
    id: "task-candidate-e2e",
    anyOf: ["task-candidate e2e"],
  },
  {
    id: "architecture-ratchet-hotspots",
    anyOf: [
      "apps/desktop/src/stores/app-store.ts",
      "crates/host-core/src/db.rs",
    ],
  },
  {
    id: "preserve-behavior-default",
    anyOf: [
      "unless the task explicitly requires",
      "unless the task explicitly requires behavior to change",
    ],
  },
  {
    id: "never-weaken-security",
    anyOf: [
      "never fix functionality by weakening",
      "never “fix” a feature by weakening",
      'never "fix" a feature by weakening',
      "never fix a feature by weakening",
    ],
  },
  {
    id: "adr-for-frozen-boundaries",
    anyOf: [
      "changing a frozen architecture, public interface, data ownership model, or security boundary requires an adr",
      "requires an adr under `docs/adr/`",
    ],
  },
  {
    id: "specs-stay-synchronized",
    anyOf: ["observable behavior changes must update the relevant spec"],
  },
  {
    id: "pr-root-cause-minimal",
    anyOf: [
      "must fix the reported root cause with the smallest coherent change",
    ],
  },
];

function requireContains(label, haystack, needle, message) {
  if (!haystack.includes(needle)) {
    failures.push(`${label}: ${message}`);
  }
}

if (agentsRaw && claudeRaw) {
  const syncToken = /policy-sync:\s*`?([^\s`]+)`?/i;

  const agentsToken = agentsRaw.match(syncToken)?.[1];
  const claudeToken = claudeRaw.match(syncToken)?.[1];

  if (!agentsToken) {
    failures.push(
      'AGENTS.md: missing `Policy-Sync: <token>` (for example `Policy-Sync: 2026-02-14.1`)',
    );
  }
  if (!claudeToken) {
    failures.push(
      'CLAUDE.md: missing `Policy-Sync: <token>` (for example `Policy-Sync: 2026-02-14.1`)',
    );
  }
  if (agentsToken && claudeToken && agentsToken !== claudeToken) {
    failures.push(
      `Policy-Sync token mismatch: AGENTS.md has \`${agentsToken}\`, CLAUDE.md has \`${claudeToken}\`. Update both mirrors and set the same new token.`,
    );
  }

  requireContains(
    "CLAUDE.md",
    claude,
    "agents.md",
    "must name AGENTS.md as the authoritative policy",
  );
  requireContains(
    "CLAUDE.md",
    claude,
    "authoritative",
    "must state that AGENTS.md is authoritative",
  );
  requireContains(
    "AGENTS.md",
    agents,
    "claude.md",
    "must name CLAUDE.md as the Claude Code mirror and require it to stay synchronized",
  );

  for (const anchor of REQUIRED_ANCHORS) {
    const inAgents = anchor.anyOf.some((phrase) => agents.includes(normalize(phrase)));
    const inClaude = anchor.anyOf.some((phrase) => claude.includes(normalize(phrase)));
    if (!inAgents && !inClaude) {
      failures.push(
        `policy anchor \`${anchor.id}\`: missing from both AGENTS.md and CLAUDE.md (looked for: ${anchor.anyOf
          .map((p) => `"${p}"`)
          .join(" | ")})`,
      );
    } else if (!inAgents) {
      failures.push(
        `policy anchor \`${anchor.id}\`: present in CLAUDE.md but missing from AGENTS.md`,
      );
    } else if (!inClaude) {
      failures.push(
        `policy anchor \`${anchor.id}\`: present in AGENTS.md but missing from CLAUDE.md — update the Claude Code mirror and bump Policy-Sync in both files`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Agent policy sync check failed:\n");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error(
    "\nAGENTS.md is authoritative. Update the other mirror, keep non-negotiables aligned,",
  );
  console.error(
    "and set the same `Policy-Sync:` token in both files. Then re-run: pnpm check:agent-policy",
  );
  process.exit(1);
}

console.log("Agent policy sync check passed (AGENTS.md ↔ CLAUDE.md).");
