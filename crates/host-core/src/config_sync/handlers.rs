use super::*;

pub(crate) async fn get_state(state: Arc<Mutex<AppState>>) -> Result<Value> {
    let mut st = state.lock().await;
    public_state(&mut st)
}

pub(crate) async fn list_history(state: Arc<Mutex<AppState>>) -> Result<Value> {
    history::list_history(state).await
}

pub(crate) async fn change_password(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value> {
    history::change_password(state, params).await
}

pub(crate) async fn restore(
    state: Arc<Mutex<AppState>>,
    params: Value,
    tx: mpsc::UnboundedSender<String>,
) -> Result<Value> {
    history::restore(state, params, tx).await
}

pub(crate) async fn test(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value> {
    let (config, password) = {
        let st = state.lock().await;
        let existing = load_config(&st)?;
        let endpoint = params
            .get("endpoint")
            .and_then(Value::as_str)
            .unwrap_or_else(|| {
                existing
                    .as_ref()
                    .map(|value| value.endpoint.as_str())
                    .unwrap_or_default()
            });
        let username = params
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or_else(|| {
                existing
                    .as_ref()
                    .map(|value| value.username.as_str())
                    .unwrap_or_default()
            });
        let directory = params
            .get("directory")
            .and_then(Value::as_str)
            .unwrap_or_else(|| {
                existing
                    .as_ref()
                    .map(|value| value.directory.as_str())
                    .unwrap_or_default()
            });
        let remote_mode = params
            .get("remoteMode")
            .and_then(Value::as_str)
            .map(parse_remote_mode)
            .transpose()?
            .or_else(|| existing.as_ref().map(|value| value.remote_mode))
            .unwrap_or_default();
        let password = connection_password(
            &st,
            existing.as_ref(),
            endpoint.trim(),
            username.trim(),
            &params,
        )?;
        let vault_id = Uuid::new_v4().to_string();
        let header = create_vault("temporary-test-password", &vault_id)?.0;
        (
            StoredConfig {
                format: FORMAT.into(),
                version: 1,
                endpoint: endpoint.trim().into(),
                username: username.trim().into(),
                directory: directory.trim().into(),
                device_label: "test".into(),
                remote_mode,
                device_id: Uuid::new_v4().to_string(),
                missing_object_status: None,
                categories: default_categories(),
                include_secrets: false,
                include_memory: false,
                automatic_sync: false,
                enabled: false,
                paused: false,
                vault_id,
                vault_header: header,
                last_run_at: None,
                last_success_at: None,
                last_revision_id: None,
                last_error: None,
                last_error_code: None,
                last_local_digest: None,
                local_change_seen_at: None,
                retry_count: 0,
                next_retry_at: None,
                project_mappings: BTreeMap::new(),
                project_group_mappings: BTreeMap::new(),
                dismissed: BTreeMap::new(),
                plugin_intents: BTreeMap::new(),
                recovery_points: Vec::new(),
            },
            password,
        )
    };
    let transport = transport_with_password(&config, password)?;
    let probe = transport.probe().await?;
    Ok(json!({
        "ok": true,
        "conditionalWrites": probe.conditional_writes,
        "appendOnly": probe.append_only,
    }))
}

pub(crate) async fn configure(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value> {
    let sync_lock = {
        let st = state.lock().await;
        st.config_sync_lock.clone()
    };
    let _sync_guard = sync_lock.lock().await;
    let backup_password = params
        .get("backupPassword")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !backup_password.is_empty() && backup_password.len() < 8 {
        bail!("CONFIG_SYNC_INVALID: backup password must be at least 8 characters");
    }
    let (mut config, mut key, transport_password, had_existing) = {
        let st = state.lock().await;
        let existing = load_config(&st)?;
        let (header, key, had_existing) = if backup_password.is_empty() {
            let saved = existing.as_ref().ok_or_else(|| {
                anyhow!("CONFIG_SYNC_LOCKED: enter the vault password to set up sync")
            })?;
            let key = local_vault_key(&st, saved)?
                .ok_or_else(|| anyhow!("CONFIG_SYNC_LOCKED: backup vault is locked"))?;
            (saved.vault_header.clone(), key, true)
        } else {
            let vault_id = existing
                .as_ref()
                .map(|value| value.vault_id.clone())
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            let (header, key) = if let Some(saved) = existing.as_ref() {
                (
                    saved.vault_header.clone(),
                    unlock_vault(&saved.vault_header, backup_password)?,
                )
            } else {
                create_vault(backup_password, &vault_id)?
            };
            (header, key, existing.is_some())
        };
        let config = config_from_input(existing.as_ref(), &params, header)?;
        let transport_password = connection_password(
            &st,
            existing.as_ref(),
            &config.endpoint,
            &config.username,
            &params,
        )?;
        (config, key, transport_password, had_existing)
    };
    let app_password = params
        .get("appPassword")
        .and_then(Value::as_str)
        .map(str::to_string);
    let transport = transport_with_password(&config, transport_password.clone())?;
    let probe = transport.probe().await?;
    match config.remote_mode {
        RemoteMode::Strict if !probe.conditional_writes => {
            bail!(
                "CONFIG_SYNC_UNSUPPORTED: WebDAV server did not prove reliable conditional writes"
            );
        }
        RemoteMode::AppendOnly if !probe.append_only => {
            bail!(
                "CONFIG_SYNC_UNSUPPORTED: WebDAV server did not prove append-only directory listing"
            );
        }
        _ => {}
    }
    let transport = transport.with_probe_result(&probe);
    config.missing_object_status = probe.missing_object_status;
    transport.ensure_collection("vault").await?;
    let remote_header = transport.get("header").await?;
    if let Some((bytes, _)) = remote_header {
        let remote: VaultHeader =
            serde_json::from_slice(&bytes).context("decode remote vault header")?;
        if had_existing && config.vault_id != remote.vault_id {
            bail!("CONFIG_SYNC_CONFLICT: selected WebDAV directory belongs to another vault");
        }
        adopt_remote_vault(&mut key, &mut config, remote, backup_password)?;
    } else {
        if config.remote_mode == RemoteMode::AppendOnly {
            if had_existing {
                bail!(
                    "CONFIG_SYNC_CONFLICT: remote vault header is missing; compatibility mode will not reinitialize an existing vault"
                );
            }
            transport
                .put_unconditional("header", serde_json::to_vec(&config.vault_header)?)
                .await?;
        } else {
            let created = transport
                .put_if_none("header", serde_json::to_vec(&config.vault_header)?)
                .await?;
            if !created {
                let Some((bytes, _)) = transport.get("header").await? else {
                    bail!("CONFIG_SYNC_REMOTE: vault header disappeared during initialization");
                };
                let remote: VaultHeader = serde_json::from_slice(&bytes)?;
                adopt_remote_vault(&mut key, &mut config, remote, backup_password)?;
            }
        }
        if config.remote_mode == RemoteMode::AppendOnly {
            let Some((bytes, _)) = transport.get("header").await? else {
                bail!("CONFIG_SYNC_REMOTE: vault header disappeared during initialization");
            };
            let remote: VaultHeader = serde_json::from_slice(&bytes)?;
            if had_existing && config.vault_id != remote.vault_id {
                bail!("CONFIG_SYNC_CONFLICT: selected WebDAV directory belongs to another vault");
            }
            adopt_remote_vault(&mut key, &mut config, remote, backup_password)?;
        }
    }
    ensure_remote_collections(&transport, &config).await?;
    let mut st = state.lock().await;
    if config.username.is_empty() {
        st.secrets.delete(WEBDAV_SECRET_REF)?;
    } else if let Some(password) = app_password {
        st.secrets.set(WEBDAV_SECRET_REF, &password)?;
    }
    st.secrets.set(
        &secret_ref_for_vault(&config.vault_id),
        &vault_key_b64(&key),
    )?;
    save_config(&st, &config)?;
    public_state(&mut st)
}

pub(crate) async fn pause(state: Arc<Mutex<AppState>>, paused: bool) -> Result<Value> {
    let sync_lock = {
        let st = state.lock().await;
        st.config_sync_lock.clone()
    };
    let _sync_guard = sync_lock.lock().await;
    let mut st = state.lock().await;
    let mut config =
        load_config(&st)?.ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: sync is not configured"))?;
    config.paused = paused;
    save_config(&st, &config)?;
    public_state(&mut st)
}

pub(crate) async fn unlock(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value> {
    let sync_lock = {
        let st = state.lock().await;
        st.config_sync_lock.clone()
    };
    let _sync_guard = sync_lock.lock().await;
    let password = params
        .get("backupPassword")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: backup password is required"))?;
    let mut st = state.lock().await;
    let config =
        load_config(&st)?.ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: sync is not configured"))?;
    let key = unlock_vault(&config.vault_header, password)?;
    st.secrets.set(
        &secret_ref_for_vault(&config.vault_id),
        &vault_key_b64(&key),
    )?;
    public_state(&mut st)
}

pub(crate) async fn approve(
    state: Arc<Mutex<AppState>>,
    params: Value,
    tx: mpsc::UnboundedSender<String>,
) -> Result<Value> {
    let sync_lock = {
        let st = state.lock().await;
        st.config_sync_lock.clone()
    };
    let _sync_guard = sync_lock.lock().await;
    let approval_id = params
        .get("approvalId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: approvalId is required"))?;
    let digest = params
        .get("digest")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: approval digest is required"))?;
    let (mut config, key, mut pending) = {
        let st = state.lock().await;
        let config = load_config(&st)?
            .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: sync is not configured"))?;
        let key = local_vault_key(&st, &config)?
            .ok_or_else(|| anyhow!("CONFIG_SYNC_LOCKED: backup vault is locked"))?;
        let pending = load_pending(&st, &key)?
            .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: approval is no longer pending"))?;
        (config, key, pending)
    };
    let item_index = pending
        .approvals
        .iter()
        .position(|item| item.approval_id == approval_id)
        .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: approval is not pending"))?;
    let item = pending.approvals[item_index].clone();
    if item.entity.digest != digest {
        bail!("CONFIG_SYNC_CONFLICT: approval digest is stale");
    }
    pending.approvals[item_index].approved = true;
    if let Some(base_id) = conflict_base_id(&item.entity.entity_id) {
        let domain = item.entity.domain.clone();
        let mut dismissed = Vec::new();
        pending.approvals.retain(|candidate| {
            let is_sibling = candidate.approval_id != approval_id
                && candidate.entity.domain == domain
                && conflict_base_id(&candidate.entity.entity_id) == Some(base_id);
            if is_sibling {
                dismissed.push(candidate.entity.clone());
            }
            !is_sibling
        });
        for candidate in dismissed {
            config
                .dismissed
                .insert(approval_key(&candidate), candidate.digest);
        }
    }
    pending.journal_state = "applying".into();
    {
        let st = state.lock().await;
        store_pending(&st, &key, &pending)?;
        save_config(&st, &config)?;
    }
    let base = {
        let st = state.lock().await;
        load_base(&st, &key)?
    };
    let local = {
        let mut st = state.lock().await;
        domains::capture(
            &mut st,
            &key,
            &selection(&config),
            config.include_secrets,
            &config.plugin_intents,
            &identity_overrides(&config),
        )?
    };
    apply_bundle(
        &state,
        &mut config,
        &key,
        base.as_ref(),
        &local.manifest,
        &pending,
    )
    .await?;
    let mut st = state.lock().await;
    send_state_notification(&tx, &mut st);
    public_state(&mut st)
}

pub(crate) async fn reject(
    state: Arc<Mutex<AppState>>,
    params: Value,
    tx: mpsc::UnboundedSender<String>,
) -> Result<Value> {
    let sync_lock = {
        let st = state.lock().await;
        st.config_sync_lock.clone()
    };
    let _sync_guard = sync_lock.lock().await;
    let approval_id = params
        .get("approvalId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: approvalId is required"))?;
    let digest = params
        .get("digest")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: approval digest is required"))?;
    let mut st = state.lock().await;
    let mut config =
        load_config(&st)?.ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: sync is not configured"))?;
    let key = local_vault_key(&st, &config)?
        .ok_or_else(|| anyhow!("CONFIG_SYNC_LOCKED: backup vault is locked"))?;
    let mut pending = load_pending(&st, &key)?
        .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: approval is no longer pending"))?;
    let Some(index) = pending
        .approvals
        .iter()
        .position(|item| item.approval_id == approval_id)
    else {
        bail!("CONFIG_SYNC_INVALID: approval is not pending");
    };
    let item = pending.approvals.remove(index);
    if item.entity.digest != digest {
        bail!("CONFIG_SYNC_CONFLICT: approval digest is stale");
    }
    config
        .dismissed
        .insert(approval_key(&item.entity), item.entity.digest);
    if pending.approvals.is_empty() {
        clear_pending(&st)?;
    } else {
        store_pending(&st, &key, &pending)?;
    }
    save_config(&st, &config)?;
    send_state_notification(&tx, &mut st);
    public_state(&mut st)
}

pub(crate) async fn map_project(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value> {
    let sync_lock = {
        let st = state.lock().await;
        st.config_sync_lock.clone()
    };
    let _sync_guard = sync_lock.lock().await;
    let logical_id = params
        .get("logicalId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: mapping logicalId is required"))?;
    if logical_id.contains('/') || logical_id.contains('\\') {
        bail!("CONFIG_SYNC_INVALID: mapping logicalId is unsafe");
    }
    let mut raw_paths = params
        .get("paths")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if raw_paths.is_empty() {
        if let Some(path) = params
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            raw_paths.push(path.to_string());
        }
    }
    if raw_paths.is_empty() || raw_paths.len() > 32 {
        bail!("CONFIG_SYNC_INVALID: one to thirty-two mapping paths are required");
    }
    let mut paths = Vec::with_capacity(raw_paths.len());
    for raw_path in raw_paths {
        if fs::symlink_metadata(&raw_path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            bail!("CONFIG_SYNC_MAPPING_REQUIRED: symbolic links are not valid project mappings");
        }
        let path = fs::canonicalize(&raw_path).with_context(|| {
            "CONFIG_SYNC_MAPPING_REQUIRED: mapped project folder is unavailable"
        })?;
        if !path.is_dir() {
            bail!("CONFIG_SYNC_MAPPING_REQUIRED: mapped path is not a folder");
        }
        let normalized = crate::agent_capabilities::normalize_project_path(&path.to_string_lossy());
        if !paths.iter().any(|candidate| candidate == &normalized) {
            paths.push(normalized);
        }
    }
    if paths.is_empty() {
        bail!("CONFIG_SYNC_INVALID: mapping paths are empty");
    }
    let mut st = state.lock().await;
    let mut config =
        load_config(&st)?.ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: sync is not configured"))?;
    if logical_id.starts_with("project-group:") || paths.len() > 1 {
        config.project_mappings.remove(logical_id);
        config
            .project_group_mappings
            .insert(logical_id.to_string(), paths);
    } else {
        config.project_group_mappings.remove(logical_id);
        config
            .project_mappings
            .insert(logical_id.to_string(), paths[0].clone());
    }
    save_config(&st, &config)?;
    public_state(&mut st)
}

pub(crate) async fn disconnect(state: Arc<Mutex<AppState>>) -> Result<Value> {
    let sync_lock = {
        let st = state.lock().await;
        st.config_sync_lock.clone()
    };
    let _sync_guard = sync_lock.lock().await;
    let mut st = state.lock().await;
    if let Some(config) = load_config(&st)? {
        st.secrets.delete(WEBDAV_SECRET_REF)?;
        st.secrets.delete(&secret_ref_for_vault(&config.vault_id))?;
        st.db.kv_delete(CONFIG_NS, CONFIG_KEY)?;
        for file in ["base.bin", "pending.bin"] {
            let path = local_path(&st, file);
            if path.exists() {
                fs::remove_file(path)?;
            }
        }
    }
    public_state(&mut st)
}

/// A saved WebDAV password belongs to one endpoint and account. Changing either
/// must not send the previous server's secret.
fn connection_password(
    st: &AppState,
    existing: Option<&StoredConfig>,
    endpoint: &str,
    username: &str,
    params: &Value,
) -> Result<String> {
    if username.is_empty() {
        return Ok(String::new());
    }
    let explicit = params.get("appPassword").and_then(Value::as_str);
    let password = match explicit {
        Some(value) => Some(value.to_string()),
        None if existing
            .is_some_and(|saved| saved.endpoint == endpoint && saved.username == username) =>
        {
            st.secrets.get(WEBDAV_SECRET_REF)?
        }
        None => None,
    };
    password.filter(|value| !value.is_empty()).ok_or_else(|| {
        anyhow!("CONFIG_SYNC_AUTH: enter the WebDAV app password for this server and account")
    })
}

fn adopt_remote_vault(
    key: &mut VaultKey,
    config: &mut StoredConfig,
    remote: VaultHeader,
    password: &str,
) -> Result<()> {
    if password.is_empty() {
        if config.vault_id != remote.vault_id {
            bail!("CONFIG_SYNC_LOCKED: enter the vault password to open this backup");
        }
        config.vault_header = remote;
        return Ok(());
    }
    *key = unlock_vault(&remote, password)?;
    config.vault_id = remote.vault_id.clone();
    config.vault_header = remote;
    Ok(())
}

#[cfg(test)]
mod credential_tests {
    use super::*;

    #[test]
    fn stored_password_stays_on_its_server_and_pause_survives_a_resave() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let state = AppState::open(dir.path())?;
        state.secrets.set(WEBDAV_SECRET_REF, "original-secret")?;
        let (header, _) = create_vault("backup-password", "test-vault")?;
        let mut config = config_from_input(
            None,
            &json!({
                "endpoint": "https://original.example/dav/",
                "username": "alice",
                "deviceLabel": "test"
            }),
            header.clone(),
        )?;
        config.paused = true;
        assert_eq!(
            connection_password(&state, Some(&config), &config.endpoint, "alice", &json!({}))?,
            "original-secret"
        );
        let resent = config_from_input(
            Some(&config),
            &json!({
                "endpoint": config.endpoint,
                "username": "alice",
                "deviceLabel": "test"
            }),
            header,
        )?;
        assert!(resent.paused);
        for (endpoint, username) in [
            ("https://other.example/dav/", "alice"),
            ("https://original.example/dav/", "bob"),
        ] {
            let error = connection_password(&state, Some(&config), endpoint, username, &json!({}))
                .unwrap_err();
            assert!(error.to_string().starts_with("CONFIG_SYNC_AUTH:"));
        }
        assert_eq!(
            connection_password(
                &state,
                Some(&config),
                "https://other.example/",
                "",
                &json!({})
            )?,
            ""
        );
        Ok(())
    }
}
