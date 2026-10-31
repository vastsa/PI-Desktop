//! Reversible storage representation shared with host-runtime/binary-storage.ts.
//! This codec never escapes the file store: business objects stay unchanged.
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Debug, thiserror::Error)]
#[error("invalid binary storage: {0}")]
struct InvalidStorage(String);
fn invalid(reason: impl Into<String>) -> anyhow::Error {
    InvalidStorage(reason.into()).into()
}
pub(super) fn is_error(error: &anyhow::Error) -> bool {
    error.downcast_ref::<InvalidStorage>().is_some()
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(untagged)]
enum Key {
    Field(String),
    Index(usize),
}
type Path = Vec<Key>;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ref {
    path: Path,
    image: usize,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Escape {
    at: usize,
    raw: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ImagePart {
    image: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    escapes: Vec<Escape>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MirrorPart {
    text: usize,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum Part {
    Literal(String),
    Image(ImagePart),
    Mirror(MirrorPart),
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Text {
    path: Path,
    parts: Vec<Part>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u32,
    data: Vec<String>,
    refs: Vec<Ref>,
    texts: Vec<Text>,
}
struct Token {
    path: Path,
    start: usize,
    end: usize,
    value: String,
}

fn base64(value: &str) -> bool {
    let body = value.trim_end_matches('=');
    !body.is_empty()
        && value.len() - body.len() <= 2
        && body
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
}
fn child<'a>(value: &'a Value, key: &Key) -> Result<&'a Value> {
    match key {
        Key::Field(k) => value.as_object().and_then(|o| o.get(k)),
        Key::Index(i) => value.as_array().and_then(|a| a.get(*i)),
    }
    .ok_or_else(|| invalid("missing or mistyped path"))
}
fn at<'a>(root: &'a Value, path: &[Key]) -> Result<&'a Value> {
    path.iter().try_fold(root, child)
}
fn put(root: &mut Value, path: &[Key], value: Value) -> Result<()> {
    let (last, parents) = path.split_last().ok_or_else(|| invalid("empty path"))?;
    let mut parent = root;
    for key in parents {
        parent = match key {
            Key::Field(k) => parent.as_object_mut().and_then(|o| o.get_mut(k)),
            Key::Index(i) => parent.as_array_mut().and_then(|a| a.get_mut(*i)),
        }
        .ok_or_else(|| invalid("missing path"))?;
    }
    let slot = match last {
        Key::Field(k) => parent.as_object_mut().and_then(|o| o.get_mut(k)),
        Key::Index(i) => parent.as_array_mut().and_then(|a| a.get_mut(*i)),
    }
    .ok_or_else(|| invalid("missing path"))?;
    *slot = value;
    Ok(())
}
fn field(path: &[Key], name: &str) -> Path {
    let mut out = path.to_vec();
    out.push(Key::Field(name.into()));
    out
}
fn walk(value: &Value, path: &mut Path, visit: &mut impl FnMut(&Value, &Path)) {
    match value {
        Value::Object(map) => {
            visit(value, path);
            for (k, v) in map {
                path.push(Key::Field(k.clone()));
                walk(v, path, visit);
                path.pop();
            }
        }
        Value::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                path.push(Key::Index(i));
                walk(v, path, visit);
                path.pop();
            }
        }
        _ => {}
    }
}
fn image_positions(root: &Value) -> Vec<Path> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |path: Path| {
        if seen.insert(path.clone()) {
            out.push(path);
        }
    };
    walk(root, &mut Vec::new(), &mut |v, p| {
        if v["type"] == "image" && v.get("data").is_some() {
            add(field(p, "data"));
        }
        if v["type"] == "resource"
            && v.get("resource")
                .is_some_and(|r| r.is_object() && r.get("blob").is_some())
        {
            add(field(&field(p, "resource"), "blob"));
        }
        if let Some(items) = v.get("images").and_then(Value::as_array) {
            for (i, image) in items.iter().enumerate() {
                if image.get("mimeType").is_some_and(Value::is_string)
                    && image.get("data").is_some()
                {
                    let mut path = field(p, "images");
                    path.push(Key::Index(i));
                    add(field(&path, "data"));
                }
            }
        }
    });
    out
}
fn json_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| json_equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, v)| b.get(k).is_some_and(|other| json_equal(v, other)))
        }
        _ => left == right,
    }
}
fn sibling_matches(parent: &Value, parsed: &Value) -> bool {
    ["result", "toolResult"]
        .iter()
        .any(|k| parent.get(k).is_some_and(|r| json_equal(r, parsed)))
}

