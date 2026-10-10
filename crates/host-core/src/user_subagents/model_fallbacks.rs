use anyhow::{bail, Result};

/// Pins remain flat frontmatter strings; no credential or runtime state is stored here.
/// An optional `|thinkingLevel` suffix is preserved so each alternative can pick
/// its own reasoning without nested YAML.
pub(super) fn normalize(values: &[String]) -> Result<Vec<String>> {
    let mut pins: Vec<String> = Vec::new();
    for value in values {
        let raw = value.trim();
        if raw.is_empty() || raw.chars().any(char::is_control) {
            bail!("SUBAGENT_INVALID: fallbackModels entries must be non-empty provider/model pins");
        }
        // Match the definition parser's flat list syntax; delimiters cannot
        // round-trip inside a pin and must never inject another field.
        if raw.contains([',', '[', ']', '\'', '"']) {
            bail!("SUBAGENT_INVALID: fallbackModels contains a frontmatter delimiter");
        }
        let (model, thinking) = split_thinking(raw)?;
        let Some(model) = super::normalize_model(Some(&model))? else {
            bail!("SUBAGENT_INVALID: fallbackModels entries must be non-empty provider/model pins");
        };
        let stored = match thinking {
            Some(level) => format!("{model}|{level}"),
            None => model.clone(),
        };
        if !pins.iter().any(|existing| {
            split_thinking(existing)
                .map(|(pin, _)| pin == model)
                .unwrap_or(false)
        }) {
            pins.push(stored);
        }
    }
    Ok(pins)
}

fn split_thinking(raw: &str) -> Result<(String, Option<String>)> {
    if let Some((head, suffix)) = raw.rsplit_once('|') {
        let head = head.trim();
        let suffix = suffix.trim().to_ascii_lowercase();
        if head.is_empty()
            || head.contains('|')
            || !super::THINKING_LEVELS.contains(&suffix.as_str())
        {
            bail!("SUBAGENT_INVALID: fallbackModels thinking suffix must be a known level");
        }
        return Ok((head.to_string(), Some(suffix)));
    }
    Ok((raw.to_string(), None))
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
    fn thinking_suffixes_round_trip_and_dedupe_by_model_pin() {
        let levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
        for level in levels {
            let pin = format!("vendor/model|{level}");
            assert_eq!(normalize(&[pin.clone()]).unwrap(), vec![pin]);
        }

        let values = [
            "vendor/model|off".into(),
            "vendor/legacy|omit".into(),
            "vendor/model|LOW".into(),
        ];
        assert_eq!(
            normalize(&values).unwrap(),
            vec!["vendor/model|off", "vendor/legacy|omit"]
        );
    }

    #[test]
    fn malformed_thinking_suffixes_are_rejected() {
        for pin in [
            "vendor/model|unknown",
            "vendor/model|",
            "vendor/model|xhigh|high",
            "vendor/model|high|omit",
        ] {
            assert!(normalize(&[pin.to_string()]).is_err(), "{pin}");
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
