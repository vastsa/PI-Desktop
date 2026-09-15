//! Deny-first permission rules (ADR 0249 / D420).
//!
//! User settings and enabled plugins contribute glob lists for tools, paths,
//! and Bash commands. A match is `PermissionDecision::Deny` and outranks auto,
//! session grants, low-risk auto-allow, and accept-edits. Plugins can only
//! add rules; they cannot remove user rules or introduce an allow list.

use globset::{GlobBuilder, GlobMatcher};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_RULES_PER_LIST: usize = 256;
pub const MAX_PATTERN_CHARS: usize = 512;

const PATH_ARG_KEYS: &[&str] = &["path", "file_path"];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct PermissionDenyRules {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DenyHit {
    pub kind: &'static str,
    pub pattern: String,
}

impl PermissionDenyRules {
    pub fn is_empty(&self) -> bool {
        self.tools.is_empty() && self.paths.is_empty() && self.commands.is_empty()
    }

    pub fn merge(&mut self, other: &Self) {
        merge_unique(&mut self.tools, &other.tools);
        merge_unique(&mut self.paths, &other.paths);
        merge_unique(&mut self.commands, &other.commands);
    }
}

pub fn parse_rules(value: &Value) -> Result<PermissionDenyRules, String> {
    if value.is_null() {
        return Ok(PermissionDenyRules::default());
    }
    let object = value
        .as_object()
        .ok_or_else(|| "permissionDeny must be an object".to_string())?;
    for key in object.keys() {
        if !matches!(key.as_str(), "tools" | "paths" | "commands") {
            return Err(format!("permissionDeny.{key} is not supported"));
        }
    }
    let rules = PermissionDenyRules {
        tools: string_list(object.get("tools"), "tools")?,
        paths: string_list(object.get("paths"), "paths")?,
        commands: string_list(object.get("commands"), "commands")?,
    };
    validate_rules(&rules)?;
    Ok(rules)
}

pub fn validate_rules(rules: &PermissionDenyRules) -> Result<(), String> {
    validate_list("tools", &rules.tools, compile_tool_glob)?;
    validate_list("paths", &rules.paths, compile_path_glob)?;
    validate_list("commands", &rules.commands, compile_command_glob)?;
    Ok(())
}

pub fn merge_from_settings_and_plugins(
    settings: Option<&Value>,
    plugin_rules: impl IntoIterator<Item = PermissionDenyRules>,
) -> PermissionDenyRules {
    let mut merged = PermissionDenyRules::default();
    if let Some(value) = settings.and_then(|settings| settings.get("permissionDeny")) {
        if let Ok(user) = parse_rules(value) {
            merged.merge(&user);
        }
    }
    for rules in plugin_rules {
        merged.merge(&rules);
    }
    merged
}

pub fn matches_deny(
    rules: &PermissionDenyRules,
    tool_name: &str,
    args: &Value,
) -> Option<DenyHit> {
    if rules.is_empty() {
        return None;
    }
    for pattern in &rules.tools {
        if tool_matches(pattern, tool_name) {
            return Some(DenyHit {
                kind: "tool",
                pattern: pattern.clone(),
            });
        }
    }
    if !rules.paths.is_empty() {
        for path in path_args(args) {
            for pattern in &rules.paths {
                if path_matches(pattern, path) {
                    return Some(DenyHit {
                        kind: "path",
                        pattern: pattern.clone(),
                    });
                }
            }
        }
    }
    if tool_name == "Bash" && !rules.commands.is_empty() {
        if let Some(command) = args.get("command").and_then(Value::as_str) {
            for pattern in &rules.commands {
                if command_matches(pattern, command) {
                    return Some(DenyHit {
                        kind: "command",
                        pattern: pattern.clone(),
                    });
                }
            }
        }
    }
    None
}

fn string_list(value: Option<&Value>, field: &str) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let items = value
        .as_array()
        .ok_or_else(|| format!("permissionDeny.{field} must be an array"))?;
    if items.len() > MAX_RULES_PER_LIST {
        return Err(format!(
            "permissionDeny.{field} allows at most {MAX_RULES_PER_LIST} entries"
        ));
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let raw = item
            .as_str()
            .ok_or_else(|| format!("permissionDeny.{field} entries must be strings"))?;
        let pattern = raw.trim();
        if pattern.is_empty() {
            return Err(format!(
                "permissionDeny.{field} entries must be non-empty strings"
            ));
        }
        if pattern.chars().count() > MAX_PATTERN_CHARS {
            return Err(format!(
                "permissionDeny.{field} entries must be at most {MAX_PATTERN_CHARS} characters"
            ));
        }
        if !out.iter().any(|existing| existing == pattern) {
            out.push(pattern.to_string());
        }
    }
    Ok(out)
}

