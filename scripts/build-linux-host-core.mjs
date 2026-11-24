#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const platforms = { arm64: "linux/arm64", x64: "linux/amd64" };
const platform = platforms[process.arch];
if (!platform || process.getuid === undefined) {
  throw new Error("The Linux release build needs a Docker host running on arm64 or x64.");
}

const binary = "pi-desktop-host-core";
const build = path.join(root, "target", `kylin-linux-${process.arch}`);
const source = path.join(build, "release", binary);
const release = path.join(root, "target", "release");
mkdirSync(build, { recursive: true });
rmSync(source, { force: true });

execFileSync("docker", [
  "run", "--rm", "--platform", platform,
  "--user", `${process.getuid()}:${process.getgid()}`,
  "--mount", `type=bind,src=${root},dst=/src,readonly`,
  "--mount", `type=bind,src=${build},dst=/build`,
  "--workdir", "/src",
  "--env", "CARGO_TARGET_DIR=/build",
  "rust:1.94.0-bullseye", "sh", "-ec",
  'test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.31"; cargo build --release --locked -p host-core',
], { stdio: "inherit" });

if (!statSync(source, { throwIfNoEntry: false })?.isFile()) {
  throw new Error(`The Linux build did not produce ${binary}.`);
}
mkdirSync(release, { recursive: true });
copyFileSync(source, path.join(release, binary));
