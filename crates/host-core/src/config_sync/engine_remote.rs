use super::*;
/// Ceiling for one resource object read back from a revision. A resource is
/// produced by the skill packager, so the receiver must accept exactly what the
/// packager accepts: a smaller receiver bound would turn an accepted upload
/// into a failed download.
const MAX_REMOTE_RESOURCE_BYTES: usize = crate::user_skills::MAX_SKILL_RESOURCE_BYTES;

pub(super) fn remote_prefix(config: &StoredConfig) -> String {
    format!("vault/{}/", config.vault_id)
}

pub(super) fn remote_path(config: &StoredConfig, suffix: &str) -> String {
    format!(
        "{}{}",
        remote_prefix(config),
        suffix.trim_start_matches('/')
    )
}

pub(super) fn validate_remote_id(value: &str, kind: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || value.contains('/')
        || value.contains('\\')
        || value.contains("..")
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
    {
        bail!("CONFIG_SYNC_INVALID: unsafe remote {kind} id");
    }
    Ok(())
}

pub(super) fn revision_path(config: &StoredConfig, revision_id: &str) -> Result<String> {
    validate_remote_id(&config.vault_id, "vault")?;
    validate_remote_id(revision_id, "revision")?;
    Ok(remote_path(config, &format!("revisions/{revision_id}")))
}

pub(super) fn object_path(config: &StoredConfig, object_id: &str) -> Result<String> {
    validate_remote_id(&config.vault_id, "vault")?;
    validate_remote_id(object_id, "object")?;
    Ok(remote_path(config, &format!("objects/{object_id}")))
}

pub(super) fn head_path(config: &StoredConfig) -> String {
    remote_path(
        config,
        if config.mode == SyncMode::Backup {
            "backup-head"
        } else {
            "head"
        },
    )
}

fn head_purpose(config: &StoredConfig) -> &'static str {
    if config.mode == SyncMode::Backup {
        "backup-head"
    } else {
        "head"
    }
}

pub(super) fn next_head(revision_id: &str, previous: Option<&RemoteHead>) -> RemoteHead {
    let mut history = vec![revision_id.to_string()];
    if let Some(previous) = previous {
        for id in &previous.history {
            if history.len() >= MAX_RETAINED_REVISIONS {
                break;
            }
            if !history.contains(id) {
                history.push(id.clone());
            }
        }
    }
    RemoteHead {
        format: FORMAT.into(),
        version: 1,
        revision_id: revision_id.into(),
        history,
    }
}

pub(super) fn serialize_json<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(value)?)
}

pub(super) async fn read_remote_head(
    transport: &S3Transport,
    config: &StoredConfig,
    key: &VaultKey,
) -> Result<Option<(RemoteHead, String)>> {
    validate_remote_id(&config.vault_id, "vault")?;
    let Some((ciphertext, etag)) = transport.get(&head_path(config)).await? else {
        return Ok(None);
    };
    let etag = etag
        .ok_or_else(|| anyhow!("CONFIG_SYNC_UNSUPPORTED: S3 head does not expose a strong ETag"))?;
    let plain = decrypt_object(key, head_purpose(config), &config.vault_id, &ciphertext)?;
    let head: RemoteHead = serde_json::from_slice(&plain).context("decode remote head")?;
    if head.format != FORMAT || head.version != 1 {
        bail!("CONFIG_SYNC_UNSUPPORTED: remote head format is not supported");
    }
    validate_remote_id(&head.revision_id, "revision")?;
    if head.history.first() != Some(&head.revision_id)
        || head.history.len() > MAX_RETAINED_REVISIONS
        || head.history.iter().collect::<BTreeSet<_>>().len() != head.history.len()
    {
        bail!("CONFIG_SYNC_INVALID: remote history index is invalid");
    }
    for id in &head.history {
        validate_remote_id(id, "revision")?;
    }
    Ok(Some((head, etag)))
}

