import { readSettingsSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const search = await readFile(
  new URL("../src/lib/settings-search.ts", import.meta.url),
  "utf8",
);
const settingsPage = await readSettingsSource();
const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");

test("settings has no usage destination; host token history stays available", () => {
  assert.doesNotMatch(search, /id: "usage"/);
  assert.doesNotMatch(search, /settings\.nav\.usage/);
  assert.doesNotMatch(settingsPage, /TokenUsagePage/);
  assert.doesNotMatch(settingsPage, /tab === "usage"/);
  assert.match(api, /getTokenUsageHistory/);
});

test("settings usage page component is gone", async () => {
  await assert.rejects(
    () =>
      access(
        new URL("../src/components/settings/TokenUsagePage.tsx", import.meta.url),
        constants.F_OK,
      ),
    { code: "ENOENT" },
  );
});
