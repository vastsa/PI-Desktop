//! Explicit user actions on one persisted file in a review round.
use super::*;
use crate::db::Database;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileRollbackOutcome {
    pub status: &'static str,
    pub changes: Vec<RollbackOutcome>,
}

/// Resolve only an exact native snapshot owned by this session. This is not a
/// general external-path resolver or a grant to read/write its parent directory.
pub(crate) fn file_target(
    db: &Database,
    session: &str,
    snapshot: &str,
    root: Option<&Path>,
) -> Result<Value> {
    let evidence = query::file_evidence(db, session, snapshot, root)?;
    if !evidence.iter().any(|change| change.snapshot_id == snapshot) {
        return Err(anyhow!("review snapshot is not in the session transcript"));
    }
    let meta = read_meta(db.data_dir(), session, snapshot)?;
    let path = Path::new(&meta.path);
    let expected = if path.is_absolute() {
        path.to_path_buf()
    } else {
        let captured = meta
            .root
            .as_deref()
            .ok_or_else(|| anyhow!("review execution root unavailable"))?;
        let captured = Path::new(captured);
        if path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            return Err(anyhow!("invalid captured review path"));
        }
        captured.join(path)
    };
    let canonical = workspace::simple_canonicalize(&expected)?;
    // Capture already resolved symlinks. A later replacement must not redirect
    // an explicit click to a different file, even within an otherwise allowed root.
    if comparable(&canonical) != comparable(&expected)
        || !canonical.is_file()
        || crate::tools::ignore_rules::is_sensitive_path(&canonical)
    {
        return Err(anyhow!("review file changed location or is unavailable"));
    }
    Ok(serde_json::json!({"path": canonical.to_string_lossy()}))
}

fn comparable(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        let text = if let Some(rest) = text.strip_prefix("//?/UNC/") {
            format!("//{rest}")
        } else {
            text.strip_prefix("//?/").unwrap_or(&text).to_owned()
        };
        text.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        text
    }
}

pub(crate) fn rollback_file(
    db: &Database,
    session: &str,
    snapshot: &str,
    root: Option<&Path>,
) -> Result<FileRollbackOutcome> {
    let evidence = query::file_evidence(db, session, snapshot, root)?;
    let outcome = |status| FileRollbackOutcome {
        status,
        changes: Vec::new(),
    };
    if evidence.is_empty() || evidence.len() > 1000 {
        return Ok(outcome("unavailable"));
    }
    let active: Vec<_> = evidence
        .iter()
        .filter(|change| change.state != ReviewChangeState::RolledBack)
        .collect();
    if active.is_empty() {
        return Ok(outcome("alreadyRolledBack"));
    }
    if active.iter().any(|change| !change.reversible) {
        return Ok(outcome("unavailable"));
    }
    let Some(root) = root else {
        return Ok(outcome("unavailable"));
    };
    let canonical_root = root.canonicalize()?;
    let mut metas = Vec::new();
    for change in active {
        let meta = read_meta(db.data_dir(), session, &change.snapshot_id)?;
        if !meta.reversible
            || meta
                .root
                .as_deref()
                .is_some_and(|captured| Path::new(captured) != canonical_root)
            || meta.path != evidence[0].path
            || meta.root != evidence[0].root
        {
            return Ok(outcome("unavailable"));
        }
        metas.push((change.snapshot_id.clone(), meta));
    }
    for pair in metas.windows(2) {
        if pair[0].1.after_exists != pair[1].1.before_exists
            || pair[0].1.after_hash != pair[1].1.before_hash
        {
            return Ok(outcome("conflict"));
        }
    }
    let (Some((first_id, first)), Some((_, last))) = (metas.first(), metas.last()) else {
        return Ok(outcome("unavailable"));
    };
    let target = match workspace::resolve_in_workspace(root, &first.path) {
        Ok(target) => target,
        Err(_) => return Ok(outcome("unavailable")),
    };
    let current_exists = target.is_file();
    let current_hash = if current_exists {
        Some(hash_file(&target)?)
    } else {
        None
    };
    if current_exists != last.after_exists || current_hash != last.after_hash {
        return Ok(outcome("conflict"));
    }
    // Validate every link and the restoration source before the single write.
    let before = if first.before_exists {
        let source = before_path(&snapshot_dir(db.data_dir(), session, first_id)?);
        if fs::metadata(&source)?.len() > MAX_SNAPSHOT_BYTES {
            return Ok(outcome("unavailable"));
        }
        let bytes = fs::read(source)?;
        if bytes.len() as u64 > MAX_SNAPSHOT_BYTES
            || Some(hex::encode(Sha256::digest(&bytes))) != first.before_hash
        {
            return Ok(outcome("unavailable"));
        }
        Some(bytes)
    } else {
        None
    };
    if let Some(bytes) = before {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&target, bytes).context("restore file review snapshot chain")?;
    } else if target.exists() {
        fs::remove_file(&target).context("remove file created in review round")?;
    }
    let mut changes = Vec::new();
    for (id, mut meta) in metas {
        meta.state = ReviewChangeState::RolledBack;
        write_meta(
            &metadata_path(&snapshot_dir(db.data_dir(), session, &id)?),
            &meta,
        )?;
        changes.push(RollbackOutcome {
            status: "rolledBack",
            snapshot_id: id,
            message_id: meta.message_id,
            path: meta.path,
        });
    }
    Ok(FileRollbackOutcome {
        status: "rolledBack",
        changes,
    })
}
