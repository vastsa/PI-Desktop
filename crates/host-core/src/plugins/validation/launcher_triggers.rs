use anyhow::{anyhow, bail, Result};
use serde_json::{Map, Value};

use super::composer_transforms::is_plugin_label;
use super::{array_of, is_contrib_id, require_permission, PluginManifest};

/// Mirrors `contributes.launcherTriggers` in the plugin SDK: at most eight
/// triggers per plugin, a 200-character pattern, a 120-character label and the
/// `i` / `s` / `m` / `u` flags the renderer accepts.
const MAX_LAUNCHER_TRIGGERS_PER_PLUGIN: usize = 8;
const LAUNCHER_PATTERN_MAX_CHARS: usize = 200;
const LAUNCHER_TITLE_MAX_CHARS: usize = 120;
const LAUNCHER_TRIGGER_FLAGS: [char; 4] = ['i', 's', 'm', 'u'];

pub(super) fn validate(map: &Map<String, Value>, manifest: &PluginManifest) -> Result<()> {
    let Some(triggers) = map.get("launcherTriggers") else {
        return Ok(());
    };
    let entries = array_of(triggers, "contributes.launcherTriggers")?;
    if entries.len() > MAX_LAUNCHER_TRIGGERS_PER_PLUGIN {
        bail!("PLUGIN_INVALID: contributes.launcherTriggers allows at most 8 entries");
    }
    // A trigger opens this plugin's panel, so a declaration without `ui.panel`
    // would be a match the launcher could never act on.
    if !entries.is_empty() {
        require_permission(manifest, "ui.panel", "launcher triggers")?;
    }

    let mut seen: Vec<&str> = Vec::new();
    for entry in entries {
        let obj = entry.as_object().ok_or_else(|| {
            anyhow!("PLUGIN_INVALID: contributes.launcherTriggers entry must be an object")
        })?;
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| is_contrib_id(id))
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: launcher trigger id is missing or invalid"))?;
        if seen.contains(&id) {
            bail!("PLUGIN_INVALID: duplicate launcher trigger id {id}");
        }
        seen.push(id);
        let pattern = obj
            .get("pattern")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: launcher trigger {id} requires a pattern"))?;
        if let Some(problem) = pattern_problem(pattern) {
            bail!("PLUGIN_INVALID: launcher trigger {id} pattern {problem}");
        }
        if let Some(flags) = obj.get("flags") {
            let flags = flags
                .as_str()
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: launcher trigger {id} flags is invalid"))?;
            if !is_trigger_flags(flags) {
                bail!("PLUGIN_INVALID: launcher trigger {id} flags is invalid");
            }
        }
        if let Some(title) = obj.get("title") {
            if !is_trigger_title(title) {
                bail!("PLUGIN_INVALID: launcher trigger {id} has an invalid title");
            }
        }
    }
    Ok(())
}

