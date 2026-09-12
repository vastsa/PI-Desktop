use super::*;

pub(crate) fn provider_from_row(
    row: &rusqlite::Row<'_>,
    secrets: &SecretStore,
) -> rusqlite::Result<ProviderPublic> {
    let secret_ref: Option<String> = row.get(8)?;
    let id: String = row.get(0)?;
    let legacy_model_id: Option<String> = row.get(9)?;
    let config_raw: String = row.get(11).unwrap_or_else(|_| "{}".to_string());
    let models = config_model_bindings(&config_raw, legacy_model_id.clone());
    let has_api_key = secret_ref.as_ref().map(|r| secrets.has(r)).unwrap_or(false);
    let has_oauth = secrets.has(&secret_ref_for_provider_oauth(&id));
    Ok(ProviderPublic {
        id,
        name: row.get(1)?,
        vendor_key: row.get(2)?,
        provider_type: row.get(3)?,
        protocol: row.get(4)?,
        enabled: row.get::<_, i64>(5)? != 0,
        base_url: row.get(6)?,
        auth_kind: row.get(7)?,
        has_secret: has_api_key || has_oauth,
        has_oauth,
        oauth_account_label: row
            .get::<_, String>(11)
            .ok()
            .and_then(|raw| config_oauth_account_label(&raw)),
        headers: row
            .get::<_, String>(11)
            .ok()
            .and_then(|raw| config_headers(&raw)),
        default_model_id: models
            .first()
            .map(|binding| binding.id.clone())
            .or(legacy_model_id),
        models,
        api_style: row.get(10)?,
        supports_reasoning: row
            .get::<_, String>(11)
            .ok()
            .and_then(|raw| config_reasoning_override(&raw)),
        supported_thinking_levels: row
            .get::<_, String>(11)
            .ok()
            .and_then(|raw| config_thinking_levels_override(&raw)),
        context_window: row
            .get::<_, String>(11)
            .ok()
            .and_then(|raw| config_limit_u32(&raw, "contextWindow")),
        max_output_tokens: row
            .get::<_, String>(11)
            .ok()
            .and_then(|raw| config_limit_u32(&raw, "maxOutputTokens")),
        temperature: row
            .get::<_, String>(11)
            .ok()
            .and_then(|raw| config_limit_f64(&raw, "temperature")),
        created_at: ms_to_ts(row.get(12)?),
        updated_at: ms_to_ts(row.get(13)?),
    })
}

