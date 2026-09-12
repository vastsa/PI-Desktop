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

test("Windows keyboard hook retains only a weak stdout sender", async () => {
  const keyboard = await readFile(
    new URL("../../../crates/host-core/src/keyboard.rs", import.meta.url),
    "utf8",
  );
  const rpc = await readFile(
    new URL("../../../crates/host-core/src/rpc/mod.rs", import.meta.url),
    "utf8",
  );

  assert.match(keyboard, /OnceLock<mpsc::WeakUnboundedSender<String>>/);
  assert.match(keyboard, /tx\.downgrade\(\)/);
  assert.doesNotMatch(keyboard, /OnceLock<mpsc::UnboundedSender<String>>/);
  assert.match(rpc, /crate::keyboard::start\(tx\.clone\(\)\)/);
  assert.match(rpc, /tokio::time::timeout\(STDOUT_WRITER_SHUTDOWN, writer_done_rx\)/);
});

test("shared host stdin cap matches host-core MAX_STDIN_LINE_BYTES", async () => {
  const rpc = await readFile(
    new URL("../../../crates/host-core/src/rpc/mod.rs", import.meta.url),
    "utf8",
  );
  const limits = await readFile(
    new URL("../../../packages/shared/src/rpc-limits.ts", import.meta.url),
    "utf8",
  );
  assert.match(rpc, /const MAX_STDIN_LINE_BYTES: u64 = 64 \* 1024 \* 1024;/);
  assert.match(limits, /export const MAX_HOST_STDIN_LINE_BYTES = 64 \* 1024 \* 1024;/);
});


