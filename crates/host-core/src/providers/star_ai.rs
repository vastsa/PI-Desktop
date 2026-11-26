use super::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub const ID: &str = "starai-managed";
const DIRECTORY: &str = "starAiDirectory";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInfo {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ratio: Option<Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    model_vendors: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) chat_models: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Group {
    #[serde(flatten)]
    info: GroupInfo,
    models: Vec<String>,
    provider_id: String,
    base_url: String,
    secret_value: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    group: String,
    model: String,
    provider_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configure {
    account_id: String,
    groups: Vec<Group>,
    selection: Option<Selection>,
    force_default: bool,
}

pub(crate) fn is_managed(id: &str) -> bool {
    id == ID || id.starts_with("starai-managed-")
}

pub fn ensure_unmanaged(id: &str) -> Result<()> {
    if is_managed(id) {
        bail!("Use the StarAI account settings for this service");
    }
    Ok(())
}

pub fn selection(db: &Database) -> Result<Option<Value>> {
    if let Some(directory) = db.get_setting(DIRECTORY)?.filter(|v| !v.is_null()) {
        return Ok(Some(directory));
    }
    let raw: Option<String> = db
        .conn()
        .query_row(
            "SELECT config_json FROM providers WHERE id = ?1",
            [ID],
            |row| row.get(0),
        )
        .optional()?;
    Ok(raw
        .and_then(|s| config_value(&s))
        .and_then(|v| v.get("starAi").cloned()))
}

fn managed_rows(db: &Database) -> Result<Vec<String>> {
    let mut query = db
        .conn()
        .prepare("SELECT id FROM providers WHERE id = ?1 OR id GLOB 'starai-managed-*'")?;
    let ids = query
        .query_map([ID], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(ids)
}

fn group_id(account: &str, group: &str) -> String {
    format!(
        "{ID}-{}",
        hex::encode(Sha256::digest(format!("{account}\0{group}").as_bytes()))
    )
}

fn safe_name(s: &str) -> bool {
    !s.is_empty() && s.trim() == s && !s.chars().any(char::is_control)
}

fn context_window(model_id: &str) -> u32 {
    // A relay can namespace its wire ID (e.g. anthropic/claude-sonnet-4-6
    // or us.anthropic.claude-opus-4-6-v1). Match the complete family token.
    let model = model_id.rsplit('/').next().unwrap_or(model_id);
    if model
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|part| part.eq_ignore_ascii_case("claude"))
    {
        1_000_000
    } else {
        256_000
    }
}

fn validate(input: &Configure, previous: Option<&Value>) -> Result<()> {
    if !input
        .account_id
        .parse::<u64>()
        .is_ok_and(|id| id > 0 && id.to_string() == input.account_id)
    {
        bail!("Invalid StarAI account");
    }
    let mut seen = HashSet::new();
    for g in &input.groups {
        let legacy = g.provider_id == ID
            && previous.is_some_and(|v| {
                v["accountId"] == input.account_id
                    && (v["group"] == g.info.id
                        || v["groups"].as_array().is_some_and(|groups| {
                            groups
                                .iter()
                                .any(|old| old["providerId"] == ID && old["id"] == g.info.id)
                        }))
            });
        let port = g
            .base_url
            .strip_prefix("http://127.0.0.1:")
            .and_then(|s| s.strip_suffix("/v1"))
            .and_then(|s| s.parse::<u16>().ok());
        if !safe_name(&g.info.id)
            || g.info.ratio.as_ref().is_some_and(|r| {
                r != "auto" && !r.as_f64().is_some_and(|v| v.is_finite() && v >= 0.0)
            })
            || (!legacy && g.provider_id != group_id(&input.account_id, &g.info.id))
            || !seen.insert(&g.info.id)
            || g.models.is_empty()
            || g.models.iter().any(|m| !safe_name(m))
            || !g
                .info
                .chat_models
                .as_ref()
                .is_some_and(|chat| chat.iter().all(|m| g.models.contains(m)))
            || !port.is_some_and(|p| p > 0 && g.base_url == format!("http://127.0.0.1:{p}/v1"))
            || !(32..=256).contains(&g.secret_value.len())
            || !g.secret_value.bytes().all(|b| b.is_ascii_graphic())
        {
            bail!("Invalid StarAI group configuration");
        }
    }
    if input.selection.as_ref().is_some_and(|s| {
        !input.groups.iter().any(|g| {
            g.provider_id == s.provider_id
                && g.info.id == s.group
                && g.info
                    .chat_models
                    .as_ref()
                    .is_some_and(|chat| chat.contains(&s.model))
        })
    }) {
        bail!("Invalid StarAI default model");
    }
    Ok(())
}

fn write_default(db: &Database, selection: Option<&Selection>, force: bool) -> Result<()> {
    let mut settings = db.get_setting("app")?.unwrap_or_else(|| json!({}));
    let current = settings["defaultProviderId"].as_str().unwrap_or("");
    if !force && !current.is_empty() && !is_managed(current) {
        return Ok(());
    }
    let before = settings.clone();
    if let Some(s) = selection {
        settings["defaultProviderId"] = json!(s.provider_id);
        settings["defaultModelId"] = json!(s.model);
    } else if is_managed(current) {
        if let Some(obj) = settings.as_object_mut() {
            obj.remove("defaultProviderId");
            obj.remove("defaultModelId");
        }
    }
    if before != settings {
        db.set_setting("app", &settings)?;
    }
    Ok(())
}

// SQL rolls back all provider rows together. File-backed loopback credentials
// are restored explicitly if any part of the directory write fails.
fn apply(
    db: &Database,
    secrets: &SecretStore,
    input: Option<Configure>,
    keep_preference: bool,
) -> Result<()> {
    let previous = selection(db)?;
    if let Some(data) = &input {
        validate(data, previous.as_ref())?;
    }
    let old_rows = managed_rows(db)?;
    let mut before = HashMap::new();
    let mut mutated = Vec::new();
    let tx = db.conn().unchecked_transaction()?;
    let result = (|| -> Result<()> {
        let mut keep = HashSet::new();
        if let Some(data) = &input {
            let mut snapshot = Vec::new();
            for g in &data.groups {
                keep.insert(g.provider_id.as_str());
                let name = &g.info.id;
                let preferred = data
                    .selection
                    .as_ref()
                    .filter(|s| s.provider_id == g.provider_id)
                    .map(|s| &s.model)
                    .or_else(|| g.info.chat_models.as_ref().and_then(|chat| chat.first()));
                let ids = preferred
                    .into_iter()
                    .chain(g.models.iter().filter(|m| Some(*m) != preferred));
                let bindings: Vec<ModelBinding> = serde_json::from_value(Value::Array(
                    ids.map(|id| json!({"id":id, "contextWindow":context_window(id), "contextWindowSource":"user"})).collect(),
                ))?;
                let config =
                    json!({"models":normalize_model_bindings(&bindings), "starAiGroup":g.info})
                        .to_string();
                let sref = secret_ref_for_provider(&g.provider_id);
                let old_secret = secrets.get(&sref)?;
                if old_secret.as_deref() != Some(&g.secret_value) {
                    before.insert(sref.clone(), old_secret);
                    mutated.push(sref.clone());
                    let backend = secrets.set(&sref, &g.secret_value)?;
                    upsert_secret_meta(db, &sref, &g.provider_id, &backend)?;
                }
                tx.execute("INSERT INTO providers (id,name,vendor_key,type,protocol,enabled,base_url,auth_kind,secret_ref,api_style,default_model_id,config_json,created_at,updated_at)
                    VALUES (?1,?2,'custom','openai_compatible','openai_compatible',1,?3,'api_key_and_base_url',?4,'chat_completions',?5,?6,?7,?7)
                    ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=1,base_url=excluded.base_url,secret_ref=excluded.secret_ref,default_model_id=excluded.default_model_id,config_json=excluded.config_json,updated_at=excluded.updated_at
                    WHERE name<>excluded.name OR enabled<>1 OR base_url IS NOT excluded.base_url OR secret_ref IS NOT excluded.secret_ref OR default_model_id IS NOT excluded.default_model_id OR config_json<>excluded.config_json",
                    params![g.provider_id,name,g.base_url,sref,preferred,config,now_ms()])?;
                // Managed models are fully declared in config. Generic discovery caches
                // must never reintroduce removed or cross-group aliases into the picker.
                tx.execute(
                    "DELETE FROM models WHERE provider_id = ?1",
                    [&g.provider_id],
                )?;
                let mut route = serde_json::to_value(&g.info)?;
                route["label"] = json!(g.info.id);
                route["models"] = json!(g.models);
                route["providerId"] = json!(g.provider_id);
                snapshot.push(route);
            }
            db.set_setting(
                DIRECTORY,
                &json!({"accountId":data.account_id,"groups":snapshot,"selection":data.selection}),
            )?;
        } else if keep_preference {
            if let Some(snapshot) = previous {
                // Keep only identities and a preference for online revalidation. No model catalog
                // or token survives here. Older releases stored a single un-hashed provider id.
                let routes: Vec<_> = if let Some(groups) = snapshot["groups"].as_array() {
                    groups
                        .iter()
                        .map(|g| json!({"id":g["id"],"providerId":g["providerId"],"models":[]}))
                        .collect()
                } else {
                    vec![json!({"id":snapshot["group"],"providerId":ID,"models":[]})]
                };
                let settings = db.get_setting("app")?.unwrap_or(Value::Null);
                let preference = routes.iter().find(|g| g["providerId"] == settings["defaultProviderId"] && settings["defaultModelId"].is_string())
                    .map(|g| json!({"providerId":g["providerId"],"group":g["id"],"model":settings["defaultModelId"]}))
                    .unwrap_or_else(|| if snapshot["group"].is_string() {
                        json!({"providerId":ID,"group":snapshot["group"],"model":snapshot["model"]})
                    } else {snapshot["selection"].clone()});
                db.set_setting(DIRECTORY, &json!({"accountId":snapshot["accountId"],"groups":routes,"selection":preference}))?;
            }
        } else {
            db.set_setting(DIRECTORY, &Value::Null)?;
        }
        for id in old_rows.iter().filter(|id| !keep.contains(id.as_str())) {
            let sref = secret_ref_for_provider(id);
            before.insert(sref.clone(), secrets.get(&sref)?);
            mutated.push(sref.clone());
            secrets.delete(&sref)?;
            tx.execute("DELETE FROM secrets_meta WHERE secret_ref = ?1", [sref])?;
            tx.execute("DELETE FROM providers WHERE id = ?1", [id])?;
        }
        write_default(
            db,
            input.as_ref().and_then(|d| d.selection.as_ref()),
            input.as_ref().is_some_and(|d| d.force_default),
        )?;
        tx.commit()?;
        Ok(())
    })();
    if let Err(err) = result {
        for sref in mutated.iter().rev() {
            if let Some(Some(value)) = before.get(sref) {
                secrets.set(sref, value)?;
            } else {
                secrets.delete(sref)?;
            }
        }
        return Err(err);
    }
    Ok(())
}

pub fn configure(db: &Database, secrets: &SecretStore, input: Configure) -> Result<Value> {
    apply(db, secrets, Some(input), false)?;
    Ok(json!({"ok":true}))
}

pub fn disconnect(db: &Database, secrets: &SecretStore) -> Result<()> {
    apply(db, secrets, None, false)
}

pub fn suspend(db: &Database, secrets: &SecretStore) -> Result<()> {
    apply(db, secrets, None, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(key: &str, port: u16) -> Value {
        json!({"id":key,"label":"Chat","models":["other", "shared"],"chatModels":["shared"],"providerId":group_id("42", key),
            "baseUrl":format!("http://127.0.0.1:{port}/v1"), "secretValue":format!("local-group-private-fixture-only-{port}")})
    }
    fn config(groups: Vec<Value>, group: Option<&Value>, force: bool) -> Configure {
        let selected =
            group.map(|g| json!({"group":g["id"],"providerId":g["providerId"],"model":"shared"}));
        serde_json::from_value(
            json!({"groups":groups,"selection":selected,"accountId":"42","forceDefault":force}),
        )
        .unwrap()
    }

    #[test]
    fn star_ai_context_windows_replace_seed_and_cache_for_existing_groups() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("fixture.sqlite")).unwrap();
        let secrets = SecretStore::open(dir.path()).unwrap();
        let mut g = group("default", 41230);
        let id = g["providerId"].as_str().unwrap().to_owned();
        g["models"] = json!([
            "shared",
            "anthropic/Claude-Sonnet-4-6",
            "us.anthropic.claude-opus-4-6-v1",
            "notclaude-chat"
        ]);
        configure(&db, &secrets, config(vec![g.clone()], Some(&g), false)).unwrap();
        // Earlier builds wrote a generic binding with no origin or token limit.
        db.conn()
            .execute(
                "UPDATE providers SET config_json=?1 WHERE id=?2",
                params![
                    json!({"models":[{"id":"shared","contextWindow":128000}]}).to_string(),
                    id
                ],
            )
            .unwrap();
        configure(&db, &secrets, config(vec![g.clone()], Some(&g), false)).unwrap();
        let p = get_provider(&db, &secrets, &id).unwrap().unwrap();
        let windows: Vec<_> = p
            .models
            .iter()
            .map(|m| (m.id.as_str(), m.context_window))
            .collect();
        assert_eq!(
            windows,
            vec![
                ("shared", 256_000),
                ("anthropic/Claude-Sonnet-4-6", 1_000_000),
                ("us.anthropic.claude-opus-4-6-v1", 1_000_000),
                ("notclaude-chat", 256_000)
            ]
        );
        assert!(p
            .models
            .iter()
            .all(|m| m.context_window_source.as_deref() == Some("user") && m.max_tokens == 8192));
    }

    #[test]
    fn star_ai_sync_registers_group_scoped_providers_and_preserves_external_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("fixture.sqlite")).unwrap();
        let secrets = SecretStore::open(dir.path()).unwrap();
        let a = group("default", 41230);
        let mut b = group("premium", 41231);
        b["ratio"] = json!(0.25);
        b["description"] = json!("Chat");
        b["modelVendors"] = json!({"shared":"Anthropic"});
        let a_id = a["providerId"].as_str().unwrap();
        let b_id = b["providerId"].as_str().unwrap();
        db.set_setting("app", &json!({"defaultProviderId":"manual","defaultModelId":"manual-chat","language":"zh-CN"})).unwrap();
        configure(&db, &secrets, config(vec![], None, false)).unwrap();
        assert_eq!(
            db.get_setting("app").unwrap().unwrap()["defaultModelId"],
            "manual-chat"
        );
        configure(
            &db,
            &secrets,
            config(vec![a.clone(), b.clone()], Some(&a), false),
        )
        .unwrap();
        let snapshot = selection(&db).unwrap().unwrap();
        assert_eq!(snapshot["selection"]["group"], "default");
        assert!(!snapshot.to_string().contains("secretValue"));
        let mut p = get_provider(&db, &secrets, b_id).unwrap().unwrap();
        assert_eq!(p.name, "premium");
        assert_eq!(
            serde_json::to_value(p.star_ai_group.as_ref().unwrap()).unwrap(),
            json!({"id":"premium","description":"Chat","ratio":0.25,"modelVendors":{"shared":"Anthropic"},"chatModels":["shared"]})
        );
        assert_eq!(snapshot["groups"][1]["ratio"], 0.25);
        assert_eq!(snapshot["groups"][1]["label"], "premium");
        assert_eq!(p.models.len(), 2);
        assert!(p.has_secret);
        assert!(delete_provider(&db, &secrets, b_id).is_err());
        assert!(set_provider_secret(&db, &secrets, a_id, None).is_err());
        assert_ne!(
            get_secret_for_provider(&db, &secrets, a_id).unwrap(),
            get_secret_for_provider(&db, &secrets, b_id).unwrap()
        );
        assert_eq!(
            db.get_setting("app").unwrap().unwrap()["defaultProviderId"],
            "manual"
        );
        configure(
            &db,
            &secrets,
            config(vec![a.clone(), b.clone()], Some(&b), true),
        )
        .unwrap();
        p = get_provider(&db, &secrets, b_id).unwrap().unwrap();
        assert_eq!(p.default_model_id.as_deref(), Some("shared"));
        assert_eq!(
            db.get_setting("app").unwrap().unwrap()["defaultProviderId"],
            b_id
        );
        let mut invalid = b.clone();
        invalid["baseUrl"] = json!("https://example.invalid");
        assert!(configure(
            &db,
            &secrets,
            config(vec![a.clone(), invalid], Some(&a), true)
        )
        .is_err());
        assert_eq!(
            selection(&db).unwrap().unwrap()["selection"]["group"],
            "premium"
        );
        configure(&db, &secrets, config(vec![a.clone()], Some(&a), false)).unwrap();
        assert!(get_provider(&db, &secrets, b_id).unwrap().is_none());
        assert!(!secrets.has(&secret_ref_for_provider(b_id)));
        assert_eq!(
            db.get_setting("app").unwrap().unwrap()["defaultProviderId"],
            a_id
        );
        configure(&db, &secrets, config(vec![], None, false)).unwrap();
        assert!(selection(&db).unwrap().unwrap()["selection"].is_null());
        assert!(db
            .get_setting("app")
            .unwrap()
            .unwrap()
            .get("defaultModelId")
            .is_none());
        disconnect(&db, &secrets).unwrap();
        assert!(selection(&db).unwrap().is_none());
        assert_eq!(db.get_setting("app").unwrap().unwrap()["language"], "zh-CN");
    }

    #[test]
    fn suspend_withdraws_bindings_and_only_remembers_the_choice_for_revalidation() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("fixture.sqlite")).unwrap();
        let secrets = SecretStore::open(dir.path()).unwrap();
        let mut g = group("生图渠道", 41233);
        g["chatModels"] = json!([]);
        assert!(configure(&db, &secrets, config(vec![g.clone()], Some(&g), true)).is_err());
        configure(&db, &secrets, config(vec![g.clone()], None, false)).unwrap();
        let id = g["providerId"].as_str().unwrap();
        let media = get_provider(&db, &secrets, id).unwrap().unwrap();
        assert_eq!(media.models.len(), 2);
        assert!(media.default_model_id.is_none());
        db.set_setting(
            "app",
            &json!({"defaultProviderId":id,"defaultModelId":"old-hidden"}),
        )
        .unwrap();
        suspend(&db, &secrets).unwrap();
        let saved = selection(&db).unwrap().unwrap();
        assert_eq!(saved["groups"][0]["models"], json!([]));
        assert_eq!(saved["selection"]["model"], "old-hidden");
        assert!(get_provider(&db, &secrets, id).unwrap().is_none());
        assert!(db
            .get_setting("app")
            .unwrap()
            .unwrap()
            .get("defaultModelId")
            .is_none());
        assert!(!secrets.has(&secret_ref_for_provider(id)));
    }

    #[test]
    fn star_ai_sync_restores_legacy_group_identity_and_rolls_back_partial_writes() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("fixture.sqlite")).unwrap();
        let secrets = SecretStore::open(dir.path()).unwrap();
        let mut a = group("原分组", 41230);
        a["providerId"] = json!(ID);
        db.conn().execute("INSERT INTO providers (id,name,vendor_key,type,protocol,enabled,auth_kind,config_json,created_at,updated_at)
            VALUES (?1,'StarAI','custom','openai_compatible','openai_compatible',1,'api_key_and_base_url',?2,1,1)",
            params![ID, json!({"starAi":{"accountId":"42","group":"原分组","model":"shared","models":["shared"]}}).to_string()]).unwrap();
        let b = group("premium", 41231);
        configure(&db, &secrets, config(vec![a.clone()], Some(&a), false)).unwrap();
        let saved = selection(&db).unwrap();
        let old = get_secret_for_provider(&db, &secrets, ID).unwrap();
        a["secretValue"] = json!("rotated-loopback-fixture-secret-12345");
        db.conn().execute_batch("CREATE TRIGGER reject_extra BEFORE INSERT ON providers WHEN NEW.id <> 'starai-managed'
            BEGIN SELECT RAISE(ABORT,'injected write failure'); END;").unwrap();
        assert!(configure(
            &db,
            &secrets,
            config(vec![a.clone(), b.clone()], Some(&a), false)
        )
        .is_err());
        assert_eq!(selection(&db).unwrap(), saved);
        assert_eq!(get_secret_for_provider(&db, &secrets, ID).unwrap(), old);
        assert!(!secrets.has(&secret_ref_for_provider(b["providerId"].as_str().unwrap())));
        assert!(get_provider(&db, &secrets, ID).unwrap().unwrap().has_secret);
    }
}
