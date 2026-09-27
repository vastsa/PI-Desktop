#!/usr/bin/env node
/** Native-only local packaging. No publishing, signing credentials or source rewrites. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, delimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopFilter = ["--filter", "@pi-desktop/desktop"];

export function parseBuildArgs(args) {
  const [platform, ...flags] = args;
  if (!["mac", "win"].includes(platform)) throw new Error("Choose mac or win.");
  for (const flag of flags) {
    if (!["--check", "--dir", "--install", "--dry-run", "--help", "--cargo-mirror"].includes(flag)) {
      throw new Error(`Unknown build option: ${flag}`);
    }
  }
  if (flags.includes("--check") && flags.includes("--dry-run")) {
    throw new Error("Use --check or --dry-run, not both.");
  }
  return { platform, check: flags.includes("--check"), dir: flags.includes("--dir"),
    install: flags.includes("--install"), cargoMirror: flags.includes("--cargo-mirror"), dryRun: flags.includes("--dry-run"), help: flags.includes("--help") };
}

export function nativeTarget(platform, host = process.platform, arch = process.arch) {
  if (platform === "mac" && host === "darwin" && ["arm64", "x64"].includes(arch)) {
    return { arch, triple: `${arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin` };
  }
  if (platform === "win" && host === "win32" && arch === "x64") {
    return { arch, triple: "x86_64-pc-windows-msvc" };
  }
  throw new Error(`${platform} requires a native ${platform === "mac" ? "macOS arm64/x64" : "Windows x64"} host and matching Node.js. Cross-compilation is not supported (current: ${host}/${arch}).`);
}

export function buildEnvironment(env = process.env) {
  const next = { ...env };
  const pathKey = Object.keys(next).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const cargoHome = next.CARGO_HOME || join(homedir(), ".cargo");
  next[pathKey] = `${join(cargoHome, "bin")}${delimiter}${next[pathKey] ?? ""}`;
  for (const key of Object.keys(next)) {
    if (/^(?:WIN_)?CSC_|^APPLE_/i.test(key)) delete next[key];
  }
  next.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  return next;
}

export function createBuildPlan(options, target, root, dependenciesPresent) {
  const steps = [];
  const add = (label, command, args, cwd = root) => steps.push({ label, command, args, cwd });
  if (options.install || !dependenciesPresent) add("Install locked dependencies", "pnpm", ["install", "--frozen-lockfile"]);
  add("Compile native Rust host", "cargo", ["build", ...(options.cargoMirror ? [
    "--config", 'source.crates-io.replace-with="pi-local-mirror"',
    "--config", 'source.pi-local-mirror.registry="sparse+https://rsproxy.cn/index/"',
  ] : []), "--release", "--locked", "-p", "host-core", "--target", target.triple, "--target-dir", join(root, "target")]);
  add("Build desktop dependencies", "pnpm", [...desktopFilter, "run", "build:deps"]);
  add("Bundle agent runtime", "pnpm", ["--filter", "@pi-desktop/agent-runtime", "bundle"]);
  add("Build desktop application", "pnpm", [...desktopFilter, "build"]);
  const packages = options.dir ? [{ targets: ["--dir"], distribution: "installed" }]
    : options.platform === "mac" ? [{ targets: ["dmg", "zip"], distribution: "installed" }]
      : ["nsis", "zip", "portable"].map((name) => ({ targets: [name], distribution: name === "nsis" ? "installed" : name }));
  for (const entry of packages) {
    add(`Package ${entry.targets.join("/")}`, "pnpm", ["exec", "electron-builder", `--${options.platform}`, ...entry.targets,
      `--${target.arch}`, "--publish", "never", "--config", "{config}", `-c.extraMetadata.piDistribution=${entry.distribution}`], join(root, "apps", "desktop"));
  }
  return steps;
}

export function localBuilderConfig(base, platform, target, root) {
  const binary = `pi-desktop-host-core${platform === "win" ? ".exe" : ""}`;
  const config = structuredClone(base);
  config.extends = null;
  config.publish = null;
  config.forceCodeSigning = false;
  config.directories = { ...base.directories, output: join(root, "apps", "desktop", "release", "local", `${platform}-${target.arch}`) };
  // Explicit Rust target prevents a stale binary for another CPU/OS from shipping.
  config[platform].extraResources = base[platform].extraResources.map((entry) => {
    if (typeof entry === "object" && /pi-desktop-host-core(?:\.exe)?$/.test(entry.from)) {
      return { ...entry, from: join(root, "target", target.triple, "release", binary) };
    }
    return entry;
  });
  if (platform === "mac") {
    // Ad-hoc signing supports local Apple Silicon execution; it is NOT Developer ID signing.
    config.mac = { ...config.mac, identity: "-", notarize: false };
  }
  return config;
}

export function windowsPnpmCommand(args) {
  // cmd expands percent variables even inside quotes. Reject those exceptional
  // temp-path spellings instead of interpreting them; ordinary spaces are safe.
  if (args.some((arg) => /["%!\r\n]/.test(arg))) {
    throw new Error("Windows build arguments cannot contain quotes, %, ! or newlines. Use a simple TEMP path.");
  }
  return `pnpm.cmd ${args.map((arg) => `"${arg}"`).join(" ")}`;
}

export function runCommand(command, args, { cwd, env, capture = false } = {}) {
  return new Promise((resolveRun, reject) => {
    // Only pnpm's trusted, fixed arguments use cmd.exe on Windows. No free-form
    // builder arguments, key material or shell snippets are accepted by this CLI.
    const windowsPnpm = process.platform === "win32" && command === "pnpm";
    const child = spawn(windowsPnpm ? windowsPnpmCommand(args) : command, windowsPnpm ? [] : args, {
      cwd, env, shell: windowsPnpm, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
    }
    child.once("error", (error) => reject(new Error(`Cannot run ${command}: ${error.message}. Check the build prerequisites.`)));
    child.once("close", (code, signal) => {
      if (code === 0) resolveRun(output.trim());
      else reject(new Error(`${command} failed (${signal ?? code})${capture ? `: ${output.trim()}` : ""}`));
    });
  });
}

export async function executeBuildPlan(plan, { env, configPath, run = runCommand }) {
  for (const step of plan) {
    console.log(`==> ${step.label}`);
    await run(step.command, step.args.map((arg) => arg === "{config}" ? configPath : arg), { cwd: step.cwd, env });
  }
}

async function checkPrerequisites(target, options, env) {
  const version = process.versions.node.split(".").map(Number);
  if (version[0] < 22 || (version[0] === 22 && version[1] < 19)) throw new Error("Node.js >=22.19 is required (Node 24 LTS recommended).");
  const run = (command, args) => runCommand(command, args, { cwd: repositoryRoot, env, capture: true });
  const pnpm = await run("pnpm", ["--version"]);
  if (Number(pnpm.split(".")[0]) < 10) throw new Error("pnpm >=10 is required; use the packageManager version in package.json.");
  const rust = await run("rustc", ["-vV"]);
  if (!rust.includes(`host: ${target.triple}`)) throw new Error(`Rust must use the native ${target.triple} toolchain. Check rustup show.`);
  await run("cargo", ["--version"]);
  if (options.platform === "mac") {
    await run("xcrun", ["--find", "clang"]);
    const machine = await run("uname", ["-m"]);
    if (machine !== (target.arch === "x64" ? "x86_64" : "arm64")) throw new Error("Node.js and the macOS shell must use the same native CPU architecture.");
  } else {
    const vswhere = join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
    const tools = await run(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"]);
    if (!tools) throw new Error("Install Visual Studio Build Tools: Desktop development with C++ and a Windows SDK.");
  }
  console.log(`Prerequisites OK: Node ${process.versions.node}, pnpm ${pnpm}, Rust ${target.triple}`);
  console.log("Media runtime requirement: Python 3.9+ must be installed on the end user's machine (not bundled).");
}

export async function main(args = process.argv.slice(2)) {
  const options = parseBuildArgs(args);
  if (options.help) {
    console.log("Usage: node scripts/build-platform-app.mjs <mac|win> [--check|--dry-run] [--dir] [--install] [--cargo-mirror]\n--cargo-mirror: use rsproxy.cn for this Cargo invocation only\n--check: validate native build tools without compiling\n--dry-run: print a plan without running commands\n--dir: unpacked .app/application directory only\n--install: reinstall dependencies using the frozen lockfile\nDefault: macOS DMG+ZIP; Windows NSIS+ZIP+portable. No upload or release signing.");
    return;
  }
  const target = options.dryRun
    ? nativeTarget(options.platform, options.platform === "mac" ? "darwin" : "win32", options.platform === "mac" && process.arch === "arm64" ? "arm64" : "x64")
    : nativeTarget(options.platform);
  const dependenciesPresent = existsSync(join(repositoryRoot, "node_modules", ".modules.yaml"));
  const plan = createBuildPlan(options, target, repositoryRoot, dependenciesPresent);
  if (options.dryRun) { console.log(JSON.stringify({ validation: "not run", target, steps: plan }, null, 2)); return; }
  const env = buildEnvironment();
  await checkPrerequisites(target, options, env);
  if (options.check) {
    console.log(dependenciesPresent ? "Dependencies found; no install needed." : "Dependencies missing; a normal build will run pnpm install --frozen-lockfile.");
    return;
  }
  const pkg = JSON.parse(await readFile(join(repositoryRoot, "apps", "desktop", "package.json"), "utf8"));
  const config = localBuilderConfig(pkg.build, options.platform, target, repositoryRoot);
  const temp = await mkdtemp(join(tmpdir(), "pi-local-build-"));
  try {
    const configPath = join(temp, "electron-builder.json");
    await writeFile(configPath, JSON.stringify(config, null, 2));
    await executeBuildPlan(plan, { env, configPath });
    console.log(`\nBuild complete: ${config.directories.output}\nLocal/testing artifacts only: not notarized, no update feed, no publishing.\nThe existing PI-Desktop app identity/profile is retained. Do not overwrite another installation.`);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`Build failed: ${error.message}`); process.exitCode = 1; });
}
