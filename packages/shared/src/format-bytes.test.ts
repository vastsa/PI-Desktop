import { describe, expect, it } from "vitest";
import { formatBytes } from "./format-bytes.js";

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
const TB = 1024 * 1024 * 1024 * 1024;

describe("formatBytes", () => {
  it("walks the binary scale and labels it KB / MB / GB / TB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(KB)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(MB)).toBe("1.00 MB");
    expect(formatBytes(1.5 * GB)).toBe("1.50 GB");
    expect(formatBytes(TB)).toBe("1.00 TB");
  });

  it("stays in the largest unit instead of dropping the number", () => {
    expect(formatBytes(2048 * TB)).toBe("2048.00 TB");
    expect(formatBytes(5 * TB, { maxUnit: "MB" })).toBe("5242880.00 MB");
  });

  it("keeps fixed fraction digits so neighbouring rows line up", () => {
    expect(formatBytes(1200)).toBe("1.2 KB");
    expect(formatBytes(1000 * KB)).toBe("1000.0 KB");
    expect(formatBytes(2 * MB + 500 * KB)).toBe("2.49 MB");
  });

  it("applies one decimal count to every unit above bytes", () => {
    expect(formatBytes(1536, { decimals: 1 })).toBe("1.5 KB");
    expect(formatBytes(1.25 * MB, { decimals: 1 })).toBe("1.3 MB");
    expect(formatBytes(1.25 * GB, { decimals: 1 })).toBe("1.3 GB");
  });

  it("applies per-unit decimal counts and falls back to the defaults", () => {
    const decimals = { KB: 1, MB: 2 } as const;
    expect(formatBytes(1536, { decimals })).toBe("1.5 KB");
    expect(formatBytes(1536 * KB, { decimals })).toBe("1.50 MB");
    expect(formatBytes(1536 * MB, { decimals })).toBe("1.50 GB");
  });

  it("rounds whole bytes only when asked, and truncates otherwise", () => {
    expect(formatBytes(1023.6)).toBe("1023 B");
    expect(formatBytes(1023.6, { roundBytes: true })).toBe("1024 B");
    expect(formatBytes(0.9, { roundBytes: true })).toBe("1 B");
  });

  it("treats non-finite input as zero instead of rendering NaN", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });

  it("scales from magnitude and keeps the sign of a negative size", () => {
    expect(formatBytes(-1536)).toBe("-1.5 KB");
    expect(formatBytes(-512)).toBe("-512 B");
  });

  it("reproduces the outputs the existing call sites relied on", () => {
    // FilesTab / tool-presentation: exact bytes, one decimal on KB and MB.
    const fileViewer = { decimals: { KB: 1, MB: 1 } };
    expect(formatBytes(1023, fileViewer)).toBe("1023 B");
    expect(formatBytes(2048, fileViewer)).toBe("2.0 KB");
    expect(formatBytes(3.5 * MB, fileViewer)).toBe("3.5 MB");

    // plugins/model: one decimal on KB, two on MB.
    const catalogSize = { decimals: { KB: 1, MB: 2 } };
    expect(formatBytes(2048, catalogSize)).toBe("2.0 KB");
    expect(formatBytes(3.5 * MB, catalogSize)).toBe("3.50 MB");

    // install-progress / config-sync-progress: rounded bytes, two on MB / GB.
    const transfer = { roundBytes: true, decimals: { KB: 1, MB: 2, GB: 2 } };
    expect(formatBytes(0, transfer)).toBe("0 B");
    expect(formatBytes(999.6, transfer)).toBe("1000 B");
    expect(formatBytes(3.5 * MB, transfer)).toBe("3.50 MB");
    expect(formatBytes(2.25 * GB, transfer)).toBe("2.25 GB");
  });
});
