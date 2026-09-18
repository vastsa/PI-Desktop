import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { elapsedBetween, formatClockTime, formatTimingDuration } = await import(
  "../src/lib/message-timing.ts"
);

test("formatTimingDuration keeps sub-second precision for a short wait", () => {
  assert.equal(formatTimingDuration(0), "0.0s");
  assert.equal(formatTimingDuration(700), "0.7s");
  assert.equal(formatTimingDuration(1_200), "1.2s");
  assert.equal(formatTimingDuration(9_940), "9.9s");
  // Past ten seconds the whole-second tool formatter reads better.
  assert.equal(formatTimingDuration(36_400), "36s");
  assert.equal(formatTimingDuration(90_000), "1m 30s");
});

test("elapsedBetween measures a pair and refuses a broken one", () => {
  assert.equal(
    elapsedBetween("2026-09-15T10:00:00.000Z", "2026-09-15T10:00:36.400Z"),
    36_400,
  );
  assert.equal(elapsedBetween(undefined, "2026-09-15T10:00:00.000Z"), undefined);
  assert.equal(elapsedBetween("2026-09-15T10:00:00.000Z", undefined), undefined);
  // A turn cannot complete before it was sent, so a reversed pair is no total.
  assert.equal(
    elapsedBetween("2026-09-15T10:00:05.000Z", "2026-09-15T10:00:00.000Z"),
    undefined,
  );
  assert.equal(
    elapsedBetween("not a date", "2026-09-15T10:00:00.000Z"),
    undefined,
  );
});

test("formatClockTime renders a local time and rejects a bad timestamp", () => {
  const at = new Date(Date.parse("2026-09-15T10:00:05.000Z"));
  const rendered = formatClockTime("2026-09-15T10:00:05.000Z") ?? "";
  // The formatter keeps the locale's own clock, so this instant reads
  // "18:00:05" on a 24-hour host, "06:00:05 PM" on a 12-hour one, and
  // "上午06:00:05" where the day period leads. Its first three digit groups are
  // the local wall clock in every case.
  assert.match(rendered, /\d{1,2}:\d{2}:\d{2}/, rendered);
  const [hour, minute, second] = (rendered.match(/\d+/g) ?? []).map(Number);
  assert.equal(minute, at.getMinutes(), rendered);
  assert.equal(second, at.getSeconds(), rendered);
  // Which cycle the locale picked is the locale's business: 12- and 24-hour
  // spellings of the same instant only ever differ by 12.
  assert.equal(hour % 12, at.getHours() % 12, rendered);
  assert.equal(formatClockTime("not a date"), undefined);
});
