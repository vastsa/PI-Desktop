//! Deny-first permission rules (ADR 0267 / D433).
//!
//! User settings and enabled plugins contribute glob lists for tools, paths,
//! and Bash commands. A match is `PermissionDecision::Deny` and outranks auto,
//! session grants, low-risk auto-allow, and accept-edits. Plugins can only
//! add rules; they cannot remove user rules or introduce an allow list.

use globset::{GlobBuilder, GlobMatcher};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const MAX_RULES_PER_LIST: usize = 256;
pub const MAX_PATTERN_CHARS: usize = 512;

const PATH_ARG_KEYS: &[&str] = &["path", "file_path", "moved_to"];

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
        match parse_rules(value) {
            Ok(user) => merged.merge(&user),
            Err(error) => {
                tracing::warn!(%error, "skipping invalid AppSettings.permissionDeny");
            }
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
    matches_deny_in(rules, tool_name, args, None)
}

/// Same as [`matches_deny`], but path globs also see the trimmed, lexically
/// resolved, and execution-equivalent form of `path` / `file_path` against
/// `path_root`. Relative `../`, `~`, and dangling symlinks therefore hit the
/// same rules as the path `resolve_external_path` would write. `~` expands
/// via the user home, not `path_root`.
pub fn matches_deny_in(
    rules: &PermissionDenyRules,
    tool_name: &str,
    args: &Value,
    path_root: Option<&Path>,
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
                if path_matches(pattern, &path, path_root) {
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

fn path_args(args: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |value: &str| {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !out.iter().any(|existing| existing == trimmed) {
            out.push(trimmed.to_string());
        }
    };
    for key in PATH_ARG_KEYS {
        if let Some(value) = args.get(*key).and_then(Value::as_str) {
            push(value);
        }
    }
    if let Some(ops) = args.get("ops").and_then(Value::as_str) {
        if let Some(dest) = crate::tools::hashline::mv_dest_from_ops(ops) {
            push(&dest);
        }
    }
    out
}

fn tool_matches(pattern: &str, tool_name: &str) -> bool {
    compile_tool_glob(pattern)
        .map(|matcher| matcher.is_match(tool_name))
        .unwrap_or(false)
}

fn path_matches(pattern: &str, path: &str, path_root: Option<&Path>) -> bool {
    let Ok(matcher) = compile_path_glob(pattern) else {
        return false;
    };
    let candidates = path_match_candidates(path, path_root);
    if candidates
        .iter()
        .any(|candidate| matcher.is_match(candidate))
    {
        return true;
    }
    // `**/.env` and `**/.env.*` must still deny a bare `.env` / `.env.local`
    // argument. globset can treat `**` as requiring a directory, so also
    // match the file name against the last glob component.
    matches_double_star_basename(pattern, &candidates)
}

fn matches_double_star_basename(pattern: &str, candidates: &[String]) -> bool {
    let normalized = normalize_path(pattern);
    let Some(rest) = normalized.strip_prefix("**/") else {
        return false;
    };
    if rest.is_empty() || rest.contains('/') {
        return false;
    }
    let Ok(matcher) = compile_path_glob(rest) else {
        return false;
    };
    candidates
        .iter()
        .filter_map(|candidate| file_name(candidate))
        .any(|name| matcher.is_match(name))
}

fn path_match_candidates(raw: &str, path_root: Option<&Path>) -> Vec<String> {
    let raw = raw.trim();
    let mut out = Vec::new();
    let mut push = |value: String| {
        if value.is_empty() {
            return;
        }
        if !out.iter().any(|existing| existing == &value) {
            out.push(value);
        }
    };

    let normalized = normalize_path(raw);
    push(normalized.clone());
    let expanded = expand_tilde(&normalized);
    push(expanded.clone());
    #[cfg(windows)]
    {
        push(msys_to_windows(&normalized));
        push(msys_to_windows(&expanded));
    }
    if let Some(name) = file_name(&normalized) {
        push(name.to_string());
    }

    if let Some(lexical) = lexical_absolute(&expanded, path_root) {
        let lexical_norm = normalize_path(&lexical.to_string_lossy());
        push(lexical_norm.clone());
        #[cfg(windows)]
        {
            push(msys_to_windows(&lexical_norm));
        }
        if let Some(name) = file_name(&lexical_norm) {
            push(name.to_string());
        }
    }

    if let Some(root) = path_root {
        let mut inputs = vec![raw.to_string()];
        if expanded != inputs[0] {
            inputs.push(expanded);
        }
        #[cfg(windows)]
        {
            let coerced = msys_to_windows(&inputs[0]);
            if !inputs.iter().any(|existing| existing == &coerced) {
                inputs.push(coerced);
            }
        }
        for input in inputs {
            if let Ok(resolved) = crate::workspace::resolve_external_path(root, &input) {
                let resolved_norm = normalize_path(&resolved.to_string_lossy());
                push(resolved_norm.clone());
                #[cfg(windows)]
                {
                    push(msys_to_windows(&resolved_norm));
                }
                if let Some(name) = file_name(&resolved_norm) {
                    push(name.to_string());
                }
            }
        }
    }
    out
}

fn lexical_absolute(input: &str, path_root: Option<&Path>) -> Option<PathBuf> {
    let mut expanded = expand_tilde(&normalize_path(input));
    #[cfg(windows)]
    {
        let coerced = msys_to_windows(&expanded);
        if Path::new(&coerced).is_absolute() {
            expanded = coerced;
        }
    }
    let path = Path::new(&expanded);
    if path.is_absolute() {
        return Some(crate::workspace::normalize_lexical(path));
    }
    let root = path_root?;
    Some(crate::workspace::normalize_lexical(&root.join(path)))
}

#[cfg(windows)]
fn msys_to_windows(path: &str) -> String {
    let rest = match path.strip_prefix('/') {
        Some(rest) if !rest.starts_with('/') => rest,
        _ => return path.to_string(),
    };
    let mut chars = rest.chars();
    let Some(drive) = chars.next() else {
        return path.to_string();
    };
    if !drive.is_ascii_alphabetic() {
        return path.to_string();
    }
    match chars.next() {
        None => format!("{}:", drive.to_ascii_uppercase()),
        Some('/') => format!("{}:/{}", drive.to_ascii_uppercase(), chars.as_str()),
        _ => path.to_string(),
    }
}

fn command_matches(pattern: &str, command: &str) -> bool {
    let command = command.trim();
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
    let mut prepared = expand_tilde(&normalize_path(pattern));
    #[cfg(windows)]
    {
        prepared = msys_to_windows(&prepared);
    }
    build_glob(&prepared, true, cfg!(windows))
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
    strip_windows_extended_prefix(&path.replace('\\', "/"))
}

fn strip_windows_extended_prefix(path: &str) -> String {
    let Some(rest) = path.strip_prefix("//?/") else {
        return path.to_string();
    };
    if rest.len() >= 2 && rest.as_bytes().get(1) == Some(&b':') {
        return rest.to_string();
    }
    if let Some(unc) = rest.strip_prefix("UNC/") {
        return format!("//{unc}");
    }
    path.to_string()
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
        let deny = rules(
            &[],
            &[
                "**/.env",
                "~/pi-deny-rules-nonexistent-ssh-dir/**",
                ".env",
            ],
            &[],
        );
        assert!(matches_deny(
            &deny,
            "Read",
            &json!({ "path": "C:/repo/.env" })
        )
        .is_some());
        assert!(matches_deny(&deny, "Write", &json!({ "path": "/tmp/.env" })).is_some());
        assert!(matches_deny(&deny, "Read", &json!({ "path": "README.md" })).is_none());

        let home = dirs::home_dir().unwrap();
        let ssh = home.join("pi-deny-rules-nonexistent-ssh-dir").join("id_rsa");
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

    #[test]
    fn path_glob_star_env_matches_bare_env() {
        let deny = rules(&[], &["**/.env"], &[]);
        assert!(matches_deny(&deny, "Read", &json!({ "path": ".env" })).is_some());
        assert!(matches_deny(&deny, "Read", &json!({ "path": "C:/repo/.env" })).is_some());
        let env_star = rules(&[], &["**/.env.*"], &[]);
        assert!(matches_deny(&env_star, "Read", &json!({ "path": ".env.local" })).is_some());
    }

    #[test]
    fn path_glob_matches_parent_relative_against_root() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("project");
        std::fs::create_dir_all(&workspace).unwrap();
        let hidden = dir.path().join("deny-hidden-dir");
        std::fs::create_dir_all(&hidden).unwrap();
        std::fs::write(hidden.join("secret.txt"), "secret").unwrap();
        let deny = rules(&[], &["**/deny-hidden-dir/**"], &[]);
        let args = json!({ "path": "../deny-hidden-dir/secret.txt" });
        assert!(matches_deny(&deny, "Read", &args).is_none());
        assert!(matches_deny_in(&deny, "Read", &args, Some(workspace.as_path())).is_some());
        let padded = json!({ "path": "  ../deny-hidden-dir/secret.txt" });
        assert!(matches_deny_in(&deny, "Grep", &padded, Some(workspace.as_path())).is_some());
    }

    #[cfg(unix)]
    #[test]
    fn path_glob_follows_dangling_symlink_against_root() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("project");
        std::fs::create_dir_all(&workspace).unwrap();
        let hidden = dir.path().join("deny-hidden-dir");
        std::fs::create_dir_all(&hidden).unwrap();
        let target = hidden.join("secret.txt");
        std::os::unix::fs::symlink(&target, workspace.join("link")).unwrap();
        let deny = rules(&[], &["**/deny-hidden-dir/**"], &[]);
        let args = json!({ "path": "link" });
        assert!(
            matches_deny_in(&deny, "Write", &args, Some(workspace.as_path())).is_some(),
            "dangling symlink Write must hit the resolved target glob"
        );
    }

    #[test]
    fn path_glob_matches_edit_mv_dest() {
        let deny = rules(&[], &["**/.env"], &[]);
        let args = json!({
            "path": "readme.md",
            "ops": "[readme.md#AB12]\nMV .env\n"
        });
        assert!(matches_deny(&deny, "Edit", &args).is_some());
        let tabbed = json!({
            "path": "readme.md",
            "ops": "[readme.md#AB12]\nMV\t.env\n"
        });
        assert!(matches_deny(&deny, "Edit", &tabbed).is_some());
        let quoted = json!({
            "path": "readme.md",
            "ops": "[readme.md#AB12]\nMV '.env'\n"
        });
        assert!(matches_deny(&deny, "Edit", &quoted).is_some());
    }

    #[test]
    fn command_glob_trims_leading_whitespace() {
        let deny = rules(&[], &[], &["echo DENY_GLOB_TRIM *"]);
        assert!(matches_deny(
            &deny,
            "Bash",
            &json!({ "command": "  echo DENY_GLOB_TRIM pwned" }),
        )
        .is_some());
    }

    #[cfg(windows)]
    #[test]
    fn path_glob_matches_msys_drive_spelling() {
        let deny = rules(&[], &["C:/Users/foo/.ssh/**"], &[]);
        assert!(matches_deny(
            &deny,
            "Read",
            &json!({ "path": "/c/Users/foo/.ssh/config" }),
        )
        .is_some());
        assert!(matches_deny(
            &deny,
            "Write",
            &json!({ "path": r"\\?\C:\Users\foo\.ssh\new_key" }),
        )
        .is_some());
    }
}
