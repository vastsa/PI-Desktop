use crate::activation::ActivationScope;
use anyhow::{Context, Result};
use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

/// App-local visibility, separate from portable definitions and enablement.
/// Older applications leave this file untouched when changing enablement.
pub(super) struct ProjectScopes {
    path: PathBuf,
}

impl ProjectScopes {
    pub fn new(data_dir: &std::path::Path) -> Self {
        Self {
            path: data_dir.join("agent-capabilities/subagent-scopes.json"),
        }
    }

    pub fn read(&self) -> Result<BTreeMap<String, ActivationScope>> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).context("read subagent project scopes"),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(error) => Err(error).context("read subagent project scopes"),
        }
    }

    pub fn set(&self, id: &str, scope: Option<&ActivationScope>) -> Result<()> {
        let mut scopes = self.read()?;
        match scope {
            Some(scope) => {
                scopes.insert(id.to_string(), scope.normalized());
            }
            None => {
                scopes.remove(id);
            }
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = self
            .path
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&temporary, serde_json::to_vec_pretty(&scopes)?)?;
        if let Err(error) = fs::rename(&temporary, &self.path) {
            let _ = fs::remove_file(&temporary);
            return Err(error).context("save subagent project scopes");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_state_defaults_but_invalid_state_fails_closed() {
        let data = tempfile::tempdir().unwrap();
        let scopes = ProjectScopes::new(data.path());
        assert!(scopes.read().unwrap().is_empty());
        scopes
            .set("reviewer", Some(&ActivationScope::default()))
            .unwrap();
        scopes.set("reviewer", None).unwrap();
        assert!(scopes.read().unwrap().is_empty());
        fs::write(&scopes.path, b"invalid JSON").unwrap();
        assert!(scopes.read().is_err());
        assert!(scopes
            .set("reviewer", Some(&ActivationScope::default()))
            .is_err());
    }
}
