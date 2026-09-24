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

pub(super) async fn ensure_remote_collections(
    transport: &WebDavTransport,
    config: &StoredConfig,
) -> Result<()> {
    validate_remote_id(&config.vault_id, "vault")?;
    transport.ensure_collection("vault").await?;
    transport
        .ensure_collection(&format!("vault/{}", config.vault_id))
        .await?;
    for child in ["objects", "revisions", "heads"] {
        transport
            .ensure_collection(&format!("vault/{}/{}", config.vault_id, child))
            .await?;
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
    remote_path(config, "head")
}

pub(super) fn compatibility_heads_path(config: &StoredConfig) -> String {
    remote_path(config, "heads")
}

pub(super) fn compatibility_head_path(config: &StoredConfig, device_id: &str) -> Result<String> {
    validate_remote_id(&config.vault_id, "vault")?;
    validate_remote_id(device_id, "device")?;
    Ok(remote_path(config, &format!("heads/{device_id}")))
}

pub(super) fn serialize_json<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(value)?)
}

pub(super) async fn read_remote_head(
    transport: &WebDavTransport,
    config: &StoredConfig,
    key: &VaultKey,
) -> Result<Option<(RemoteHead, String)>> {
    validate_remote_id(&config.vault_id, "vault")?;
    let Some((ciphertext, etag)) = transport.get(&head_path(config)).await? else {
        return Ok(None);
    };
    let etag = etag.ok_or_else(|| {
        anyhow!("CONFIG_SYNC_UNSUPPORTED: WebDAV head does not expose a strong ETag")
    })?;
    let plain = decrypt_object(key, "head", &config.vault_id, &ciphertext)?;
    let head: RemoteHead = serde_json::from_slice(&plain).context("decode remote head")?;
    if head.format != FORMAT || head.version != 1 {
        bail!("CONFIG_SYNC_UNSUPPORTED: remote head format is not supported");
    }
    validate_remote_id(&head.revision_id, "revision")?;
    Ok(Some((head, etag)))
}

#[derive(Debug)]
pub(super) struct AppendOnlyRemote {
    pub tip_ids: Vec<String>,
    pub tips: Vec<RevisionManifest>,
    pub resources: BTreeMap<String, Vec<u8>>,
}

fn is_ancestor(
    manifests: &BTreeMap<String, RevisionManifest>,
    ancestor: &str,
    descendant: &str,
) -> bool {
    let mut pending = vec![descendant.to_string()];
    let mut seen = BTreeSet::new();
    while let Some(revision_id) = pending.pop() {
        if !seen.insert(revision_id.clone()) {
            continue;
        }
        if revision_id == ancestor {
            return true;
        }
        if let Some(manifest) = manifests.get(&revision_id) {
            pending.extend(manifest.parents.iter().cloned());
        }
    }
    false
}

