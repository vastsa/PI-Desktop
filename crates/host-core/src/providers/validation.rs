use super::*;

pub(crate) const MAX_HEADERS: usize = 32;
const MAX_HEADER_KEY_BYTES: usize = 256;
const MAX_HEADER_VALUE_BYTES: usize = 4096;
const MAX_MODEL_ALIAS_CHARS: usize = 60;
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

pub(crate) fn normalize_one_header(key: &str, value: &str) -> Result<Option<(String, String)>> {
    let key = key.trim();
    let value = value.trim();
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
