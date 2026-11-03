import { describe, expect, it } from "vitest";
import {
  chooseStartupAnimation,
  decodeStartupAnimationArgument,
  encodeStartupAnimationArgument,
  STARTUP_ANIMATION_ARGUMENT_PREFIX,
  STARTUP_ANIMATION_EXTENSIONS,
  STARTUP_ANIMATION_MAX_BYTES,
  STARTUP_ANIMATION_MIME_TYPES,
  startupAnimationExtensionOf,
  type StartupAnimationDescriptor,
} from "./startup-animation.js";

describe("chooseStartupAnimation", () => {
  it("returns nothing for an empty or unplayable directory", () => {
    expect(chooseStartupAnimation([])).toBeNull();
    expect(
      chooseStartupAnimation([
        { fileName: "readme.txt", byteLength: 10 },
        { fileName: "poster.png", byteLength: 10 },
        { fileName: "noextension", byteLength: 10 },
      ]),
    ).toBeNull();
  });

  it("prefers the container Chromium decodes in every build", () => {
    const chosen = chooseStartupAnimation([
      { fileName: "b.mp4", byteLength: 100 },
      { fileName: "a.webm", byteLength: 100 },
      { fileName: "c.mov", byteLength: 100 },
    ]);
    expect(chosen?.fileName).toBe("a.webm");
    expect(chosen?.extension).toBe("webm");
  });

  it("breaks a tie inside one container by file name, not by directory order", () => {
    const forward = chooseStartupAnimation([
      { fileName: "b.mp4", byteLength: 1 },
      { fileName: "a.mp4", byteLength: 1 },
    ]);
    const reversed = chooseStartupAnimation([
      { fileName: "a.mp4", byteLength: 1 },
      { fileName: "b.mp4", byteLength: 1 },
    ]);
    expect(forward?.fileName).toBe("a.mp4");
    expect(reversed?.fileName).toBe("a.mp4");
  });

  it("is case-insensitive about the extension", () => {
    expect(chooseStartupAnimation([{ fileName: "Intro.MP4", byteLength: 5 }])?.extension).toBe(
      "mp4",
    );
  });

  it("treats an oversized or empty file as absent", () => {
    expect(
      chooseStartupAnimation([
        { fileName: "huge.webm", byteLength: STARTUP_ANIMATION_MAX_BYTES + 1 },
      ]),
    ).toBeNull();
    expect(chooseStartupAnimation([{ fileName: "empty.webm", byteLength: 0 }])).toBeNull();
    // The cap is inclusive, so a file exactly at the limit still plays.
    expect(
      chooseStartupAnimation([
        { fileName: "atlimit.webm", byteLength: STARTUP_ANIMATION_MAX_BYTES },
      ])?.fileName,
    ).toBe("atlimit.webm");
  });

  it("skips dot-prefixed entries so a resource fork cannot win", () => {
    // macOS writes `._intro.mp4` beside a copied file, and it sorts before the
    // real one; an editor's swap file behaves the same way.
    expect(
      chooseStartupAnimation([
        { fileName: "._intro.mp4", byteLength: 4 },
        { fileName: "intro.mp4", byteLength: 400 },
      ])?.fileName,
    ).toBe("intro.mp4");
  });

  it("falls back to the next candidate when the preferred one is rejected", () => {
    expect(
      chooseStartupAnimation([
        { fileName: "a.webm", byteLength: STARTUP_ANIMATION_MAX_BYTES + 1 },
        { fileName: "b.mp4", byteLength: 10 },
      ])?.fileName,
    ).toBe("b.mp4");
  });
});

describe("startupAnimationExtensionOf", () => {
  it("accepts only the declared containers", () => {
    for (const extension of STARTUP_ANIMATION_EXTENSIONS) {
      expect(startupAnimationExtensionOf(`clip.${extension}`)).toBe(extension);
      // Every accepted container must have a content type to serve it with.
      expect(STARTUP_ANIMATION_MIME_TYPES[extension]).toMatch(/^video\//);
    }
    expect(startupAnimationExtensionOf("clip.avi")).toBeNull();
    expect(startupAnimationExtensionOf("clip.")).toBeNull();
    expect(startupAnimationExtensionOf(".webm")).toBeNull();
  });
});

describe("the renderer creation argument", () => {
  const descriptor: StartupAnimationDescriptor = {
    fileName: "intro clip.webm",
    extension: "webm",
    byteLength: 2048,
    skipWhenReady: true,
  };

  it("round-trips a descriptor", () => {
    const argument = encodeStartupAnimationArgument(descriptor);
    expect(argument.startsWith(STARTUP_ANIMATION_ARGUMENT_PREFIX)).toBe(true);
    expect(decodeStartupAnimationArgument(["--other", argument])).toEqual(descriptor);
  });

  it("survives a file name with spaces, quotes, and non-ASCII characters", () => {
    const awkward: StartupAnimationDescriptor = {
      ...descriptor,
      fileName: 'o"pen ing — 启动.mp4',
      extension: "mp4",
    };
    expect(
      decodeStartupAnimationArgument([encodeStartupAnimationArgument(awkward)]),
    ).toEqual(awkward);
  });

  it("reads nothing when the argument is absent", () => {
    expect(decodeStartupAnimationArgument([])).toBeNull();
    expect(decodeStartupAnimationArgument(["--pi-desktop-locale=en"])).toBeNull();
  });

  it("refuses a malformed or incomplete descriptor rather than half-building one", () => {
    // The argument vector is process input: every rejection here is a launch
    // that keeps the brand splash instead of a renderer holding a bad value.
    const cases = [
      "not-json",
      encodeURIComponent("null"),
      encodeURIComponent('"a string"'),
      encodeURIComponent(JSON.stringify({ extension: "webm", byteLength: 1 })),
      encodeURIComponent(JSON.stringify({ fileName: "a.webm", byteLength: 1 })),
      encodeURIComponent(
        JSON.stringify({ fileName: "a.avi", extension: "avi", byteLength: 1 }),
      ),
      encodeURIComponent(
        JSON.stringify({ fileName: "a.webm", extension: "webm", byteLength: 0 }),
      ),
      encodeURIComponent(
        JSON.stringify({ fileName: "a.webm", extension: "webm", byteLength: 1.5 }),
      ),
    ];
    for (const payload of cases) {
      expect(
        decodeStartupAnimationArgument([
          `${STARTUP_ANIMATION_ARGUMENT_PREFIX}${payload}`,
        ]),
      ).toBeNull();
    }
  });

  it("defaults skipWhenReady to playing the animation out", () => {
    const argument = `${STARTUP_ANIMATION_ARGUMENT_PREFIX}${encodeURIComponent(
      JSON.stringify({ fileName: "a.webm", extension: "webm", byteLength: 1 }),
    )}`;
    expect(decodeStartupAnimationArgument([argument])?.skipWhenReady).toBe(false);
  });
});
