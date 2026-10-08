//! Settings validation and normalization for the one-shot completions that
//! carry user-editable prompts: Composer prompt enhancement (ADR 0121) and
//! session title generation (ADR 0322).
//!
//! Kept beside — not inside — the shared dispatcher so `rpc::mod` only wires
//! the `settings.set` validation hook and the read/write normalization hook.

use serde_json::{Map, Value};

/// Upper bound for one stored prompt or template, in characters. Mirrored by
/// `PROMPT_ENHANCEMENT_TEMPLATE_MAX_LENGTH` and `SESSION_TITLE_PROMPT_MAX_LENGTH`
/// in `packages/shared`; keep them in step.
const MAX_ONE_SHOT_TEMPLATE_CHARS: usize = 8000;

const PROMPT_ENHANCEMENT_TEMPLATE_FIELD: &str = "promptEnhancementUserTemplate";
/// The placeholder a usable prompt-enhancement user template must carry.
const PROMPT_ENHANCEMENT_DRAFT_VARIABLE: &str = "{{draft}}";

const SESSION_TITLE_PROMPT_FIELD: &str = "sessionTitlePrompt";
const SESSION_TITLE_IDEAL_LENGTH_FIELD: &str = "sessionTitleIdealLength";
const SESSION_TITLE_MAX_LENGTH_FIELD: &str = "sessionTitleMaxLength";
/// Inclusive ranges mirrored from `packages/shared/src/session-title.ts`.
const SESSION_TITLE_IDEAL_LENGTH_RANGE: (i64, i64) = (8, 60);
const SESSION_TITLE_MAX_LENGTH_RANGE: (i64, i64) = (16, 200);

/// A prompt override is either blank (meaning "use the built-in default") or a
/// non-blank string within the length bound. When `required_variable` is set,
/// a non-blank value must also carry it; prompt enhancement needs `{{draft}}`
/// or the draft never reaches the model, while the session title prompt has no
/// required variable because its conversation content is a built-in message.
fn one_shot_template_error(
    field: &str,
    value: &Value,
    required_variable: Option<&str>,
) -> Option<String> {
    let Some(text) = value.as_str() else {
        return Some(format!("{field} must be a string"));
    };
    if text.trim().is_empty() {
        return None;
    }
    if text.chars().count() > MAX_ONE_SHOT_TEMPLATE_CHARS {
        return Some(format!(
            "{field} must not exceed {MAX_ONE_SHOT_TEMPLATE_CHARS} characters"
        ));
    }
    if let Some(variable) = required_variable {
        if !text.contains(variable) {
            return Some(format!("{field} must contain {variable}"));
        }
    }
    None
}

fn length_error(field: &str, value: &Value, (min, max): (i64, i64)) -> Option<String> {
    match value.as_i64() {
        Some(length) if (min..=max).contains(&length) => None,
        _ => Some(format!("{field} must be an integer from {min} to {max}")),
    }
}

/// The template fields and the variable each one requires.
const TEMPLATE_FIELDS: [(&str, Option<&str>); 2] = [
    (
        PROMPT_ENHANCEMENT_TEMPLATE_FIELD,
        Some(PROMPT_ENHANCEMENT_DRAFT_VARIABLE),
    ),
    (SESSION_TITLE_PROMPT_FIELD, None),
];

const LENGTH_FIELDS: [(&str, (i64, i64)); 2] = [
    (
        SESSION_TITLE_IDEAL_LENGTH_FIELD,
        SESSION_TITLE_IDEAL_LENGTH_RANGE,
    ),
    (
        SESSION_TITLE_MAX_LENGTH_FIELD,
        SESSION_TITLE_MAX_LENGTH_RANGE,
    ),
];

/// `settings.set` validation for an incoming patch. Returns the first error
/// message; the caller maps it to `INVALID_PARAMS`.
pub(super) fn validate_one_shot_settings(object: &Map<String, Value>) -> Result<(), String> {
    for (field, required_variable) in TEMPLATE_FIELDS {
        if let Some(value) = object.get(field) {
            if let Some(message) = one_shot_template_error(field, value, required_variable) {
                return Err(message);
            }
        }
    }
    for (field, range) in LENGTH_FIELDS {
        if let Some(value) = object.get(field) {
            if let Some(message) = length_error(field, value, range) {
                return Err(message);
            }
        }
    }
    Ok(())
}

