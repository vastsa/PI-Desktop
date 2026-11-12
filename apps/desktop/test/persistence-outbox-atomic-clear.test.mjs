import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PersistenceOutbox } from "../electron/main/persistence-outbox.ts";

for (const file of ["session-message-outbox.json", "session-message-outbox.dead-letter.json"]) {
  for (const failure of ["interrupted write", "failed rename"]) {
    test(`${file}: clearing survives ${failure}`, async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "pi-outbox-atomic-clear-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const entry = { key: "message:s:m", sessionId: "s", message: { id: "m" } };
      const records = file.includes("dead-letter")
        ? [{ ...entry, quarantinedAt: "2026-11-12T00:00:00.000Z", reason: "fixture" }]
        : [entry];
      const path = join(dir, file);
      const raw = JSON.stringify(records) + "\n";
      await writeFile(path, raw);
      const moduleUrl = new URL("../electron/main/persistence-outbox.ts", import.meta.url).href;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import fs from "node:fs/promises";
        import { syncBuiltinESMExports } from "node:module";
        const originalWrite = fs.writeFile;
        const originalRename = fs.rename;
        const path = ${JSON.stringify(path)};
        const failure = ${JSON.stringify(failure)};
        if (failure === "interrupted write") {
          fs.writeFile = async (target, data, ...args) => {
            if (String(target).startsWith(path) && data === "[]\\n") {
              // Model process termination after open(O_TRUNC), before payload write.
              await originalWrite(target, "", ...args);
              process.exit(77);
            }
            return originalWrite(target, data, ...args);
          };
        } else {
          fs.rename = async (from, to) => {
            if (to === path) throw Object.assign(new Error("fixture rename denied"), { code: "EPERM" });
            return originalRename(from, to);
          };
        }
        syncBuiltinESMExports();
        const { PersistenceOutbox } = await import(${JSON.stringify(moduleUrl)});
        const outbox = new PersistenceOutbox(${JSON.stringify(dir)}, () => {});
        if (failure === "interrupted write") {
          await outbox.dropSession("s");
          assert.fail("fault injection did not interrupt the empty write");
        } else {
          await assert.rejects(outbox.dropSession("s"), { code: "EPERM" });
        }
      `], { encoding: "utf8", timeout: 10_000 });
      assert.equal(child.status, failure === "interrupted write" ? 77 : 0, child.stderr || child.stdout);
      assert.equal(await readFile(path, "utf8"), raw, "the committed recovery file must remain intact");

      const recovered = new PersistenceOutbox(dir, () => {});
      const replayed = [];
      await recovered.flush(() => ({
        isAvailable: () => true,
        call: async (_method, params) => replayed.push(params.message),
      }));
      assert.deepEqual(replayed, file.includes("dead-letter") ? [] : [entry.message]);
      await recovered.dropSession("s");
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), []);
      await new PersistenceOutbox(dir, () => {}).flush(() => null);
    });
  }
}
