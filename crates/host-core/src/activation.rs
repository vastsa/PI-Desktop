use serde::{Deserialize, Serialize};

/// Where an extension is allowed to run.
///
/// Plugins, user MCP servers and user skills all carry one of these next to an
/// `enabled` flag, so "off / these projects / everywhere" is a single decision
/// with a single serialized shape. The TypeScript mirror — including the path
/// matching rules this module reimplements — lives in
/// `packages/shared/src/activation.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationScope {
    pub mode: ActivationMode,
    /// Absolute project paths, only consulted in `Projects` mode. Kept when the
    /// mode changes so switching back restores the previous selection.
    #[serde(default)]
    pub projects: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivationMode {
    Global,
    Projects,
}

impl Default for ActivationScope {
    fn default() -> Self {
        Self {
            mode: ActivationMode::Global,
            projects: Vec::new(),
        }
    }
}

impl ActivationScope {
    /// Canonicalize on the way in: normalized paths, no blanks, no duplicates.
    pub fn normalized(&self) -> Self {
        let mut projects: Vec<String> = Vec::new();
        for raw in &self.projects {
            let path = normalize_project_path(raw);
            if path.is_empty() {
                continue;
            }
            if projects.iter().any(|existing| same_path(existing, &path)) {
                continue;
            }
            projects.push(path);
        }
        Self {
            mode: self.mode,
            projects,
        }
    }

    /// Whether an enabled extension with this scope applies to `project_path`.
    ///
    /// A project-scoped extension stays inactive in a session with no project:
    /// "these projects" is a claim about projects, and no workspace is not one.
    #[allow(dead_code)]
    pub fn matches(&self, project_path: Option<&str>) -> bool {
        match self.mode {
            ActivationMode::Global => true,
            ActivationMode::Projects => {
                let Some(target) = project_path.map(normalize_project_path) else {
                    return false;
                };
                if target.is_empty() {
                    return false;
                }
                self.projects
                    .iter()
                    .any(|entry| project_path_matches(entry, &target))
            }
        }
    }
}

/// Storage spelling of a project path: forward slashes, no trailing separator.
/// Mirrors `normalize_project_path` in `db.rs` so scope entries compare equal to
/// the `projects` table.
pub fn normalize_project_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let mut normalized = trimmed.replace('\\', "/");
    while normalized.len() > 1
        && normalized.ends_with('/')
        && !normalized
            .strip_suffix('/')
            .is_some_and(|prefix| prefix.ends_with(':'))
    {
        normalized.pop();
    }
    normalized
}

/// Case-insensitive path comparison: macOS and Windows both hand us
/// case-varying spellings of one directory, and a scope that silently stops
/// matching because of capitalization reads as a bug.
fn same_path(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// True when `target` is the scoped directory or sits underneath it, so scoping
/// to a monorepo root covers sessions opened on a package inside it.
#[allow(dead_code)]
pub fn project_path_matches(entry: &str, target: &str) -> bool {
    let scoped = normalize_project_path(entry);
    let target = normalize_project_path(target);
    if scoped.is_empty() || target.is_empty() {
        return false;
    }
    if same_path(&scoped, &target) {
        return true;
    }
    let prefix = if scoped.ends_with('/') {
        scoped
    } else {
        format!("{scoped}/")
    };
    target.len() > prefix.len() && same_path(&target[..prefix.len()], &prefix)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn projects(paths: &[&str]) -> ActivationScope {
        ActivationScope {
            mode: ActivationMode::Projects,
            projects: paths.iter().map(|p| p.to_string()).collect(),
        }
    }

    #[test]
    fn global_matches_every_session_including_one_without_a_project() {
        let scope = ActivationScope::default();
        assert!(scope.matches(Some("/repo")));
        assert!(scope.matches(None));
    }

    #[test]
    fn project_scope_matches_the_directory_and_its_children() {
        let scope = projects(&["/repo"]);
        assert!(scope.matches(Some("/repo")));
        assert!(scope.matches(Some("/repo/apps/web")));
        assert!(!scope.matches(Some("/repo-other")));
        assert!(!scope.matches(None));
    }

    #[test]
    fn project_scope_ignores_case_and_trailing_separators() {
        let scope = projects(&["/Users/me/App/"]);
        assert!(scope.matches(Some("/users/me/app")));
    }

    #[test]
    fn empty_project_list_matches_nothing() {
        assert!(!projects(&[]).matches(Some("/repo")));
    }

    #[test]
    fn normalized_drops_blanks_and_duplicates() {
        let scope = projects(&["/repo/", "/REPO", "  ", "/other"]).normalized();
        assert_eq!(scope.projects, vec!["/repo".to_string(), "/other".to_string()]);
    }

    #[test]
    fn missing_scope_deserializes_as_global() {
        let scope: ActivationScope = serde_json::from_str(r#"{"mode":"global"}"#).unwrap();
        assert_eq!(scope, ActivationScope::default());
    }

    #[test]
    fn windows_drive_root_survives_normalization() {
        assert_eq!(normalize_project_path("C:\\"), "C:/");
        assert_eq!(normalize_project_path("C:\\work\\app\\"), "C:/work/app");
    }
}
