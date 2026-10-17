use super::*;

/// Keeps "a sync is running" true for as long as the run lives, and clears it
/// however the run ends, so an early return cannot leave the flag set.
struct SyncRunGuard(Arc<AtomicBool>);

impl SyncRunGuard {
    fn start(flag: Arc<AtomicBool>) -> Self {
        flag.store(true, Ordering::Relaxed);
        Self(flag)
    }
}

impl Drop for SyncRunGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

pub(super) async fn sync_once(
    state: &Arc<Mutex<AppState>>,
    tx: &mpsc::UnboundedSender<String>,
    observer: &dyn SyncProgressObserver,
) -> Result<()> {
    let lock = {
        let st = state.lock().await;
        st.config_sync_lock.clone()
    };
    let _guard = lock.lock().await;
    let progress = {
        let st = state.lock().await;
        SyncRunGuard::start(st.config_sync_in_progress.clone())
    };
    let _progress = progress;
    {
        let mut st = state.lock().await;
        send_state_notification(tx, &mut st);
    }
    for _attempt in 0..MAX_RETRIES {
        let (config, key, base, local, local_before, local_digest) = {
            let mut st = state.lock().await;
            let mut config = load_config(&st)?
                .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: sync is not configured"))?;
            if config.paused {
                return Ok(());
            }
            let key = local_vault_key(&st, &config)?
                .ok_or_else(|| anyhow!("CONFIG_SYNC_LOCKED: backup vault is locked"))?;
            let pending_waiting_for_approval = if let Some(pending) = load_pending(&st, &key)? {
                if pending.journal_state == "applying" {
                    recover_import_journal(&mut st, &mut config, &key, &pending)?;
                }
                load_pending(&st, &key)?.is_some_and(|pending| !pending.approvals.is_empty())
            } else {
                false
            };
            let baseline = baseline::load(&st, &key)?;
            let base = baseline.as_ref().map(|value| value.shared.clone());
            observer.report(SyncProgress::started(SyncPhase::Capture));
            let mut local = domains::capture(
                &mut st,
                &key,
                &selection(&config),
                config.include_secrets,
                &config.plugin_intents,
                &identity_overrides(&config),
            )?;
            let local_digest = domains::snapshot_digest(&local);
            let local_before = local.manifest.clone();
            if config.mode == SyncMode::Sync {
                if let Some(baseline) = &baseline {
                    baseline::merge_input(&mut local.manifest, baseline, config.include_secrets);
                }
            }
            observer.report(SyncProgress::counted(
                SyncPhase::Capture,
                local.manifest.entities.len() as u64,
                local.manifest.entities.len() as u64,
                0,
                0,
            ));
            if pending_waiting_for_approval
                && config.last_local_digest.as_deref() == Some(local_digest.as_str())
            {
                // Keep an unresolved remote import staged without publishing
                // a new identical revision on every scheduler tick. A local
                // edit changes this digest and is still allowed to reconcile
                // with unrelated remote edits.
                return Ok(());
            }
            merge::snapshot_with_tombstones(base.as_ref(), &mut local, &selection(&config));
            config.last_run_at = Some(Utc::now().to_rfc3339());
            save_config(&st, &config)?;
            (config, key, base, local, local_before, local_digest)
        };
        let transport = {
            let st = state.lock().await;
            configured_transport(&st, &config)?
        };
        let remote_head = read_remote_head(&transport, &config, &key).await?;
        if remote_head.is_none() && config.last_revision_id.is_some() {
            bail!(
                "CONFIG_SYNC_REMOTE: configured remote head is missing; refusing to overwrite recovery history"
            );
        }
        let (mut remote, remote_resources) = if config.mode == SyncMode::Sync {
            if let Some((head, _)) = remote_head.as_ref() {
                let (manifest, resources) =
                    read_remote_revision(&transport, &config, &key, &head.revision_id, observer)
                        .await?;
                (Some(manifest), resources)
            } else {
                (None, BTreeMap::new())
            }
        } else {
            (None, BTreeMap::new())
        };
        let resolved_conflicts = remote
            .as_mut()
            .is_some_and(|remote| conflicts::reconcile(&config.resolved_conflicts, remote));
        let remote_parent_ids = remote_head
            .as_ref()
            .map(|(head, _)| vec![head.revision_id.clone()])
            .unwrap_or_default();
        observer.report(SyncProgress::started(SyncPhase::Merge));
        let merged = if config.mode == SyncMode::Backup {
            if config.last_local_digest.as_deref() == Some(&local_digest) && remote_head.is_some() {
                let mut st = state.lock().await;
                let mut next_config = config.clone();
                next_config.last_success_at = Some(Utc::now().to_rfc3339());
                clear_error(&mut next_config);
                save_config(&st, &next_config)?;
                send_state_notification(tx, &mut st);
                return Ok(());
            }
            merge::MergeResult {
                entities: local.manifest.entities.clone(),
                conflicts: Vec::new(),
            }
        } else {
            merge::three_way(base.as_ref(), &local.manifest, remote.as_ref())?
        };
        {
            observer.report(SyncProgress::counted(
                SyncPhase::Merge,
                merged.entities.len() as u64,
                merged.entities.len() as u64,
                0,
                0,
            ));
            if let (Some(remote), true) = (remote.as_ref(), !remote_parent_ids.is_empty()) {
                // Skip publication when the acknowledged base, current local
                // snapshot, and remote head agree for every subscribed domain.
                // A remote-only change in an opted-out category is already
                // represented by the remote head. A fresh device with selected
                // remote content still has to stage it for approval and
                // activation, even though the merge result equals the remote
                // entities.
                let no_selected_change = !resolved_conflicts
                    && selected_manifests_equal(base.as_ref(), Some(remote), &selection(&config))
                    && selected_manifests_equal(
                        Some(&local.manifest),
                        Some(remote),
                        &selection(&config),
                    )
                    && merged.conflicts.is_empty()
                    && remote.entities == merged.entities;
                if no_selected_change {
                    let mut st = state.lock().await;
                    let mut next_config = config.clone();
                    next_config.last_success_at = Some(Utc::now().to_rfc3339());
                    next_config.last_revision_id = remote_parent_ids.first().cloned();
                    next_config.last_local_digest = Some(local_digest);
                    next_config.local_change_seen_at = None;
                    clear_error(&mut next_config);
                    save_config(&st, &next_config)?;
                    send_state_notification(tx, &mut st);
                    return Ok(());
                }
            }
        }
        let mut resources = local.resources.clone();
        resources.extend(remote_resources);
        let referenced = merged
            .entities
            .iter()
            .flat_map(|entity| entity.resource_ids.iter().cloned())
            .collect::<BTreeSet<_>>();
        resources.retain(|id, _| referenced.contains(id));
        let revision_id = Uuid::new_v4().to_string();
        let candidate = LocalSnapshot {
            manifest: RevisionManifest {
                format: REVISION_FORMAT.into(),
                version: 1,
                revision_id: revision_id.clone(),
                parents: remote_parent_ids.clone(),
                created_at: Utc::now().to_rfc3339(),
                entities: merged.entities.clone(),
                resource_ids: resources.keys().cloned().collect(),
            },
            resources,
        };
        upload_snapshot(&transport, &config, &key, &candidate, observer).await?;
        let head = next_head(
            &candidate.manifest.revision_id,
            remote_head.as_ref().map(|(head, _)| head),
        );
        let published = publish_head(
            &transport,
            &config,
            &key,
            &head,
            remote_head.as_ref().map(|(_, etag)| etag.as_str()),
        )
        .await?;
        if !published {
            let jitter_ms = u64::from(Uuid::new_v4().as_bytes()[0] % 31);
            tokio::time::sleep(std::time::Duration::from_millis(
                50 * (_attempt as u64 + 1) + jitter_ms,
            ))
            .await;
            continue;
        }
        if config.mode == SyncMode::Backup {
            let mut st = state.lock().await;
            let mut next_config = config.clone();
            baseline::store(&st, &key, &candidate.manifest, &local_before)?;
            next_config.last_success_at = Some(Utc::now().to_rfc3339());
            next_config.last_revision_id = Some(candidate.manifest.revision_id.clone());
            next_config.last_local_digest = Some(local_digest);
            next_config.local_change_seen_at = None;
            clear_error(&mut next_config);
            save_config(&st, &next_config)?;
            send_state_notification(tx, &mut st);
            return Ok(());
        }
        let pending = build_pending(
            &config,
            base.as_ref(),
            &local_before,
            remote.as_ref(),
            &merged,
            &candidate.manifest.revision_id,
            candidate.resources.clone(),
        );
        {
            let st = state.lock().await;
            let mut journal = pending.clone();
            journal.journal_state = "applying".into();
            store_pending(&st, &key, &journal)?;
        }
        let mut next_config = config.clone();
        let candidate_revision_id = candidate.manifest.revision_id.clone();
        let apply_bundle_state = PendingBundle {
            manifest: candidate.manifest,
            local_before: Some(local_before.clone()),
            resources: candidate.resources,
            approvals: pending.approvals,
            conflicts: pending.conflicts,
            journal_state: "applying".into(),
            remote_revision_id: candidate_revision_id,
        };
        observer.report(SyncProgress::started(SyncPhase::Apply));
        let applied_entities = apply_bundle_state.manifest.entities.len() as u64;
        apply_bundle(
            state,
            &mut next_config,
            &key,
            base.as_ref(),
            &local_before,
            &apply_bundle_state,
        )
        .await?;
        observer.report(SyncProgress::counted(
            SyncPhase::Apply,
            applied_entities,
            applied_entities,
            0,
            0,
        ));
        let mut st = state.lock().await;
        send_state_notification(tx, &mut st);
        return Ok(());
    }
    bail!("CONFIG_SYNC_CONFLICT: remote head changed while publishing")
}

