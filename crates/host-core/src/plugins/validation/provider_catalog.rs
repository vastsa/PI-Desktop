use anyhow::{bail, Result};
use serde_json::{Map, Value};

fn valid_text(value: &Value, max_chars: usize) -> bool {
    let valid = |text: &str| !text.trim().is_empty() && text.encode_utf16().count() <= max_chars;
    match value {
        Value::String(text) => valid(text),
        Value::Object(localized) => ["en", "zh-CN"].iter().all(|locale| {
            localized
                .get(*locale)
                .and_then(Value::as_str)
                .is_some_and(valid)
        }),
        _ => false,
    }
}

pub(super) fn validate_provider_catalog_fields(
    id: &str,
    declaration: &Map<String, Value>,
) -> Result<()> {
    if let Some(category) = declaration.get("category") {
        if !valid_text(category, 128) {
            bail!("PLUGIN_INVALID: provider {id} category must be a string or localized strings of at most 128 characters");
        }
    }
    if let Some(description) = declaration.get("description") {
        if !valid_text(description, 280) {
            bail!("PLUGIN_INVALID: provider {id} description must be a string or localized strings of at most 280 characters");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn validate(fields: Value) -> Result<()> {
        let declaration = fields
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("test declaration must be an object"))?;
        validate_provider_catalog_fields("community-site", declaration)
    }

    #[test]
    fn accepts_omitted_and_localized_catalog_fields() {
        validate(json!({})).expect("catalog metadata is optional");
        validate(json!({
            "category": { "en": "Community API Sites", "zh-CN": "公益站" },
            "description": { "en": "A community API service.", "zh-CN": "社区 API 服务。" }
        }))
        .expect("localized catalog metadata should be accepted");
    }

    #[test]
    fn rejects_incomplete_or_blank_localized_catalog_fields() {
        for fields in [
            json!({ "category": { "en": "Community API Sites" } }),
            json!({ "description": { "en": "A community API service.", "zh-CN": " " } }),
            json!({ "category": "  " }),
        ] {
            assert!(validate(fields).is_err());
        }
    }

    #[test]
    fn enforces_utf16_character_limits() {
        assert!(validate(json!({ "category": "界".repeat(128) })).is_ok());
        assert!(validate(json!({ "category": "界".repeat(129) })).is_err());
        assert!(validate(json!({ "description": "😀".repeat(140) })).is_ok());
        assert!(validate(json!({ "description": "😀".repeat(141) })).is_err());
    }
}