/// Why a declared trigger pattern is refused, or `None` when it is safe.
///
/// The renderer compiles the pattern and runs it against every keystroke, so a
/// pattern that can backtrack catastrophically would freeze the panel. The scan
/// is deliberately conservative: it refuses a quantifier applied to a group
/// whose body already contains a quantifier or an alternation, because branch
/// ambiguity inside a repeated group is what produces exponential
/// backtracking. The host does not compile the pattern — Rust `regex` syntax
/// and JavaScript syntax differ, and all that is needed here is a proof that
/// the declaration cannot blow up.
fn pattern_problem(pattern: &str) -> Option<&'static str> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Some("is empty");
    }
    if trimmed.chars().count() > LAUNCHER_PATTERN_MAX_CHARS {
        return Some("is longer than 200 characters");
    }

    let chars: Vec<char> = pattern.chars().collect();
    // One flag per open group: does the body already contain a quantifier or an
    // alternation? A group that does may not itself be repeated. The bottom
    // frame is the whole pattern, which nothing quantifies.
    let mut open_groups: Vec<bool> = vec![false];
    let mut in_class = false;
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if ch == '\\' {
            if index + 1 >= chars.len() {
                return Some("ends with a dangling escape");
            }
            // An escaped bracket, parenthesis or quantifier is a literal atom.
            index += 2;
            continue;
        }
        if in_class {
            if ch == ']' {
                in_class = false;
            }
            index += 1;
            continue;
        }
        match ch {
            '[' => {
                in_class = true;
                index += 1;
            }
            '(' => {
                open_groups.push(false);
                index += 1;
                // `(?:`, `(?=` and `(?<name>` use `?` as a group modifier, not
                // as a quantifier over the open group.
                if chars.get(index) == Some(&'?') {
                    index += 1;
                }
            }
            ')' => {
                if open_groups.len() == 1 {
                    return Some("has unbalanced parentheses");
                }
                let body_risky = open_groups.pop().unwrap_or(false);
                index += 1;
                // The quantifier itself is handled on the next pass and marks
                // the enclosing frame.
                if quantifier_at(&chars, index) && body_risky {
                    return Some(
                        "nests a quantifier in a repeated group, which can backtrack catastrophically",
                    );
                }
            }
            '*' | '+' => {
                mark_risky(&mut open_groups);
                index += 1;
            }
            '?' => {
                // A `?` right after a quantifier is its lazy modifier, not a
                // second quantifier.
                let lazy = index > 0 && matches!(chars[index - 1], '*' | '+' | '?' | '}');
                if !lazy {
                    mark_risky(&mut open_groups);
                }
                index += 1;
            }
            '{' => match brace_quantifier_end(&chars, index) {
                Some(end) => {
                    mark_risky(&mut open_groups);
                    index = end;
                }
                None => index += 1,
            },
            '|' => {
                // Any alternation inside a group makes that group ambiguous, and
                // the scan cannot prove the branches are disjoint.
                mark_risky(&mut open_groups);
                index += 1;
            }
            _ => index += 1,
        }
    }
    if in_class {
        return Some("has unbalanced brackets");
    }
    if open_groups.len() > 1 {
        return Some("has unbalanced parentheses");
    }
    None
}

fn mark_risky(open_groups: &mut [bool]) {
    if let Some(frame) = open_groups.last_mut() {
        *frame = true;
    }
}

/// Whether a quantifier starts at `index`: `*`, `+`, `?` or `{n}` / `{n,}` /
/// `{n,m}`. A bare `{` is a literal in JavaScript, so it is not a quantifier.
fn quantifier_at(chars: &[char], index: usize) -> bool {
    match chars.get(index) {
        Some('*') | Some('+') | Some('?') => true,
        Some('{') => brace_quantifier_end(chars, index).is_some(),
        _ => false,
    }
}

/// End index (exclusive) of a brace quantifier starting at `index`.
fn brace_quantifier_end(chars: &[char], index: usize) -> Option<usize> {
    let mut cursor = index + 1;
    let mut digits = 0;
    while matches!(chars.get(cursor), Some(ch) if ch.is_ascii_digit()) {
        cursor += 1;
        digits += 1;
    }
    if digits == 0 {
        return None;
    }
    if chars.get(cursor) == Some(&',') {
        cursor += 1;
        while matches!(chars.get(cursor), Some(ch) if ch.is_ascii_digit()) {
            cursor += 1;
        }
    }
    (chars.get(cursor) == Some(&'}')).then_some(cursor + 1)
}

fn is_trigger_flags(flags: &str) -> bool {
    if flags.chars().count() > LAUNCHER_TRIGGER_FLAGS.len() {
        return false;
    }
    let mut seen: Vec<char> = Vec::new();
    for flag in flags.chars() {
        if !LAUNCHER_TRIGGER_FLAGS.contains(&flag) || seen.contains(&flag) {
            return false;
        }
        seen.push(flag);
    }
    true
}

/// A title is a plain string or both contract locales, as elsewhere in the
/// manifest, and the launcher keeps its labels shorter than the composer's.
fn is_trigger_title(value: &Value) -> bool {
    match value {
        Value::String(title) => fits_launcher_label(title),
        Value::Object(_) => {
            is_plugin_label(value)
                && ["en", "zh-CN"].iter().all(|locale| {
                    value
                        .get(*locale)
                        .and_then(Value::as_str)
                        .is_some_and(fits_launcher_label)
                })
        }
        _ => false,
    }
}

fn fits_launcher_label(label: &str) -> bool {
    let trimmed = label.trim();
    !trimmed.is_empty() && trimmed.chars().count() <= LAUNCHER_TITLE_MAX_CHARS
}