fn validate_list(
    field: &str,
    patterns: &[String],
    compile: fn(&str) -> Result<GlobMatcher, String>,
) -> Result<(), String> {
    if patterns.len() > MAX_RULES_PER_LIST {
        return Err(format!(
            "permissionDeny.{field} allows at most {MAX_RULES_PER_LIST} entries"
        ));
    }
    for pattern in patterns {
        compile(pattern).map_err(|error| format!("permissionDeny.{field}: {error}"))?;
    }
    Ok(())
}

fn merge_unique(target: &mut Vec<String>, extra: &[String]) {
    for pattern in extra {
        if !target.iter().any(|existing| existing == pattern) {
            target.push(pattern.clone());
        }
    }
}

fn path_args(args: &Value) -> Vec<&str> {
    PATH_ARG_KEYS
        .iter()
        .filter_map(|key| args.get(*key).and_then(Value::as_str))
        .filter(|path| !path.is_empty())
        .collect()
}

fn tool_matches(pattern: &str, tool_name: &str) -> bool {
    compile_tool_glob(pattern)
        .map(|matcher| matcher.is_match(tool_name))
        .unwrap_or(false)
}

fn path_matches(pattern: &str, path: &str) -> bool {
    let Ok(matcher) = compile_path_glob(pattern) else {
        return false;
    };
    let normalized = normalize_path(path);
    let expanded = expand_tilde(&normalized);
    if matcher.is_match(&normalized) || matcher.is_match(&expanded) {
        return true;
    }
    if let Some(name) = file_name(&normalized) {
        if matcher.is_match(name) {
            return true;
        }
    }
    false
}

fn command_matches(pattern: &str, command: &str) -> bool {
    if compile_command_glob(pattern)
        .map(|matcher| matcher.is_match(command))
        .unwrap_or(false)
    {
        return true;
    }
    if !has_glob_meta(pattern) {
        return command_prefix_matches(pattern, command);
    }
    false
}

fn command_prefix_matches(pattern: &str, command: &str) -> bool {
    let needle = pattern.trim();
    let haystack = command.trim();
    if cfg!(windows) {
        let needle = needle.to_ascii_lowercase();
        let haystack = haystack.to_ascii_lowercase();
        return haystack == needle
            || haystack
                .strip_prefix(&needle)
                .is_some_and(|rest| rest.starts_with(char::is_whitespace));
    }
    haystack == needle
        || haystack
            .strip_prefix(needle)
            .is_some_and(|rest| rest.starts_with(char::is_whitespace))
}

fn compile_tool_glob(pattern: &str) -> Result<GlobMatcher, String> {
    build_glob(pattern, true, false)
}

fn compile_path_glob(pattern: &str) -> Result<GlobMatcher, String> {
    build_glob(&expand_tilde(&normalize_path(pattern)), true, cfg!(windows))
}

fn compile_command_glob(pattern: &str) -> Result<GlobMatcher, String> {
    build_glob(pattern, false, cfg!(windows))
}

