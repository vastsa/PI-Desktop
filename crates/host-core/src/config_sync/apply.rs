use super::*;

fn mapped_project_paths(config: &StoredConfig, payload: &Value) -> Result<Option<Vec<String>>> {
    let logical_ids = [
        payload.get("projectGroupLogicalId"),
        payload.get("projectLogicalId"),
        payload.get("workspaceProjectLogicalId"),
        payload.get("logicalId"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .collect::<Vec<_>>();
    if logical_ids.is_empty() {
        return Ok(None);
    }
    let paths = logical_ids
        .iter()
        .find_map(|logical_id| config.project_group_mappings.get(*logical_id).cloned())
        .or_else(|| {
            logical_ids.iter().find_map(|logical_id| {
                config
                    .project_mappings
                    .get(*logical_id)
                    .map(|path| vec![path.clone()])
            })
        })
        .ok_or_else(|| anyhow!("CONFIG_SYNC_MAPPING_REQUIRED: project folder is not mapped"))?;
    if paths.is_empty() {
        bail!("CONFIG_SYNC_MAPPING_REQUIRED: project folder is not mapped");
    }
    for path in &paths {
        if !Path::new(path).is_dir() {
            bail!("CONFIG_SYNC_MAPPING_REQUIRED: mapped project folder is unavailable");
        }
    }
    Ok(Some(paths))
}

fn mapped_project_path(config: &StoredConfig, payload: &Value) -> Result<Option<String>> {
    let Some(paths) = mapped_project_paths(config, payload)? else {
        return Ok(None);
    };
    let position = payload
        .get("projectRootPosition")
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    if let Some(position) = position {
        if let Some(path) = paths.get(position) {
            return Ok(Some(path.clone()));
        }
        bail!("CONFIG_SYNC_MAPPING_REQUIRED: project root mapping is incomplete");
    }
    Ok(paths.into_iter().next())
}

fn required_resource(bundle: &PendingBundle, entity: &PortableEntity) -> Result<String> {
    let id = entity
        .resource_ids
        .first()
        .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: portable entity has no resource"))?;
    let bytes = bundle
        .resources
        .get(id)
        .ok_or_else(|| anyhow!("CONFIG_SYNC_REMOTE: portable resource is missing"))?;
    String::from_utf8(bytes.clone()).context("portable resource is not UTF-8")
}

fn require_provider_reference(st: &AppState, value: &Value, context: &str) -> Result<()> {
    let Some(provider_id) = value.get("providerId").and_then(Value::as_str) else {
        return Ok(());
    };
    if providers::get_provider(&st.db, &st.secrets, provider_id)?.is_none() {
        bail!("CONFIG_SYNC_DEPENDENCY: {context} references missing provider {provider_id}");
    }
    Ok(())
}

pub(crate) fn validate_application_references(st: &AppState, payload: &Value) -> Result<()> {
    for provider_key in ["defaultProviderId", "promptEnhancementProviderId"] {
        let Some(provider_id) = payload.get(provider_key).and_then(Value::as_str) else {
            continue;
        };
        if providers::get_provider(&st.db, &st.secrets, provider_id)?.is_none() {
            bail!(
                "CONFIG_SYNC_DEPENDENCY: {provider_key} references missing provider {provider_id}"
            );
        }
    }
    if let Some(binding) = payload.get("imageGeneration") {
        require_provider_reference(st, binding, "imageGeneration")?;
    }
    if let Some(bindings) = payload
        .get("imageGenerationModels")
        .and_then(Value::as_array)
    {
        for binding in bindings {
            require_provider_reference(st, binding, "imageGenerationModels")?;
        }
    }
    if let Some(speech) = payload.get("speech").and_then(Value::as_object) {
        for (role, binding) in speech {
            require_provider_reference(st, binding, &format!("speech.{role}"))?;
        }
    }
    Ok(())
}

fn apply_entity(
    st: &mut AppState,
    config: &mut StoredConfig,
    bundle: &PendingBundle,
    entity: &PortableEntity,
) -> Result<()> {
    if entity.domain == domains::DOMAIN_APPLICATION {
        validate_application_references(st, &entity.payload)?;
        let mut current = st.db.get_setting("app")?.unwrap_or_else(|| json!({}));
        apply_application_fields(&mut current, &entity.payload);
        return st.db.set_setting("app", &current);
    }
    if entity.domain == domains::DOMAIN_PROVIDERS {
        let provider_id = entity
            .payload
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| entity.entity_id.strip_prefix("provider:"))
            .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: provider entity id is invalid"))?;
        if entity.deleted {
            let _ = providers::delete_provider(&st.db, &st.secrets, provider_id)?;
            return Ok(());
        }
        let mut payload = entity.payload.clone();
        let secret_value = payload
            .get("portableApiKey")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(object) = payload.as_object_mut() {
            object.remove("portableApiKey");
            object.insert("id".into(), Value::String(provider_id.into()));
            if let Some(secret) = secret_value.as_ref() {
                object.insert("secretValue".into(), Value::String(secret.clone()));
            }
        }
        // A bundle from a peer on an older build, or a backup taken before the
        // header rule was tightened, can carry a value this build refuses. That
        // is dropped here — the rule `config_headers` already applies when
        // reading a store — so one stale row cannot fail the whole revision,
        // which is what the strict write the editor goes through would do.
        providers::retain_storable_headers(&mut payload);
        let exists = st
            .db
            .conn()
            .query_row(
                "SELECT 1 FROM providers WHERE id = ?1",
                rusqlite::params![provider_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        let missing_portable_secret = entity.secret_bearing && secret_value.is_none();
        if exists {
            let input: ProviderUpdateInput = serde_json::from_value(payload)?;
            providers::update_provider(&st.db, &st.secrets, input)?;
        } else {
            let input: ProviderCreateInput = serde_json::from_value(payload)?;
            providers::create_provider_with_id(&st.db, &st.secrets, provider_id, input)?;
            if missing_portable_secret {
                st.db.conn().execute(
                    "UPDATE providers SET enabled = 0 WHERE id = ?1",
                    rusqlite::params![provider_id],
                )?;
            }
        }
        return Ok(());
    }
    if entity.domain == domains::DOMAIN_MCP {
        let mut payload = entity.payload.clone();
        if let Some(path) = mapped_project_path(config, &payload)? {
            if let Some(object) = payload.as_object_mut() {
                object.remove("projectLogicalId");
                object.insert("projectPath".into(), Value::String(path));
                object.insert("level".into(), Value::String("project".into()));
            }
        }
        let input: McpServerInput = serde_json::from_value(payload)?;
        let mut input = input;
        if entity.secret_bearing && input.env.is_none() && input.headers.is_none() {
            // A credential-excluded MCP record is retained as an explicit,
            // disabled definition. Approval alone must not claim it is ready
            // to send requests without the device-local secret values.
            input.enabled = Some(false);
        }
        if entity.deleted {
            let level = input
                .level
                .as_deref()
                .and_then(|value| CapabilityLevel::parse(Some(value)).ok());
            let _ = st
                .mcp_servers
                .remove(&input.id, level, input.project_path.as_deref())?;
        } else {
            st.mcp_servers.upsert(input)?;
        }
        return Ok(());
    }
    if entity.domain == domains::DOMAIN_SKILLS {
        let mut input: crate::user_skills::UserSkillInput =
            serde_json::from_value(entity.payload.clone())?;
        if let Some(path) = mapped_project_path(config, &entity.payload)? {
            input.project_path = Some(path);
            input.level = Some("project".into());
        }
        if !entity.deleted {
            input.body = Some(required_resource(bundle, entity)?);
        }
        let package_files =
            entity
                .payload
                .get("packageFiles")
                .and_then(Value::as_array)
                .map(|descriptors| {
                    descriptors
                        .iter()
                        .map(|descriptor| {
                            let path = descriptor.get("path").and_then(Value::as_str).ok_or_else(
                                || anyhow!("CONFIG_SYNC_INVALID: skill package path is missing"),
                            )?;
                            let resource_id = descriptor
                                .get("resourceId")
                                .and_then(Value::as_str)
                                .ok_or_else(|| {
                                    anyhow!(
                                        "CONFIG_SYNC_INVALID: skill package resource is missing"
                                    )
                                })?;
                            let bytes =
                                bundle.resources.get(resource_id).cloned().ok_or_else(|| {
                                    anyhow!("CONFIG_SYNC_REMOTE: skill package resource is missing")
                                })?;
                            Ok((path.to_string(), bytes))
                        })
                        .collect::<Result<Vec<_>>>()
                })
                .transpose()?
                .unwrap_or_default();
        if !package_files.is_empty() {
            input.shape = Some("dir".into());
        }
        let id = input.id.clone().unwrap_or_default();
        let package_project_path = input.project_path.clone();
        let level = input
            .level
            .as_deref()
            .and_then(|value| CapabilityLevel::parse(Some(value)).ok());
        if entity.deleted {
            if !id.is_empty() {
                st.user_skills
                    .remove(&id, level, input.project_path.as_deref())?;
            }
        } else if st.user_skills.update(&id, input.clone())?.is_none() {
            st.user_skills.create(input)?;
        }
        if !entity.deleted {
            st.user_skills.write_package_files(
                &id,
                level.unwrap_or(CapabilityLevel::Global),
                package_project_path.as_deref(),
                &package_files,
            )?;
        }
        return Ok(());
    }
    if entity.domain == domains::DOMAIN_SUBAGENTS {
        let mut input: crate::user_subagents::UserSubagentInput =
            serde_json::from_value(entity.payload.clone())?;
        if !entity.deleted {
            input.body = Some(required_resource(bundle, entity)?);
        }
        let id = input.id.clone().unwrap_or_default();
        if entity.deleted {
            st.user_subagents.remove(&id)?;
        } else if st.user_subagents.update(&id, input.clone())?.is_none() {
            st.user_subagents.create(input)?;
        }
        return Ok(());
    }
    if entity.domain == domains::DOMAIN_MEMORY {
        let Some(paths) = mapped_project_paths(config, &entity.payload)? else {
            bail!("CONFIG_SYNC_MAPPING_REQUIRED: project memory needs a local folder");
        };
        let group_logical_id = entity
            .payload
            .get("projectGroupLogicalId")
            .and_then(Value::as_str);
        let is_group_memory =
            group_logical_id.is_some() && entity.payload.get("projectRootPosition").is_none();
        if is_group_memory {
            let group = st.db.stored_project_group_for_path(&paths[0])?;
            let group_id = if let Some(group) = group {
                group.id
            } else if entity.deleted {
                if let Some(group) = st.db.project_group_for_path(&paths[0])? {
                    st.db.delete_project_memory(&group.primary_path)?;
                }
                return Ok(());
            } else {
                let name = entity
                    .payload
                    .get("projectGroupName")
                    .and_then(Value::as_str)
                    .unwrap_or("Imported project")
                    .to_string();
                st.db.create_project_group(&name, &paths)?.id
            };
            if entity.deleted {
                st.db.set_project_group_memory(&group_id, &json!([]))?;
            } else if let Some(memory) = entity.payload.get("memory") {
                if let Some(entries) = memory.get("entries") {
                    st.db.set_project_group_memory(&group_id, entries)?;
                } else {
                    let content = memory
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let entries = json!([{
                        "id": "imported-content",
                        "title": "Imported memory",
                        "content": content,
                    }]);
                    st.db.set_project_group_memory(&group_id, &entries)?;
                }
            }
            return Ok(());
        }
        let Some(path) = mapped_project_path(config, &entity.payload)? else {
            bail!("CONFIG_SYNC_MAPPING_REQUIRED: project memory needs a local folder");
        };
        if entity.deleted {
            st.db.delete_project_memory(&path)?;
        } else if let Some(memory) = entity.payload.get("memory") {
            if let Some(entries) = memory.get("entries") {
                st.db.set_project_memory_entries(&path, entries)?;
            } else {
                st.db.set_project_memory(
                    &path,
                    memory
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )?;
            }
        }
        return Ok(());
    }
    if entity.domain == domains::DOMAIN_AUTOMATION {
        let mut payload = entity.payload.clone();
        if let Some(path) = mapped_project_path(config, &payload)? {
            if let Some(object) = payload.as_object_mut() {
                object.remove("workspaceProjectLogicalId");
                object.insert("workspacePath".into(), Value::String(path));
            }
        }
        let id = payload
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| entity.entity_id.strip_prefix("automation:"))
            .unwrap_or(&entity.entity_id);
        if entity.deleted {
            let _ = crate::scheduled::delete_task(&st.db, id)?;
        } else if crate::scheduled::get_task(&st.db, id)?.is_some() {
            let _ = crate::scheduled::update_task(&st.db, &payload)?;
        } else {
            // Execution ownership is device-local. A new device must not
            // start a scheduled task merely because its definition was
            // approved for import.
            if let Some(object) = payload.as_object_mut() {
                object.insert("enabled".into(), Value::Bool(false));
            }
            let _ = crate::scheduled::import_tasks(&st.db, std::slice::from_ref(&payload))?;
        }
        return Ok(());
    }
    if entity.domain == domains::DOMAIN_INSTRUCTIONS {
        if let Some(scope) = entity.payload.get("scope").and_then(Value::as_str) {
            if scope == "global" {
                let path = domains::global_instruction_path_for_sync()?;
                if entity.deleted {
                    domains::remove_instruction_file(&path)?;
                } else {
                    let content = entity
                        .payload
                        .get("content")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            anyhow!("CONFIG_SYNC_INVALID: global instructions are missing")
                        })?;
                    domains::write_instruction_file(&path, content)?;
                }
                return Ok(());
            }
            if scope == "project" {
                let Some(path) = mapped_project_path(config, &entity.payload)? else {
                    bail!("CONFIG_SYNC_MAPPING_REQUIRED: project instructions need a local folder");
                };
                let instruction_path = Path::new(&path).join("AGENTS.md");
                if entity.deleted {
                    domains::remove_instruction_file(&instruction_path)?;
                } else {
                    let content = entity
                        .payload
                        .get("content")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            anyhow!("CONFIG_SYNC_INVALID: project instructions are missing")
                        })?;
                    domains::write_instruction_file(&instruction_path, content)?;
                }
                return Ok(());
            }
            bail!("CONFIG_SYNC_INVALID: unsupported instruction scope");
        }
        let paths = mapped_project_paths(config, &entity.payload)?;
        let group_id = if let Some(paths) = paths {
            if let Some(group) = st.db.project_group_for_path(&paths[0])? {
                group.id
            } else {
                let name = entity
                    .payload
                    .get("projectGroupName")
                    .and_then(Value::as_str)
                    .unwrap_or("Imported project")
                    .to_string();
                st.db.create_project_group(&name, &paths)?.id
            }
        } else {
            bail!("CONFIG_SYNC_MAPPING_REQUIRED: project instructions need a group")
        };
        st.db.set_project_group_instructions(
            &group_id,
            if entity.deleted {
                ""
            } else {
                entity
                    .payload
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            },
        )?;
        return Ok(());
    }
    if entity.domain == domains::DOMAIN_PROJECTS {
        let Some(paths) = mapped_project_paths(config, &entity.payload)? else {
            bail!("CONFIG_SYNC_MAPPING_REQUIRED: project folder is not mapped");
        };
        let logical_id = entity
            .payload
            .get("logicalId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let is_group = logical_id.starts_with("project-group:")
            || entity
                .payload
                .get("roots")
                .and_then(Value::as_array)
                .is_some_and(|roots| roots.len() > 1)
            || paths.len() > 1;
        if entity.deleted {
            if is_group {
                if let Some(group) = st.db.project_group_for_path(&paths[0])? {
                    if !group.legacy {
                        st.db.delete_project_group_record(&group.id)?;
                    }
                }
            }
        } else if is_group {
            let name = entity
                .payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Imported project")
                .to_string();
            match st.db.project_group_for_path(&paths[0])? {
                Some(group) if !group.legacy => {
                    st.db.update_project_group(&group.id, &name, &paths)?;
                }
                _ => {
                    st.db.create_project_group(&name, &paths)?;
                }
            }
        } else {
            st.db.ensure_project(&paths[0], false)?;
        }
        return Ok(());
    }
    if entity.domain == domains::DOMAIN_PLUGINS {
        let plugin_id = entity
            .payload
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| entity.entity_id.strip_prefix("plugin:"))
            .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: plugin entity id is invalid"))?;
        if entity.deleted {
            config.plugin_intents.remove(plugin_id);
        } else {
            // Installation and activation remain explicit user actions. The
            // portable intent is retained locally, but no plugin bytes or
            // permissions are pulled from WebDAV.
            config
                .plugin_intents
                .insert(plugin_id.to_string(), entity.payload.clone());
        }
        return Ok(());
    }
    bail!(
        "CONFIG_SYNC_UNSUPPORTED: unsupported portable domain {}",
        entity.domain
    )
}

