use super::*;

#[tokio::test]
async fn notification_pending_completion_is_acknowledged_by_ordinary_history_actions() {
    for (method, viewed) in [
        ("notification.markRead", None),
        ("notification.markRead", Some(false)),
        ("notification.markRead", Some(true)),
        ("notification.markAllRead", None),
        ("notification.clear", None),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let session = sessions::create_session(
            &app.db,
            Some("Unseen result".into()),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let turn = sessions::begin_turn(&app.db, &session.id, None, None).unwrap();
        let state = Arc::new(Mutex::new(app));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let ended = handle_request(
            state.clone(),
            "session.endTurn",
            json!({ "turnId": turn, "status": "completed" }),
            tx.clone(),
        )
        .await
        .unwrap();
        let original = ended["notification"].clone();
        let id = original["id"].as_str().unwrap();
        let listed = handle_request(state.clone(), "notification.list", json!({}), tx.clone())
            .await
            .unwrap();
        assert_eq!(listed["pendingCompletionCount"], 1);
        assert_eq!(listed["pendingCompletions"], json!([original]));
        assert_eq!(listed["notifications"], listed["pendingCompletions"]);
        assert_eq!(listed["unreadCount"], 1);

        let params = if method == "notification.markRead" {
            match viewed {
                Some(viewed) => json!({ "id": id, "viewed": viewed }),
                None => json!({ "id": id }),
            }
        } else {
            json!({})
        };
        for _ in 0..2 {
            let result = handle_request(state.clone(), method, params.clone(), tx.clone())
                .await
                .unwrap();
            assert_eq!(result, json!({ "ok": true }));
            let listed = handle_request(
                state.clone(),
                "notification.list",
                json!({ "unreadOnly": true }),
                tx.clone(),
            )
            .await
            .unwrap();
            assert_eq!(listed["notifications"], json!([]));
            assert_eq!(listed["unreadCount"], 0);
            assert_eq!(
                listed["pendingCompletionCount"], 0,
                "{method}, viewed={viewed:?}"
            );
            assert_eq!(listed["pendingCompletions"], json!([]));
        }

        drop(state);
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let new_turn = sessions::begin_turn(&app.db, &session.id, None, None).unwrap();
        let state = Arc::new(Mutex::new(app));
        let replayed = handle_request(
            state.clone(),
            "session.endTurn",
            json!({ "turnId": turn, "status": "completed" }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(replayed, json!({ "ok": false }));
        let listed = handle_request(state.clone(), "notification.list", json!({}), tx.clone())
            .await
            .unwrap();
        assert_eq!(listed["pendingCompletions"], json!([]));
        assert_eq!(listed["pendingCompletionCount"], 0);
        assert_eq!(listed["unreadCount"], 0);
        let history = listed["notifications"].as_array().unwrap();
        assert_eq!(history.len(), usize::from(method != "notification.clear"));
        if let Some(notification) = history.first() {
            assert_eq!(notification["id"], id);
            assert_eq!(notification["sessionTitle"], "Unseen result");
            assert!(notification["readAt"].is_string());
        }
        let ended = handle_request(
            state.clone(),
            "session.endTurn",
            json!({ "turnId": new_turn, "status": "completed" }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_ne!(ended["notification"]["id"], id);
        let listed = handle_request(state, "notification.list", json!({}), tx)
            .await
            .unwrap();
        assert_eq!(listed["pendingCompletions"], json!([ended["notification"]]));
        assert_eq!(listed["pendingCompletionCount"], 1);
        assert_eq!(listed["unreadCount"], 1);
        assert!(
            rx.try_recv().is_err(),
            "no additional notification event channel"
        );
    }
}

#[tokio::test]
async fn notification_pending_completion_rpc_pages_independently_of_history_filter() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let session = sessions::create_session(&app.db, None, None, None, None, None).unwrap();
    let mut ids = Vec::new();
    for _ in 0..203 {
        let turn = sessions::begin_turn(&app.db, &session.id, None, None).unwrap();
        ids.push(
            sessions::end_turn(&app.db, &turn, "completed", None, None, true)
                .unwrap()
                .notification
                .unwrap()
                .id,
        );
    }
    let history = notifications::list(&app.db, false, 200).unwrap().0;
    let pruned_id = ids
        .iter()
        .find(|id| !history.iter().any(|n| &n.id == *id))
        .unwrap()
        .clone();
    app.db
        .conn()
        .execute(
            "UPDATE pending_completion_notifications SET created_at = 42",
            [],
        )
        .unwrap();
    ids.sort_by(|a, b| b.cmp(a));
    let state = Arc::new(Mutex::new(app));
    let (tx, _rx) = mpsc::unbounded_channel();
    for (params, start, len) in [
        (json!({}), 0, 200),
        (
            json!({ "unreadOnly": true, "limit": 500, "completionOffset": 200 }),
            200,
            3,
        ),
        (json!({ "limit": 2, "completionOffset": 1 }), 1, 2),
        (json!({ "limit": 0, "completionOffset": -1 }), 0, 1),
        (json!({ "completionOffset": 203 }), 203, 0),
    ] {
        let listed = handle_request(
            state.clone(),
            "notification.list",
            params.clone(),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(listed["pendingCompletionCount"], 203);
        assert_eq!(listed["unreadCount"], 200);
        let actual = listed["pendingCompletions"].as_array().unwrap();
        assert_eq!(actual.len(), len);
        assert_eq!(
            actual
                .iter()
                .map(|n| n["id"].as_str().unwrap().to_string())
                .collect::<Vec<_>>(),
            ids[start..start + len]
        );
        assert!(actual
            .iter()
            .all(|n| n.get("readAt").is_none() && n["kind"] == "task.completed"));
        if params["unreadOnly"] == true || params.get("limit").is_none() {
            assert_eq!(listed["notifications"].as_array().unwrap().len(), 200);
        }
    }
    for expected in [true, false] {
        let marked = handle_request(
            state.clone(),
            "notification.markRead",
            json!({ "id": pruned_id }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(marked, json!({ "ok": expected }));
    }
    let listed = handle_request(
        state,
        "notification.list",
        json!({ "completionOffset": 200 }),
        tx,
    )
    .await
    .unwrap();
    assert_eq!(listed["pendingCompletionCount"], 202);
    assert_eq!(listed["pendingCompletions"].as_array().unwrap().len(), 2);
    assert_eq!(listed["unreadCount"], 200);
}

#[tokio::test]
async fn notification_pending_completion_rpc_excludes_visible_failed_and_aborted_results() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let session = sessions::create_session(&app.db, None, None, None, None, None).unwrap();
    let state = Arc::new(Mutex::new(app));
    let (tx, _rx) = mpsc::unbounded_channel();
    for (status, create_notification) in [("completed", false), ("error", true), ("aborted", true)]
    {
        let turn = sessions::begin_turn(&state.lock().await.db, &session.id, None, None).unwrap();
        let result = handle_request(
            state.clone(),
            "session.endTurn",
            json!({
                "turnId": turn, "status": status, "createNotification": create_notification
            }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result.get("notification").is_some(), status == "error");
    }
    let listed = handle_request(state.clone(), "notification.list", json!({}), tx.clone())
        .await
        .unwrap();
    assert_eq!(listed["pendingCompletions"], json!([]));
    assert_eq!(listed["pendingCompletionCount"], 0);
    assert_eq!(listed["unreadCount"], 1);
    assert_eq!(listed["notifications"][0]["kind"], "task.failed");
    let marked = handle_request(
        state,
        "notification.markRead",
        json!({
            "id": listed["notifications"][0]["id"], "viewed": true
        }),
        tx,
    )
    .await
    .unwrap();
    assert_eq!(marked["ok"], true);
}
