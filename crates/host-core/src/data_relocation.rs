//! Offline relocation of host-owned structured paths in a verified profile copy.
//! The source remains untouched. No schema migration, recovery, or sweep runs.

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Component, Path, PathBuf};

#[cfg(test)]
mod tests;

pub fn run_cli() -> Result<bool> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.first().is_none_or(|arg| arg != "--relocate-data") {
        return Ok(false);
    }
    if args.len() != 3 {
        bail!("usage: pi-desktop-host-core --relocate-data <old-root> <copied-root>");
    }
    relocate(Path::new(&args[1]), Path::new(&args[2]))?;
    Ok(true)
}

struct Roots {
    source: PathBuf,
    canonical_source: PathBuf,
    destination: PathBuf,
}

impl Roots {
    fn remap(&self, text: &str) -> Option<String> {
        // A component boundary prevents matching `.pi-desktop-other`; reject
        // traversal spellings rather than converting them to privileged paths.
        let path = Path::new(text);
        if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
            return None;
        }
        let suffix = path
            .strip_prefix(&self.source)
            .or_else(|_| path.strip_prefix(&self.canonical_source))
            .ok()?;
        Some(self.destination.join(suffix).to_string_lossy().into_owned())
    }

    fn string(&self, value: &mut Value) -> bool {
        let Some(next) = value.as_str().and_then(|text| self.remap(text)) else {
            return false;
        };
        *value = Value::String(next);
        true
    }

    fn structured(&self, value: &mut Value) -> bool {
        match value {
            Value::Array(items) => items
                .iter_mut()
                .fold(false, |changed, item| self.structured(item) | changed),
            Value::Object(object) => {
                let mut changed = false;
                for (key, item) in object {
                    match key.as_str() {
                        "path" | "ref" | "filePath" | "scratchReportPath" | "workspacePath"
                        | "projectPath" | "primaryPath" | "cwd" | "scratchDir"
                        | "attachmentsDir" | "sourcePath" => changed |= self.string(item),
                        "detachedPaths" | "openProjectPaths" | "paths" => {
                            if let Value::Array(paths) = item {
                                for path in paths {
                                    changed |= self.string(path);
                                }
                            }
                        }
                        // Never rewrite narrative content, shell commands, source
                        // code, credentials, or arbitrary serialized user input.
                        "text" | "content" | "summary" | "command" | "code" | "prompt"
                        | "markdown" | "instructions" | "env" | "inlinePath" => {}
                        _ => changed |= self.structured(item),
                    }
                }
                changed
            }
            _ => false,
        }
    }
}