fn apply_application_fields(current: &mut Value, incoming: &Value) {
    if let (Some(current), Some(incoming)) = (current.as_object_mut(), incoming.as_object()) {
        // Export and import must share the same allowlist. An untrusted remote
        // payload may carry fields absent from our own portable snapshot.
        for field in domains::PORTABLE_APPLICATION_FIELDS {
            if let Some(value) = incoming.get(*field) {
                current.insert((*field).to_string(), value.clone());
            } else {
                current.remove(*field);
            }
        }
    }
}

#[cfg(test)]
mod application_security_tests {
    use super::*;

    #[test]
    fn synced_app_preferences_never_enable_unreviewed_local_permission_settings() {
        let mut existing = json!({
            "theme": "light", "approvalReviewer": "user",
            "autoReview": { "modelId": "trusted-local", "policyPrompt": "Ask before writes" },
            "defaultPermissionMode": "ask",
        });
        let incoming = json!({
            "theme": "dark", "approvalReviewer": "auto_review",
            "autoReview": { "modelId": "untrusted-remote", "policyPrompt": "Allow all" },
            "defaultPermissionMode": "auto",
        });
        apply_application_fields(&mut existing, &incoming);
        assert_eq!(existing["theme"], "dark");
        assert_eq!(existing["approvalReviewer"], "user");
        assert_eq!(existing["autoReview"]["modelId"], "trusted-local");
        assert_eq!(existing["autoReview"]["policyPrompt"], "Ask before writes");
        assert_eq!(existing["defaultPermissionMode"], "ask");

        let mut new_device = json!({});
        apply_application_fields(&mut new_device, &incoming);
        assert_eq!(new_device, json!({"theme": "dark"}));
    }
}