fn mirrors(root: &Value) -> Vec<(Path, String, Value)> {
    let mut out = Vec::new();
    walk(root, &mut Vec::new(), &mut |parent, path| {
        for key in ["content", "text"] {
            if let Some(text) = parent.get(key).and_then(Value::as_str) {
                if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                    if sibling_matches(parent, &parsed) {
                        out.push((field(path, key), text.to_owned(), parsed));
                    }
                }
            }
        }
    });
    out
}

fn mirrors_in(root: &Value) -> HashMap<Path, String> {
    mirrors(root)
        .into_iter()
        .map(|(path, text, _)| (path, text))
        .collect()
}

// The caller parsed the JSON already. Scan its string tokens to retain exact
// offsets/spelling; serde's map ordering must not rewrite the original mirror.
fn tokens(text: &str) -> Result<Vec<Token>> {
    struct Scanner<'a> {
        text: &'a str,
        pos: usize,
        out: Vec<Token>,
    }
    impl Scanner<'_> {
        fn white(&mut self) {
            while self.pos < self.text.len() && self.text.as_bytes()[self.pos].is_ascii_whitespace()
            {
                self.pos += 1;
            }
        }
        fn string(&mut self) -> Result<(usize, usize, String)> {
            let start = self.pos;
            self.pos += 1;
            while self.pos < self.text.len() {
                let c = self.text.as_bytes()[self.pos];
                self.pos += 1;
                if c == b'\\' {
                    self.pos += 1;
                } else if c == b'"' {
                    return Ok((
                        start,
                        self.pos,
                        serde_json::from_str(&self.text[start..self.pos])?,
                    ));
                }
            }
            Err(invalid("unterminated JSON string"))
        }
        fn value(&mut self, path: Path) -> Result<()> {
            self.white();
            let c = *self
                .text
                .as_bytes()
                .get(self.pos)
                .ok_or_else(|| invalid("missing JSON value"))?;
            if c == b'"' {
                let (start, end, value) = self.string()?;
                self.out.push(Token {
                    path,
                    start,
                    end,
                    value,
                });
            } else if c == b'{' || c == b'[' {
                let object = c == b'{';
                let end = if object { b'}' } else { b']' };
                self.pos += 1;
                self.white();
                let mut index = 0;
                while self.text.as_bytes().get(self.pos) != Some(&end) {
                    self.white();
                    let key = if object {
                        let (_, _, key) = self.string()?;
                        self.white();
                        self.pos += 1;
                        Key::Field(key)
                    } else {
                        let k = Key::Index(index);
                        index += 1;
                        k
                    };
                    let mut next = path.clone();
                    next.push(key);
                    self.value(next)?;
                    self.white();
                    if self.text.as_bytes().get(self.pos) != Some(&b',') {
                        break;
                    }
                    self.pos += 1;
                }
                self.pos += 1;
            } else {
                while self.pos < self.text.len()
                    && !matches!(
                        self.text.as_bytes()[self.pos],
                        b' ' | b'\t' | b'\r' | b'\n' | b',' | b']' | b'}'
                    )
                {
                    self.pos += 1;
                }
            }
            Ok(())
        }
    }
    let mut scanner = Scanner {
        text,
        pos: 0,
        out: Vec::new(),
    };
    scanner.value(Vec::new())?;
    Ok(scanner.out)
}
fn image_tokens(text: &str, parsed: &Value) -> Result<Vec<Token>> {
    let positions: HashSet<_> = image_positions(parsed).into_iter().collect();
    Ok(tokens(text)?
        .into_iter()
        .filter(|t| positions.contains(&t.path) && base64(&t.value))
        .collect())
}
fn image_part(text: &str, token: &Token, image: usize) -> ImagePart {
    let bytes = &text.as_bytes()[token.start + 1..token.end - 1];
    let mut pos = 0;
    let mut index = 0;
    let mut escapes = Vec::new();
    while pos < bytes.len() {
        if bytes[pos] == b'\\' {
            let size = if bytes[pos + 1] == b'u' { 6 } else { 2 };
            escapes.push(Escape {
                at: index,
                raw: String::from_utf8(bytes[pos..pos + size].to_vec()).expect("ASCII JSON escape"),
            });
            pos += size;
        } else {
            pos += 1;
        }
        index += 1;
    }
    ImagePart { image, escapes }
}
fn index_of(data: &mut Vec<String>, indexes: &mut HashMap<String, usize>, value: &str) -> usize {
    if let Some(i) = indexes.get(value) {
        return *i;
    }
    let index = data.len();
    data.push(value.into());
    indexes.insert(value.into(), index);
    index
}

