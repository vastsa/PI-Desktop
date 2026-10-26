use super::{create_migration_backup, Connection, Context, Path, Result};

/// Account identity is separate from legacy manifest singleton identities.
/// No existing provider is implicitly adopted into a template.
pub(crate) const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS provider_template_bindings (
  provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version = 1),
  definition_json TEXT NOT NULL
);
"#;

pub(crate) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 25)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(DDL)?;
    // Development builds also used v25 for templates without discovery state.
    super::model_discovery_migration::ensure_discovery_state(&tx)?;
    tx.pragma_update(None, "user_version", 26i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v25 to v26 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::{db::Database, providers, secrets::SecretStore};
    use serde_json::json;

    #[test]
    fn template_migration_v24_preserves_existing_rows_credentials_and_has_no_implicit_adoption() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        let secrets = SecretStore::open(root.path()).unwrap();
        let input = serde_json::from_value(json!({"name":"Existing user","secretValue":"fixture-migration-key","models":[{"id":"old-model"}]})).unwrap();
        let before = providers::create_provider(&db, &secrets, input).unwrap();
        let mut legacy = before.clone();
        legacy.owner_plugin_id = Some("fixture.legacy".into());
        db.conn()
            .execute(
                "UPDATE providers SET owner_plugin_id='fixture.legacy' WHERE id=?1",
                [&before.id],
            )
            .unwrap();
        let config: String = db
            .conn()
            .query_row(
                "SELECT config_json FROM providers WHERE id=?1",
                [&before.id],
                |r| r.get(0),
            )
            .unwrap();
        db.conn()
            .execute_batch("DROP TABLE provider_template_bindings; ALTER TABLE models DROP COLUMN discovery_state; PRAGMA user_version=24;")
            .unwrap();
        drop(db);
        let upgraded = Database::open(&path).unwrap();
        let after = providers::get_provider(&upgraded, &secrets, &before.id)
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(after).unwrap(),
            serde_json::to_value(legacy).unwrap()
        );
        assert_eq!(
            upgraded
                .conn()
                .query_row(
                    "SELECT config_json FROM providers WHERE id=?1",
                    [&before.id],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            config
        );
        assert_eq!(
            upgraded
                .conn()
                .query_row("SELECT count(*) FROM provider_template_bindings", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            upgraded
                .conn()
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            crate::db::SCHEMA_VERSION
        );
        assert_eq!(
            providers::get_secret_for_provider(&upgraded, &secrets, &before.id)
                .unwrap()
                .as_deref(),
            Some("fixture-migration-key")
        );
        assert!(upgraded
            .conn()
            .execute(
                "INSERT INTO provider_template_bindings VALUES(?1,'gateway',2,'{}')",
                [&before.id]
            )
            .is_err());
    }

    #[test]
    fn template_migration_accepts_both_v25_layouts_and_preserves_data() {
        use crate::db::{migration_backup_path, Connection, SCHEMA_VERSION};

        for template_layout in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("pi.sqlite");
            let db = Database::open(&path).unwrap();
            let secrets = SecretStore::open(root.path()).unwrap();
            let input = serde_json::from_value(json!({"name":"Kept account","secretValue":"fixture-v25-key","models":[{"id":"known"}]})).unwrap();
            let provider = providers::create_provider(&db, &secrets, input).unwrap();
            let session = crate::sessions::create_session(
                &db,
                Some("Kept conversation".into()),
                None,
                None,
                None,
                None,
            )
            .unwrap();
            db.kv_set("fixture", "history", &json!({"kept": true}))
                .unwrap();
            db.conn().execute(
                "INSERT INTO models(provider_id, model_id, display_name, source, updated_at, discovery_state) VALUES (?1, 'known', 'Known', 'discovered', 1, 'unlisted')",
                [&provider.id],
            ).unwrap();
            let mut expected = serde_json::to_value(&provider).unwrap();
            if template_layout {
                db.conn()
                    .execute(
                        "INSERT INTO provider_template_bindings VALUES (?1, 'gateway', 1, '{}')",
                        [&provider.id],
                    )
                    .unwrap();
                expected = serde_json::to_value(
                    providers::get_provider(&db, &secrets, &provider.id)
                        .unwrap()
                        .unwrap(),
                )
                .unwrap();
                db.conn()
                    .execute_batch("ALTER TABLE models DROP COLUMN discovery_state;")
                    .unwrap();
            } else {
                db.conn()
                    .execute_batch("DROP TABLE provider_template_bindings;")
                    .unwrap();
            }
            db.conn()
                .pragma_update(None, "user_version", 25i64)
                .unwrap();
            drop(db);

            let upgraded = Database::open(&path).unwrap();
            assert_eq!(
                upgraded
                    .conn()
                    .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                SCHEMA_VERSION
            );
            let bindings: i64 = upgraded
                .conn()
                .query_row("SELECT count(*) FROM provider_template_bindings", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(bindings, i64::from(template_layout));
            let models = providers::list_models(&upgraded, Some(&provider.id)).unwrap();
            assert_eq!(models.len(), 1);
            assert_eq!(
                models[0].discovery_state.as_deref(),
                Some(if template_layout {
                    "published"
                } else {
                    "unlisted"
                })
            );
            assert_eq!(
                serde_json::to_value(
                    providers::get_provider(&upgraded, &secrets, &provider.id)
                        .unwrap()
                        .unwrap()
                )
                .unwrap(),
                expected
            );
            assert_eq!(
                providers::get_secret_for_provider(&upgraded, &secrets, &provider.id)
                    .unwrap()
                    .as_deref(),
                Some("fixture-v25-key")
            );
            assert_eq!(
                upgraded.kv_get("fixture", "history").unwrap(),
                Some(json!({"kept": true}))
            );
            assert_eq!(
                upgraded
                    .conn()
                    .query_row(
                        "SELECT title FROM sessions WHERE id=?1",
                        [&session.id],
                        |r| r.get::<_, String>(0)
                    )
                    .unwrap(),
                "Kept conversation"
            );
            let backup_path = migration_backup_path(&path, 25);
            let backup_bytes = std::fs::read(&backup_path).unwrap();
            let backup = Connection::open(&backup_path).unwrap();
            assert_eq!(
                backup
                    .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                25
            );
            assert_eq!(
                backup
                    .query_row(
                        "SELECT count(*) FROM providers WHERE id=?1",
                        [&provider.id],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                1
            );
            drop(backup);
            drop(upgraded);
            let reopened = Database::open(&path).unwrap();
            assert_eq!(
                providers::list_models(&reopened, Some(&provider.id)).unwrap(),
                models
            );
            assert_eq!(
                reopened
                    .conn()
                    .query_row("SELECT count(*) FROM provider_template_bindings", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                bindings
            );
            assert_eq!(std::fs::read(&backup_path).unwrap(), backup_bytes);
        }
    }
}
