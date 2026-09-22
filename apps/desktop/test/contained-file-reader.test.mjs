import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createContainedFileReader } = await import(
  "../electron/main/services/contained-file-reader.ts"
);

/** The reader reports only the codes its caller asked for; these stand in for one caller. */
const CODES = {
  outside: "FIXTURE_OUTSIDE",
  notFound: "FIXTURE_NOT_FOUND",
  invalid: "FIXTURE_INVALID",
  fileTooLarge: "FIXTURE_FILE_TOO_LARGE",
  setTooLarge: "FIXTURE_SET_TOO_LARGE",
};

const ATTACHMENT_NAME = "a".repeat(64);

/** Real roots under a temp directory: project, scratch, and the attachment store. */
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "pi-contained-reader-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const roots = {
    projectPath: join(base, "project"),
    scratchPath: join(base, "scratch"),
    dataDir: join(base, "data"),
  };
  mkdirSync(roots.projectPath, { recursive: true });
  mkdirSync(roots.scratchPath, { recursive: true });
  mkdirSync(join(roots.dataDir, "attachments"), { recursive: true });
  return { base, roots };
}

function reader(roots, overrides = {}) {
  return createContainedFileReader({
    roots,
    maxFileBytes: 4096,
    maxSetBytes: 1024 * 1024,
    maxBudgetBytes: 1024 * 1024,
    codes: CODES,
    ...overrides,
  });
}

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the reader returned bytes for a ref it must refuse");
}

test("reads a project-relative ref, an attachments ref, and a scratch ref", async (t) => {
  const { roots } = fixture(t);
  writeFileSync(join(roots.projectPath, "notes.bin"), "project bytes");
  writeFileSync(join(roots.dataDir, "attachments", ATTACHMENT_NAME), "attachment bytes");
  writeFileSync(join(roots.scratchPath, "scratch.bin"), "scratch bytes");

  const [project, attachment] = await reader(roots)([
    "notes.bin",
    `attachments/${ATTACHMENT_NAME}`,
  ]);
  assert.equal(Buffer.from(project).toString(), "project bytes");
  assert.equal(Buffer.from(attachment).toString(), "attachment bytes");

  // Without a project the ref resolves against the scratch directory instead.
  const withoutProject = reader({ scratchPath: roots.scratchPath, dataDir: roots.dataDir });
  const [scratch] = await withoutProject(["scratch.bin"]);
  assert.equal(Buffer.from(scratch).toString(), "scratch bytes");

  // A repeated ref is read once, so both entries are the same bytes.
  const [first, second] = await reader(roots)(["notes.bin", "notes.bin"]);
  assert.equal(first, second);
});

test("a sibling path reached with .. is outside every root", async (t) => {
  const { base, roots } = fixture(t);
  writeFileSync(join(base, "sibling.bin"), "outside");
  const error = await refusal(reader(roots)(["../sibling.bin"]));
  assert.equal(error.errorCode, CODES.outside);
});

test("an absolute path outside every root is refused", async (t) => {
  const { base, roots } = fixture(t);
  const outside = join(base, "sibling.bin");
  writeFileSync(outside, "outside");
  const error = await refusal(reader(roots)([outside]));
  assert.equal(error.errorCode, CODES.outside);
});

test("a symlink pointing outside the roots is refused", async (t) => {
  const { base, roots } = fixture(t);
  writeFileSync(join(base, "sibling.bin"), "outside");
  try {
    symlinkSync(join(base, "sibling.bin"), join(roots.projectPath, "link.bin"));
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("creating a link is not permitted on this host");
      return;
    }
    throw error;
  }
  const error = await refusal(reader(roots)(["link.bin"]));
  assert.equal(error.errorCode, CODES.outside);
});

test("a missing file keeps the raw filesystem error unless the caller asks for a code", async (t) => {
  const { roots } = fixture(t);
  const { notFound: _unused, ...withoutNotFound } = CODES;
  const raw = await refusal(reader(roots, { codes: withoutNotFound })(["missing.bin"]));
  assert.equal(raw.code, "ENOENT");
  assert.equal(raw.errorCode, undefined);

  const mapped = await refusal(reader(roots)(["missing.bin"]));
  assert.equal(mapped.errorCode, CODES.notFound);
});