pub(super) async fn read_remote_revision(
    transport: &S3Transport,
    config: &StoredConfig,
    key: &VaultKey,
    revision_id: &str,
    observer: &dyn SyncProgressObserver,
) -> Result<(RevisionManifest, BTreeMap<String, Vec<u8>>)> {
    let manifest = read_remote_manifest(transport, config, key, revision_id).await?;
    let mut resource_ids = BTreeSet::new();
    for entity in &manifest.entities {
        resource_ids.extend(entity.resource_ids.iter().cloned());
    }
    if resource_ids.len() > MAX_RESOURCES {
        bail!("CONFIG_SYNC_LIMIT_EXCEEDED: remote revision references too many resources");
    }
    let total = resource_ids.len() as u64;
    observer.report(SyncProgress::counted(SyncPhase::Download, 0, total, 0, 0));
    let mut resources = BTreeMap::new();
    let mut bytes_done = 0u64;
    for object_id in resource_ids {
        let path = object_path(config, &object_id)?;
        let Some((ciphertext, _)) = transport.get(&path).await? else {
            bail!("CONFIG_SYNC_REMOTE: referenced resource is missing");
        };
        let bytes = decrypt_object(
            key,
            &format!("resource/{object_id}"),
            &config.vault_id,
            &ciphertext,
        )?;
        if bytes.len() > MAX_REMOTE_RESOURCE_BYTES {
            bail!("CONFIG_SYNC_LIMIT_EXCEEDED: remote resource is too large");
        }
        bytes_done = bytes_done.saturating_add(bytes.len() as u64);
        resources.insert(object_id, bytes);
        observer.report(SyncProgress::counted(
            SyncPhase::Download,
            resources.len() as u64,
            total,
            bytes_done,
            0,
        ));
    }
    Ok((manifest, resources))
}

pub(super) async fn read_remote_manifest(
    transport: &S3Transport,
    config: &StoredConfig,
    key: &VaultKey,
    revision_id: &str,
) -> Result<RevisionManifest> {
    let path = revision_path(config, revision_id)?;
    let Some((ciphertext, _)) = transport.get(&path).await? else {
        bail!("CONFIG_SYNC_REMOTE: referenced revision is missing");
    };
    let plain = decrypt_object(
        key,
        &format!("manifest/{revision_id}"),
        &config.vault_id,
        &ciphertext,
    )?;
    let mut manifest: RevisionManifest =
        serde_json::from_slice(&plain).context("decode remote revision")?;
    if manifest.format != REVISION_FORMAT
        || manifest.version != 1
        || manifest.revision_id != revision_id
        || manifest.entities.len() > MAX_ENTITIES
        || manifest.resource_ids.len() > MAX_RESOURCES
    {
        bail!("CONFIG_SYNC_UNSUPPORTED: remote revision is invalid");
    }
    for parent in &manifest.parents {
        validate_remote_id(parent, "revision")?;
    }
    for entity in &manifest.entities {
        // Retired project records remain readable in existing vault history,
        // but are never merged or applied by this device.
        if entity.domain != "projects" && domains::adapter_for(&entity.domain).is_none() {
            bail!(
                "CONFIG_SYNC_UNSUPPORTED: remote domain {} is not supported",
                entity.domain
            );
        }
        if entity.entity_id.len() > 256
            || entity.label.len() > 512
            || serde_json::to_vec(&entity.payload)?.len() > 512 * 1024
        {
            bail!("CONFIG_SYNC_LIMIT_EXCEEDED: remote entity is too large");
        }
    }
    let mut resource_ids = BTreeSet::new();
    for entity in &manifest.entities {
        for object_id in &entity.resource_ids {
            validate_remote_id(object_id, "object")?;
        }
        resource_ids.extend(entity.resource_ids.iter().cloned());
    }
    let declared_resources = manifest
        .resource_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    for object_id in &declared_resources {
        validate_remote_id(object_id, "object")?;
    }
    if declared_resources != resource_ids {
        bail!("CONFIG_SYNC_INVALID: remote revision resource references do not match");
    }
    if resource_ids.len() > MAX_RESOURCES {
        bail!("CONFIG_SYNC_LIMIT_EXCEEDED: remote revision references too many resources");
    }
    for object_id in resource_ids {
        validate_remote_id(&object_id, "object")?;
    }
    domains::retain_supported_entities(&mut manifest);
    Ok(manifest)
}

