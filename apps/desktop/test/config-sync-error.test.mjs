import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { configSyncErrorKind } = await import(
  "../src/features/settings/config-sync-error.ts"
);

test("cloud sync errors map to a recovery action", () => {
  assert.equal(
    configSyncErrorKind(
      "CONFIG_SYNC_AUTH: enter the WebDAV app password for this server and account",
    ),
    "auth",
  );
  assert.equal(
    configSyncErrorKind("CONFIG_SYNC_REDIRECT: use the direct WebDAV endpoint"),
    "redirect",
  );
  assert.equal(
    configSyncErrorKind("CONFIG_SYNC_CRYPTO: wrong vault password"),
    "password",
  );
  assert.equal(configSyncErrorKind("socket hang up"), "unknown");
});
