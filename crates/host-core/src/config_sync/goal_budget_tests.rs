use super::*;

fn application_snapshot(st: &mut AppState) -> Result<PortableEntity> {
    let selection = CategorySelection(
        domains::ALL_DOMAINS
            .iter()
            .map(|domain| (domain.to_string(), *domain == domains::DOMAIN_APPLICATION))
            .collect(),
    );
    let snapshot = domains::capture(
        st,
        &VaultKey([7; 32]),
        &selection,
        false,
        &BTreeMap::new(),
        &domains::ProjectIdentityOverrides::default(),
    )?;
    Ok(snapshot
        .manifest
        .entities
        .into_iter()
        .find(|e| e.domain == domains::DOMAIN_APPLICATION)
        .unwrap())
}
#[test]
fn goals_approved_config_sync_roundtrip_validates_defaults_and_keeps_old_goals() {
    let source_dir = tempfile::tempdir().unwrap();
    let dest_dir = tempfile::tempdir().unwrap();
    let mut source = AppState::open(source_dir.path()).unwrap();
    let dest = AppState::open(dest_dir.path()).unwrap();
    dest.db.set_setting("app",&json!({"defaultGoalBudget":{"maxTurns":4},"defaultCommandShell":"local-shell","theme":"dark"})).unwrap();
    let session =
        crate::sessions::create_session(&dest.db, None, Some("goal".into()), None, None, None)
            .unwrap();
    let old = crate::goals::start(
        &dest.db,
        serde_json::from_value(json!({"sessionId":session.id,"objective":"ship"})).unwrap(),
    )
    .unwrap();
    for budget in [
        json!({"maxTurns":9}),
        json!({"maxTurns":null,"maxTokens":100}),
    ] {
        source
            .db
            .set_setting("app", &json!({"theme":"light","defaultGoalBudget":budget}))
            .unwrap();
        let captured = application_snapshot(&mut source).unwrap();
        assert_eq!(captured.payload["defaultGoalBudget"], budget);
        apply_application(&dest, &captured.payload).unwrap();
        let read = dest.db.get_setting("app").unwrap().unwrap();
        assert_eq!(read["defaultGoalBudget"], budget);
        assert_eq!(read["theme"], "light");
        assert_eq!(read["defaultCommandShell"], "local-shell");
        assert_eq!(
            serde_json::to_value(crate::goals::get(&dest.db, &session.id).unwrap().unwrap())
                .unwrap(),
            serde_json::to_value(&old).unwrap()
        );
    }
    let before = dest.db.get_setting("app").unwrap().unwrap();
    for bad in [
        json!({}),
        json!({"maxTokens":9}),
        Value::Null,
        json!({"maxTurns":0}),
        json!({"maxTurns":null,"maxTokens":null}),
    ] {
        assert_eq!(
            apply_application(&dest, &json!({"theme":"dark","defaultGoalBudget":bad}))
                .unwrap_err()
                .to_string(),
            "CONFIG_SYNC_INVALID: defaultGoalBudget is invalid"
        );
        assert_eq!(dest.db.get_setting("app").unwrap().unwrap(), before);
        assert!(source
            .db
            .set_setting("app", &json!({"defaultGoalBudget":bad}))
            .is_err());
        source
            .db
            .kv_set("app", "app", &json!({"defaultGoalBudget":bad}))
            .unwrap();
        assert!(application_snapshot(&mut source).is_err());
    }
    drop(dest);
    let dest = AppState::open(dest_dir.path()).unwrap();
    assert_eq!(dest.db.get_setting("app").unwrap().unwrap(), before);
    assert_eq!(
        crate::goals::get(&dest.db, &session.id)
            .unwrap()
            .unwrap()
            .status,
        crate::goals::GoalStatus::Paused
    );
    apply_application(&dest, &json!({"theme":"dark"})).unwrap();
    assert!(dest
        .db
        .get_setting("app")
        .unwrap()
        .unwrap()
        .get("defaultGoalBudget")
        .is_none());
}
