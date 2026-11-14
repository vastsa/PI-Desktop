import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url).href);

const {
  pinUnpackedTranscribeLibrary,
  resolveTranscribeLibraryOverride,
  toUnpackedAsarPath,
  transcribeLibraryFileName,
} = await import("../electron/main/transcribe-native-library.ts");

test("maps only the app.asar path segment to its unpacked sibling", () => {
  assert.equal(
    toUnpackedAsarPath("/A.app/Contents/Resources/app.asar/node_modules/@transcribe-cpp/x", "/"),
    "/A.app/Contents/Resources/app.asar.unpacked/node_modules/@transcribe-cpp/x",
  );
  assert.equal(
    toUnpackedAsarPath("C:\\PI\\resources\\app.asar\\node_modules\\@transcribe-cpp\\x", "\\"),
    "C:\\PI\\resources\\app.asar.unpacked\\node_modules\\@transcribe-cpp\\x",
  );
  // Development trees and look-alike names are not asar archives.
  assert.equal(toUnpackedAsarPath("/repo/node_modules/@transcribe-cpp/x", "/"), null);
  assert.equal(toUnpackedAsarPath("/repo/my-app.asar.d/x", "/"), null);
  assert.equal(toUnpackedAsarPath("/A/app.asar.unpacked/x", "/"), null);
});

test("library file names follow transcribe-cpp's per-platform loader", () => {
  assert.equal(transcribeLibraryFileName("darwin"), "libtranscribe.dylib");
  assert.equal(transcribeLibraryFileName("win32"), "transcribe.dll");
  assert.equal(transcribeLibraryFileName("linux"), "libtranscribe.so");
});

test("override targets the unpacked library only when it exists and none is set", () => {
  const artifactDir = "/R/app.asar/node_modules/@transcribe-cpp/darwin-arm64-metal";
  const expected = "/R/app.asar.unpacked/node_modules/@transcribe-cpp/darwin-arm64-metal/libtranscribe.dylib";
  const base = { artifactDir, platform: "darwin", sep: "/" };

  assert.equal(
    resolveTranscribeLibraryOverride({ ...base, currentOverride: undefined, exists: (p) => p === expected }),
    expected,
  );
  assert.equal(
    resolveTranscribeLibraryOverride({ ...base, currentOverride: undefined, exists: () => false }),
    null,
    "a missing unpacked copy must leave transcribe-cpp's own resolution in place",
  );
  assert.equal(
    resolveTranscribeLibraryOverride({ ...base, currentOverride: "/custom/lib.dylib", exists: () => true }),
    null,
    "an explicit TRANSCRIBE_LIBRARY always wins",
  );
  assert.equal(
    resolveTranscribeLibraryOverride({
      ...base,
      artifactDir: "/repo/node_modules/@transcribe-cpp/darwin-arm64-metal",
      currentOverride: undefined,
      exists: () => true,
    }),
    null,
  );
});

test("pins TRANSCRIBE_LIBRARY to a real unpacked provider before loading", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-transcribe-unpacked-"));
  try {
    const provider = join("node_modules", "@transcribe-cpp", "tuple");
    const unpackedDir = join(root, "app.asar.unpacked", provider);
    await mkdir(unpackedDir, { recursive: true });
    const library = join(unpackedDir, transcribeLibraryFileName(process.platform));
    await writeFile(library, "");
    const loadModule = async () => ({ artifactDir: () => join(root, "app.asar", provider) });

    const env = {};
    await pinUnpackedTranscribeLibrary(env, loadModule);
    assert.equal(env.TRANSCRIBE_LIBRARY, library);

    const userEnv = { TRANSCRIBE_LIBRARY: "/custom/lib" };
    await pinUnpackedTranscribeLibrary(userEnv, loadModule);
    assert.equal(userEnv.TRANSCRIBE_LIBRARY, "/custom/lib");

    const missingEnv = {};
    await pinUnpackedTranscribeLibrary(missingEnv, async () => ({
      artifactDir: () => {
        throw new Error("provider not installed");
      },
    }));
    assert.equal(missingEnv.TRANSCRIBE_LIBRARY, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
