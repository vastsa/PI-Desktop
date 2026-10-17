use super::*;

/// History is a bounded, authenticated index, not a recursive parent walk.
/// Immutable objects are retained: deleting shared resources without a durable
/// cross-device acknowledgement protocol can race an offline or publishing peer.
pub(super) async fn list_history(state: Arc<Mutex<AppState>>) -> Result<Value> {
    let (config, key, transport) = {
        let st = state.lock().await;
        let config = load_config(&st)?
            .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: S3 backup is not configured"))?;
        let key = local_vault_key(&st, &config)?
            .ok_or_else(|| anyhow!("CONFIG_SYNC_LOCKED: backup vault is locked"))?;
        let transport = configured_transport(&st, &config)?;
        (config, key, transport)
    };
    let Some((head, _)) = read_remote_head(&transport, &config, &key).await? else {
        return Ok(json!([]));
    };
    let mut entries = Vec::new();
    for revision_id in &head.history {
        let manifest = read_remote_manifest(&transport, &config, &key, revision_id).await?;
        entries.push(PublicHistoryEntry {
            current: revision_id == &head.revision_id,
            revision_id: manifest.revision_id,
            created_at: manifest.created_at,
            parent_revision_ids: manifest.parents,
            entity_count: manifest.entities.len(),
            resource_count: manifest.resource_ids.len(),
        });
    }
    Ok(serde_json::to_value(entries)?)
}

fn add_restore_approvals(
    config: &StoredConfig,
    local: &RevisionManifest,
    target: &RevisionManifest,
    pending: &mut PendingBundle,
) {
    let local_map = manifest_map(Some(local));
    let existing: BTreeSet<(String, String)> = pending
        .approvals
        .iter()
        .map(|item| entity_key(&item.entity))
        .collect();
    for entity in &target.entities {
        if !selection(config).is_selected(&entity.domain)
            || (!entity.requires_approval && !entity.mapping_required)
        {
            continue;
        }
        let changed = local_map
            .get(&entity_key(entity))
            .is_none_or(|current| !merge::same_version(current, entity));
        if changed && !existing.contains(&entity_key(entity)) {
            pending.approvals.push(PendingApproval {
                approval_id: Uuid::new_v4().to_string(),
                entity: entity.clone(),
                reason: if entity.mapping_required {
                    "mapping"
                } else {
                    "securityChange"
                }
                .into(),
                approved: false,
            });
        }
    }
}