pub(super) async fn upload_snapshot(
    transport: &S3Transport,
    config: &StoredConfig,
    key: &VaultKey,
    snapshot: &LocalSnapshot,
    observer: &dyn SyncProgressObserver,
) -> Result<()> {
    if snapshot.manifest.entities.len() > MAX_ENTITIES || snapshot.resources.len() > MAX_RESOURCES {
        bail!("CONFIG_SYNC_LIMIT_EXCEEDED: local revision is too large");
    }
    let declared_resources = snapshot
        .manifest
        .resource_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let referenced_resources = snapshot
        .manifest
        .entities
        .iter()
        .flat_map(|entity| entity.resource_ids.iter().cloned())
        .collect::<BTreeSet<_>>();
    if declared_resources != snapshot.resources.keys().cloned().collect()
        || declared_resources != referenced_resources
    {
        bail!("CONFIG_SYNC_INVALID: local revision resource references do not match");
    }
    for entity in &snapshot.manifest.entities {
        if domains::adapter_for(&entity.domain).is_none()
            || entity.entity_id.len() > 256
            || entity.label.len() > 512
            || serde_json::to_vec(&entity.payload)?.len() > 512 * 1024
        {
            bail!("CONFIG_SYNC_LIMIT_EXCEEDED: local entity is too large or unsupported");
        }
    }
    let total = snapshot.resources.len() as u64;
    let bytes_total = snapshot
        .resources
        .values()
        .map(|bytes| bytes.len() as u64)
        .fold(0u64, u64::saturating_add);
    let mut uploaded = 0u64;
    let mut bytes_done = 0u64;
    observer.report(SyncProgress::counted(
        SyncPhase::Upload,
        0,
        total,
        0,
        bytes_total,
    ));
    for (object_id, bytes) in &snapshot.resources {
        let path = object_path(config, object_id)?;
        let encrypted = encrypt_object(
            key,
            &format!("resource/{object_id}"),
            &config.vault_id,
            bytes,
        )?;
        transport.put_if_none(&path, encrypted).await?;
        let Some((existing, _)) = transport.get(&path).await? else {
            bail!("CONFIG_SYNC_REMOTE: immutable resource disappeared after upload");
        };
        let verified = decrypt_object(
            key,
            &format!("resource/{object_id}"),
            &config.vault_id,
            &existing,
        )?;
        if verified != *bytes {
            bail!("CONFIG_SYNC_CRYPTO: immutable resource id collision");
        }
        uploaded = uploaded.saturating_add(1);
        bytes_done = bytes_done.saturating_add(bytes.len() as u64);
        observer.report(SyncProgress::counted(
            SyncPhase::Upload,
            uploaded,
            total,
            bytes_done,
            bytes_total,
        ));
    }
    let manifest_bytes = serialize_json(&snapshot.manifest)?;
    let encrypted = encrypt_object(
        key,
        &format!("manifest/{}", snapshot.manifest.revision_id),
        &config.vault_id,
        &manifest_bytes,
    )?;
    let path = revision_path(config, &snapshot.manifest.revision_id)?;
    transport.put_if_none(&path, encrypted).await?;
    let Some((existing, _)) = transport.get(&path).await? else {
        bail!("CONFIG_SYNC_REMOTE: immutable revision disappeared after upload");
    };
    let verified = decrypt_object(
        key,
        &format!("manifest/{}", snapshot.manifest.revision_id),
        &config.vault_id,
        &existing,
    )?;
    if verified != manifest_bytes {
        bail!("CONFIG_SYNC_CRYPTO: immutable revision id collision");
    }
    Ok(())
}

pub(super) async fn publish_head(
    transport: &S3Transport,
    config: &StoredConfig,
    key: &VaultKey,
    head: &RemoteHead,
    etag: Option<&str>,
) -> Result<bool> {
    validate_remote_id(&config.vault_id, "vault")?;
    let encrypted = encrypt_object(
        key,
        head_purpose(config),
        &config.vault_id,
        &serialize_json(head)?,
    )?;
    if let Some(etag) = etag {
        transport
            .put_if_match(&head_path(config), etag, encrypted)
            .await
    } else {
        Ok(transport.put_if_none(&head_path(config), encrypted).await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_index_stays_bounded_without_traversing_deleted_ancestors() {
        let mut head = next_head("first", None);
        for index in 0..300 {
            head = next_head(&format!("revision-{index}"), Some(&head));
        }
        assert_eq!(head.history.len(), MAX_RETAINED_REVISIONS);
        assert_eq!(head.history[0], "revision-299");
        assert_eq!(
            head.history.last().map(String::as_str),
            Some("revision-270")
        );
        let repeated = next_head(&head.revision_id, Some(&head));
        assert_eq!(repeated.history, head.history);
    }
}