pub(super) async fn read_append_only_remote(
    transport: &WebDavTransport,
    config: &StoredConfig,
    key: &VaultKey,
    observer: &dyn SyncProgressObserver,
) -> Result<Option<AppendOnlyRemote>> {
    let mut head_revision_ids = BTreeSet::new();
    for device_id in transport
        .list_children(&compatibility_heads_path(config))
        .await?
    {
        validate_remote_id(&device_id, "device")?;
        let path = compatibility_head_path(config, &device_id)?;
        let Some((ciphertext, _)) = transport.get(&path).await? else {
            bail!("CONFIG_SYNC_REMOTE: compatibility head disappeared");
        };
        let plain = decrypt_object(
            key,
            &format!("append-head/{device_id}"),
            &config.vault_id,
            &ciphertext,
        )?;
        let head: RemoteHead =
            serde_json::from_slice(&plain).context("decode compatibility head")?;
        if head.format != FORMAT || head.version != 1 {
            bail!("CONFIG_SYNC_UNSUPPORTED: compatibility head format is not supported");
        }
        validate_remote_id(&head.revision_id, "revision")?;
        head_revision_ids.insert(head.revision_id);
    }

    // A vault created by strict mode may be joined explicitly in append-only
    // mode. Treat the old shared head as one input while the first
    // compatibility head is published; strict-mode devices are warned in the
    // UI and must not remain subscribed to the same vault.
    if let Some((ciphertext, _)) = transport.get(&head_path(config)).await? {
        let plain = decrypt_object(key, "head", &config.vault_id, &ciphertext)?;
        let head: RemoteHead = serde_json::from_slice(&plain).context("decode legacy head")?;
        if head.format != FORMAT || head.version != 1 {
            bail!("CONFIG_SYNC_UNSUPPORTED: legacy head format is not supported");
        }
        validate_remote_id(&head.revision_id, "revision")?;
        head_revision_ids.insert(head.revision_id);
    }

    if head_revision_ids.is_empty() {
        return Ok(None);
    }

    let mut manifests = BTreeMap::new();
    let mut pending = head_revision_ids.iter().cloned().collect::<Vec<_>>();
    while let Some(revision_id) = pending.pop() {
        if manifests.contains_key(&revision_id) {
            continue;
        }
        if manifests.len() >= MAX_HISTORY_SCAN {
            bail!("CONFIG_SYNC_LIMIT_EXCEEDED: compatibility history is too large");
        }
        let manifest = read_remote_manifest(transport, config, key, &revision_id).await?;
        pending.extend(manifest.parents.iter().cloned());
        manifests.insert(revision_id, manifest);
    }

    let tip_ids = head_revision_ids
        .iter()
        .filter(|candidate| {
            !head_revision_ids
                .iter()
                .any(|other| *candidate != other && is_ancestor(&manifests, candidate, other))
        })
        .cloned()
        .collect::<Vec<_>>();

    let mut tips = Vec::new();
    let mut resources = BTreeMap::new();
    let tip_total = tip_ids.len() as u64;
    for (index, revision_id) in tip_ids.iter().enumerate() {
        // Count tips, not the objects inside them: the tips are read one after
        // another, so a per-object count inside each of them would restart and
        // walk the bar backwards on a vault with more than one tip.
        observer.report(SyncProgress::counted(
            SyncPhase::Download,
            index as u64,
            tip_total,
            0,
            0,
        ));
        let (manifest, revision_resources) =
            read_remote_revision(transport, config, key, revision_id, &NoSyncProgress).await?;
        for (object_id, bytes) in revision_resources {
            if let Some(existing) = resources.get(&object_id) {
                if existing != &bytes {
                    bail!("CONFIG_SYNC_CRYPTO: compatibility resource id collision");
                }
            } else {
                resources.insert(object_id, bytes);
            }
        }
        tips.push(manifest);
    }
    observer.report(SyncProgress::counted(
        SyncPhase::Download,
        tip_total,
        tip_total,
        0,
        0,
    ));
    if resources.len() > MAX_RESOURCES {
        bail!("CONFIG_SYNC_LIMIT_EXCEEDED: compatibility revision references too many resources");
    }
    Ok(Some(AppendOnlyRemote {
        tip_ids,
        tips,
        resources,
    }))
}

pub(super) fn merge_append_only_tips(
    base: Option<&RevisionManifest>,
    tips: &[RevisionManifest],
) -> Result<merge::MergeResult> {
    let Some(first) = tips.first() else {
        return Ok(merge::MergeResult {
            entities: Vec::new(),
            conflicts: Vec::new(),
        });
    };
    let mut accumulator = first.clone();
    let mut conflicts = Vec::new();
    for tip in tips.iter().skip(1) {
        let merged = merge::three_way(base, &accumulator, Some(tip))?;
        accumulator.entities = merged.entities;
        conflicts.extend(merged.conflicts);
    }
    Ok(merge::MergeResult {
        entities: accumulator.entities,
        conflicts,
    })
}