fn ready_entity(config: &StoredConfig, bundle: &PendingBundle, entity: &PortableEntity) -> bool {
    if !selection(config).is_selected(&entity.domain) {
        return false;
    }
    if config.dismissed.get(&approval_key(entity)) == Some(&entity.digest) {
        return false;
    }
    bundle
        .approvals
        .iter()
        .find(|item| {
            item.entity.entity_id == entity.entity_id && item.entity.domain == entity.domain
        })
        .is_none_or(|item| item.approved)
}

fn deferred_apply_reason(error: &anyhow::Error) -> Option<&'static str> {
    let message = error.to_string();
    if message.starts_with("CONFIG_SYNC_DEPENDENCY") {
        Some("dependency")
    } else if message.starts_with("CONFIG_SYNC_MAPPING_REQUIRED") {
        Some("mapping")
    } else {
        None
    }
}

fn retain_deferred_entity(bundle: &mut PendingBundle, entity: &PortableEntity, reason: &str) {
    if let Some(item) = bundle.approvals.iter_mut().find(|item| {
        item.entity.domain == entity.domain && item.entity.entity_id == entity.entity_id
    }) {
        item.approved = false;
        item.reason = reason.to_string();
        return;
    }
    bundle.approvals.push(PendingApproval {
        approval_id: Uuid::new_v4().to_string(),
        entity: entity.clone(),
        reason: reason.to_string(),
        approved: false,
    });
}