pub(super) async fn change_password(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value> {
    let sync_lock = state.lock().await.config_sync_lock.clone();
    let _sync_guard = sync_lock.lock().await;
    let current_password = params
        .get("currentPassword")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: current backup password is required"))?;
    let new_password = params
        .get("newPassword")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: new backup password is required"))?;
    if new_password.len() < 8 {
        bail!("CONFIG_SYNC_INVALID: new backup password must be at least 8 characters");
    }
    let (mut config, key, transport) = {
        let st = state.lock().await;
        let config = load_config(&st)?
            .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: S3 backup is not configured"))?;
        let key = unlock_vault(&config.vault_header, current_password)?;
        let transport = configured_transport(&st, &config)?;
        (config, key, transport)
    };
    let Some((bytes, etag)) = transport.get("header").await? else {
        bail!("CONFIG_SYNC_REMOTE: remote vault header is missing");
    };
    let remote: VaultHeader =
        serde_json::from_slice(&bytes).context("decode remote vault header")?;
    if remote.vault_id != config.vault_id {
        bail!("CONFIG_SYNC_CONFLICT: selected S3 prefix belongs to another vault");
    }
    let remote_key = unlock_vault(&remote, current_password)?;
    if remote_key.as_bytes() != key.as_bytes() {
        bail!("CONFIG_SYNC_CONFLICT: local and remote vault keys do not match");
    }
    let next_header = rewrap_vault(&remote, &key, new_password)?;
    let etag =
        etag.ok_or_else(|| anyhow!("CONFIG_SYNC_UNSUPPORTED: vault header needs a strong ETag"))?;
    if !transport
        .put_if_match("header", &etag, serde_json::to_vec(&next_header)?)
        .await?
    {
        bail!("CONFIG_SYNC_CONFLICT: remote vault header changed while changing password");
    }
    let Some((stored, _)) = transport.get("header").await? else {
        bail!("CONFIG_SYNC_REMOTE: remote vault header disappeared after password change");
    };
    let stored: VaultHeader = serde_json::from_slice(&stored)?;
    if stored.vault_id != config.vault_id
        || unlock_vault(&stored, new_password)?.as_bytes() != key.as_bytes()
    {
        bail!("CONFIG_SYNC_CONFLICT: remote vault changed while changing password");
    }
    config.vault_header = next_header;
    let mut st = state.lock().await;
    save_config(&st, &config)?;
    public_state(&mut st)
}

pub(super) async fn restore(
    state: Arc<Mutex<AppState>>,
    params: Value,
    tx: mpsc::UnboundedSender<String>,
) -> Result<Value> {
    let revision_id = params
        .get("revisionId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: revisionId is required"))?;
    validate_remote_id(revision_id, "revision")?;
    let sync_lock = state.lock().await.config_sync_lock.clone();
    let _sync_guard = sync_lock.lock().await;
    let (mut config, key, base, local, transport) = {
        let mut st = state.lock().await;
        let config = load_config(&st)?
            .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: S3 backup is not configured"))?;
        if config.mode == SyncMode::Sync
            && !params
                .get("acknowledgePropagation")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            bail!("CONFIG_SYNC_INVALID: restore propagation warning must be acknowledged");
        }
        let key = local_vault_key(&st, &config)?
            .ok_or_else(|| anyhow!("CONFIG_SYNC_LOCKED: backup vault is locked"))?;
        if load_pending(&st, &key)?.is_some() {
            bail!("CONFIG_SYNC_CONFLICT: resolve pending changes before restoring");
        }
        let base = load_base(&st, &key)?;
        let local = domains::capture(
            &mut st,
            &key,
            &selection(&config),
            config.include_secrets,
            &config.plugin_intents,
            &identity_overrides(&config),
        )?;
        let transport = configured_transport(&st, &config)?;
        (config, key, base, local, transport)
    };
    let Some((current_head, etag)) = read_remote_head(&transport, &config, &key).await? else {
        bail!("CONFIG_SYNC_REMOTE: cannot restore from an empty vault");
    };
    let (target, resources) =
        read_remote_revision(&transport, &config, &key, revision_id, &NoSyncProgress).await?;
    {
        let st = state.lock().await;
        create_recovery_point(&st, &mut config, &key, base.clone(), local.clone())?;
        save_config(&st, &config)?;
    }
    let candidate_id = if config.mode == SyncMode::Sync {
        Uuid::new_v4().to_string()
    } else {
        target.revision_id.clone()
    };
    let candidate = LocalSnapshot {
        manifest: RevisionManifest {
            format: REVISION_FORMAT.into(),
            version: 1,
            revision_id: candidate_id.clone(),
            parents: vec![current_head.revision_id.clone()],
            created_at: Utc::now().to_rfc3339(),
            entities: target.entities.clone(),
            resource_ids: resources.keys().cloned().collect(),
        },
        resources,
    };
    if config.mode == SyncMode::Sync {
        upload_snapshot(&transport, &config, &key, &candidate, &NoSyncProgress).await?;
        let head = next_head(&candidate_id, Some(&current_head));
        if !publish_head(&transport, &config, &key, &head, Some(&etag)).await? {
            bail!("CONFIG_SYNC_CONFLICT: remote head changed while restoring");
        }
    }
    let merged = merge::MergeResult {
        entities: candidate.manifest.entities.clone(),
        conflicts: Vec::new(),
    };
    let mut pending = build_pending(
        &config,
        base.as_ref(),
        &local.manifest,
        Some(&target),
        &merged,
        &candidate_id,
        candidate.resources.clone(),
    );
    pending.manifest = candidate.manifest;
    pending.local_before = Some(local.manifest.clone());
    add_restore_approvals(&config, &local.manifest, &target, &mut pending);
    let should_apply = pending.approvals.is_empty();
    pending.journal_state = if should_apply { "applying" } else { "staged" }.into();
    {
        let st = state.lock().await;
        store_pending(&st, &key, &pending)?;
        if !should_apply {
            config.last_revision_id = Some(candidate_id);
            clear_error(&mut config);
            save_config(&st, &config)?;
        }
    }
    if should_apply {
        apply_bundle(
            &state,
            &mut config,
            &key,
            base.as_ref(),
            &local.manifest,
            &pending,
        )
        .await?;
    }
    let mut st = state.lock().await;
    send_state_notification(&tx, &mut st);
    public_state(&mut st)
}
