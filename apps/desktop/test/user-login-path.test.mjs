import assert from "node:assert/strict";
import { delimiter } from "node:path";
import test from "node:test";
import {
  mergePathParts,
  probedLoginPath,
  resetUserLoginPathCacheForTests,
  userLookupPath,
} from "../electron/main/user-login-path.ts";

test("mergePathParts keeps first-seen order and drops empties", () => {
  assert.equal(
    mergePathParts(`/opt/homebrew/bin${delimiter}/usr/bin`, `/usr/bin${delimiter}/bin`, ""),
    `/opt/homebrew/bin${delimiter}/usr/bin${delimiter}/bin`,
  );
  assert.equal(mergePathParts(undefined, "", "/usr/bin"), "/usr/bin");
});

test("a login-shell PATH is searched before the inherited GUI PATH", () => {
  resetUserLoginPathCacheForTests();
  const inherited = `/usr/bin${delimiter}/bin`;
  const path = userLookupPath(inherited, () => `/opt/homebrew/bin${delimiter}/usr/bin`);
  if (process.platform === "win32") {
    assert.equal(path, inherited);
    return;
  }
  const parts = path.split(delimiter);
  assert.equal(parts[0], "/opt/homebrew/bin");
  assert.ok(parts.includes("/usr/bin"));
  assert.ok(parts.includes("/bin"));
  assert.equal(parts.filter((part) => part === "/usr/bin").length, 1);
});

test("a failed probe still keeps the inherited PATH", () => {
  resetUserLoginPathCacheForTests();
  const inherited = `/usr/bin${delimiter}/sbin`;
  const path = userLookupPath(inherited, () => undefined);
  assert.ok(path.split(delimiter).includes("/usr/bin"));
  assert.ok(path.split(delimiter).includes("/sbin"));
});

test("the login-shell probe is cached for the process", () => {
  resetUserLoginPathCacheForTests();
  let calls = 0;
  const probe = () => {
    calls += 1;
    return "/tmp/probed";
  };
  assert.equal(probedLoginPath(probe), "/tmp/probed");
  assert.equal(probedLoginPath(() => "/tmp/other"), "/tmp/probed");
  assert.equal(calls, 1);
});