pub(crate) fn encode(mut value: Value) -> Result<Value> {
    if !value.is_object() {
        return Ok(value);
    }
    if value.get("binaryStorage").is_some() {
        return Err(invalid("reserved binaryStorage field"));
    }
    let mut data = Vec::new();
    let mut indexes = HashMap::new();
    let mut refs = Vec::new();
    let mut texts = Vec::new();
    for path in image_positions(&value) {
        if let Some(s) = at(&value, &path)?.as_str().filter(|s| base64(s)) {
            let image = index_of(&mut data, &mut indexes, s);
            refs.push(Ref { path, image });
        }
    }
    if refs.is_empty() {
        return Ok(value);
    }
    let mirrors: Vec<_> = mirrors(&value)
        .into_iter()
        .filter(|(_, _, parsed)| {
            image_positions(parsed).iter().any(|path| {
                at(parsed, path)
                    .ok()
                    .and_then(Value::as_str)
                    .is_some_and(base64)
            })
        })
        .collect();
    let mut mirror_indexes = HashMap::new();
    for (index, (_, text, _)) in mirrors.iter().enumerate() {
        mirror_indexes.entry(text.as_str()).or_insert(index);
    }
    for (path, text, parsed) in &mirrors {
        let images: HashSet<_> = image_positions(parsed).into_iter().collect();
        let nested: HashMap<_, _> = mirrors_in(parsed);
        let mut parts = Vec::new();
        let mut start = 0;
        for token in tokens(text)? {
            let part = if images.contains(&token.path) && base64(&token.value) {
                let image = index_of(&mut data, &mut indexes, &token.value);
                Part::Image(image_part(text, &token, image))
            } else if let Some(index) = mirror_indexes.get(token.value.as_str()) {
                if nested.get(&token.path) != Some(&token.value)
                    || text[token.start..token.end] != serde_json::to_string(&token.value)?
                {
                    continue;
                }
                Part::Mirror(MirrorPart { text: *index })
            } else {
                continue;
            };
            parts.push(Part::Literal(text[start..token.start].into()));
            parts.push(part);
            start = token.end;
        }
        parts.push(Part::Literal(text[start..].into()));
        texts.push(Text {
            path: path.clone(),
            parts,
        });
    }
    let occurrences = refs.len()
        + texts
            .iter()
            .map(|t| {
                t.parts
                    .iter()
                    .filter(|p| !matches!(p, Part::Literal(_)))
                    .count()
            })
            .sum::<usize>();
    if occurrences == data.len() {
        return Ok(value);
    }
    for path in refs
        .iter()
        .map(|r| &r.path)
        .chain(texts.iter().map(|t| &t.path))
    {
        put(&mut value, path, Value::Null)?;
    }
    value["binaryStorage"] = serde_json::to_value(Envelope {
        version: 1,
        data,
        refs,
        texts,
    })?;
    Ok(value)
}
fn render(part: &ImagePart, data: &str) -> Result<String> {
    let mut out = String::from("\"");
    let mut start = 0;
    for escape in &part.escapes {
        if escape.at < start || escape.at >= data.len() {
            return Err(invalid("invalid escape offset"));
        }
        let raw = escape.raw.as_bytes();
        let valid = raw == b"\\/"
            || (raw.len() == 6
                && raw.starts_with(b"\\u")
                && raw[2..].iter().all(u8::is_ascii_hexdigit));
        if !valid {
            return Err(invalid("invalid escape spelling"));
        }
        let decoded: String = serde_json::from_str(&format!("\"{}\"", escape.raw))
            .map_err(|_| invalid("invalid escape"))?;
        if decoded.as_bytes() != &data.as_bytes()[escape.at..escape.at + 1] {
            return Err(invalid("escape changes data"));
        }
        out.push_str(&data[start..escape.at]);
        out.push_str(&escape.raw);
        start = escape.at + 1;
    }
    out.push_str(&data[start..]);
    out.push('"');
    Ok(out)
}
fn validate_paths(root: &Value, paths: &[Path]) -> Result<()> {
    let mut sorted = paths.to_vec();
    sorted.sort();
    let mut previous: Option<&Path> = None;
    for path in &sorted {
        if path.is_empty()
            || matches!(path.first(),Some(Key::Field(k)) if k=="binaryStorage")
            || !at(root, path)?.is_null()
        {
            return Err(invalid("invalid placeholder"));
        }
        if previous.is_some_and(|p| path.starts_with(p)) {
            return Err(invalid("duplicate or overlapping placeholders"));
        }
        previous = Some(path);
    }
    Ok(())
}

