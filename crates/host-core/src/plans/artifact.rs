use super::*;

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub(crate) fn title_slug(value: &str, fallback: &str) -> String {
    let mut slug = String::new();
    for ch in value.trim().chars() {
        if ch.is_alphanumeric() {
            slug.push(if ch.is_ascii() {
                ch.to_ascii_lowercase()
            } else {
                ch
            });
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.chars().count() >= 64 {
            break;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        fallback.into()
    } else {
        slug
    }
}

pub(crate) fn plan_filename(kind: &str, title: &str, now: DateTime<Local>, suffix: u32) -> String {
    let slug = title_slug(title, kind);
    let stamp = now.format("%Y%m%d-%H%M");
    if suffix == 1 {
        format!("{slug}-{stamp}.md")
    } else {
        format!("{slug}-{stamp}-{suffix}.md")
    }
}

#[cfg(windows)]
pub(crate) fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
pub(crate) fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

pub(crate) fn safe_directory(path: &Path, create: bool) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if is_link_or_reparse(&metadata) || !metadata.is_dir() {
                return Err(plan_error("PLAN_ARTIFACT_PATH_UNSAFE"));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
            fs::create_dir(path).map_err(|_| plan_error("PLAN_ARTIFACT_PATH_UNSAFE"))?;
            let metadata =
                fs::symlink_metadata(path).map_err(|_| plan_error("PLAN_ARTIFACT_PATH_UNSAFE"))?;
            if is_link_or_reparse(&metadata) || !metadata.is_dir() {
                return Err(plan_error("PLAN_ARTIFACT_PATH_UNSAFE"));
            }
        }
        Err(_) => return Err(plan_error("PLAN_ARTIFACT_PATH_UNSAFE")),
    }
    Ok(())
}

/// Resolve `<workspace>/.pi/<kind>` with every component checked for links.
/// `kind` is always a `'static` literal, never caller text.
pub(crate) fn plan_directory(
    workspace_root: &Path,
    kind: &'static str,
    create: bool,
) -> Result<(PathBuf, PathBuf)> {
    let root = workspace_root
        .canonicalize()
        .map_err(|_| plan_error("PLAN_WORKSPACE_REQUIRED"))?;
    let root_metadata =
        fs::symlink_metadata(&root).map_err(|_| plan_error("PLAN_WORKSPACE_REQUIRED"))?;
    if is_link_or_reparse(&root_metadata) || !root_metadata.is_dir() {
        return Err(plan_error("PLAN_ARTIFACT_PATH_UNSAFE"));
    }
    let pi = root.join(".pi");
    safe_directory(&pi, create)?;
    let directory = pi.join(kind);
    safe_directory(&directory, create)?;
    Ok((root, directory))
}

pub(crate) fn publish_artifact(
    workspace_root: &Path,
    kind: &'static str,
    title: &str,
    markdown: &str,
) -> Result<(PlanArtifact, PathBuf)> {
    let bytes = markdown.as_bytes();
    if bytes.is_empty() {
        return Err(plan_error("PLAN_INVALID_ARGUMENT"));
    }
    if bytes.len() > PLAN_MAX_MARKDOWN_BYTES {
        return Err(plan_error("PLAN_MARKDOWN_TOO_LARGE"));
    }
    let (_root, directory) = plan_directory(workspace_root, kind, true)?;
    let now = Local::now();
    for suffix in 1..=10_000u32 {
        let filename = plan_filename(kind, title, now, suffix);
        let path = directory.join(&filename);
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(plan_error("PLAN_ARTIFACT_WRITE_FAILED")),
        };
        let write_result = (|| -> Result<()> {
            file.write_all(bytes)
                .map_err(|_| plan_error("PLAN_ARTIFACT_WRITE_FAILED"))?;
            file.sync_all()
                .map_err(|_| plan_error("PLAN_ARTIFACT_WRITE_FAILED"))?;
            Ok(())
        })();
        drop(file);
        if let Err(error) = write_result {
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        let relative_path = format!(".pi/{kind}/{filename}");
        return Ok((
            PlanArtifact {
                relative_path,
                sha256: sha256_hex(bytes),
                size_bytes: bytes.len() as u64,
            },
            path,
        ));
    }
    Err(plan_error("PLAN_ARTIFACT_COLLISION_LIMIT"))
}

pub(crate) fn safe_artifact_path(
    workspace_root: &Path,
    kind: &'static str,
    relative_path: &str,
) -> Result<PathBuf> {
    let (root, _directory) = plan_directory(workspace_root, kind, false)?;
    let components = Path::new(relative_path).components().collect::<Vec<_>>();
    if components.len() != 3
        || components[0] != Component::Normal(".pi".as_ref())
        || components[1] != Component::Normal(kind.as_ref())
    {
        return Err(plan_error("PLAN_ARTIFACT_PATH_UNSAFE"));
    }
    let Some(Component::Normal(filename)) = components.get(2).copied() else {
        return Err(plan_error("PLAN_ARTIFACT_PATH_UNSAFE"));
    };
    let filename = filename
        .to_str()
        .ok_or_else(|| plan_error("PLAN_ARTIFACT_PATH_UNSAFE"))?;
    if filename.is_empty()
        || !filename.ends_with(".md")
        || filename.contains('/')
        || filename.contains('\\')
    {
        return Err(plan_error("PLAN_ARTIFACT_PATH_UNSAFE"));
    }
    let path = root.join(".pi").join(kind).join(filename);
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| plan_error("PLAN_ARTIFACT_NOT_READY"))?;
    if is_link_or_reparse(&metadata) || !metadata.is_file() || !path.starts_with(&root) {
        return Err(plan_error("PLAN_ARTIFACT_PATH_UNSAFE"));
    }
    Ok(path)
}

pub(crate) fn verify_artifact(
    workspace_root: &Path,
    kind: &'static str,
    artifact: &PlanArtifact,
) -> Result<()> {
    let path = safe_artifact_path(workspace_root, kind, &artifact.relative_path)?;
    let bytes = fs::read(path).map_err(|_| plan_error("PLAN_ARTIFACT_NOT_READY"))?;
    if bytes.len() as u64 != artifact.size_bytes {
        return Err(plan_error("PLAN_ARTIFACT_HASH_MISMATCH"));
    }
    if sha256_hex(&bytes) != artifact.sha256 {
        return Err(plan_error("PLAN_ARTIFACT_HASH_MISMATCH"));
    }
    Ok(())
}
