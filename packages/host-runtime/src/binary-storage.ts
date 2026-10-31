/** Storage-only, reversible image deduplication. Business values never use this envelope. */
type Path = (string | number)[];
type JsonObject = Record<string, unknown>;
type ImageRef = { path: Path; image: number };
type Escape = { at: number; raw: string };
type ImagePart = { image: number; escapes?: Escape[] };
type MirrorPart = { text: number };
type TextRef = { path: Path; parts: (string | ImagePart | MirrorPart)[] };
type Mirror = { path: Path; value: string; parsed: unknown; tokens: Token[] };
type Envelope = { version: 1; data: string[]; refs: ImageRef[]; texts: TextRef[] };
type Token = { path: Path; start: number; end: number; value: string };

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isBase64 = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
const pathKey = (path: Path) => JSON.stringify(path);
const own = (value: object, key: string | number) => Object.hasOwn(value, key);
function invalid(reason: string): never {
  throw new Error(`Invalid binary storage: ${reason}`);
}

function walk(
  value: unknown,
  visit: (object: JsonObject, path: Path) => void,
  path: Path = [],
): void {
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visit, [...path, index]));
  else if (isObject(value)) {
    visit(value, path);
    for (const [key, item] of Object.entries(value)) walk(item, visit, [...path, key]);
  }
}

/** Only recognized binary positions are eligible; arbitrary data/text remains literal. */
function imagePositions(value: unknown): Path[] {
  const paths: Path[] = [];
  walk(value, (object, path) => {
    if (object.type === "image" && own(object, "data")) paths.push([...path, "data"]);
    if (object.type === "resource" && isObject(object.resource) && own(object.resource, "blob")) {
      paths.push([...path, "resource", "blob"]);
    }
    if (Array.isArray(object.images))
      object.images.forEach((image, index) => {
        if (isObject(image) && typeof image.mimeType === "string" && own(image, "data")) {
          paths.push([...path, "images", index, "data"]);
        }
      });
  });
  return [...new Map(paths.map((path) => [pathKey(path), path])).values()];
}

function parentAt(
  root: unknown,
  path: Path,
): { parent: JsonObject | unknown[]; key: string | number } {
  if (!path.length) invalid("empty placeholder path");
  let parent = root;
  for (const key of path.slice(0, -1)) parent = childAt(parent, key);
  const key = path[path.length - 1];
  childAt(parent, key);
  return { parent: parent as JsonObject | unknown[], key };
}
function childAt(parent: unknown, key: string | number): unknown {
  if (Array.isArray(parent)) {
    if (typeof key !== "number" || !Number.isSafeInteger(key) || key < 0 || !own(parent, key))
      invalid("invalid array path");
  } else if (!isObject(parent) || typeof key !== "string" || !own(parent, key))
    invalid("missing object path");
  return (parent as JsonObject)[key];
}
function valueAt(root: unknown, path: Path): unknown {
  return path.reduce(childAt, root);
}
function setAt(root: unknown, path: Path, value: unknown): void {
  const { parent, key } = parentAt(root, path);
  (parent as JsonObject)[key] = value;
}

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((item, index) => equal(item, right[index]));
  if (!isObject(left) || !isObject(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => own(right, key) && equal(left[key], right[key]))
  );
}
function parseMirror(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
function matchesSibling(parent: JsonObject, parsed: unknown): boolean {
  return (
    parsed !== undefined &&
    ["result", "toolResult"].some((key) => own(parent, key) && equal(parent[key], parsed))
  );
}

/** JSON.parse proves validity; this scanner retains token offsets and original spelling. */
function stringTokens(text: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  const whitespace = () => {
    while (offset < text.length && /\s/.test(text[offset])) offset++;
  };
  const string = (): { start: number; end: number; value: string } => {
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === "\\") offset++;
      else if (character === '"') break;
    }
    return { start, end: offset, value: JSON.parse(text.slice(start, offset)) as string };
  };
  const value = (path: Path): void => {
    whitespace();
    const character = text[offset];
    if (character === '"') {
      tokens.push({ path, ...string() });
      return;
    }
    if (character === "{" || character === "[") {
      const object = character === "{";
      const close = object ? "}" : "]";
      offset++;
      whitespace();
      let index = 0;
      while (text[offset] !== close) {
        whitespace();
        const key = object ? string().value : index++;
        if (object) {
          whitespace();
          offset++;
        }
        value([...path, key]);
        whitespace();
        if (text[offset] !== ",") break;
        offset++;
      }
      offset++;
    } else {
      while (offset < text.length && !/[\s,\]}]/.test(text[offset])) offset++;
    }
  };
  value([]);
  return tokens;
}
function imagePart(text: string, token: Token, image: number): ImagePart {
  const spelling = text.slice(token.start + 1, token.end - 1);
  const escapes: Escape[] = [];
  for (let rawOffset = 0, at = 0; rawOffset < spelling.length; at++) {
    if (spelling[rawOffset] !== "\\") {
      rawOffset++;
      continue;
    }
    const length = spelling[rawOffset + 1] === "u" ? 6 : 2;
    escapes.push({ at, raw: spelling.slice(rawOffset, rawOffset + length) });
    rawOffset += length;
  }
  return { image, ...(escapes.length ? { escapes } : {}) };
}

