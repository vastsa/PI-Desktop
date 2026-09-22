use super::*;

pub(super) async fn history_chain(
    transport: &WebDavTransport,
    config: &StoredConfig,
    key: &VaultKey,
    head_revision_id: &str,
) -> Result<Vec<RevisionManifest>> {
    let mut pending = vec![head_revision_id.to_string()];
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    while let Some(revision_id) = pending.pop() {
        if !seen.insert(revision_id.clone()) {
            continue;
        }
        if seen.len() > MAX_HISTORY_SCAN {
            bail!("CONFIG_SYNC_LIMIT_EXCEEDED: remote history is too large");
        }
        let manifest = read_remote_manifest(transport, config, key, &revision_id).await?;
        for parent in manifest.parents.iter().rev() {
            pending.push(parent.clone());
        }
        result.push(manifest);
    }
    Ok(result)
}

fn older_than_grace(manifest: &RevisionManifest) -> bool {
    let Ok(created_at) = chrono::DateTime::parse_from_rfc3339(&manifest.created_at) else {
        return false;
    };
    Utc::now()
        .signed_duration_since(created_at.with_timezone(&Utc))
        .num_seconds()
        >= HISTORY_GRACE_SECONDS
}

pub(super) async fn cleanup_history(
    state: &Arc<Mutex<AppState>>,
    transport: &WebDavTransport,
    config: &StoredConfig,
    key: &VaultKey,
) -> Result<()> {
    let Some((head, _)) = read_remote_head(transport, config, key).await? else {
        return Ok(());
    };
    let history = history_chain(transport, config, key, &head.revision_id).await?;
    if history.len() <= MAX_RETAINED_REVISIONS {
        return Ok(());
    }
    let (base_id, protected_ids, protected_resources) = {
        let st = state.lock().await;
        let base_id = load_base(&st, key)?.map(|value| value.revision_id);
        let pending = load_pending(&st, key)?;
        let mut protected = BTreeSet::new();
        let mut resources = BTreeSet::new();
        if let Some(pending) = pending {
            protected.insert(pending.manifest.revision_id);
            protected.insert(pending.remote_revision_id);
            resources.extend(pending.manifest.resource_ids);
        }
        for filename in &config.recovery_points {
            let path = recovery_path(&st, filename)?;
            if let Some(point) = load_encrypted::<RecoveryPoint>(&st, key, "local-recovery", &path)?
            {
                if let Some(base) = point.base {
                    protected.insert(base.revision_id);
                    resources.extend(base.resource_ids);
                }
            }
        }
        (base_id, protected, resources)
    };
    let mut keep = BTreeSet::new();
    for manifest in history.iter().take(MAX_RETAINED_REVISIONS) {
        keep.insert(manifest.revision_id.clone());
    }
    keep.insert(head.revision_id.clone());
    if let Some(base_id) = base_id {
        keep.insert(base_id);
    }
    keep.extend(protected_ids);

    let mut deletable = Vec::new();
    for manifest in history {
        if !keep.contains(&manifest.revision_id) && older_than_grace(&manifest) {
            deletable.push(manifest);
        }
    }
    if deletable.is_empty() {
        return Ok(());
    }
    let mut retained_resources: BTreeSet<String> =
        history_chain(transport, config, key, &head.revision_id)
            .await?
            .into_iter()
            .filter(|manifest| keep.contains(&manifest.revision_id))
            .flat_map(|manifest| manifest.resource_ids)
            .collect();
    retained_resources.extend(protected_resources);
    let mut candidate_resources = BTreeSet::new();
    for manifest in &deletable {
        candidate_resources.extend(manifest.resource_ids.iter().cloned());
        transport
            .delete(&revision_path(config, &manifest.revision_id)?)
            .await?;
    }
    for resource_id in candidate_resources.difference(&retained_resources) {
        transport.delete(&object_path(config, resource_id)?).await?;
    }
    Ok(())
}

pub(super) async fn list_history(state: Arc<Mutex<AppState>>) -> Result<Value> {
    let (config, key, transport_password) = {
        let st = state.lock().await;
        let config = load_config(&st)?
            .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: sync is not configured"))?;
        let key = local_vault_key(&st, &config)?
            .ok_or_else(|| anyhow!("CONFIG_SYNC_LOCKED: backup vault is locked"))?;
        let password = webdav_password(&st, &config)?;
        (config, key, password)
    };
    let transport = transport_with_password(&config, transport_password)?;
    let Some((head, _)) = read_remote_head(&transport, &config, &key).await? else {
        return Ok(json!([]));
    };
    let history = history_chain(&transport, &config, &key, &head.revision_id).await?;
    Ok(serde_json::to_value(
        history
            .into_iter()
            .map(|manifest| PublicHistoryEntry {
                current: manifest.revision_id == head.revision_id,
                revision_id: manifest.revision_id,
                created_at: manifest.created_at,
                parent_revision_ids: manifest.parents,
                entity_count: manifest.entities.len(),
                resource_count: manifest.resource_ids.len(),
            })
            .collect::<Vec<_>>(),
    )?)
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
            .is_none_or(|current| current.digest != entity.digest);
        if changed && !existing.contains(&entity_key(entity)) {
            pending.approvals.push(PendingApproval {
                approval_id: Uuid::new_v4().to_string(),
                entity: entity.clone(),
                reason: if entity.mapping_required {
                    "mapping".into()
                } else {
                    "securityChange".into()
                },
                approved: false,
            });
        }
    }
}

