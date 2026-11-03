/**
 * User-supplied startup animation (D679 / ADR 0338).
 *
 * A user who drops a video into `<dataDir>/startup/` gets it played as the
 * boot surface instead of the brand splash. Everything here is the contract
 * the three sides share: the main process resolves a file against these rules
 * before the window exists, passes the result to the renderer as a creation
 * argument, and the renderer drives the phases from the same bounds.
 *
 * The rules are deliberately narrow. The animation owns the first paint of a
 * released app, so a file that is missing, oversized, undecodable, or simply
 * never ends must degrade to the existing splash rather than hold the window.
 */

/**
 * Container extensions a startup animation may use, most preferred first.
 *
 * `webm` leads because it is the only container Chromium decodes in every
 * build; the two MP4-family entries depend on the proprietary codecs Electron's
 * bundled ffmpeg carries. The order is also the tie-break when the directory
 * holds more than one candidate, so the choice stays deterministic.
 */
export const STARTUP_ANIMATION_EXTENSIONS = ["webm", "mp4", "m4v", "mov"] as const;

export type StartupAnimationExtension =
  (typeof STARTUP_ANIMATION_EXTENSIONS)[number];

/** Response `content-type` per container; a missing entry is not served. */
export const STARTUP_ANIMATION_MIME_TYPES: Record<
  StartupAnimationExtension,
  string
> = {
  webm: "video/webm",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
};

/** Directory below the installation data directory that holds the animation. */
export const STARTUP_ANIMATION_DIR_NAME = "startup";

/**
 * Largest file that is played.
 *
 * The cap exists because the animation is in front of the user before anything
 * else, so decoding it competes with the boot it is covering. A file past this
 * is treated as absent, which keeps a 2 GB export from turning into a stalled
 * launch instead of a visible mistake.
 */
export const STARTUP_ANIMATION_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Longest the animation may stay on screen, counted from the first paint.
 *
 * `ended` is not guaranteed: a truncated container, a decoder failure after the
 * first frame, or an infinitely looping stream all leave the event unfired.
 * This is the bound that makes the boot surface recoverable in those cases.
 */
export const STARTUP_ANIMATION_MAX_DURATION_MS = 15_000;

/**
 * How long the first frame may take before the animation is abandoned.
 *
 * Past this the file is readable but not playable in practice, and the user is
 * looking at an empty black window. Dropping to the reveal is better than
 * waiting for a decoder that is not coming.
 */
export const STARTUP_ANIMATION_FIRST_FRAME_TIMEOUT_MS = 2_000;

/**
 * Cross-fade from the black mask to the shell.
 *
 * An order of magnitude above `--motion-duration-slow` (300ms), which is sized
 * for in-flow UI feedback. This is the one deliberate exception: the reveal is
 * the end of a cinematic, not a control responding to a click.
 */
export const STARTUP_ANIMATION_REVEAL_MS = 1_000;

/**
 * How long the mask may stay fully black before it admits the app is still
 * starting.
 *
 * The mask is opaque by design, so a boot that outlasts the video is
 * indistinguishable from a hang. Past this bound the surface adds the splash's
 * own progress affordance; the startup watchdog still owns the real failure
 * bounds (`STARTUP_SLOW_HINT_MS` / `STARTUP_STALLED_MS`).
 */
export const STARTUP_ANIMATION_HOLD_HINT_MS = 3_000;

/** The URL the renderer plays; the scheme serves exactly one resolved file. */
export const STARTUP_ANIMATION_SCHEME = "pi-startup";
export const STARTUP_ANIMATION_URL = `${STARTUP_ANIMATION_SCHEME}://animation`;

/** Renderer creation argument carrying the descriptor past the sandbox. */
export const STARTUP_ANIMATION_ARGUMENT_PREFIX = "--pi-desktop-startup-animation=";

/**
 * What the renderer is told about the animation before its first paint.
 *
 * No filesystem path: the renderer plays `STARTUP_ANIMATION_URL` and the main
 * process keeps the only reference to the file. `byteLength` and `extension`
 * are carried for diagnostics and for the settings row, not for playback.
 */
export type StartupAnimationDescriptor = {
  /** Base name of the resolved file, for the settings row and logs. */
  fileName: string;
  extension: StartupAnimationExtension;
  byteLength: number;
  /** Cut the animation short once the shell has its initial state. */
  skipWhenReady: boolean;
};

