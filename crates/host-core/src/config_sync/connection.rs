use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct S3Connection {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub prefix: String,
    pub access_key_id: String,
    pub path_style: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ConnectionCredentials {
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

fn input_text(input: &Value, name: &str, fallback: &str) -> Result<String> {
    match input.get(name) {
        Some(Value::String(value)) => Ok(value.trim().to_string()),
        Some(_) => bail!("CONFIG_SYNC_INVALID: {name} must be text"),
        None => Ok(fallback.to_string()),
    }
}

fn input_bool(input: &Value, name: &str, fallback: bool) -> Result<bool> {
    match input.get(name) {
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => bail!("CONFIG_SYNC_INVALID: {name} must be a boolean"),
        None => Ok(fallback),
    }
}

impl S3Connection {
    pub(super) fn from_input(existing: Option<&Self>, input: &Value) -> Result<Self> {
        let value = Self {
            endpoint: input_text(input, "endpoint", existing.map_or("", |v| &v.endpoint))?
                .trim_end_matches('/')
                .to_string(),
            region: input_text(input, "region", existing.map_or("us-east-1", |v| &v.region))?,
            bucket: input_text(input, "bucket", existing.map_or("", |v| &v.bucket))?,
            prefix: input_text(
                input,
                "prefix",
                existing.map_or("pi-desktop/config", |v| &v.prefix),
            )?
            .trim_matches('/')
            .to_string(),
            access_key_id: input_text(
                input,
                "accessKeyId",
                existing.map_or("", |v| &v.access_key_id),
            )?,
            path_style: input_bool(input, "pathStyle", existing.is_none_or(|v| v.path_style))?,
        };
        if value.endpoint.is_empty()
            || value.region.is_empty()
            || value.bucket.is_empty()
            || value.access_key_id.is_empty()
        {
            bail!(
                "CONFIG_SYNC_INVALID: S3 endpoint, region, bucket and access key ID are required"
            );
        }
        Ok(value)
    }
}

pub(super) fn credential_ref(config: &StoredConfig) -> String {
    format!("secret:config-sync:s3:{}:connection", config.state_id)
}

pub(super) fn stored_credentials(
    st: &AppState,
    config: &StoredConfig,
) -> Result<ConnectionCredentials> {
    let value = st
        .secrets
        .get(&credential_ref(config))?
        .ok_or_else(|| anyhow!("CONFIG_SYNC_AUTH: S3 credentials are not available"))?;
    serde_json::from_str(&value)
        .map_err(|_| anyhow!("CONFIG_SYNC_AUTH: stored S3 credentials are invalid"))
}

pub(super) fn connection_credentials(
    st: &AppState,
    existing: Option<&StoredConfig>,
    connection: &S3Connection,
    input: &Value,
) -> Result<ConnectionCredentials> {
    // A complete replacement must recover even when the old secret was lost.
    // Omitted fields still mean reuse, never silently dropping a session token.
    let needs_saved = input.get("secretAccessKey").is_none() || input.get("sessionToken").is_none();
    let saved = if needs_saved {
        existing
            .filter(|saved| saved.connection == *connection)
            .map(|saved| stored_credentials(st, saved))
            .transpose()?
    } else {
        None
    };
    let secret_access_key = match input.get("secretAccessKey") {
        Some(Value::String(value)) if !value.is_empty() => value.clone(),
        Some(_) => bail!("CONFIG_SYNC_AUTH: enter the S3 secret access key"),
        None => saved
            .as_ref()
            .map(|saved| saved.secret_access_key.clone())
            .ok_or_else(|| {
                anyhow!("CONFIG_SYNC_AUTH: enter the S3 secret access key for this connection")
            })?,
    };
    let session_token = match input.get("sessionToken") {
        Some(Value::String(value)) => (!value.is_empty()).then(|| value.clone()),
        Some(_) => bail!("CONFIG_SYNC_INVALID: S3 session token must be text"),
        None => saved.and_then(|saved| saved.session_token),
    };
    Ok(ConnectionCredentials {
        secret_access_key,
        session_token,
    })
}

pub(super) fn transport_with_credentials(
    connection: &S3Connection,
    credentials: ConnectionCredentials,
) -> Result<S3Transport> {
    S3Transport::new(&S3Config {
        endpoint: connection.endpoint.clone(),
        region: connection.region.clone(),
        bucket: connection.bucket.clone(),
        prefix: connection.prefix.clone(),
        access_key_id: connection.access_key_id.clone(),
        secret_access_key: credentials.secret_access_key,
        session_token: credentials.session_token,
        path_style: connection.path_style,
        allow_insecure_http: crate::network_policy::relaxed(),
    })
}

pub(super) fn configured_transport(st: &AppState, config: &StoredConfig) -> Result<S3Transport> {
    transport_with_credentials(&config.connection, stored_credentials(st, config)?)
}

pub(super) fn config_from_input(
    existing: Option<&StoredConfig>,
    input: &Value,
    header: VaultHeader,
) -> Result<StoredConfig> {
    if !input.is_object() {
        bail!("CONFIG_SYNC_INVALID: configuration must be an object");
    }
    for removed in ["username", "appPassword", "directory", "remoteMode"] {
        if input.get(removed).is_some() {
            bail!("CONFIG_SYNC_INVALID: legacy connection fields are no longer supported");
        }
    }
    let connection = S3Connection::from_input(existing.map(|value| &value.connection), input)?;
    let device_label = input_text(
        input,
        "deviceLabel",
        existing.map_or("This device", |v| &v.device_label),
    )?;
    if device_label.is_empty() || device_label.len() > 128 {
        bail!("CONFIG_SYNC_INVALID: device label must contain 1 to 128 bytes");
    }
    let mode = match input.get("mode") {
        None => existing.map(|value| value.mode).unwrap_or_default(),
        Some(Value::String(value)) if value == "sync" => SyncMode::Sync,
        Some(Value::String(value)) if value == "backup" => SyncMode::Backup,
        _ => bail!("CONFIG_SYNC_INVALID: unsupported configuration mode"),
    };
    let same_state = existing.filter(|saved| saved.connection == connection && saved.mode == mode);
    let include_memory = input_bool(
        input,
        "includeMemory",
        existing.is_some_and(|v| v.include_memory),
    )?;
    let include_secrets = input_bool(
        input,
        "includeSecrets",
        existing.is_some_and(|v| v.include_secrets),
    )?;
    let mut categories = existing
        .map(|value| value.categories.clone())
        .unwrap_or_else(default_categories);
    if let Some(value) = input.get("categories") {
        let object = value
            .as_object()
            .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: categories must be an object"))?;
        for (name, selected) in object {
            if !domains::ALL_DOMAINS.contains(&name.as_str()) && name != "credentials" {
                bail!("CONFIG_SYNC_INVALID: unsupported configuration category");
            }
            categories.insert(
                name.clone(),
                selected.as_bool().ok_or_else(|| {
                    anyhow!("CONFIG_SYNC_INVALID: category selection must be a boolean")
                })?,
            );
        }
    }
    categories.insert("credentials".into(), include_secrets);
    categories.insert(domains::DOMAIN_MEMORY.into(), include_memory);
    Ok(StoredConfig {
        format: FORMAT.into(),
        version: 1,
        connection,
        mode,
        state_id: same_state
            .map(|value| value.state_id.clone())
            .unwrap_or_else(new_device_id),
        device_label,
        device_id: existing
            .map(|value| value.device_id.clone())
            .unwrap_or_else(new_device_id),
        categories,
        include_secrets,
        include_memory,
        automatic_sync: input_bool(
            input,
            "automaticSync",
            existing.is_none_or(|v| v.automatic_sync),
        )?,
        enabled: true,
        paused: existing.is_some_and(|value| value.paused),
        vault_id: header.vault_id.clone(),
        vault_header: header,
        last_run_at: same_state.and_then(|v| v.last_run_at.clone()),
        last_success_at: same_state.and_then(|v| v.last_success_at.clone()),
        last_revision_id: same_state.and_then(|v| v.last_revision_id.clone()),
        last_error: None,
        last_error_code: None,
        last_local_digest: same_state.and_then(|v| v.last_local_digest.clone()),
        local_change_seen_at: None,
        retry_count: 0,
        next_retry_at: None,
        project_mappings: same_state
            .map(|v| v.project_mappings.clone())
            .unwrap_or_default(),
        project_group_mappings: same_state
            .map(|v| v.project_group_mappings.clone())
            .unwrap_or_default(),
        dismissed: same_state.map(|v| v.dismissed.clone()).unwrap_or_default(),
        resolved_conflicts: same_state
            .map(|v| v.resolved_conflicts.clone())
            .unwrap_or_default(),
        plugin_intents: same_state
            .map(|v| v.plugin_intents.clone())
            .unwrap_or_default(),
        recovery_points: same_state
            .map(|v| v.recovery_points.clone())
            .unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> Value {
        json!({"endpoint":"https://s3.example.test", "region":"us-east-1", "bucket":"config-bucket",
            "accessKeyId":"fixture-access", "prefix":"config", "deviceLabel":"Test"})
    }

    #[test]
    fn credentials_are_scoped_to_the_complete_connection() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let state = AppState::open(directory.path())?;
        let (header, _) = create_vault("backup-password", "test-vault")?;
        let config = config_from_input(None, &input(), header)?;
        state.secrets.set(
            &credential_ref(&config),
            &serde_json::to_string(&ConnectionCredentials {
                secret_access_key: "fixture-secret".into(),
                session_token: Some("fixture-session".into()),
            })?,
        )?;
        let reused = connection_credentials(&state, Some(&config), &config.connection, &json!({}))?;
        assert_eq!(reused.secret_access_key, "fixture-secret");
        for (name, value) in [
            ("endpoint", "https://other.example.test"),
            ("region", "eu-west-1"),
            ("bucket", "other-bucket"),
            ("prefix", "other-prefix"),
            ("accessKeyId", "other-access"),
        ] {
            let changed =
                S3Connection::from_input(Some(&config.connection), &json!({(name):value}))?;
            assert!(connection_credentials(&state, Some(&config), &changed, &json!({})).is_err());
        }
        let changed =
            S3Connection::from_input(Some(&config.connection), &json!({"pathStyle":false}))?;
        assert!(connection_credentials(&state, Some(&config), &changed, &json!({})).is_err());
        let cleared = connection_credentials(
            &state,
            Some(&config),
            &config.connection,
            &json!({"sessionToken":""}),
        )?;
        assert!(cleared.session_token.is_none());
        Ok(())
    }

    #[test]
    fn complete_replacement_recovers_missing_or_invalid_stored_credentials() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let state = AppState::open(directory.path())?;
        let (header, _) = create_vault("backup-password", "test-vault")?;
        let config = config_from_input(None, &input(), header)?;
        for invalid in [None, Some("not-json")] {
            if let Some(invalid) = invalid {
                state.secrets.set(&credential_ref(&config), invalid)?;
            }
            let replaced = connection_credentials(
                &state,
                Some(&config),
                &config.connection,
                &json!({"secretAccessKey":"replacement", "sessionToken":""}),
            )?;
            assert_eq!(replaced.secret_access_key, "replacement");
            assert!(replaced.session_token.is_none());
            assert!(
                connection_credentials(&state, Some(&config), &config.connection, &json!({}))
                    .is_err()
            );
        }
        Ok(())
    }

    #[test]
    fn destination_and_mode_changes_get_a_fresh_local_baseline() -> Result<()> {
        let (header, _) = create_vault("backup-password", "test-vault")?;
        let mut config = config_from_input(None, &input(), header.clone())?;
        config.paused = true;
        let saved = config_from_input(Some(&config), &input(), header.clone())?;
        assert_eq!(saved.state_id, config.state_id);
        assert!(saved.paused);
        for change in [json!({"mode":"backup"}), json!({"bucket":"other-bucket"})] {
            let changed = config_from_input(Some(&config), &change, header.clone())?;
            assert_ne!(changed.state_id, config.state_id);
            assert!(changed.last_revision_id.is_none());
        }
        Ok(())
    }
}
