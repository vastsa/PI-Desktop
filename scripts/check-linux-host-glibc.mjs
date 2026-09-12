#!/usr/bin/env node
/**
 * Fail a Linux host-core binary that needs a newer glibc than the advertised
 * floor (Ubuntu 22.04 / glibc 2.35). Release packaging must run this after
 * `cargo build --release -p host-core` so ubuntu-latest cannot silently
 * raise the requirement again.
 *
 * Usage:
 *   node scripts/check-linux-host-glibc.mjs [path-to-host-core]
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  LINUX_GLIBC_DISTROS,
  MIN_LINUX_GLIBC,
  formatGlibcVersion,
  hostGlibcWithinFloor,
  maxNeededGlibc,
} from "../apps/desktop/electron/main/linux-glibc.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const binary = path.resolve(
  process.argv[2] || path.join(root, "target/release/pi-desktop-host-core"),
);

if (!existsSync(binary)) {
  console.error(`host-core binary not found: ${binary}`);
  process.exit(1);
}

let dump = "";
try {
  dump = execFileSync("objdump", ["-T", binary], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
} catch {
  try {
    dump = execFileSync("readelf", ["-W", "-s", binary], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    console.error(`unable to read dynamic symbols from ${binary}: ${error}`);
    process.exit(1);
  }
}

const needed = maxNeededGlibc(dump);
const floor = formatGlibcVersion(MIN_LINUX_GLIBC);
if (!hostGlibcWithinFloor(needed)) {
  const found = needed ? formatGlibcVersion(needed) : "unknown";
  console.error(
    `${binary} needs glibc ${found}, above the ${floor} floor (${LINUX_GLIBC_DISTROS}). Build host-core on Ubuntu 22.04.`,
  );
  process.exit(1);
}

console.log(
  `${binary} glibc ${needed ? formatGlibcVersion(needed) : "none"} <= ${floor} (${LINUX_GLIBC_DISTROS})`,
);