struct RestoredMirror {
    value: String,
    spans: Vec<(usize, usize, Part)>,
}

fn restore_texts(envelope: &Envelope) -> Result<Vec<RestoredMirror>> {
    fn resolve(
        index: usize,
        envelope: &Envelope,
        restored: &mut [Option<RestoredMirror>],
        visiting: &mut HashSet<usize>,
    ) -> Result<()> {
        let text = envelope
            .texts
            .get(index)
            .ok_or_else(|| invalid("invalid text index"))?;
        if restored[index].is_some() {
            return Ok(());
        }
        if !visiting.insert(index) {
            return Err(invalid("text dependency cycle"));
        }
        let mut out = String::new();
        let mut spans = Vec::new();
        for part in &text.parts {
            let start = out.len();
            match part {
                Part::Literal(s) => out.push_str(s),
                Part::Image(p) => {
                    let data = envelope
                        .data
                        .get(p.image)
                        .ok_or_else(|| invalid("invalid image index"))?;
                    out.push_str(&render(p, data)?);
                }
                Part::Mirror(p) => {
                    resolve(p.text, envelope, restored, visiting)?;
                    out.push_str(&serde_json::to_string(
                        &restored[p.text].as_ref().expect("resolved mirror").value,
                    )?);
                }
            }
            if !matches!(part, Part::Literal(_)) {
                spans.push((start, out.len(), part.clone()));
            }
        }
        if spans.is_empty() {
            return Err(invalid("text has no binary references"));
        }
        visiting.remove(&index);
        restored[index] = Some(RestoredMirror { value: out, spans });
        Ok(())
    }
    let mut restored: Vec<_> = envelope.texts.iter().map(|_| None).collect();
    let mut visiting = HashSet::new();
    for index in 0..envelope.texts.len() {
        resolve(index, envelope, &mut restored, &mut visiting)?;
    }
    Ok(restored
        .into_iter()
        .map(|value| value.expect("all mirrors resolved"))
        .collect())
}