function mirrorPositions(value: unknown): Map<string, string> {
  const positions = new Map<string, string>();
  walk(value, (parent, path) => {
    for (const key of ["content", "text"]) {
      const text = parent[key];
      if (typeof text === "string" && matchesSibling(parent, parseMirror(text))) {
        positions.set(pathKey([...path, key]), text);
      }
    }
  });
  return positions;
}

function collectMirrors(value: unknown): Mirror[] {
  const mirrors: Mirror[] = [];
  walk(value, (parent, path) => {
    for (const key of ["content", "text"]) {
      const text = parent[key];
      if (typeof text !== "string") continue;
      const parsed = parseMirror(text);
      if (
        matchesSibling(parent, parsed) &&
        imagePositions(parsed).some((path) => isBase64(valueAt(parsed, path)))
      ) {
        mirrors.push({ path: [...path, key], value: text, parsed, tokens: stringTokens(text) });
      }
    }
  });
  return mirrors;
}

export function encodeBinaryStorage(value: unknown): unknown {
  if (!isObject(value)) return value;
  if (own(value, "binaryStorage")) invalid("reserved binaryStorage field already exists");
  const refs: ImageRef[] = [];
  const data: string[] = [];
  const indexes = new Map<string, number>();
  const indexOf = (dataString: string): number => {
    let index = indexes.get(dataString);
    if (index === undefined) {
      index = data.length;
      data.push(dataString);
      indexes.set(dataString, index);
    }
    return index;
  };
  for (const path of imagePositions(value)) {
    const dataString = valueAt(value, path);
    if (isBase64(dataString)) refs.push({ path, image: indexOf(dataString) });
  }
  if (!refs.length) return value;
  const mirrors = collectMirrors(value);
  const mirrorIndexes = new Map<string, number>();
  mirrors.forEach((mirror, index) => {
    if (!mirrorIndexes.has(mirror.value)) mirrorIndexes.set(mirror.value, index);
  });
  const texts = mirrors.map((mirror): TextRef => {
    const images = new Set(imagePositions(mirror.parsed).map(pathKey));
    const nested = mirrorPositions(mirror.parsed);
    const parts: TextRef["parts"] = [];
    let start = 0;
    for (const token of mirror.tokens) {
      let part: ImagePart | MirrorPart;
      if (images.has(pathKey(token.path)) && isBase64(token.value)) {
        part = imagePart(mirror.value, token, indexOf(token.value));
      } else {
        const text = mirrorIndexes.get(token.value);
        // A canonical complete string token can be rendered without storing its
        // escaped copy. Other spellings remain literal to preserve every byte.
        if (
          text === undefined ||
          nested.get(pathKey(token.path)) !== token.value ||
          mirror.value.slice(token.start, token.end) !== JSON.stringify(token.value)
        )
          continue;
        part = { text };
      }
      parts.push(mirror.value.slice(start, token.start), part);
      start = token.end;
    }
    parts.push(mirror.value.slice(start));
    return { path: mirror.path, parts };
  });
  const occurrences =
    refs.length +
    texts.reduce(
      (count, text) => count + text.parts.filter((part) => typeof part !== "string").length,
      0,
    );
  if (occurrences === data.length) return value;
  const encoded = structuredClone(value);
  for (const ref of [...refs, ...texts]) setAt(encoded, ref.path, null);
  encoded.binaryStorage = { version: 1, data, refs, texts } satisfies Envelope;
  return encoded;
}