pub fn list_providers(
    db: &Database,
    secrets: &SecretStore,
    include_disabled: bool,
) -> Result<Vec<ProviderPublic>> {
    let sql = if include_disabled {
        format!("{PROVIDER_SELECT} ORDER BY created_at ASC")
    } else {
        format!("{PROVIDER_SELECT} WHERE enabled = 1 ORDER BY created_at ASC")
    };
    let mut stmt = db.conn().prepare_cached(&sql)?;
    let rows = stmt.query_map([], |row| provider_from_row(row, secrets))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn create_provider(
    db: &Database,
    secrets: &SecretStore,
    input: ProviderCreateInput,
) -> Result<ProviderPublic> {
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    // Validate before any side effect: a rejected alias must not leave a
    // stored secret behind.
    if let Some(models) = input.models.as_deref() {
        validate_model_aliases(models)?;
    }
    let secret_ref = secret_ref_for_provider(&id);
    let mut backend = None;
    if let Some(secret) = input.secret_value.as_ref().filter(|s| !s.is_empty()) {
        let b = secrets.set(&secret_ref, secret)?;
        upsert_secret_meta(db, &secret_ref, &id, &b)?;
        backend = Some(b);
    }

    let vendor_key = input.vendor_key.unwrap_or_else(|| "custom".into());
    let provider_type = input
        .provider_type
        .unwrap_or_else(|| "openai_compatible".into());
    let protocol = input.protocol.unwrap_or_else(|| "openai_compatible".into());
    let auth_kind = input
        .auth_kind
        .unwrap_or_else(|| "api_key_and_base_url".into());
    let config_json = build_provider_config_json(
        input.supports_reasoning,
        input.supported_thinking_levels.as_deref(),
        input.models.as_deref(),
        &LimitOverrides {
            context_window: input.context_window,
            max_output_tokens: input.max_output_tokens,
            temperature: input.temperature,
        },
    )?;
    let config_json = match input.oauth_account_label.as_deref() {
        Some(label) => config_with_oauth_account_label(&config_json, label)?,
        None => config_json,
    };
    let config_json = match input.headers.as_ref() {
        Some(headers) => config_with_headers(&config_json, headers)?,
        None => config_json,
    };

    db.conn()
        .prepare_cached(
            "INSERT INTO providers (
                id, name, vendor_key, type, protocol, enabled, base_url, auth_kind, secret_ref,
                api_style, default_model_id, config_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
        )?
        .execute(params![
            id,
            input.name,
            vendor_key,
            provider_type,
            protocol,
            input.base_url,
            auth_kind,
            if backend.is_some() {
                Some(secret_ref.clone())
            } else {
                None
            },
            input.api_style,
            input.default_model_id.or_else(|| {
                input
                    .models
                    .as_ref()
                    .and_then(|models| models.first().map(|model| model.id.clone()))
            }),
            config_json.to_string(),
            now,
        ])?;

    get_provider(db, secrets, &id)?.ok_or_else(|| anyhow::anyhow!("provider missing after create"))
}

pub fn update_provider(
    db: &Database,
    secrets: &SecretStore,
    input: ProviderUpdateInput,
) -> Result<Option<ProviderPublic>> {
    let existing = get_provider(db, secrets, &input.id)?;
    if existing.is_none() {
        return Ok(None);
    }
    // Validate before any side effect: a rejected alias must not replace the
    // stored secret.
    if let Some(models) = input.models.as_deref() {
        validate_model_aliases(models)?;
    }
    // Derive from the API key ref directly: `has_secret` now also covers an
    // OAuth credential, so reusing it here would stamp an api_key ref onto a
    // provider that only ever signed in with a vendor account.
    let api_key_ref = secret_ref_for_provider(&input.id);
    let mut secret_ref = secrets.has(&api_key_ref).then(|| api_key_ref.clone());

    if let Some(secret) = input.secret_value.as_ref().filter(|s| !s.is_empty()) {
        let backend = secrets.set(&api_key_ref, secret)?;
        upsert_secret_meta(db, &api_key_ref, &input.id, &backend)?;
        secret_ref = Some(api_key_ref);
    }
    let raw_config: String = db.conn().query_row(
        "SELECT config_json FROM providers WHERE id = ?1",
        params![input.id],
        |row| row.get(0),
    )?;
    // `Some(None)` clears an explicit levels override; plain `None` leaves it.
    let levels_update = if input.supported_thinking_levels.is_some() {
        Some(input.supported_thinking_levels.clone())
    } else {
        None
    };
    let models_update = input.models.clone().map(Some);
    let config_json = merge_provider_config_overrides(
        &raw_config,
        input.supports_reasoning,
        levels_update,
        models_update,
        &LimitOverrides {
            context_window: input.context_window,
            max_output_tokens: input.max_output_tokens,
            temperature: input.temperature,
        },
    )?;
    // An empty label clears the badge, which is what logout sends.
    let config_json = match input.oauth_account_label.as_deref() {
        Some(label) => Some(config_with_oauth_account_label(
            config_json.as_deref().unwrap_or(&raw_config),
            label,
        )?),
        None => config_json,
    };
    // An empty map clears stored headers so adapter defaults return.
    let config_json = match input.headers.as_ref() {
        Some(headers) => Some(config_with_headers(
            config_json.as_deref().unwrap_or(&raw_config),
            headers,
        )?),
        None => config_json,
    };

    db.conn()
        .prepare_cached(
            "UPDATE providers SET
                name = COALESCE(?1, name),
                vendor_key = COALESCE(?2, vendor_key),
                type = COALESCE(?3, type),
                protocol = COALESCE(?4, protocol),
                base_url = COALESCE(?5, base_url),
                auth_kind = COALESCE(?6, auth_kind),
                default_model_id = COALESCE(?7, default_model_id),
                api_style = COALESCE(?8, api_style),
                enabled = COALESCE(?9, enabled),
                secret_ref = COALESCE(?10, secret_ref),
                config_json = COALESCE(?11, config_json),
                updated_at = ?12
             WHERE id = ?13",
        )?
        .execute(params![
            input.name,
            input.vendor_key,
            input.provider_type,
            input.protocol,
            input.base_url,
            input.auth_kind,
            input.default_model_id.or_else(|| {
                input
                    .models
                    .as_ref()
                    .and_then(|models| models.first().map(|model| model.id.clone()))
            }),
            input.api_style,
            input.enabled.map(|b| if b { 1 } else { 0 }),
            secret_ref,
            config_json,
            now_ms(),
            input.id
        ])?;
    get_provider(db, secrets, &input.id)
}

pub fn delete_provider(db: &Database, secrets: &SecretStore, id: &str) -> Result<bool> {
    // Both credential channels are provider-scoped, so deleting the row must
    // take the OAuth credential with it or a re-created provider could inherit
    // a stranger's refresh token.
    for sref in [
        secret_ref_for_provider(id),
        secret_ref_for_provider_oauth(id),
    ] {
        let _ = secrets.delete(&sref);
        db.conn()
            .prepare_cached("DELETE FROM secrets_meta WHERE secret_ref = ?1")?
            .execute(params![sref])?;
    }
    let n = db
        .conn()
        .prepare_cached("DELETE FROM providers WHERE id = ?1")?
        .execute(params![id])?;
    Ok(n > 0)
}

pub fn get_provider(
    db: &Database,
    secrets: &SecretStore,
    id: &str,
) -> Result<Option<ProviderPublic>> {
    let sql = format!("{PROVIDER_SELECT} WHERE id = ?1");
    db.conn()
        .prepare_cached(&sql)?
        .query_row(params![id], |row| provider_from_row(row, secrets))
        .optional()
        .map_err(Into::into)
}
