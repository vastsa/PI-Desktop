use super::*;

#[tokio::test]
async fn notification_rpc_keeps_schema_33_history_and_completion_acknowledgement() {
    for method in [
        "notification.markRead",
        "notification.markAllRead",
        "notification.clear",
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
        let (tx, _rx) = mpsc::unbounded_channel();
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
        assert_eq!(
            listed,
            json!({ "notifications": [original], "unreadCount": 1 })
        );
        let params = if method == "notification.markRead" {
            json!({ "id": id })
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
            assert_eq!(listed, json!({ "notifications": [], "unreadCount": 0 }));
        }
        drop(state);
        let reopened = AppState::open(dir.path()).unwrap();
        assert_eq!(
            reopened
                .db
                .conn()
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            33
        );
        let (history, unread) = notifications::list(&reopened.db, false, 200).unwrap();
        assert_eq!(unread, 0);
        if method == "notification.clear" {
            assert!(history.is_empty());
        } else {
            assert_eq!(history.len(), 1);
            assert_eq!(history[0].id, id);
            assert!(history[0].read_at.is_some());
        }
        assert!(
            sessions::end_turn(&reopened.db, &turn, "completed", None, None, true)
                .unwrap()
                .notification
                .is_none()
        );
        let new_turn = sessions::begin_turn(&reopened.db, &session.id, None, None).unwrap();
        assert!(
            sessions::end_turn(&reopened.db, &new_turn, "completed", None, None, true)
                .unwrap()
                .notification
                .is_some()
        );
        assert_eq!(notifications::list(&reopened.db, true, 200).unwrap().1, 1);
    }
}
