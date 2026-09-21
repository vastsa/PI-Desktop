#!/usr/bin/env node
/**
 * Require the current head to contain the latest integration base.
 *
 * Locally that base is `origin/main`. In GitHub Actions pass the pull
 * request base and head SHAs. `origin/main` must be an ancestor of the
 * PR head — do not open or update a PR that is behind `origin/main`.
 *
 * Usage:
 *   node scripts/check-pr-base-main.mjs
 *   node scripts/check-pr-base-main.mjs --base origin/main --head HEAD
 *   pnpm check:pr-base
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function parseArgs(argv) {
  const out = {
    base: process.env.PR_BASE_SHA || process.env.GITHUB_BASE_SHA || "origin/main",
    head: process.env.PR_HEAD_SHA || "HEAD",
    cwd: root,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--base" && value) {
      out.base = value;
      i += 1;
    } else if (flag === "--head" && value) {
      out.head = value;
      i += 1;
    } else if (flag === "--cwd" && value) {
      out.cwd = value;
      i += 1;
    }
  }
  return out;
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

let baseSha;
let headSha;
try {
  baseSha = git(args.cwd, ["rev-parse", "--verify", `${args.base}^{commit}`]);
  headSha = git(args.cwd, ["rev-parse", "--verify", `${args.head}^{commit}`]);
} catch (error) {
  const detail = error.stderr?.toString().trim() || error.message;
  fail(
    `PR base check: cannot resolve --base ${args.base} or --head ${args.head}. ` +
      `Fetch origin/main first.\n${detail}`,
  );
}

if (baseSha === headSha) {
  console.log(`PR base check passed: head ${headSha.slice(0, 12)} is the base.`);
  process.exit(0);
}

try {
  git(args.cwd, ["merge-base", "--is-ancestor", baseSha, headSha]);
} catch {
  let behind = "unknown";
  try {
    behind = git(args.cwd, ["rev-list", "--count", `${headSha}..${baseSha}`]);
  } catch {
    // Keep the generic count when history is incomplete.
  }
  fail(
    `PR base check failed: ${args.base} (${baseSha.slice(0, 12)}) is not an ancestor of ` +
      `${args.head} (${headSha.slice(0, 12)}). The branch is ${behind} commit(s) behind the base. ` +
      `Fetch origin/main and rebase (private branch) or merge it, then re-run pnpm check:pr-base. ` +
      `Do not open or update a PR that is behind origin/main.`,
  );
}

console.log(
  `PR base check passed: ${args.base} (${baseSha.slice(0, 12)}) is an ancestor of ` +
    `${args.head} (${headSha.slice(0, 12)}).`,
);
