use super::*;
use serde_json::json;

fn provider(db: &Database, secrets: &SecretStore, name: &str) -> ProviderPublic {
    create_provider(
        db,
        secrets,
        serde_json::from_value(json!({
            "name": name, "authKind": "none", "defaultModelId": "model-1"
        }))
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn provider_order_is_applied_on_read_and_survives_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let secrets = SecretStore::open(dir.path()).unwrap();
    let a = provider(&db, &secrets, "A");
    let b = provider(&db, &secrets, "B");
    let c = provider(&db, &secrets, "C");
    db.set_setting("providers.order", &json!([c.id, a.id, b.id]))
        .unwrap();
    drop(db);
    let db = Database::open(&path).unwrap();
    let rows = list_providers(&db, &secrets, true).unwrap();
    assert_eq!(
        rows.iter().map(|row| row.name.as_str()).collect::<Vec<_>>(),
        ["C", "A", "B"]
    );
    assert_eq!(rows[1].models, a.models);
}

fn names(db: &Database, secrets: &SecretStore, include_disabled: bool) -> Vec<String> {
    list_providers(db, secrets, include_disabled)
        .unwrap()
        .into_iter()
        .map(|row| row.name)
        .collect()
}

fn move_provider(
    db: &Database,
    secrets: &SecretStore,
    id: &str,
    target: &str,
    placement: &str,
) -> bool {
    reorder_providers(
        db,
        secrets,
        serde_json::from_value(json!({
            "id": id, "targetId": target, "placement": placement
        }))
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn provider_moves_preserve_configuration_and_new_or_disabled_rows() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let secrets = SecretStore::open(dir.path()).unwrap();
    let a = provider(&db, &secrets, "A");
    let b = provider(&db, &secrets, "B");
    let c = provider(&db, &secrets, "C");
    assert_eq!(names(&db, &secrets, true), ["A", "B", "C"]);
    assert!(move_provider(&db, &secrets, &c.id, &a.id, "before"));
    assert_eq!(names(&db, &secrets, true), ["C", "A", "B"]);
    assert!(move_provider(&db, &secrets, &c.id, &b.id, "after"));
    assert_eq!(names(&db, &secrets, true), ["A", "B", "C"]);
    db.conn()
        .execute(
            "UPDATE providers SET enabled = 0, owner_plugin_id = 'fixture.plugin' WHERE id = ?1",
            params![b.id],
        )
        .unwrap();
    assert!(move_provider(&db, &secrets, &b.id, &a.id, "before"));
    let d = provider(&db, &secrets, "D");
    assert_eq!(names(&db, &secrets, true), ["B", "A", "C", "D"]);
    assert_eq!(names(&db, &secrets, false), ["A", "C", "D"]);
    assert!(move_provider(&db, &secrets, &a.id, &c.id, "after"));
    assert_eq!(names(&db, &secrets, true), ["B", "C", "A", "D"]);
    for original in [&a, &c, &d] {
        let current = get_provider(&db, &secrets, &original.id).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(&current).unwrap(),
            serde_json::to_value(original).unwrap()
        );
    }
    let plugin = get_provider(&db, &secrets, &b.id).unwrap().unwrap();
    assert_eq!(plugin.owner_plugin_id.as_deref(), Some("fixture.plugin"));
    assert!(!plugin.enabled);
}

#[test]
fn provider_order_rejects_stale_moves_and_ignores_deleted_ids_on_read() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let secrets = SecretStore::open(dir.path()).unwrap();
    assert!(!move_provider(&db, &secrets, "missing", "target", "before"));
    let a = provider(&db, &secrets, "A");
    let b = provider(&db, &secrets, "B");
    let c = provider(&db, &secrets, "C");
    assert!(move_provider(&db, &secrets, &c.id, &a.id, "before"));
    let saved = db.get_setting("providers.order").unwrap();
    assert!(move_provider(&db, &secrets, &a.id, &a.id, "after"));
    assert!(move_provider(&db, &secrets, &a.id, &b.id, "before"));
    assert!(!move_provider(&db, &secrets, &a.id, "removed", "after"));
    assert_eq!(db.get_setting("providers.order").unwrap(), saved);
    delete_provider(&db, &secrets, &c.id).unwrap();
    assert_eq!(names(&db, &secrets, true), ["A", "B"]);
    assert!(!move_provider(&db, &secrets, &c.id, &a.id, "before"));
    assert_eq!(db.get_setting("providers.order").unwrap(), saved);
}