function exactKeys(value: JsonObject, required: string[], optional: string[] = []): void {
  if (
    required.some((key) => !own(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid("unexpected envelope fields");
}
function parsePath(value: unknown): Path {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (key) =>
        typeof key !== "string" &&
        !(typeof key === "number" && Number.isSafeInteger(key) && key >= 0),
    )
  )
    invalid("invalid placeholder path");
  if (value[0] === "binaryStorage") invalid("placeholder inside envelope");
  return value as Path;
}
function tableIndex(value: unknown, data: readonly unknown[], kind = "image"): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= data.length
  )
    invalid(`invalid ${kind} index`);
  return value;
}
function parseEnvelope(value: unknown): Envelope {
  if (!isObject(value)) invalid("envelope must be an object");
  exactKeys(value, ["version", "data", "refs", "texts"]);
  if (value.version !== 1) invalid("unsupported version");
  if (
    !Array.isArray(value.data) ||
    !value.data.length ||
    !value.data.every(isBase64) ||
    new Set(value.data).size !== value.data.length
  )
    invalid("invalid data table");
  if (!Array.isArray(value.refs) || !Array.isArray(value.texts))
    invalid("refs and texts must be arrays");
  for (const ref of value.refs) {
    if (!isObject(ref)) invalid("invalid reference");
    exactKeys(ref, ["path", "image"]);
    parsePath(ref.path);
    tableIndex(ref.image, value.data);
  }
  for (const text of value.texts) {
    if (!isObject(text)) invalid("invalid text reference");
    exactKeys(text, ["path", "parts"]);
    parsePath(text.path);
    if (!Array.isArray(text.parts) || !text.parts.some((part) => typeof part !== "string"))
      invalid("invalid text parts");
    for (const part of text.parts)
      if (typeof part !== "string") {
        if (!isObject(part)) invalid("invalid text part");
        if (own(part, "text")) {
          exactKeys(part, ["text"]);
          tableIndex(part.text, value.texts, "text");
        } else {
          exactKeys(part, ["image"], ["escapes"]);
          tableIndex(part.image, value.data);
          if (part.escapes !== undefined && !Array.isArray(part.escapes))
            invalid("invalid escapes");
        }
      }
  }
  return value as unknown as Envelope;
}

/** Reject duplicate and ancestor paths before restoring any placeholder. */
function validatePaths(root: JsonObject, paths: Path[]): void {
  type Trie = { terminal: boolean; children: Map<string | number, Trie> };
  const trie: Trie = { terminal: false, children: new Map() };
  for (const path of paths) {
    if (valueAt(root, path) !== null) invalid("placeholder must be null");
    let node = trie;
    for (const key of path) {
      if (node.terminal) invalid("overlapping placeholder paths");
      let next = node.children.get(key);
      if (!next) {
        next = { terminal: false, children: new Map() };
        node.children.set(key, next);
      }
      node = next;
    }
    if (node.terminal || node.children.size) invalid("duplicate or overlapping placeholder paths");
    node.terminal = true;
  }
}
function renderImage(part: ImagePart, data: string): string {
  const overrides = new Map<number, string>();
  let last = -1;
  for (const escape of part.escapes ?? []) {
    if (!isObject(escape)) invalid("invalid escape");
    exactKeys(escape, ["at", "raw"]);
    if (
      !Number.isSafeInteger(escape.at) ||
      escape.at <= last ||
      escape.at >= data.length ||
      typeof escape.raw !== "string" ||
      !/^(?:\\\/|\\u[0-9a-fA-F]{4})$/.test(escape.raw)
    )
      invalid("invalid escape spelling or offset");
    if (JSON.parse(`"${escape.raw}"`) !== data[escape.at]) invalid("escape changes image data");
    overrides.set(escape.at, escape.raw);
    last = escape.at;
  }
  if (!overrides.size) return `"${data}"`;
  const chunks: string[] = ['"'];
  let start = 0;
  for (const [at, raw] of overrides) {
    chunks.push(data.slice(start, at), raw);
    start = at + 1;
  }
  chunks.push(data.slice(start), '"');
  return chunks.join("");
}
type RestoredMirror = {
  value: string;
  spans: { start: number; end: number; part: ImagePart | MirrorPart }[];
};

