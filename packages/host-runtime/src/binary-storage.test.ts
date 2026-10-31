import { describe, expect, it } from "vitest";
import { decodeBinaryStorage, encodeBinaryStorage } from "./binary-storage.js";
import golden from "./fixtures/binary-storage.json";
import nestedGolden from "./fixtures/binary-storage-nested.json";

const image = (data = "A/B=") => ({ type: "image", mimeType: "image/png", data });
const record = () => {
  const toolResult = {
    content: [image()],
    details: { images: [{ mimeType: "image/png", data: "A/B=" }] },
  };
  return { id: "m", content: JSON.stringify(toolResult), toolResult };
};

describe("lossless binary storage", () => {
  it("matches the common v1 golden envelope and preserves exact text spellings", () => {
    expect(encodeBinaryStorage(golden.original)).toEqual(golden.encoded);
    expect(decodeBinaryStorage(golden.encoded)).toEqual(golden.original);
  });

  it("stores four business copies once without mutating the input", () => {
    const original = record();
    const before = structuredClone(original);
    const encoded = encodeBinaryStorage(original);
    expect(JSON.stringify(encoded).split("A/B=").length - 1).toBe(1);
    expect(decodeBinaryStorage(JSON.parse(JSON.stringify(encoded)))).toEqual(original);
    expect(original).toEqual(before);
    expect(decodeBinaryStorage(encoded)).toEqual(before);
    expect(encoded).not.toEqual(before);
  });

  it("leaves legacy records, single images, generic data and non-ASCII data unchanged", () => {
    for (const original of [
      null,
      [1, "ordinary"],
      { content: [image()] },
      { a: { data: "A/B=" }, b: { data: "A/B=" } },
      { content: [image("中文"), image("中文")] },
    ]) {
      expect(encodeBinaryStorage(original)).toEqual(original);
      expect(decodeBinaryStorage(original)).toEqual(original);
    }
  });

  it("encodes resources, images arrays and all unknown metadata losslessly", () => {
    const original = {
      nested: {
        result: {
          content: [
            { type: "resource", resource: { uri: "test:", mimeType: "image/png", blob: "A/B=" } },
          ],
          images: [{ mimeType: "image/png", data: "A/B=", unknown: true }],
        },
        text: "ordinary",
      },
      usage: { unknown: [2, "x"] },
    };
    const encoded = encodeBinaryStorage(original);
    expect(JSON.stringify(encoded).split("A/B=").length - 1).toBe(1);
    expect(decodeBinaryStorage(encoded)).toEqual(original);
  });

  it("does not template JSON that differs from a sibling result", () => {
    const original = {
      content: JSON.stringify({ content: [image()], extra: 1 }),
      toolResult: { content: [image(), image()] },
      text: "A/B=",
      unknown: "A/B=",
    };
    const encoded = encodeBinaryStorage(original) as typeof original;
    expect(encoded.content).toBe(original.content);
    expect(encoded.text).toBe(original.text);
    expect(encoded.unknown).toBe(original.unknown);
    expect(decodeBinaryStorage(encoded)).toEqual(original);
  });

  it("supports text mirrors, multiple images and escaped property names", () => {
    const result = { content: [image("AA=="), image("BB==")] };
    const text = JSON.stringify(result).replace('"data"', '"d\\u0061ta"');
    const original = { messages: [{ result, text, metadata: { source: "unknown" } }] };
    const encoded = encodeBinaryStorage(original);
    expect(JSON.stringify(encoded).split("AA==").length - 1).toBe(1);
    expect(JSON.stringify(encoded).split("BB==").length - 1).toBe(1);
    expect(decodeBinaryStorage(encoded)).toEqual(original);
  });

  it("retains literal duplicate JSON keys while templating only matching image values", () => {
    const result = { content: [image()] };
    const original = {
      result,
      content:
        '{"ignored":0,"ignored":1,"content":[{"type":"image","mimeType":"image/png","data":"A/B="}]}',
    };
    // The extra ignored field prevents mirror equality.
    expect((encodeBinaryStorage(original) as typeof original).content).toBe(original.content);
  });
});

