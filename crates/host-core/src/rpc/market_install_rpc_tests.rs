use super::*;

#[tokio::test]
async fn cancel_install_uses_matching_plugin_without_waiting_for_app_state() {
    let data = tempfile::tempdir().unwrap();
    let mut app = AppState::open(data.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let guard = state.lock().await;
    let cancel = crate::plugins::CancelToken::default();
    crate::plugins::progress::arm_active_cancel("plugin-a", &cancel);

    let (tx, _rx) = mpsc::unbounded_channel();
    let mismatch = tokio::time::timeout(
        Duration::from_millis(100),
        handle_request(
            state.clone(),
            "market.cancelInstall",
            json!({ "id": "plugin-b" }),
            tx.clone(),
        ),
    )
    .await
    .expect("mismatched cancellation should not wait for AppState")
    .unwrap();
    assert_eq!(mismatch["cancelled"], false);
    assert!(!cancel.is_cancelled());

    let matched = tokio::time::timeout(
        Duration::from_millis(100),
        handle_request(
            state.clone(),
            "market.cancelInstall",
            json!({ "id": "plugin-a" }),
            tx,
        ),
    )
    .await
    .expect("matching cancellation should not wait for AppState")
    .unwrap();
    assert_eq!(matched["cancelled"], true);
    assert!(cancel.is_cancelled());

    crate::plugins::progress::disarm_active_cancel();
    drop(guard);
}