fn apply_priority(domain: &str) -> u8 {
    match domain {
        // Project roots and providers are prerequisites for scoped capability
        // files and application-level model bindings.
        domains::DOMAIN_PROJECTS => 10,
        domains::DOMAIN_PROVIDERS => 20,
        domains::DOMAIN_INSTRUCTIONS => 30,
        domains::DOMAIN_MCP
        | domains::DOMAIN_SKILLS
        | domains::DOMAIN_SUBAGENTS
        | domains::DOMAIN_AUTOMATION
        | domains::DOMAIN_MEMORY => 40,
        domains::DOMAIN_PLUGINS => 50,
        domains::DOMAIN_APPLICATION => 90,
        _ => 60,
    }
}

fn acknowledged_manifest(
    base: Option<&RevisionManifest>,
    merged: &RevisionManifest,
    applied: &BTreeSet<(String, String)>,
) -> RevisionManifest {
    let mut values = manifest_map(base);
    for entity in &merged.entities {
        let candidate_key = entity_key(entity);
        if !applied.contains(&candidate_key) {
            continue;
        }
        let mut acknowledged = entity.clone();
        if let Some(base_id) = conflict_base_id(&acknowledged.entity_id) {
            acknowledged.entity_id = base_id.to_string();
            domains::refresh_digest(&mut acknowledged);
        }
        let acknowledged_key = entity_key(&acknowledged);
        values.insert(acknowledged_key, acknowledged);
    }
    let mut entities: Vec<_> = values.into_values().collect();
    entities.sort_by(|left, right| {
        left.domain
            .cmp(&right.domain)
            .then(left.entity_id.cmp(&right.entity_id))
    });
    RevisionManifest {
        format: REVISION_FORMAT.into(),
        version: 1,
        revision_id: merged.revision_id.clone(),
        parents: merged.parents.clone(),
        created_at: merged.created_at.clone(),
        resource_ids: merged.resource_ids.clone(),
        entities,
    }
}