pub(super) async fn publish_append_only_head(
    transport: &WebDavTransport,
    config: &StoredConfig,
    key: &VaultKey,
    device_id: &str,
    revision_id: &str,
) -> Result<()> {
    let path = compatibility_head_path(config, device_id)?;
    validate_remote_id(revision_id, "revision")?;
    let head = RemoteHead {
        format: FORMAT.into(),
        version: 1,
        revision_id: revision_id.into(),
    };
    let encrypted = encrypt_object(
        key,
        &format!("append-head/{device_id}"),
        &config.vault_id,
        &serialize_json(&head)?,
    )?;
    transport.put_unconditional(&path, encrypted).await?;
    let Some((stored, _)) = transport.get(&path).await? else {
        bail!("CONFIG_SYNC_REMOTE: compatibility head disappeared after upload");
    };
    let plain = decrypt_object(
        key,
        &format!("append-head/{device_id}"),
        &config.vault_id,
        &stored,
    )?;
    let stored: RemoteHead = serde_json::from_slice(&plain)?;
    if stored.revision_id != revision_id {
        bail!("CONFIG_SYNC_CONFLICT: compatibility head was changed during publication");
    }
    Ok(())
}

pub(super) async fn read_remote_revision(
    transport: &WebDavTransport,
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
    transport: &WebDavTransport,
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
    let manifest: RevisionManifest =
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
        if domains::adapter_for(&entity.domain).is_none() {
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
    Ok(manifest)
}

pub(super) async fn upload_snapshot(
    transport: &WebDavTransport,
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
    if declared_resources != snapshot.resources.keys().cloned().collect() {
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
        if config.remote_mode == RemoteMode::AppendOnly {
            if transport.get(&path).await?.is_none() {
                transport.put_unconditional(&path, encrypted).await?;
            }
        } else {
            transport.put_if_none(&path, encrypted).await?;
        }
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
    if config.remote_mode == RemoteMode::AppendOnly {
        transport.put_unconditional(&path, encrypted).await?;
    } else {
        transport.put_if_none(&path, encrypted).await?;
    }
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
    transport: &WebDavTransport,
    config: &StoredConfig,
    key: &VaultKey,
    head: &RemoteHead,
    etag: Option<&str>,
) -> Result<bool> {
    validate_remote_id(&config.vault_id, "vault")?;
    let encrypted = encrypt_object(key, "head", &config.vault_id, &serialize_json(head)?)?;
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
    use serde_json::json;

    fn application_entity(payload: serde_json::Value) -> PortableEntity {
        let mut entity = PortableEntity {
            domain: domains::DOMAIN_APPLICATION.to_string(),
            entity_id: "application".to_string(),
            label: "Application".to_string(),
            deleted: false,
            requires_approval: false,
            secret_bearing: false,
            mapping_required: false,
            digest: String::new(),
            payload,
            resource_ids: Vec::new(),
        };
        domains::refresh_digest(&mut entity);
        entity
    }

    fn manifest(
        revision_id: &str,
        parents: Vec<String>,
        entity: PortableEntity,
    ) -> RevisionManifest {
        RevisionManifest {
            format: REVISION_FORMAT.to_string(),
            version: 1,
            revision_id: revision_id.to_string(),
            parents,
            created_at: "2026-09-22T00:00:00Z".to_string(),
            entities: vec![entity],
            resource_ids: Vec::new(),
        }
    }

    #[test]
    fn append_only_tips_merge_disjoint_application_fields() {
        let base = manifest(
            "base",
            Vec::new(),
            application_entity(json!({"theme": "light", "language": "en"})),
        );
        let theme_tip = manifest(
            "theme-tip",
            vec!["base".to_string()],
            application_entity(json!({"theme": "dark", "language": "en"})),
        );
        let language_tip = manifest(
            "language-tip",
            vec!["base".to_string()],
            application_entity(json!({"theme": "light", "language": "zh-CN"})),
        );

        let merged = merge_append_only_tips(Some(&base), &[theme_tip, language_tip])
            .expect("append-only tips merge");
        assert!(merged.conflicts.is_empty());
        assert_eq!(
            merged.entities[0].payload,
            json!({"theme": "dark", "language": "zh-CN"})
        );
    }
}