/**
 * What the Appearance row shows about the animation directory.
 *
 * Re-scanned per request, so it describes what the *next* launch will play
 * rather than what this one did. `directoryName` is the folder's own name, not
 * its path: the row names the folder it opens without disclosing where the
 * user's data directory is.
 */
export type StartupAnimationStatus = {
  directoryName: string;
  fileName: string | null;
  byteLength: number | null;
};

function isStartupAnimationExtension(
  value: unknown,
): value is StartupAnimationExtension {
  return (
    typeof value === "string" &&
    (STARTUP_ANIMATION_EXTENSIONS as readonly string[]).includes(value)
  );
}

/** The extension of a file name, lowercased, or null when it has none. */
export function startupAnimationExtensionOf(
  fileName: string,
): StartupAnimationExtension | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return null;
  const extension = fileName.slice(dot + 1).toLowerCase();
  return isStartupAnimationExtension(extension) ? extension : null;
}

/** One directory entry the chooser considers. */
export type StartupAnimationCandidate = {
  fileName: string;
  byteLength: number;
};

/**
 * Pick the one animation a directory offers.
 *
 * Deterministic so two launches from the same directory never disagree:
 * oversized and unknown-extension entries drop out, then the most preferred
 * container wins, and a tie inside one container falls to the lowest file name
 * under a locale-independent comparison. A dot-prefixed entry is skipped so a
 * macOS `._foo.mp4` resource fork or an editor's `.foo.mp4.swp` cannot win.
 */
export function chooseStartupAnimation(
  candidates: readonly StartupAnimationCandidate[],
  maxBytes: number = STARTUP_ANIMATION_MAX_BYTES,
): { fileName: string; extension: StartupAnimationExtension; byteLength: number } | null {
  let best:
    | { fileName: string; extension: StartupAnimationExtension; byteLength: number; rank: number }
    | null = null;
  for (const candidate of candidates) {
    if (candidate.fileName.startsWith(".")) continue;
    if (!Number.isInteger(candidate.byteLength)) continue;
    if (candidate.byteLength <= 0 || candidate.byteLength > maxBytes) continue;
    const extension = startupAnimationExtensionOf(candidate.fileName);
    if (!extension) continue;
    const rank = STARTUP_ANIMATION_EXTENSIONS.indexOf(extension);
    if (
      best &&
      (best.rank < rank ||
        (best.rank === rank && best.fileName < candidate.fileName))
    ) {
      continue;
    }
    best = {
      fileName: candidate.fileName,
      extension,
      byteLength: candidate.byteLength,
      rank,
    };
  }
  if (!best) return null;
  return {
    fileName: best.fileName,
    extension: best.extension,
    byteLength: best.byteLength,
  };
}

/**
 * Byte range a media request asked for, clamped to the file.
 *
 * `<video>` playback is range-driven, so the handler has to answer `Range`
 * rather than always sending the whole file. Null means "no usable range":
 * the caller replies 200 with the full body, which is also the correct answer
 * for a header this does not understand.
 */
export function parseByteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;
  // A suffix range (`bytes=-N`) asks for the last N bytes.
  if (!rawStart) {
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return null;
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return null;
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}

/** Encode the descriptor as the renderer creation argument. */
export function encodeStartupAnimationArgument(
  descriptor: StartupAnimationDescriptor,
): string {
  return `${STARTUP_ANIMATION_ARGUMENT_PREFIX}${encodeURIComponent(
    JSON.stringify(descriptor),
  )}`;
}

/**
 * Read the descriptor back in the preload sandbox.
 *
 * Every field is re-validated rather than trusted: the argument vector is
 * process input, and a malformed one must leave the window on the brand splash
 * instead of handing the renderer a half-built descriptor.
 */
export function decodeStartupAnimationArgument(
  argv: readonly string[],
): StartupAnimationDescriptor | null {
  const raw = argv.find((argument) =>
    argument.startsWith(STARTUP_ANIMATION_ARGUMENT_PREFIX),
  );
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      decodeURIComponent(raw.slice(STARTUP_ANIMATION_ARGUMENT_PREFIX.length)),
    );
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value.fileName !== "string" || !value.fileName) return null;
  if (!isStartupAnimationExtension(value.extension)) return null;
  if (
    typeof value.byteLength !== "number" ||
    !Number.isInteger(value.byteLength) ||
    value.byteLength <= 0
  ) {
    return null;
  }
  return {
    fileName: value.fileName,
    extension: value.extension,
    byteLength: value.byteLength,
    skipWhenReady: value.skipWhenReady === true,
  };
}
