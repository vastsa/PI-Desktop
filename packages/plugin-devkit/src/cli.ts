#!/usr/bin/env node
import { resolve } from "node:path";
import { formatBytes as formatByteSize } from "@pi-desktop/shared";
import { check } from "./check.js";
import { pack } from "./pack.js";
import { publish } from "./publish.js";
import { TEMPLATE_NAMES, isTemplateName, scaffold } from "./templates.js";

const USAGE = `pi-plugin — PI-Desktop plugin development commands

Usage:
  pi-plugin init <template> <dir> [--id <id>] [--name <name>]
  pi-plugin check <dir>
  pi-plugin pack <dir> [--out <dir>]
  pi-plugin publish <dir> [--out <dir>] [--ref <ref>] [--channel stable|beta] [--allow-dirty]

Templates:
${TEMPLATE_NAMES.map((name) => `  ${name}`).join("\n")}
`;

type Flags = { positional: string[]; options: Record<string, string> };

function parseArgs(argv: string[]): Flags {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        options[key] = "true";
      } else {
        options[key] = next;
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function formatBytes(bytes: number): string {
  return formatByteSize(bytes, { decimals: { KB: 1, MB: 2 } });
}

async function runInit(flags: Flags): Promise<number> {
  const [template, dir] = flags.positional;
  if (!template || !dir) {
    process.stderr.write("pi-plugin init needs a template and a target directory\n\n");
    process.stderr.write(USAGE);
    return 2;
  }
  if (!isTemplateName(template)) {
    process.stderr.write(
      `unknown template "${template}" (expected one of: ${TEMPLATE_NAMES.join(", ")})\n`,
    );
    return 2;
  }
  const result = await scaffold({
    dir: resolve(dir),
    template,
    id: flags.options.id,
    name: flags.options.name,
  });
  process.stdout.write(`Created ${result.name} (${result.id}) in ${result.dir}\n`);
  for (const file of result.files) process.stdout.write(`  ${file}\n`);
  process.stdout.write(
    "\nNext: load it from the Plugins page with \"Load development plugin\", then run `pi-plugin pack`.\n",
  );
  return 0;
}

async function runCheck(flags: Flags): Promise<number> {
  const dir = resolve(flags.positional[0] ?? ".");
  const result = await check(dir);
  for (const issue of result.errors) {
    process.stderr.write(`error  ${issue.code}: ${issue.message}\n`);
  }
  for (const issue of result.warnings) {
    process.stdout.write(`warn   ${issue.code}: ${issue.message}\n`);
  }
  if (!result.ok) {
    process.stderr.write(`\n${result.errors.length} error(s) in ${dir}\n`);
    return 1;
  }
  const manifest = result.manifest;
  process.stdout.write(
    `\nOK ${manifest?.id}@${manifest?.version} — ${result.fileCount} files, ${formatBytes(result.totalBytes)}\n`,
  );
  return 0;
}

async function runPack(flags: Flags): Promise<number> {
  const dir = resolve(flags.positional[0] ?? ".");
  try {
    const result = await pack(dir, { outDir: flags.options.out });
    for (const issue of result.check.warnings) {
      process.stdout.write(`warn   ${issue.code}: ${issue.message}\n`);
    }
    process.stdout.write(
      `Packed ${result.fileName} (${result.fileCount} files, ${formatBytes(result.byteLength)})\n`,
    );
    process.stdout.write(`  path   ${result.packagePath}\n`);
    process.stdout.write(`  sha256 ${result.shasum}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * Pack a version and pin it to the commit it came from.
 *
 * This writes a submission the publisher hands to the plugin center; it does
 * not publish anything by itself. The center re-resolves the ref and rebuilds
 * from source, so a submission is a claim to be checked, not an instruction.
 */
async function runPublish(flags: Flags): Promise<number> {
  const dir = resolve(flags.positional[0] ?? ".");
  const channel = flags.options.channel === "beta" ? "beta" : "stable";
  try {
    const result = await publish(dir, {
      outDir: flags.options.out,
      ref: flags.options.ref,
      channel,
      allowDirty: flags.options["allow-dirty"] === "true",
    });
    for (const issue of result.pack.check.warnings) {
      process.stdout.write(`warn   ${issue.code}: ${issue.message}\n`);
    }
    for (const warning of result.warnings) {
      process.stdout.write(`warn   ${warning}\n`);
    }
    const { payload } = result;
    process.stdout.write(
      `Prepared ${payload.pluginId}@${payload.version} for submission (${payload.channel})\n`,
    );
    process.stdout.write(`  package    ${result.pack.packagePath}\n`);
    process.stdout.write(`  sha256     ${payload.artifact.sha256}\n`);
    process.stdout.write(`  size       ${formatBytes(payload.artifact.sizeBytes)}\n`);
    process.stdout.write(`  repository ${payload.source.repository}\n`);
    process.stdout.write(`  ref        ${payload.source.ref}\n`);
    process.stdout.write(`  commit     ${payload.source.commit}\n`);
    process.stdout.write(`  path       ${payload.source.path}\n`);
    process.stdout.write(`  submission ${result.payloadPath}\n`);
    process.stdout.write(
      "\nNext: attach the package to a release on this commit, then submit the file above to the plugin center.\n",
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest);
  switch (command) {
    case "init":
    case "create":
      return runInit(flags);
    case "check":
      return runCheck(flags);
    case "pack":
      return runPack(flags);
    case "publish":
      return runPublish(flags);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
