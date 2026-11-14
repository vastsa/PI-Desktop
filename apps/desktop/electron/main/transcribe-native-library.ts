/**
 * Points transcribe-cpp at the unpacked copy of its native library in
 * packaged builds.
 *
 * transcribe-cpp resolves its `@transcribe-cpp/<platform>` provider with
 * `require.resolve`, which in a packaged app yields a path inside
 * `app.asar`. Electron's fs shims make that path readable, but koffi hands
 * it to the OS loader (dlopen / LoadLibrary), which cannot see into an asar
 * archive, so local transcription fails to load. The provider is listed in
 * `asarUnpack`; this module redirects the loader to that real file through
 * transcribe-cpp's documented `TRANSCRIBE_LIBRARY` override. Development
 * trees contain no `app.asar` segment and are left untouched.
 */

import { existsSync } from "node:fs";
import path from "node:path";

const ASAR_SEGMENT = "app.asar";
const UNPACKED_SEGMENT = "app.asar.unpacked";

/** Library file name transcribe-cpp loads from its provider directory. */
export function transcribeLibraryFileName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "libtranscribe.dylib";
  if (platform === "win32") return "transcribe.dll";
  return "libtranscribe.so";
}

/**
 * Map a path inside `app.asar` to its `app.asar.unpacked` sibling, or return
 * null when the path is not inside an asar archive.
 */
export function toUnpackedAsarPath(filePath: string, sep: string = path.sep): string | null {
  const segments = filePath.split(sep);
  const index = segments.indexOf(ASAR_SEGMENT);
  if (index < 0) return null;
  segments[index] = UNPACKED_SEGMENT;
  return segments.join(sep);
}

export interface TranscribeLibraryOverrideInput {
  /** Current `TRANSCRIBE_LIBRARY` value; an explicit override always wins. */
  readonly currentOverride: string | undefined;
  /** transcribe-cpp's resolved provider directory. */
  readonly artifactDir: string;
  readonly platform: NodeJS.Platform;
  readonly sep?: string;
  readonly exists: (filePath: string) => boolean;
}

/**
 * Return the unpacked library path to export as `TRANSCRIBE_LIBRARY`, or null
 * when no redirect is needed or possible.
 */
export function resolveTranscribeLibraryOverride(
  input: TranscribeLibraryOverrideInput,
): string | null {
  if (input.currentOverride) return null;
  const sep = input.sep ?? path.sep;
  const unpackedDir = toUnpackedAsarPath(input.artifactDir, sep);
  if (!unpackedDir) return null;
  const libraryPath = [unpackedDir, transcribeLibraryFileName(input.platform)].join(sep);
  return input.exists(libraryPath) ? libraryPath : null;
}

type TranscribeCppModule = { artifactDir(): string };

/**
 * Export `TRANSCRIBE_LIBRARY` for the unpacked provider before transcribe-cpp
 * loads its native library. Resolution failures are left for transcribe-cpp to
 * report with its own diagnostics when the model actually loads.
 */
export async function pinUnpackedTranscribeLibrary(
  env: NodeJS.ProcessEnv = process.env,
  loadModule: () => Promise<TranscribeCppModule> = () =>
    import("transcribe-cpp") as Promise<TranscribeCppModule>,
): Promise<void> {
  if (env.TRANSCRIBE_LIBRARY) return;
  let artifactDir: string;
  try {
    artifactDir = (await loadModule()).artifactDir();
  } catch {
    // Missing or partial provider installs surface through ModelManager's
    // load error, which carries transcribe-cpp's install diagnosis.
    return;
  }
  const override = resolveTranscribeLibraryOverride({
    currentOverride: env.TRANSCRIBE_LIBRARY,
    artifactDir,
    platform: process.platform,
    exists: existsSync,
  });
  if (override) env.TRANSCRIBE_LIBRARY = override;
}