pub(super) async fn change_password(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value> {
    let sync_lock = {
        let st = state.lock().await;
        st.config_sync_lock.clone()
    };
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
    let (mut config, key, transport_password) = {
        let st = state.lock().await;
        let config = load_config(&st)?
            .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: sync is not configured"))?;
        let key = unlock_vault(&config.vault_header, current_password)?;
        let password = webdav_password(&st, &config)?;
        (config, key, password)
    };
    let transport = transport_with_password(&config, transport_password)?;
    let Some((remote_header_bytes, remote_etag)) = transport.get("header").await? else {
        bail!("CONFIG_SYNC_REMOTE: remote vault header is missing");
    };
    let remote_etag = remote_etag.ok_or_else(|| {
        anyhow!("CONFIG_SYNC_UNSUPPORTED: remote vault header does not expose a strong ETag")
    })?;
    let remote_header: VaultHeader =
        serde_json::from_slice(&remote_header_bytes).context("decode remote vault header")?;
    if remote_header.vault_id != config.vault_id {
        bail!("CONFIG_SYNC_CONFLICT: selected WebDAV directory belongs to another vault");
    }
    let remote_key = unlock_vault(&remote_header, current_password)?;
    if remote_key.as_bytes() != key.as_bytes() {
        bail!("CONFIG_SYNC_CONFLICT: local and remote vault keys do not match");
    }
    let next_header = rewrap_vault(&remote_header, &key, new_password)?;
    let published = transport
        .put_if_match("header", &remote_etag, serde_json::to_vec(&next_header)?)
        .await?;
    if !published {
        bail!("CONFIG_SYNC_CONFLICT: remote vault header changed while changing password");
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
    if !params
        .get("acknowledgePropagation")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        bail!("CONFIG_SYNC_INVALID: restore propagation warning must be acknowledged");
    }
    let revision_id = params
        .get("revisionId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: revisionId is required"))?;
    validate_remote_id(revision_id, "revision")?;
    let sync_lock = {
        let st = state.lock().await;
        st.config_sync_lock.clone()
    };
    let _sync_guard = sync_lock.lock().await;
    let (mut config, key, base, local, transport_password) = {
        let mut st = state.lock().await;
        let config = load_config(&st)?
            .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: sync is not configured"))?;
        let key = local_vault_key(&st, &config)?
            .ok_or_else(|| anyhow!("CONFIG_SYNC_LOCKED: backup vault is locked"))?;
        let base = load_base(&st, &key)?;
        let local = domains::capture(
            &mut st,
            &key,
            &selection(&config),
            config.include_secrets,
            &config.plugin_intents,
            &identity_overrides(&config),
        )?;
        let password = webdav_password(&st, &config)?;
        (config, key, base, local, password)
    };
    let transport = transport_with_password(&config, transport_password)?;
    let Some((current_head, current_etag)) = read_remote_head(&transport, &config, &key).await?
    else {
        bail!("CONFIG_SYNC_REMOTE: cannot restore from an empty vault");
    };
    let (target, target_resources) =
        read_remote_revision(&transport, &config, &key, revision_id).await?;
    let candidate_id = Uuid::new_v4().to_string();
    let candidate = LocalSnapshot {
        manifest: RevisionManifest {
            format: REVISION_FORMAT.into(),
            version: 1,
            revision_id: candidate_id.clone(),
            parents: vec![current_head.revision_id.clone()],
            created_at: Utc::now().to_rfc3339(),
            entities: target.entities.clone(),
            resource_ids: target_resources.keys().cloned().collect(),
        },
        resources: target_resources,
    };
    upload_snapshot(&transport, &config, &key, &candidate).await?;
    if !publish_head(
        &transport,
        &config,
        &key,
        &RemoteHead {
            format: FORMAT.into(),
            version: 1,
            revision_id: candidate_id.clone(),
        },
        Some(&current_etag),
    )
    .await?
    {
        bail!("CONFIG_SYNC_CONFLICT: remote head changed while restoring");
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
    pending.manifest = candidate.manifest.clone();
    pending.local_before = Some(local.manifest.clone());
    add_restore_approvals(&config, &local.manifest, &target, &mut pending);
    let should_apply = pending.approvals.is_empty();
    {
        let st = state.lock().await;
        create_recovery_point(&st, &mut config, &key, base.clone(), local.clone())?;
        let mut journal = pending.clone();
        journal.journal_state = if should_apply { "applying" } else { "staged" }.into();
        store_pending(&st, &key, &journal)?;
        if !should_apply {
            config.last_success_at = Some(Utc::now().to_rfc3339());
            config.last_revision_id = Some(candidate_id.clone());
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
    if let Err(error) = cleanup_history(&state, &transport, &config, &key).await {
        tracing::warn!(error = %error, "config sync history cleanup failed after restore");
    }
    let mut st = state.lock().await;
    send_state_notification(&tx, &mut st);
    public_state(&mut st)
}
