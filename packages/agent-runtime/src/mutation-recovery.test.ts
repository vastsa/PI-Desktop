import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mutationFailureKey } from "./mutation-recovery.js";

describe("mutationFailureKey", () => {
  it("uses a stable lexical identity when the target does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-missing-edit-"));
    try {
      const expected = resolve(root, "missing", "example.ts");
      expect(await mutationFailureKey("missing/example.ts", root)).toBe(expected);
      expect(await mutationFailureKey("./missing/sub/../example.ts", root)).toBe(expected);
      expect(await mutationFailureKey(expected, root)).toBe(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("respects the directory's actual case sensitivity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-case-edit-"));
    try {
      await writeFile(join(root, "a.ts"), "lower\n");
      const caseSensitive = await stat(join(root, "A.ts")).then(
        () => false,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return true;
          throw error;
        },
      );
      if (caseSensitive) {
        await writeFile(join(root, "A.ts"), "upper\n");
        expect(await mutationFailureKey("a.ts", root)).not.toBe(await mutationFailureKey("A.ts", root));
      } else {
        expect(await mutationFailureKey("a.ts", root)).toBe(await mutationFailureKey("A.ts", root));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("preserves POSIX backslashes in file names", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-backslash-edit-"));
    try {
      await writeFile(join(root, "a\\b.ts"), "literal\n");
      expect(await mutationFailureKey("a\\b.ts", root)).toBe(join(await realpath(root), "a\\b.ts"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
