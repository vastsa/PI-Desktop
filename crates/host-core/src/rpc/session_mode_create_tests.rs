use super::*;

fn definition(mode: &str) -> Value {
    json!({ "version": 1, "id": mode, "permission": "contract", "stages": [] })
}

#[tokio::test]
async fn session_create_persists_mode_snapshot_and_policy() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let (tx, _rx) = mpsc::unbounded_channel();
    for mode in ["goal", "review"] {
        let result = handle_request(
            state.clone(),
            "session.create",
            json!({
                "mode": mode, "modeSnapshot": definition(mode)
            }),
            tx.clone(),
        )
        .await
        .unwrap();
        let app = state.lock().await;
        let id = result["session"]["id"].as_str().unwrap();
        let hash: Option<String> = app
            .db
            .conn()
            .query_row(
                "SELECT mode_snapshot_hash FROM sessions WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(hash.is_some(), "{mode} must have its snapshot at creation");
        assert_eq!(
            crate::mode_runs::tool_policy(&app.db, id).unwrap(),
            Some(crate::mode_runs::ToolPolicy::Contract)
        );
    }
}

#[tokio::test]
async fn session_create_rejects_invalid_snapshot_without_leaving_a_session() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let (tx, _rx) = mpsc::unbounded_channel();
    let error = handle_request(
        state.clone(),
        "session.create",
        json!({
            "mode": "review", "modeSnapshot": definition("other")
        }),
        tx,
    )
    .await
    .unwrap_err();
    assert_eq!(error.data.unwrap()["errorCode"], "MODE_SNAPSHOT_INVALID");
    assert!(sessions::list_sessions(&state.lock().await.db)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn session_create_rolls_back_snapshot_when_session_insert_fails() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    app.db
        .conn()
        .execute_batch(
            "CREATE TRIGGER reject_session BEFORE INSERT ON sessions
         BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END;",
        )
        .unwrap();
    let state = Arc::new(Mutex::new(app));
    let (tx, _rx) = mpsc::unbounded_channel();
    assert!(handle_request(
        state.clone(),
        "session.create",
        json!({
            "mode": "review", "modeSnapshot": definition("review")
        }),
        tx
    )
    .await
    .is_err());
    let app = state.lock().await;
    assert!(sessions::list_sessions(&app.db).unwrap().is_empty());
    let count: i64 = app
        .db
        .conn()
        .query_row("SELECT count(*) FROM mode_snapshots", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}
