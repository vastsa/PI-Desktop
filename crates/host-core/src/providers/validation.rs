use super::*;

pub(crate) const MAX_HEADERS: usize = 32;
const MAX_HEADER_KEY_BYTES: usize = 256;
const MAX_HEADER_VALUE_BYTES: usize = 4096;
pub(crate) const MAX_MODEL_ALIAS_CHARS: usize = 60;
const FORBIDDEN_HEADER_KEYS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "host",
    "content-type",
    "content-length",
    "cookie",
    "set-cookie",
    "connection",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "keep-alive",
    "x-api-key",
    "api-key",
    "chatgpt-account-id",
    "x-opencode-session",
];

pub(crate) fn valid_header_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Fold the fullwidth block (U+FF01–U+FF5E) and the ideographic space (U+3000)
/// onto ASCII. This is what a Chinese/Japanese IME or a fullwidth-formatted
/// page produces for plain ASCII — `０` is U+FF10 — so folding it back is the
/// user's intent, not a rewrite of it.
///
/// Deliberately not a full NFKC pass: NFKC would also turn halfwidth katakana
/// `ｱ` into U+30A2 and emit combining marks, replacing one unusable value with
/// another. Mirrors `foldFullwidthHeaderValue` in `@pi-desktop/shared`.
pub(crate) fn fold_fullwidth(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            let code = ch as u32;
            if (0xFF01..=0xFF5E).contains(&code) {
                char::from_u32(code - 0xFEE0).unwrap_or(ch)
            } else if code == 0x3000 {
                ' '
            } else {
                ch
            }
        })
        .collect()
}

/// First character an HTTP header value cannot carry, with the code-unit index
/// undici would name in `Cannot convert argument to a ByteString because the
/// character at index N ...`. HTTP header values are ByteStrings: HTAB,
/// printable ASCII, and the Latin-1 supplement travel; NUL, the other C0
/// controls, DEL, and every code point above U+00FF do not. Mirrors
/// `HEADER_VALUE_ALLOWED` in `@pi-desktop/shared`.
///
/// The first fault always sits below U+0100, and every character before it is
/// below U+0100 too, so a char index and a UTF-16 code-unit index agree here —
/// the two engines cannot report different positions.
pub(crate) fn header_value_fault(value: &str) -> Option<(usize, char)> {
    value.chars().enumerate().find(|(_, ch)| {
        let code = *ch as u32;
        !(code == 0x09 || (0x20..=0x7E).contains(&code) || (0x80..=0xFF).contains(&code))
    })
}

/// Trim exactly what `String.prototype.trim` trims, because the renderer and
/// the runtime normalize values with it: `char::is_whitespace` is the Unicode
/// White_Space property, which includes U+0085 (NEL) that JavaScript keeps, and
/// excludes U+FEFF (a byte-order mark pasted from a file) that JavaScript
/// removes. Diverging here would let the host refuse a value the editor showed
/// as clean, or store a byte the runtime would have stripped.
fn is_header_trim(ch: char) -> bool {
    ch != '\u{85}' && (ch.is_whitespace() || ch == '\u{FEFF}')
}

pub(crate) fn normalize_one_header(key: &str, value: &str) -> Result<Option<(String, String)>> {
    let key = key.trim_matches(is_header_trim);
    let value = fold_fullwidth(value.trim_matches(is_header_trim));
    let value = value.as_str();
    if key.is_empty() {
        if value.is_empty() {
            return Ok(None);
        }
        bail!("HEADERS_INVALID: header name is required");
    }
    if key.len() > MAX_HEADER_KEY_BYTES {
        bail!("HEADERS_INVALID: header name is too long");
    }
    if value.len() > MAX_HEADER_VALUE_BYTES {
        bail!("HEADERS_INVALID: header value is too long");
    }
    if key.contains('\r') || key.contains('\n') || value.contains('\r') || value.contains('\n') {
        bail!("HEADERS_INVALID: must not contain CR or LF");
    }
    if !valid_header_key(key) {
        bail!("HEADERS_INVALID: header name \"{key}\" is not allowed");
    }
    if FORBIDDEN_HEADER_KEYS.contains(&key.to_ascii_lowercase().as_str()) {
        bail!("HEADERS_INVALID: header \"{key}\" is reserved");
    }
    if let Some((index, ch)) = header_value_fault(value) {
        let label = if ch.is_control() {
            format!("U+{:04X}", ch as u32)
        } else {
            format!("{ch} (U+{:04X})", ch as u32)
        };
        bail!(
            "HEADERS_INVALID: header \"{key}\" value has {label} at character index {index}; \
             header values must be printable Latin-1"
        );
    }
    if value.is_empty() {
        return Ok(None);
    }
    Ok(Some((key.to_string(), value.to_string())))
}

pub(crate) fn normalize_headers_input(
    raw: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>> {
    let mut by_lower: BTreeMap<String, (String, String)> = BTreeMap::new();
    for (key, value) in raw {
        if let Some((normalized_key, normalized_value)) = normalize_one_header(key, value)? {
            let lower = normalized_key.to_ascii_lowercase();
            if by_lower.contains_key(&lower) {
                bail!("HEADERS_INVALID: duplicate header \"{normalized_key}\"");
            }
            by_lower.insert(lower, (normalized_key, normalized_value));
        }
    }
    if by_lower.len() > MAX_HEADERS {
        bail!("HEADERS_INVALID: at most {MAX_HEADERS} headers");
    }
    Ok(by_lower.into_values().collect())
}

/// Store what can travel and drop the rest — the rule `config_headers` applies
/// when reading a stored map, exposed for data the user did not type here. A
/// bundle written by a peer on an older build, or a backup taken before this
/// rule existed, can hold a value this build refuses; dropping the row keeps
/// the rest of the revision applying instead of failing it whole (D621).
pub(crate) fn storable_headers(raw: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut by_lower: BTreeMap<String, (String, String)> = BTreeMap::new();
    for (key, value) in raw {
        if let Ok(Some((normalized_key, normalized_value))) = normalize_one_header(key, value) {
            by_lower.insert(
                normalized_key.to_ascii_lowercase(),
                (normalized_key, normalized_value),
            );
        }
    }
    by_lower.into_values().take(MAX_HEADERS).collect()
}

pub(crate) fn normalize_thinking_levels(levels: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for level in levels {
        let trimmed = level.trim();
        if !CANONICAL_THINKING_LEVELS.contains(&trimmed) {
            continue;
        }
        if !out.iter().any(|existing| existing == trimmed) {
            out.push(trimmed.to_string());
        }
    }
    out
}

pub(crate) fn validate_model_aliases(bindings: &[ModelBinding]) -> Result<()> {
    for binding in bindings {
        if let Some(alias) = binding.alias.as_deref() {
            if alias.trim().chars().count() > MAX_MODEL_ALIAS_CHARS {
                bail!(
                    "MODEL_ALIAS_TOO_LONG: alias for model \"{}\" exceeds {} characters",
                    binding.id.trim(),
                    MAX_MODEL_ALIAS_CHARS
                );
            }
        }
    }
    Ok(())
}

pub(crate) fn config_limit_u32(raw: &str, key: &str) -> Option<u32> {
    let value = config_value(raw)?.get("limits")?.get(key)?.as_u64()?;
    u32::try_from(value).ok().filter(|v| *v > 0)
}

pub(crate) fn config_limit_f64(raw: &str, key: &str) -> Option<f64> {
    config_value(raw)?.get("limits")?.get(key)?.as_f64()
}