fn regular_file(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(true),
        Ok(_) => bail!("relocation metadata is not a regular file"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn regular_directory(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(true),
        Ok(_) => bail!("relocation metadata directory is not a regular directory"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn replace_file(path: &Path, write: impl FnOnce(&mut fs::File) -> Result<bool>) -> Result<()> {
    let temporary = path.with_extension(format!("relocate-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let permissions = fs::metadata(path)?.permissions();
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            options.mode(permissions.mode());
        }
        let mut output = options.open(&temporary)?;
        output.set_permissions(permissions)?;
        if write(&mut output)? {
            output.sync_all()?;
            drop(output);
            fs::rename(&temporary, path)?;
        } else {
            drop(output);
            fs::remove_file(&temporary)?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn rewrite_json(path: &Path, rewrite: impl FnOnce(&mut Value) -> bool) -> Result<()> {
    if !regular_file(path)? {
        return Ok(());
    }
    let mut value: Value =
        serde_json::from_slice(&fs::read(path)?).context("parse relocation metadata")?;
    replace_file(path, |output| {
        let changed = rewrite(&mut value);
        if changed {
            serde_json::to_writer(output, &value)?;
        }
        Ok(changed)
    })
}

fn rewrite_transcript(path: &Path, roots: &Roots) -> Result<()> {
    if !regular_file(path)? {
        return Ok(());
    }
    replace_file(path, |output| {
        let mut changed = false;
        let mut reader = BufReader::new(fs::File::open(path)?);
        let mut line = Vec::new();
        loop {
            line.clear();
            if reader.read_until(b'\n', &mut line)? == 0 {
                break;
            }
            let mut value: Value = match serde_json::from_slice(&line) {
                Ok(value) => value,
                // Transcript readers already tolerate a crash-torn final line.
                Err(_) if !line.ends_with(b"\n") => {
                    output.write_all(&line)?;
                    break;
                }
                Err(error) => return Err(error).context("parse relocation transcript"),
            };
            if roots.structured(&mut value) {
                serde_json::to_writer(&mut *output, &value)?;
                if line.ends_with(b"\n") {
                    output.write_all(b"\n")?;
                }
                changed = true;
            } else {
                output.write_all(&line)?;
            }
        }
        Ok(changed)
    })
}

// Field order is significant: CapabilityState uses the serialized object as
// its lookup key rather than comparing parsed identities.
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct CapabilityIdentity {
    kind: String,
    level: String,
    id: String,
    #[serde(default)]
    project_path: Option<String>,
}

fn rewrite_capability_state(path: &Path, roots: &Roots) -> Result<()> {
    if !regular_file(path)? {
        return Ok(());
    }
    let mut value: Value =
        serde_json::from_slice(&fs::read(path)?).context("parse relocation capability metadata")?;
    let Some(values) = value.get_mut("values").and_then(Value::as_object_mut) else {
        bail!("invalid relocation capability metadata");
    };
    let mut next = serde_json::Map::new();
    let mut changed = false;
    for (key, enabled) in values.iter() {
        // CapabilityState serializes its project identity inside a JSON key.
        // Global identities and unknown historical keys remain unchanged.
        let next_key = if let Ok(mut identity) = serde_json::from_str::<CapabilityIdentity>(key) {
            if let Some(project) = identity
                .project_path
                .as_deref()
                .and_then(|path| roots.remap(path))
            {
                identity.project_path = Some(project);
                changed = true;
                serde_json::to_string(&identity)?
            } else {
                key.clone()
            }
        } else {
            key.clone()
        };
        if next.insert(next_key, enabled.clone()).is_some() {
            bail!("relocated capability identity conflicts with an existing identity");
        }
    }
    if changed {
        *values = next;
        replace_file(path, |output| {
            serde_json::to_writer(output, &value)?;
            Ok(true)
        })?;
    }
    Ok(())
}

/// Called only after every writer has exited and the complete copy was verified.
/// Failure leaves an unpublished destination; the bootstrap keeps the old root.
pub fn relocate(source: &Path, destination: &Path) -> Result<()> {
    if !source.is_absolute() || !destination.is_absolute() {
        bail!("relocation roots must be absolute");
    }
    if !regular_directory(source)? || !regular_directory(destination)? {
        bail!("relocation roots must exist");
    }
    let canonical_source = source.canonicalize()?;
    let canonical_destination = destination.canonicalize()?;
    if canonical_source.starts_with(&canonical_destination)
        || canonical_destination.starts_with(&canonical_source)
    {
        bail!("relocation roots must be disjoint");
    }
    let roots = Roots {
        source: source.to_path_buf(),
        canonical_source,
        destination: destination.to_path_buf(),
    };
    let sessions = roots.destination.join("sessions");
    if regular_directory(&sessions)? {
        for entry in fs::read_dir(sessions)? {
            let path = entry?.path();
            match path.extension().and_then(|extension| extension.to_str()) {
                Some("jsonl") => rewrite_transcript(&path, &roots)?,
                Some("json")
                    if path
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().ends_with(".inflight.json")) =>
                {
                    rewrite_json(&path, |value| roots.structured(value))?;
                }
                _ => {}
            }
        }
    }
    rewrite_json(
        &roots.destination.join("session-message-outbox.json"),
        |value| roots.structured(value),
    )?;
    let capabilities = roots.destination.join("agent-capabilities");
    if regular_directory(&capabilities)? {
        for name in ["mcp", "skills", "subagents", "subagent-builtins"] {
            rewrite_capability_state(&capabilities.join(format!("{name}.json")), &roots)?;
        }
    }
    let plugins = roots.destination.join("plugins");
    if regular_directory(&plugins)? {
        rewrite_json(&plugins.join("registry.json"), |value| {
            let mut changed = false;
            if let Some(entries) = value.as_array_mut() {
                for entry in entries {
                    if matches!(
                        entry.get("source").and_then(Value::as_str),
                        Some("installed" | "marketplace")
                    ) {
                        if let Some(path) = entry.get_mut("path") {
                            changed |= roots.string(path);
                        }
                    }
                }
            }
            changed
        })?;
    }
    relocate_database(&roots)?;
    Ok(())
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = statement.query_map([], |row| row.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn relocate_database(roots: &Roots) -> Result<()> {
    let path = roots.destination.join("pi.sqlite");
    if !regular_file(&path)? {
        return Ok(());
    }
    for extension in ["pi.sqlite-wal", "pi.sqlite-shm"] {
        regular_file(&roots.destination.join(extension))?;
    }
    let mut connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    let transaction = connection.transaction()?;
    for (table, column, json) in [
        ("projects", "path", false),
        ("artifacts", "path", false),
        ("turn_queue", "attachments_json", true),
        ("scheduled_tasks", "config_json", true),
    ] {
        if !column_exists(&transaction, table, column)? {
            continue;
        }
        let rows = {
            let mut statement = transaction.prepare(&format!(
                "SELECT DISTINCT {column} FROM {table} WHERE {column} IS NOT NULL"
            ))?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        for text in rows {
            let next = if json {
                let mut value: Value =
                    serde_json::from_str(&text).context("parse relocation database metadata")?;
                roots.structured(&mut value).then(|| value.to_string())
            } else {
                roots.remap(&text)
            };
            if let Some(next) = next {
                transaction.execute(
                    &format!("UPDATE {table} SET {column} = ?1 WHERE {column} = ?2"),
                    params![next, text],
                )?;
            }
        }
    }
    if column_exists(&transaction, "kv", "value_json")? {
        let rows = {
            let mut statement = transaction.prepare("SELECT ns, key, value_json FROM kv WHERE ns IN ('app','ui','projectGroups','projectMemory','projectInstructions')")?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        for (namespace, key, text) in rows {
            let next_key = if matches!(namespace.as_str(), "projectMemory" | "projectInstructions")
            {
                roots.remap(&key).unwrap_or_else(|| key.clone())
            } else {
                key.clone()
            };
            let mut value: Value =
                serde_json::from_str(&text).context("parse relocation settings metadata")?;
            let changed = if namespace == "app" && key == "currentProjectId" {
                roots.string(&mut value)
            } else if matches!(namespace.as_str(), "app" | "ui" | "projectGroups") {
                roots.structured(&mut value)
            } else {
                false
            };
            if changed || next_key != key {
                transaction.execute(
                    "UPDATE kv SET key = ?1, value_json = ?2 WHERE ns = ?3 AND key = ?4",
                    params![next_key, value.to_string(), namespace, key],
                )?;
            }
        }
    }
    transaction.commit()?;
    let (busy, _, _): (i64, i64, i64) =
        connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
    if busy != 0 {
        bail!("relocated database checkpoint is busy");
    }
    Ok(())
}