/// Normalization applied to every read and merged write. A blank override
/// means "use the built-in default", and an unusable one (wrong type,
/// oversized, missing a required variable, or a length out of range — only
/// possible in a hand-edited or synced store) falls back to the default too,
/// rather than leaving a value the runtime would have to second-guess.
///
/// The prompt-enhancement system prompt is part of that feature's contract,
/// not a preference: an override written by an older build is dropped so the
/// store cannot hold a value that would never be read.
pub(super) fn normalize_one_shot_settings(object: &mut Map<String, Value>) {
    object.remove("promptEnhancementSystemPrompt");
    for (field, required_variable) in TEMPLATE_FIELDS {
        let unusable = match object.get(field) {
            None => false,
            Some(value) => match one_shot_template_error(field, value, required_variable) {
                Some(_) => true,
                None => value.as_str().is_some_and(|text| text.trim().is_empty()),
            },
        };
        if unusable {
            object.remove(field);
        }
    }
    for (field, range) in LENGTH_FIELDS {
        if object
            .get(field)
            .is_some_and(|value| length_error(field, value, range).is_some())
        {
            object.remove(field);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn prompt_enhancement_template_keeps_its_contract() {
        assert!(validate_one_shot_settings(&object(json!({
            "promptEnhancementUserTemplate": "before {{draft}} after"
        })))
        .is_ok());
        assert_eq!(
            validate_one_shot_settings(&object(json!({
                "promptEnhancementUserTemplate": "no placeholder"
            }))),
            Err("promptEnhancementUserTemplate must contain {{draft}}".to_string())
        );
    }

    #[test]
    fn session_title_prompt_needs_no_variable_but_is_bounded() {
        for value in [
            json!("Short title only."),
            json!("Keep it under {{idealLength}} characters."),
            json!("   "),
        ] {
            assert!(
                validate_one_shot_settings(&object(json!({ "sessionTitlePrompt": value }))).is_ok()
            );
        }
        for value in [json!(42), json!("x".repeat(8001))] {
            assert!(
                validate_one_shot_settings(&object(json!({ "sessionTitlePrompt": value })))
                    .is_err()
            );
        }
        // The bound counts characters, not bytes.
        assert!(validate_one_shot_settings(&object(json!({
            "sessionTitlePrompt": "标".repeat(8000)
        })))
        .is_ok());
    }

    #[test]
    fn session_title_lengths_are_range_checked() {
        for patch in [
            json!({ "sessionTitleIdealLength": 8, "sessionTitleMaxLength": 16 }),
            json!({ "sessionTitleIdealLength": 60, "sessionTitleMaxLength": 200 }),
            // Cross-field order is not enforced: the runtime clamps at use.
            json!({ "sessionTitleIdealLength": 40, "sessionTitleMaxLength": 20 }),
        ] {
            assert!(validate_one_shot_settings(&object(patch)).is_ok());
        }
        for patch in [
            json!({ "sessionTitleIdealLength": 7 }),
            json!({ "sessionTitleIdealLength": 61 }),
            json!({ "sessionTitleIdealLength": 25.5 }),
            json!({ "sessionTitleIdealLength": "25" }),
            json!({ "sessionTitleMaxLength": 15 }),
            json!({ "sessionTitleMaxLength": 201 }),
        ] {
            assert!(
                validate_one_shot_settings(&object(patch.clone())).is_err(),
                "{patch}"
            );
        }
    }

    #[test]
    fn normalization_drops_unusable_and_blank_values() {
        let mut stored = object(json!({
            "promptEnhancementSystemPrompt": "legacy",
            "promptEnhancementUserTemplate": "no placeholder",
            "sessionTitlePrompt": "   ",
            "sessionTitleIdealLength": 500,
            "sessionTitleMaxLength": 120,
            "sessionTitleCustomPrompt": true,
        }));
        normalize_one_shot_settings(&mut stored);
        assert_eq!(
            Value::Object(stored),
            json!({ "sessionTitleMaxLength": 120, "sessionTitleCustomPrompt": true })
        );

        let mut usable = object(json!({
            "promptEnhancementUserTemplate": "x {{draft}}",
            "sessionTitlePrompt": "Custom {{idealLength}}",
            "sessionTitleIdealLength": 12,
        }));
        let before = usable.clone();
        normalize_one_shot_settings(&mut usable);
        assert_eq!(usable, before);
    }
}