describe("corrupt binary storage is an explicit error", () => {
  const corrupted = (mutate: (value: typeof golden.encoded) => void) => {
    const value = structuredClone(golden.encoded);
    mutate(value);
    return value;
  };

  it.each([
    [
      "unknown version",
      (v: typeof golden.encoded) => {
        v.binaryStorage.version = 2;
      },
    ],
    [
      "missing image",
      (v: typeof golden.encoded) => {
        v.binaryStorage.refs[0].image = 50;
      },
    ],
    [
      "non-base64 table data",
      (v: typeof golden.encoded) => {
        v.binaryStorage.data[0] = "中文";
      },
    ],
    [
      "non-null placeholder",
      (v: typeof golden.encoded) => {
        v.toolResult.content[0].data = "unexpected" as unknown as null;
      },
    ],
    [
      "missing path",
      (v: typeof golden.encoded) => {
        v.binaryStorage.refs[0].path = ["absent"];
      },
    ],
    [
      "illegal binary position",
      (v: typeof golden.encoded) => {
        v.binaryStorage.refs[0].path = ["content"];
      },
    ],
    [
      "duplicate ref",
      (v: typeof golden.encoded) => {
        v.binaryStorage.refs.push(v.binaryStorage.refs[0]);
      },
    ],
    [
      "overlapping path",
      (v: typeof golden.encoded) => {
        v.binaryStorage.refs[1].path = ["toolResult"];
      },
    ],
    [
      "invalid escape offset",
      (v: typeof golden.encoded) => {
        const p = v.binaryStorage.texts[0].parts[1];
        if (typeof p !== "string" && p.escapes) p.escapes[0].at = 99;
      },
    ],
    [
      "invalid escape spelling",
      (v: typeof golden.encoded) => {
        const p = v.binaryStorage.texts[0].parts[1];
        if (typeof p !== "string" && p.escapes) p.escapes[0].raw = "\\u0042";
      },
    ],
    [
      "invalid mirror",
      (v: typeof golden.encoded) => {
        v.binaryStorage.texts[0].parts[0] = "{}";
      },
    ],
    [
      "unproven mirror",
      (v: typeof golden.encoded) => {
        v.binaryStorage.texts[0].path = ["metadata", "unused"];
        Object.assign(v.metadata, { unused: null });
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    expect(() => decodeBinaryStorage(corrupted(mutate))).toThrow(/binary storage/i);
  });
});

function nestedMirror(depth: number): Record<string, unknown> {
  let result: Record<string, unknown> = { source: "中文😀", content: [image()] };
  for (let level = 0; level < depth; level++) {
    const text = JSON.stringify(result);
    result = { source: `层${level}😀`, nested: { result, text } };
  }
  return { toolResult: result, content: JSON.stringify(result) };
}

type StoredMirror = {
  binaryStorage: {
    texts: {
      path: (string | number)[];
      parts: (string | { image: number } | { text: number })[];
    }[];
  };
};

describe("nested proven JSON mirrors", () => {
  it("matches the shared nested envelope with exact original text spellings", () => {
    expect(encodeBinaryStorage(nestedGolden.original)).toEqual(nestedGolden.encoded);
    expect(decodeBinaryStorage(nestedGolden.encoded)).toEqual(nestedGolden.original);
  });

  it.each([1, 2, 3])("stores images once through %i nested mirror levels", (depth) => {
    const original = nestedMirror(depth);
    const encoded = encodeBinaryStorage(original);
    expect(JSON.stringify(encoded).split("A/B=").length - 1).toBe(1);
    expect(decodeBinaryStorage(JSON.parse(JSON.stringify(encoded)))).toEqual(original);
    const stored = encoded as StoredMirror;
    expect(
      stored.binaryStorage.texts.some((text) =>
        text.parts.some((part) => typeof part !== "string" && "text" in part),
      ),
    ).toBe(true);
  });

  it("preserves inner source spelling and escapes through canonical outer string tokens", () => {
    const inner =
      '{"source":"earlier","source":"中文😀","content":[{"type":"image","mimeType":"image/png","data":"\\u0041\\/B="}]}';
    const result = {
      nested: { result: JSON.parse(inner) as unknown, text: inner },
      exponent: 1,
      fraction: 1,
    };
    const original = {
      toolResult: result,
      content: JSON.stringify(result)
        .replace('"exponent":1', '"exponent":1e0')
        .replace('"fraction":1', '"fraction":1.0'),
    };
    const encoded = encodeBinaryStorage(original);
    expect(JSON.stringify(encoded).split("A/B=").length - 1).toBe(1);
    expect(JSON.stringify(encoded).split("earlier").length - 1).toBe(1);
    expect(decodeBinaryStorage(encoded)).toEqual(original);
  });

  it("retains noncanonical outer string-token spelling literally and losslessly", () => {
    const original = nestedMirror(1);
    original.content = (original.content as string).replace('"text":"', '"text":"\\u0020');
    original.toolResult = JSON.parse(original.content as string) as unknown;
    const encoded = encodeBinaryStorage(original);
    expect(decodeBinaryStorage(encoded)).toEqual(original);
  });

  it.each(["missing", "self cycle", "mutual cycle"])(
    "rejects %s text dependencies explicitly",
    (kind) => {
      const encoded = encodeBinaryStorage(nestedMirror(2)) as StoredMirror;
      const texts = encoded.binaryStorage.texts;
      const owner = texts.findIndex((text) =>
        text.parts.some((part) => typeof part !== "string" && "text" in part),
      );
      const part = texts[owner].parts.find((part) => typeof part !== "string" && "text" in part);
      if (typeof part === "string" || !part || !("text" in part))
        throw new Error("Missing nested text reference");
      if (kind === "missing") part.text = texts.length;
      else if (kind === "self cycle") part.text = owner;
      else {
        const child = part.text;
        texts[child].parts = [{ text: owner }];
      }
      expect(() => decodeBinaryStorage(encoded)).toThrow(/binary storage.*(?:index|cycle)/i);
    },
  );

  it("rejects a text reference used for an ordinary narrative token", () => {
    const original = nestedMirror(1);
    const result = original.toolResult as { nested: { text: string } };
    Object.assign(result, { narrative: result.nested.text });
    original.content = JSON.stringify(result);
    const encoded = encodeBinaryStorage(original) as StoredMirror;
    const owner = encoded.binaryStorage.texts.find((text) => text.path.length === 1);
    const nested = encoded.binaryStorage.texts.findIndex((text) => text.path.at(-1) === "text");
    if (!owner) throw new Error("Missing outer mirror");
    const rawToken = JSON.stringify(result.nested.text);
    owner.parts = owner.parts.flatMap((part) => {
      if (typeof part !== "string" || !part.includes(`"narrative":${rawToken}`)) return [part];
      const [before, after] = part.split(rawToken);
      return [before, { text: nested }, after];
    });
    expect(() => decodeBinaryStorage(encoded)).toThrow(/binary storage.*text.*token/i);
  });
});

describe("nested mirror corruption parity", () => {
  it("rejects unknown fields in a text-reference part", () => {
    const encoded = structuredClone(nestedGolden.encoded) as StoredMirror;
    const part = encoded.binaryStorage.texts
      .flatMap((text) => text.parts)
      .find((part) => typeof part !== "string" && "text" in part);
    if (!part || typeof part === "string") throw new Error("Missing mirror part fixture");
    Object.assign(part, { unknown: true });
    expect(() => decodeBinaryStorage(encoded)).toThrow(/unexpected envelope fields/i);
  });
});
