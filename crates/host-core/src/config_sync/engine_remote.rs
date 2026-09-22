use super::*;

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
    for child in ["objects", "revisions"] {
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

pub(super) async fn read_remote_revision(
    transport: &WebDavTransport,
    config: &StoredConfig,
    key: &VaultKey,
    revision_id: &str,
) -> Result<(RevisionManifest, BTreeMap<String, Vec<u8>>)> {
    let manifest = read_remote_manifest(transport, config, key, revision_id).await?;
    let mut resource_ids = BTreeSet::new();
    for entity in &manifest.entities {
        resource_ids.extend(entity.resource_ids.iter().cloned());
    }
    if resource_ids.len() > MAX_RESOURCES {
        bail!("CONFIG_SYNC_LIMIT_EXCEEDED: remote revision references too many resources");
    }
    let mut resources = BTreeMap::new();
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
        if bytes.len() > 128 * 1024 {
            bail!("CONFIG_SYNC_LIMIT_EXCEEDED: remote resource is too large");
        }
        resources.insert(object_id, bytes);
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