pub(crate) fn decode(mut value: Value) -> Result<Value> {
    let Some(object) = value.as_object_mut() else {
        return Ok(value);
    };
    let Some(raw) = object.remove("binaryStorage") else {
        return Ok(value);
    };
    let envelope: Envelope = serde_json::from_value(raw).map_err(|e| invalid(e.to_string()))?;
    if envelope.version != 1 {
        return Err(invalid("unsupported version"));
    }
    let mut unique = HashSet::new();
    if envelope.data.is_empty()
        || envelope
            .data
            .iter()
            .any(|s| !base64(s) || !unique.insert(s))
    {
        return Err(invalid("invalid data table"));
    }
    let paths: Vec<_> = envelope
        .refs
        .iter()
        .map(|r| r.path.clone())
        .chain(envelope.texts.iter().map(|t| t.path.clone()))
        .collect();
    validate_paths(&value, &paths)?;
    let positions: HashSet<_> = image_positions(&value).into_iter().collect();
    let mut used = HashSet::new();
    for r in &envelope.refs {
        if !positions.contains(&r.path) {
            return Err(invalid("reference is not a binary field"));
        }
        let data = envelope
            .data
            .get(r.image)
            .ok_or_else(|| invalid("invalid image index"))?;
        put(&mut value, &r.path, json!(data))?;
        used.insert(r.image);
    }
    let restored = restore_texts(&envelope)?;
    // Nested siblings can contain other mirrors. Restore all placeholders first.
    for (text, mirror) in envelope.texts.iter().zip(&restored) {
        put(&mut value, &text.path, json!(mirror.value))?;
    }
    for (text, mirror) in envelope.texts.iter().zip(&restored) {
        let (key, parents) = text
            .path
            .split_last()
            .ok_or_else(|| invalid("empty text path"))?;
        let parsed: Value =
            serde_json::from_str(&mirror.value).map_err(|_| invalid("invalid mirror JSON"))?;
        if !matches!(key,Key::Field(k) if k=="content"||k=="text")
            || !sibling_matches(at(&value, parents)?, &parsed)
        {
            return Err(invalid("not an exact result mirror"));
        }
        let tokens = tokens(&mirror.value).map_err(|e| invalid(e.to_string()))?;
        let images: HashSet<_> = image_positions(&parsed).into_iter().collect();
        let nested = mirrors_in(&parsed);
        for (start, end, part) in &mirror.spans {
            let token = tokens
                .iter()
                .find(|t| t.start == *start && t.end == *end)
                .ok_or_else(|| invalid("text reference is not a JSON token"))?;
            match part {
                Part::Image(p) => {
                    if !images.contains(&token.path) || token.value != envelope.data[p.image] {
                        return Err(invalid("text reference is not a binary token"));
                    }
                    used.insert(p.image);
                }
                Part::Mirror(p) => {
                    if token.value != restored[p.text].value
                        || nested.get(&token.path) != Some(&token.value)
                    {
                        return Err(invalid("text reference is not a proven mirror token"));
                    }
                }
                Part::Literal(_) => unreachable!("literal parts have no reference span"),
            }
        }
    }
    if used.len() != envelope.data.len() {
        return Err(invalid("unused data table entry"));
    }
    Ok(value)
}

fn parse_line(text: &str) -> Result<Value> {
    serde_json::from_str(text).map_err(|e| {
        if text.contains("\"binaryStorage\"") {
            invalid(e.to_string())
        } else {
            anyhow!(e)
        }
    })
}

pub(super) fn read<T: serde::de::DeserializeOwned>(text: &str) -> Result<T> {
    let value = parse_line(text)?;
    let encoded = value.get("binaryStorage").is_some();
    let decoded = decode(value)?;
    serde_json::from_value(decoded).map_err(|e| {
        if encoded {
            invalid(e.to_string())
        } else {
            anyhow!(e)
        }
    })
}

