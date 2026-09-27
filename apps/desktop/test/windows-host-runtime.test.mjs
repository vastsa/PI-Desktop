import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Windows host-core statically links the MSVC CRT for clean installs", async () => {
  const cargoConfig = await readFile(
    new URL("../../../.cargo/config.toml", import.meta.url),
    "utf8",
  );

  assert.match(
    cargoConfig,
    /\[target\.x86_64-pc-windows-msvc\]\s*\nrustflags = \["-C", "target-feature=\+crt-static"\]/,
  );
});