/** Memoized dependency traversal rejects cycles before rendering any business value. */
function restoreTexts(envelope: Envelope): RestoredMirror[] {
  const restored = new Map<number, RestoredMirror>();
  const visiting = new Set<number>();
  const resolve = (index: number): RestoredMirror => {
    const previous = restored.get(index);
    if (previous) return previous;
    if (visiting.has(index)) invalid("text dependency cycle");
    visiting.add(index);
    const chunks: string[] = [];
    const spans: RestoredMirror["spans"] = [];
    let length = 0;
    for (const part of envelope.texts[index].parts) {
      const chunk =
        typeof part === "string"
          ? part
          : "text" in part
            ? JSON.stringify(resolve(part.text).value)
            : renderImage(part, envelope.data[part.image]);
      if (typeof part !== "string") spans.push({ start: length, end: length + chunk.length, part });
      chunks.push(chunk);
      length += chunk.length;
    }
    const mirror = { value: chunks.join(""), spans };
    visiting.delete(index);
    restored.set(index, mirror);
    return mirror;
  };
  return envelope.texts.map((_text, index) => resolve(index));
}

export function decodeBinaryStorage(value: unknown): unknown {
  if (!isObject(value) || !own(value, "binaryStorage")) return value;
  const envelope = parseEnvelope(value.binaryStorage);
  const decoded = structuredClone(value);
  delete decoded.binaryStorage;
  validatePaths(
    decoded,
    [...envelope.refs, ...envelope.texts].map((ref) => ref.path),
  );
  const positions = new Set(imagePositions(decoded).map(pathKey));
  const used = new Set<number>();
  for (const ref of envelope.refs) {
    if (!positions.has(pathKey(ref.path))) invalid("reference is not a binary field");
    setAt(decoded, ref.path, envelope.data[ref.image]);
    used.add(ref.image);
  }
  // Restore all mirrors before comparing, since nested mirror siblings can reference one another.
  const restored = restoreTexts(envelope);
  const mirrors = envelope.texts.map((text, index) => ({ text, ...restored[index] }));
  for (const mirror of mirrors) setAt(decoded, mirror.text.path, mirror.value);
  for (const mirror of mirrors) {
    const { parent, key } = parentAt(decoded, mirror.text.path);
    const parsed = parseMirror(mirror.value);
    if (
      !isObject(parent) ||
      (key !== "content" && key !== "text") ||
      !matchesSibling(parent, parsed)
    )
      invalid("text is not an exact result mirror");
    const tokens = stringTokens(mirror.value);
    const images = new Set(imagePositions(parsed).map(pathKey));
    const nested = mirrorPositions(parsed);
    for (const span of mirror.spans) {
      const token = tokens.find((token) => token.start === span.start && token.end === span.end);
      if ("text" in span.part) {
        if (
          !token ||
          token.value !== restored[span.part.text].value ||
          nested.get(pathKey(token.path)) !== token.value
        ) {
          invalid("text reference is not a proven mirror token");
        }
      } else {
        if (
          !token ||
          !images.has(pathKey(token.path)) ||
          token.value !== envelope.data[span.part.image]
        ) {
          invalid("text reference is not a binary token");
        }
        used.add(span.part.image);
      }
    }
  }
  if (used.size !== envelope.data.length) invalid("unused data table entry");
  return decoded;
}