/// Validate the storage representation without making historical plain rows
/// obey newer business schemas. Encoded known rows have the same typed
/// validation and explicit corruption errors as their normal read paths.
pub(super) fn validate_line(text: &str) -> Result<()> {
    let value = parse_line(text)?;
    let encoded = value.get("binaryStorage").is_some();
    let value = decode(value)?;
    if !encoded {
        return Ok(());
    }
    validate_record(value).map_err(|error| invalid(error.to_string()))
}

pub(super) fn validate_record(value: Value) -> serde_json::Result<()> {
    match value.get("type").and_then(Value::as_str) {
        Some("message") => serde_json::from_value::<super::MessageRecord>(value).map(|_| ()),
        Some("compaction") => serde_json::from_value::<super::CompactionRecord>(value).map(|_| ()),
        Some("revision") => serde_json::from_value::<super::RevisionRecord>(value).map(|_| ()),
        Some("revision_live") => {
            serde_json::from_value::<super::LiveRevisionRecord>(value).map(|_| ())
        }
        _ => Ok(()),
    }
}

/// Relocation changes structured paths. Apply that same intentional change to
/// proven image-result JSON mirrors, preserving every other literal byte. Plain
/// narrative content is never rewritten or guessed to be a machine mirror.
pub(crate) fn relocate(value: Value, mut rewrite: impl FnMut(&mut Value) -> bool) -> Result<Value> {
    let original = decode(value)?;
    let mut mirrors = Vec::new();
    walk(&original, &mut Vec::new(), &mut |parent, path| {
        for key in ["content", "text"] {
            if let Some(text) = parent.get(key).and_then(Value::as_str) {
                if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                    if !image_tokens(text, &parsed).is_ok_and(|tokens| !tokens.is_empty()) {
                        continue;
                    }
                    if let Some(sibling) = ["result", "toolResult"].into_iter().find(|key| {
                        parent
                            .get(key)
                            .is_some_and(|value| json_equal(value, &parsed))
                    }) {
                        mirrors.push((
                            field(path, key),
                            field(path, sibling),
                            text.to_owned(),
                            parsed,
                        ));
                    }
                }
            }
        }
    });
    let mut relocated = original.clone();
    rewrite(&mut relocated);
    // An outer mirror embeds its inner mirrors as JSON strings, so it must see
    // their already relocated values rather than a separately transformed copy.
    mirrors.sort_by_key(|(path, _, _, _)| std::cmp::Reverse(path.len()));
    for (path, sibling, text, before) in mirrors {
        let target = at(&relocated, &sibling)?;
        let parsed_tokens = tokens(&text)?;
        let last: HashMap<_, _> = parsed_tokens
            .iter()
            .enumerate()
            .map(|(index, token)| (token.path.clone(), index))
            .collect();
        let mut next = String::new();
        let mut cursor = 0;
        for (index, token) in parsed_tokens.iter().enumerate() {
            // JSON duplicate keys have last-write-wins semantics. Earlier
            // overwritten members and objects are literal bytes, not metadata.
            if last.get(&token.path) != Some(&index) {
                continue;
            }
            let (Ok(previous), Ok(replacement)) =
                (at(&before, &token.path), at(target, &token.path))
            else {
                continue;
            };
            if previous.as_str() == Some(token.value.as_str())
                && replacement.is_string()
                && replacement != previous
            {
                next.push_str(&text[cursor..token.start]);
                next.push_str(&serde_json::to_string(replacement)?);
                cursor = token.end;
            }
        }
        next.push_str(&text[cursor..]);
        let parsed: Value = serde_json::from_str(&next)?;
        anyhow::ensure!(
            json_equal(&parsed, target),
            "relocated result mirror diverged from canonical data"
        );
        put(&mut relocated, &path, Value::String(next))?;
    }
    encode(relocated)
}