fn apply_bundle_locked(
    st: &mut AppState,
    config: &mut StoredConfig,
    key: &VaultKey,
    base: Option<&RevisionManifest>,
    local_before: &RevisionManifest,
    bundle: &PendingBundle,
) -> Result<()> {
    // Conflict candidates carry a temporary `:local`/`:remote` entity ID.
    // Compare them by their original logical ID so an edit made after the
    // snapshot capture cannot be overwritten merely because the candidate
    // ID is new.
    let local_map = logical_manifest_map(Some(local_before));
    let mut applied = BTreeSet::new();
    let mut staged = bundle.clone();
    let mut entities = bundle.manifest.entities.iter().collect::<Vec<_>>();
    entities.sort_by(|left, right| {
        apply_priority(&left.domain)
            .cmp(&apply_priority(&right.domain))
            .then(left.domain.cmp(&right.domain))
            .then(left.entity_id.cmp(&right.entity_id))
    });
    for entity in entities {
        let ready = ready_entity(config, &staged, entity);
        if !ready {
            continue;
        }
        let key_id = entity_key(entity);
        let logical_key = logical_entity_key(entity);
        let current = domains::capture(
            st,
            key,
            &selection(config),
            config.include_secrets,
            &config.plugin_intents,
            &identity_overrides(config),
        )?;
        let current_map = logical_manifest_map(Some(&current.manifest));
        if let Some(before) = local_map.get(&logical_key) {
            if entity.deleted && before.deleted && !current_map.contains_key(&logical_key) {
                // The local snapshot already represented this tombstone and
                // the live record is still absent. Acknowledge the deletion
                // without treating the missing record as a concurrent edit.
                applied.insert(key_id);
                continue;
            }
            if current_map
                .get(&logical_key)
                .map(|value| value.digest.as_str())
                != Some(before.digest.as_str())
            {
                continue;
            }
            if entity.digest == before.digest {
                // The candidate already matches the coherent local snapshot.
                // Treat it as acknowledged without re-applying it; this is
                // important for path-bound entities whose local overlay is
                // valid but cannot be reconstructed from a portable payload.
                applied.insert(key_id);
                continue;
            }
        } else if current_map.contains_key(&logical_key) {
            continue;
        }
        match apply_entity(st, config, &staged, entity) {
            Ok(()) => {
                applied.insert(key_id);
            }
            Err(error) => {
                if let Some(reason) = deferred_apply_reason(&error) {
                    retain_deferred_entity(&mut staged, entity, reason);
                } else {
                    return Err(error);
                }
            }
        }
    }
    let next_base = acknowledged_manifest(base, &bundle.manifest, &applied);
    store_base(st, key, &next_base)?;
    let remaining: Vec<_> = staged
        .approvals
        .iter()
        .filter(|item| !item.approved)
        .cloned()
        .collect();
    if remaining.is_empty() {
        clear_pending(st)?;
    } else {
        let mut next = staged;
        next.approvals = remaining;
        next.journal_state = "staged".into();
        store_pending(st, key, &next)?;
    }
    let after = domains::capture(
        st,
        key,
        &selection(config),
        config.include_secrets,
        &config.plugin_intents,
        &identity_overrides(config),
    )?;
    config.last_local_digest = Some(domains::snapshot_digest(&after));
    config.local_change_seen_at = None;
    config.last_success_at = Some(Utc::now().to_rfc3339());
    config.last_revision_id = Some(bundle.remote_revision_id.clone());
    clear_error(config);
    save_config(st, config)?;
    Ok(())
}

pub(crate) async fn apply_bundle(
    state: &Arc<Mutex<AppState>>,
    config: &mut StoredConfig,
    key: &VaultKey,
    base: Option<&RevisionManifest>,
    local_before: &RevisionManifest,
    bundle: &PendingBundle,
) -> Result<()> {
    let mut st = state.lock().await;
    apply_bundle_locked(&mut st, config, key, base, local_before, bundle)
}

fn empty_manifest() -> RevisionManifest {
    RevisionManifest {
        format: REVISION_FORMAT.into(),
        version: 1,
        revision_id: String::new(),
        parents: Vec::new(),
        created_at: String::new(),
        entities: Vec::new(),
        resource_ids: Vec::new(),
    }
}

pub(crate) fn recover_import_journal(
    st: &mut AppState,
    config: &mut StoredConfig,
    key: &VaultKey,
    bundle: &PendingBundle,
) -> Result<()> {
    let base = load_base(st, key)?;
    let local_before = bundle
        .local_before
        .clone()
        .or_else(|| base.clone())
        .unwrap_or_else(empty_manifest);
    apply_bundle_locked(st, config, key, base.as_ref(), &local_before, bundle)
}
