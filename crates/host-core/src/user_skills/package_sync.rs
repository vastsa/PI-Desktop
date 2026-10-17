//! Compare-and-replace of approved skill resources. Validate the entire change
//! before writing, retain unrelated files, and permit journal replay.
use super::*;
use std::collections::BTreeMap;

fn checked_files(files: &[(String, Vec<u8>)]) -> Result<BTreeMap<&str, &[u8]>> {
    if files.len() > MAX_SKILL_PACKAGE_FILES {
        bail!("SKILL_LIMIT_EXCEEDED: skill package contains too many files");
    }
    let mut total = 0usize;
    let mut result = BTreeMap::new();
    for (path, bytes) in files {
        total = total
            .checked_add(bytes.len())
            .ok_or_else(|| anyhow::anyhow!("SKILL_LIMIT_EXCEEDED: skill package is too large"))?;
        if total > MAX_SKILL_PACKAGE_BYTES || bytes.len() > MAX_SKILL_RESOURCE_BYTES {
            bail!("SKILL_LIMIT_EXCEEDED: skill package resource or total is too large");
        }
        if result.insert(path.as_str(), bytes.as_slice()).is_some() {
            bail!("SKILL_INVALID: skill package contains duplicate paths");
        }
    }
    Ok(result)
}

fn read_current(root: &Path, target: &Path) -> Result<Option<Vec<u8>>> {
    ensure_no_symlink_path(root, target)?;
    match fs::symlink_metadata(target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                bail!("SKILL_INVALID: skill package destination is unsafe");
            }
            if metadata.len() > MAX_SKILL_RESOURCE_BYTES as u64 {
                bail!("SKILL_LIMIT_EXCEEDED: existing skill resource is too large");
            }
            Ok(Some(fs::read(target)?))
        }
    }
}

impl UserSkillRegistry {
    /// Update only files whose bytes still match the observed local version or
    /// the desired version (an interrupted import replay). Unlisted files stay.
    pub(crate) fn replace_package_files(
        &mut self,
        id: &str,
        level: CapabilityLevel,
        project_path: Option<&str>,
        expected: &[(String, Vec<u8>)],
        files: &[(String, Vec<u8>)],
    ) -> Result<()> {
        let expected = checked_files(expected)?;
        let desired = checked_files(files)?;
        if expected.is_empty() && desired.is_empty() {
            return Ok(());
        }
        let record = self
            .find(id, Some(level), project_path)?
            .ok_or_else(|| anyhow::anyhow!("SKILL_INVALID: skill package target was not found"))?;
        let root = package_root(&record, level, project_path)?.ok_or_else(|| {
            anyhow::anyhow!("SKILL_INVALID: package resources require a directory-shaped skill")
        })?;
        let metadata = fs::symlink_metadata(&root)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            bail!("SKILL_INVALID: skill package root is unsafe");
        }
        let paths = expected
            .keys()
            .chain(desired.keys())
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        let mut changes = Vec::new();
        for path in paths {
            let target = package_destination(&root, path)?;
            let current = read_current(&root, &target)?;
            let next = desired.get(path).copied();
            if current.as_deref() == next {
                continue;
            }
            if current.as_deref() != expected.get(path).copied() {
                bail!("CONFIG_SYNC_CONFLICT: skill package resource was edited locally");
            }
            changes.push((target, current, next));
        }
        for (target, expected, next) in changes {
            if read_current(&root, &target)? != expected {
                bail!("CONFIG_SYNC_CONFLICT: skill package resource changed during import");
            }
            if let Some(bytes) = next {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                    ensure_no_symlink_path(&root, parent)?;
                }
                let temporary = target.with_file_name(format!(".resource-{}.tmp", Uuid::new_v4()));
                let result = (|| -> Result<()> {
                    fs::write(&temporary, bytes)?;
                    ensure_no_symlink_path(&root, &target)?;
                    if read_current(&root, &target)? != expected {
                        bail!("CONFIG_SYNC_CONFLICT: skill package resource changed during import");
                    }
                    fs::rename(&temporary, &target)?;
                    Ok(())
                })();
                if result.is_err() && temporary.exists() {
                    fs::remove_file(&temporary)?;
                }
                result?;
            } else {
                fs::remove_file(&target)?;
            }
        }
        Ok(())
    }
}