fn build_glob(
    pattern: &str,
    literal_separator: bool,
    case_insensitive: bool,
) -> Result<GlobMatcher, String> {
    GlobBuilder::new(pattern)
        .literal_separator(literal_separator)
        .case_insensitive(case_insensitive)
        .backslash_escape(false)
        .build()
        .map(|glob| glob.compile_matcher())
        .map_err(|error| error.to_string())
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

fn expand_tilde(path: &str) -> String {
    if path == "~" {
        return home_prefix();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        let home = home_prefix();
        if home.is_empty() {
            return path.to_string();
        }
        return format!("{home}/{rest}");
    }
    path.to_string()
}

fn home_prefix() -> String {
    dirs::home_dir()
        .map(|home| normalize_path(&home.to_string_lossy()))
        .unwrap_or_default()
}

fn file_name(path: &str) -> Option<&str> {
    path.rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
}

fn has_glob_meta(pattern: &str) -> bool {
    pattern.contains('*') || pattern.contains('?') || pattern.contains('[')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rules(tools: &[&str], paths: &[&str], commands: &[&str]) -> PermissionDenyRules {
        PermissionDenyRules {
            tools: tools.iter().map(|s| (*s).to_string()).collect(),
            paths: paths.iter().map(|s| (*s).to_string()).collect(),
            commands: commands.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    #[test]
    fn parse_rejects_unknown_keys_and_bad_lists() {
        assert!(parse_rules(&json!({ "allow": ["Bash"] })).is_err());
        assert!(parse_rules(&json!({ "tools": "Bash" })).is_err());
        assert!(parse_rules(&json!({ "tools": [""] })).is_err());
        assert!(parse_rules(&json!({ "tools": [1] })).is_err());
        assert!(parse_rules(&json!({ "paths": ["["] })).is_err());
    }

    #[test]
    fn parse_trims_and_dedupes() {
        let parsed = parse_rules(&json!({ "tools": [" Bash ", "Bash", "Read"] })).unwrap();
        assert_eq!(parsed.tools, vec!["Bash", "Read"]);
    }

    #[test]
    fn tool_glob_matches_plugin_prefix() {
        let deny = rules(&["plugin_*", "Bash"], &[], &[]);
        assert!(matches_deny(&deny, "plugin_x_run", &json!({})).is_some());
        assert!(matches_deny(&deny, "Bash", &json!({})).is_some());
        assert!(matches_deny(&deny, "Read", &json!({})).is_none());
    }

    #[test]
    fn path_glob_matches_env_and_ssh() {
        let deny = rules(&[], &["**/.env", "~/.ssh/**", ".env"], &[]);
        assert!(matches_deny(
            &deny,
            "Read",
            &json!({ "path": "C:/repo/.env" })
        )
        .is_some());
        assert!(matches_deny(&deny, "Write", &json!({ "path": "/tmp/.env" })).is_some());
        assert!(matches_deny(&deny, "Read", &json!({ "path": "README.md" })).is_none());

        let home = dirs::home_dir().unwrap();
        let ssh = home.join(".ssh").join("id_rsa");
        assert!(matches_deny(
            &deny,
            "Read",
            &json!({ "path": ssh.to_string_lossy() })
        )
        .is_some());
    }

    #[test]
    fn path_rules_see_file_path_alias() {
        let deny = rules(&[], &["**/*.pem"], &[]);
        assert!(matches_deny(
            &deny,
            "plugin_vault_read",
            &json!({ "file_path": "certs/prod.pem" })
        )
        .is_some());
    }

    #[test]
    fn command_glob_and_prefix_match() {
        let deny = rules(&[], &[], &["rm -rf *", "git push --force"]);
        assert!(matches_deny(
            &deny,
            "Bash",
            &json!({ "command": "rm -rf /tmp/foo" })
        )
        .is_some());
        assert!(matches_deny(
            &deny,
            "Bash",
            &json!({ "command": "git push --force origin main" })
        )
        .is_some());
        assert!(matches_deny(&deny, "Bash", &json!({ "command": "git status" })).is_none());
        assert!(matches_deny(
            &deny,
            "Read",
            &json!({ "command": "rm -rf /tmp/foo" })
        )
        .is_none());
    }

    #[cfg(windows)]
    #[test]
    fn command_prefix_is_case_insensitive_on_windows() {
        let deny = rules(&[], &[], &["git push --force"]);
        assert!(matches_deny(
            &deny,
            "Bash",
            &json!({ "command": "GIT PUSH --FORCE origin main" })
        )
        .is_some());
    }

    #[test]
    fn merge_unions_without_duplicates() {
        let mut user = rules(&["Bash"], &["**/.env"], &[]);
        user.merge(&rules(&["Bash", "Write"], &["~/.ssh/**"], &["curl *"]));
        assert_eq!(user.tools, vec!["Bash", "Write"]);
        assert_eq!(user.paths, vec!["**/.env", "~/.ssh/**"]);
        assert_eq!(user.commands, vec!["curl *"]);
    }

    #[test]
    fn merge_from_settings_then_plugins() {
        let settings = json!({
            "permissionDeny": { "tools": ["Bash"], "paths": ["**/.env"] }
        });
        let plugin = rules(&["Write"], &["**/.env"], &["rm -rf *"]);
        let merged = merge_from_settings_and_plugins(Some(&settings), [plugin]);
        assert_eq!(merged.tools, vec!["Bash", "Write"]);
        assert_eq!(merged.paths, vec!["**/.env"]);
        assert_eq!(merged.commands, vec!["rm -rf *"]);
    }

    #[test]
    fn invalid_settings_are_skipped_not_fatal() {
        let settings = json!({ "permissionDeny": { "allow": ["Bash"] } });
        let merged = merge_from_settings_and_plugins(Some(&settings), []);
        assert!(merged.is_empty());
    }

    #[test]
    fn empty_object_is_valid() {
        assert_eq!(parse_rules(&json!({})).unwrap(), PermissionDenyRules::default());
        assert_eq!(parse_rules(&json!(null)).unwrap(), PermissionDenyRules::default());
    }
}
