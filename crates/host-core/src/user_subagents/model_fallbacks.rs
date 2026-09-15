use anyhow::{bail, Result};

/// Pins remain flat frontmatter strings; no credential or runtime state is stored here.
pub(super) fn normalize(values: &[String]) -> Result<Vec<String>> {
    let mut pins = Vec::new();
    for value in values {
        let pin = value.trim();
        if pin.is_empty() || pin.chars().any(char::is_control) {
            bail!("SUBAGENT_INVALID: fallbackModels entries must be non-empty provider/model pins");
        }
        // Match the definition parser's flat list syntax; delimiters cannot
        // round-trip inside a pin and must never inject another field.
        if pin.contains([',', '[', ']', '\'', '"']) {
            bail!("SUBAGENT_INVALID: fallbackModels contains a frontmatter delimiter");
        }
        super::normalize_model(Some(pin))?;
        if !pins.iter().any(|existing| existing == pin) {
            pins.push(pin.to_string());
        }
    }
    Ok(pins)
}

/// Read the same inline or block list accepted by the shared definition parser.
pub(super) fn parse(raw: &str) -> Result<Vec<String>> {
    let mut lines = raw.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Ok(Vec::new());
    }
    let mut values = Vec::new();
    let mut collecting = false;
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if collecting {
            if let Some(value) = line.strip_prefix("- ") {
                values.push(unquote(value));
                continue;
            }
        }
        collecting = false;
        if let Some((key, value)) = line.split_once(':') {
            if key.to_lowercase().replace(['-', '_', ' '], "") == "fallbackmodels" {
                values.clear();
                let value = value.trim();
                collecting = value.is_empty();
                if !collecting {
                    values.extend(
                        value
                            .trim_matches(['[', ']'])
                            .split(',')
                            .map(unquote)
                            .filter(|pin| !pin.is_empty()),
                    );
                }
            }
        }
    }
    normalize(&values)
}

fn unquote(value: &str) -> String {
    value.trim().trim_matches(['\'', '"']).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordered_lists_accept_both_spellings_and_preserve_model_slashes() {
        for list in [
            "fallbackModels: [a/one, b/vendor/two, a/one]",
            "fallback-models:\n  - a/one\n  - 'b/vendor/two'\n  - a/one",
        ] {
            let raw = format!("---\n{list}\n---\nBody");
            assert_eq!(parse(&raw).unwrap(), vec!["a/one", "b/vendor/two"]);
        }
    }

    #[test]
    fn invalid_pins_and_frontmatter_injection_are_rejected() {
        for pin in [
            "",
            "model",
            "/model",
            "vendor/",
            "vendor/model\npermission: auto",
            "vendor/model, other/model",
        ] {
            assert!(normalize(&[pin.to_string()]).is_err(), "{pin}");
        }
        assert_eq!(normalize(&[]).unwrap(), Vec::<String>::new());
    }
}
