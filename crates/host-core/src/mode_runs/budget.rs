//! Run budgets the user sets outside a mode definition: the Goal default in
//! the app settings (`goalBudget`) and a per-run change through
//! `modes.update`. Both use the same range as a definition's `budget`.

use serde::Deserialize;
use serde_json::Value;

use super::model::MAX_SAFE_INTEGER;
use super::snapshot::{MAX_TURNS, MIN_TOKENS};

/// The builtin mode whose new runs take the `goalBudget` setting.
pub const GOAL_MODE_ID: &str = "goal";
/// App settings field (`AppSettings.goalBudget`).
pub const GOAL_BUDGET_SETTING: &str = "goalBudget";

/// `{ maxTurns, maxTokens }`; `null` is unlimited. Both fields are required
/// so a client never clears a limit by omitting it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunBudget {
    #[serde(deserialize_with = "nullable")]
    pub max_turns: Option<i64>,
    #[serde(deserialize_with = "nullable")]
    pub max_tokens: Option<i64>,
}

fn nullable<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
    Option::<i64>::deserialize(deserializer)
}

impl RunBudget {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self
            .max_turns
            .is_some_and(|turns| !(1..=MAX_TURNS).contains(&turns))
        {
            return Err("maxTurns must be between 1 and 10000, or null");
        }
        if self
            .max_tokens
            .is_some_and(|tokens| !(MIN_TOKENS..=MAX_SAFE_INTEGER).contains(&tokens))
        {
            return Err("maxTokens must be at least 1000, or null");
        }
        Ok(())
    }
}

fn parse(value: &Value) -> Result<RunBudget, String> {
    let budget: RunBudget =
        serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
    budget.validate()?;
    Ok(budget)
}

/// `settings.set` check for `goalBudget`: absent, `null`, or a valid budget.
pub fn validate_goal_budget_setting(settings: &Value) -> Result<(), String> {
    match settings.get(GOAL_BUDGET_SETTING) {
        None | Some(Value::Null) => Ok(()),
        Some(value) => parse(value)
            .map(|_| ())
            .map_err(|error| format!("{GOAL_BUDGET_SETTING}: {error}")),
    }
}

/// The Goal default stored in the app settings, when it is set and valid.
/// An invalid stored value is ignored: the definition budget applies.
pub fn goal_budget_from_settings(settings: Option<&Value>) -> Option<RunBudget> {
    let value = settings?.get(GOAL_BUDGET_SETTING)?;
    if value.is_null() {
        return None;
    }
    parse(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn settings_budget_accepts_limits_and_unlimited() {
        let settings = json!({ "goalBudget": { "maxTurns": 5, "maxTokens": null } });
        assert!(validate_goal_budget_setting(&settings).is_ok());
        assert_eq!(
            goal_budget_from_settings(Some(&settings)),
            Some(RunBudget {
                max_turns: Some(5),
                max_tokens: None
            })
        );
        assert!(validate_goal_budget_setting(&json!({})).is_ok());
        assert!(validate_goal_budget_setting(&json!({ "goalBudget": null })).is_ok());
    }

    #[test]
    fn settings_budget_rejects_out_of_range_and_partial_values() {
        for value in [
            json!({ "maxTurns": 0, "maxTokens": null }),
            json!({ "maxTurns": 10_001, "maxTokens": null }),
            json!({ "maxTurns": null, "maxTokens": 999 }),
            json!({ "maxTurns": 3 }),
            json!({ "maxTurns": "3", "maxTokens": null }),
            json!({ "maxTurns": 3, "maxTokens": null, "extra": 1 }),
        ] {
            let settings = json!({ "goalBudget": value });
            assert!(validate_goal_budget_setting(&settings).is_err(), "{value}");
            assert_eq!(goal_budget_from_settings(Some(&settings)), None);
        }
    }
}