/// Runs one sync driven by the user: the manual path, with progress carried to
/// the renderer as `configSync.progress`.
pub(crate) async fn sync_now(
    state: Arc<Mutex<AppState>>,
    tx: mpsc::UnboundedSender<String>,
) -> Result<Value> {
    let observer = ProgressNotifier::new(tx.clone());
    sync_now_with(state, tx, &observer).await
}

/// Runs one sync with the observer the caller installed, and records the same
/// failure bookkeeping either way: a background poll and a manual run must not
/// differ in what they record about a failure.
pub(crate) async fn sync_now_with(
    state: Arc<Mutex<AppState>>,
    tx: mpsc::UnboundedSender<String>,
    observer: &dyn SyncProgressObserver,
) -> Result<Value> {
    if let Err(error) = sync_once(&state, &tx, observer).await {
        let mut st = state.lock().await;
        if let Some(mut config) = load_config(&st)? {
            mark_error(&mut config, &error);
            config.retry_count = config.retry_count.saturating_add(1).min(8);
            let backoff = 2_i64.saturating_pow(config.retry_count.min(8)).min(300);
            let jitter = i64::from(Uuid::new_v4().as_bytes()[0] % 7);
            config.next_retry_at =
                Some((Utc::now() + chrono::Duration::seconds(backoff + jitter)).to_rfc3339());
            save_config(&st, &config)?;
        }
        send_state_notification(&tx, &mut st);
        return Err(error);
    }
    get_state(state).await
}
/// Run the configured foreground/background poll. The host process owns this
/// task so the renderer and Electron main never become a second scheduler.
pub(crate) async fn sync_if_enabled(
    state: Arc<Mutex<AppState>>,
    tx: mpsc::UnboundedSender<String>,
) -> Result<()> {
    const LOCAL_DEBOUNCE_SECONDS: i64 = 30;
    const REMOTE_POLL_SECONDS: i64 = 300;
    let should_sync = {
        let mut st = state.lock().await;
        let Some(mut config) = load_config(&st)? else {
            return Ok(());
        };
        if !config.enabled
            || !config.automatic_sync
            || config.paused
            || matches!(
                config.last_error_code.as_deref(),
                Some("LOCKED" | "AUTH_REQUIRED" | "UNSUPPORTED_SERVER")
            )
        {
            return Ok(());
        }
        if retry_deadline(&config).is_some_and(|deadline| deadline > Utc::now()) {
            return Ok(());
        }
        let key = local_vault_key(&st, &config)?;
        let Some(key) = key else {
            return Ok(());
        };
        let snapshot = domains::capture(
            &mut st,
            &key,
            &selection(&config),
            config.include_secrets,
            &config.plugin_intents,
            &identity_overrides(&config),
        )?;
        let digest = domains::snapshot_digest(&snapshot);
        let now = Utc::now();
        let local_changed = config
            .last_local_digest
            .as_deref()
            .is_some_and(|expected| expected != digest);
        if local_changed {
            let seen_at = config
                .local_change_seen_at
                .as_deref()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .map(|value| value.with_timezone(&Utc));
            if seen_at.is_none_or(|seen| {
                now.signed_duration_since(seen).num_seconds() < LOCAL_DEBOUNCE_SECONDS
            }) {
                if config.local_change_seen_at.is_none() {
                    config.local_change_seen_at = Some(now.to_rfc3339());
                    save_config(&st, &config)?;
                }
                return Ok(());
            }
            true
        } else {
            if config.local_change_seen_at.take().is_some() {
                save_config(&st, &config)?;
            }
            config
                .last_success_at
                .as_deref()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .map(|value| value.with_timezone(&Utc))
                .is_none_or(|last| {
                    now.signed_duration_since(last).num_seconds() >= REMOTE_POLL_SECONDS
                })
        }
    };
    if should_sync {
        sync_now_with(state, tx, &NoSyncProgress).await.map(|_| ())
    } else {
        Ok(())
    }
}