test("the per-file cap is enforced at stat and a file exactly at the cap still reads", async (t) => {
  const { roots } = fixture(t);
  writeFileSync(join(roots.projectPath, "at-cap.bin"), Buffer.alloc(4096, 0x41));
  writeFileSync(join(roots.projectPath, "over-cap.bin"), Buffer.alloc(4097, 0x41));
  const read = reader(roots);
  const [atCap] = await read(["at-cap.bin"]);
  assert.equal(atCap.length, 4096);
  const error = await refusal(read(["over-cap.bin"]));
  assert.equal(error.errorCode, CODES.fileTooLarge);
});

test("a call whose refs exceed the per-call cap is refused", async (t) => {
  const { roots } = fixture(t);
  writeFileSync(join(roots.projectPath, "one.bin"), Buffer.alloc(2048, 0x41));
  writeFileSync(join(roots.projectPath, "two.bin"), Buffer.alloc(2048, 0x42));
  const [single] = await reader(roots, { maxSetBytes: 3000 })(["one.bin"]);
  assert.equal(single.length, 2048);
  const error = await refusal(reader(roots, { maxSetBytes: 3000 })(["one.bin", "two.bin"]));
  assert.equal(error.errorCode, CODES.setTooLarge);
});

test("the lifetime budget stops a second call", async (t) => {
  const { roots } = fixture(t);
  writeFileSync(join(roots.projectPath, "one.bin"), Buffer.alloc(2048, 0x41));
  writeFileSync(join(roots.projectPath, "two.bin"), Buffer.alloc(2048, 0x42));
  const read = reader(roots, { maxBudgetBytes: 3000 });
  const [first] = await read(["one.bin"]);
  assert.equal(first.length, 2048);
  const error = await refusal(read(["two.bin"]));
  assert.equal(error.errorCode, CODES.setTooLarge);
});

/** Appends once, `delayMs` after this call, and reports whether the append ran. */
function armAppend(file, delayMs, bytes) {
  const started = performance.now();
  let fired = false;
  let cancelled = false;
  const tick = () => {
    if (cancelled) return;
    if (performance.now() - started >= delayMs) {
      appendFileSync(file, bytes);
      fired = true;
      return;
    }
    setImmediate(tick);
  };
  setImmediate(tick);
  return () => {
    cancelled = true;
    return fired;
  };
}

/**
 * One growth attempt: the file holds exactly the per-file cap when the read
 * starts, and a single append grows it past that cap.
 */
async function attemptGrowth(workdir, cap, delayMs) {
  const file = join(workdir, "growing.bin");
  writeFileSync(file, Buffer.alloc(cap, 0x41));
  const read = createContainedFileReader({
    roots: { projectPath: workdir, scratchPath: workdir, dataDir: workdir },
    maxFileBytes: cap,
    maxSetBytes: cap * 8,
    maxBudgetBytes: cap * 64,
    codes: CODES,
  });
  const stopAppend = armAppend(file, delayMs, Buffer.alloc(64 * 1024, 0x42));
  try {
    const [bytes] = await read(["growing.bin"]);
    stopAppend();
    const grown = statSync(file).size;
    return bytes.length > cap
      ? { kind: "captured", bytes, grown }
      : { kind: "after-read", bytes, grown };
  } catch (error) {
    stopAppend();
    return { kind: "before-stat", error, grown: statSync(file).size };
  } finally {
    rmSync(file, { force: true });
  }
}

test("a file that grows after stat is truncated at the cap, never returned in full", async (t) => {
  const { roots } = fixture(t);
  const cap = 4 * 1024 * 1024;
  // The append has to land between `stat` and the end of the bounded read, and
  // the reader exposes no hook for that moment. The delay is therefore found by
  // bisection: an append that lands before `stat` refuses the file as too large,
  // and one that lands after the read leaves the result at the cap.
  let low = 0;
  let high = null;
  let delay = 1;
  let captured = null;
  let attempts = 0;
  const deadline = performance.now() + 5000;
  while (!captured && attempts < 40 && performance.now() < deadline) {
    attempts += 1;
    const outcome = await attemptGrowth(roots.projectPath, cap, delay);
    if (outcome.kind === "captured") {
      captured = outcome;
      break;
    }
    if (outcome.kind === "before-stat") {
      assert.equal(outcome.error.errorCode, CODES.fileTooLarge);
      low = delay;
    } else {
      high = delay;
    }
    delay = high === null ? delay * 2 : (low + high) / 2;
    if (high !== null && high - low < 0.05) break;
  }
  assert.ok(captured, `no append landed inside the bounded read after ${attempts} attempts`);
  assert.equal(captured.bytes.length, cap + 1);
  assert.ok(captured.grown > cap);
  assert.ok(captured.bytes.length < captured.grown);
});
