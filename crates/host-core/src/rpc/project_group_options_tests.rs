use super::*;

async fn request(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    handle_request(state.clone(), method, params, mpsc::unbounded_channel().0).await
}

fn state(path: &Path) -> Arc<Mutex<AppState>> {
    let mut st = AppState::open(path).unwrap();
    st.handshook = true;
    Arc::new(Mutex::new(st))
}

#[tokio::test]
async fn project_group_options_rpc_create_edit_context_reopen_and_remote_rename() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    std::fs::create_dir_all(&root).unwrap();
    let st = state(dir.path());
    let created = request(&st, "project.group.create", json!({
        "name": "Local", "folders": [root],
        "capabilities": {"skillIds": [], "mcpServerIds": ["Unavailable", "Unavailable", "unavailable"]},
        "instructions": "# App\r\n中文"
    })).await.unwrap()["group"].clone();
    assert_eq!(
        created["capabilities"],
        json!({"skillIds": [], "mcpServerIds": ["Unavailable", "unavailable"]})
    );
    assert!(created.get("instructions").is_none());
    let edited = request(
        &st,
        "project.group.update",
        json!({
            "groupId": created["id"], "name": "Edited", "folders": [root]
        }),
    )
    .await
    .unwrap();
    assert_eq!(edited["group"]["capabilities"], created["capabilities"]);
    let remote = request(
        &st,
        "project.group.createRemote",
        json!({
            "name": "Remote", "remote": {"hostKey": "test-host", "path": "/srv/unavailable"},
            "capabilities": {"mcpServerIds": []}, "instructions": "remote only"
        }),
    )
    .await
    .unwrap()["group"]
        .clone();
    let renamed = request(&st, "project.group.rename", json!({
        "groupId": remote["id"], "name": "Remote edited", "capabilities": {"skillIds": ["future"]}
    })).await.unwrap()["group"].clone();
    assert_eq!(renamed["remote"], remote["remote"]);
    assert_eq!(renamed["primaryPath"], remote["primaryPath"]);
    assert_eq!(renamed["capabilities"], json!({"skillIds": ["future"]}));
    drop(st);
    let st = state(dir.path());
    let local_context = request(&st, "project.group.context", json!({"path": root}))
        .await
        .unwrap()["context"]
        .clone();
    assert_eq!(local_context["capabilities"], created["capabilities"]);
    assert_eq!(local_context["instructions"], "# App\r\n中文");
    let remote_context = request(
        &st,
        "project.group.context",
        json!({"path": remote["primaryPath"]}),
    )
    .await
    .unwrap()["context"]
        .clone();
    assert_eq!(remote_context["instructions"], "remote only");
    assert_eq!(remote_context["capabilities"], renamed["capabilities"]);
    request(&st, "project.group.update", json!({
        "groupId": created["id"], "name": "Reset", "folders": [root], "capabilities": {}, "instructions": ""
    })).await.unwrap();
    let context = request(&st, "project.group.context", json!({"path": root}))
        .await
        .unwrap()["context"]
        .clone();
    assert_eq!(context["capabilities"], json!({}));
    assert_eq!(context["instructions"], "");
    assert_eq!(std::fs::read_dir(root).unwrap().count(), 0);
}

#[tokio::test]
async fn project_group_options_rpc_invalid_settings_reject_before_any_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    let new_root = dir.path().join("new-project");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&new_root).unwrap();
    let st = state(dir.path());
    let group = request(&st, "project.group.create", json!({
        "name": "Original", "folders": [root], "capabilities": {"skillIds": []}, "instructions": "keep"
    })).await.unwrap()["group"].clone();
    let before = request(&st, "project.groups.list", json!({}))
        .await
        .unwrap();
    let invalid = [
        json!({"capabilities": null}),
        json!({"capabilities": []}),
        json!({"capabilities": {"skillIds": null}}),
        json!({"capabilities": {"unknown": []}}),
        json!({"capabilities": {"mcpServerIds": [""]}}),
        json!({"capabilities": {"skillIds": ["a\nb"]}}),
        json!({"instructions": null}),
        json!({"instructions": "é".repeat(16_385)}),
    ];
    for method in [
        "project.group.create",
        "project.group.createRemote",
        "project.group.update",
        "project.group.rename",
    ] {
        for settings in &invalid {
            let mut params = json!({"groupId": group["id"], "name": "Changed", "folders": [new_root],
                "remote": {"hostKey": "test-host", "path": "/srv/new"}});
            params
                .as_object_mut()
                .unwrap()
                .extend(settings.as_object().unwrap().clone());
            let error = request(&st, method, params).await.unwrap_err();
            assert_eq!(error.code, 1002, "{method}");
            assert_eq!(error.data.unwrap()["errorCode"], "INVALID_PARAMS");
            assert_eq!(
                request(&st, "project.groups.list", json!({}))
                    .await
                    .unwrap(),
                before
            );
        }
    }
    assert_eq!(
        request(
            &st,
            "project.group.instructions.get",
            json!({"groupId": group["id"]})
        )
        .await
        .unwrap()["content"],
        "keep"
    );
    for method in ["project.group.update", "project.group.rename"] {
        let error = request(
            &st,
            method,
            json!({"groupId": "absent", "name": "Bad", "folders": [root], "capabilities": {}}),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, 1002);
    }
}

#[tokio::test]
async fn project_group_options_rpc_legacy_edit_promotes_and_preserves_repository_instructions() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    std::fs::create_dir_all(&root).unwrap();
    let agents = root.join("AGENTS.md");
    std::fs::write(&agents, "Repository bytes\r\n").unwrap();
    let st = state(dir.path());
    request(&st, "projects.create", json!({"path": root}))
        .await
        .unwrap();
    let legacy = request(&st, "project.groups.list", json!({}))
        .await
        .unwrap()["groups"][0]
        .clone();
    assert_eq!(legacy["legacy"], true);
    assert!(legacy.get("capabilities").is_none());
    request(
        &st,
        "project.group.instructions.set",
        json!({"groupId": legacy["id"], "content": "App owned"}),
    )
    .await
    .unwrap();
    let group = request(
        &st,
        "project.group.rename",
        json!({"groupId": legacy["id"], "name": "Configured", "capabilities": {"skillIds": []}}),
    )
    .await
    .unwrap()["group"]
        .clone();
    assert_eq!(group["legacy"], false);
    assert_ne!(group["id"], legacy["id"]);
    let context = request(&st, "project.group.context", json!({"path": root}))
        .await
        .unwrap()["context"]
        .clone();
    assert_eq!(context["instructions"], "App owned");
    assert_eq!(context["capabilities"], json!({"skillIds": []}));
    assert_eq!(
        std::fs::read_to_string(agents).unwrap(),
        "Repository bytes\r\n"
    );
}

#[tokio::test]
async fn project_group_options_rpc_delete_cleans_stored_and_legacy_instructions() {
    let dir = tempfile::tempdir().unwrap();
    let st = state(dir.path());
    for legacy in [false, true] {
        let root = dir.path().join(if legacy { "legacy" } else { "stored" });
        std::fs::create_dir_all(&root).unwrap();
        let group = if legacy {
            request(&st, "projects.create", json!({"path": root}))
                .await
                .unwrap();
            request(&st, "project.groups.list", json!({}))
                .await
                .unwrap()["groups"][0]
                .clone()
        } else {
            request(
                &st,
                "project.group.create",
                json!({
                    "name": "Stored", "folders": [root], "capabilities": {"skillIds": []}
                }),
            )
            .await
            .unwrap()["group"]
                .clone()
        };
        request(
            &st,
            "project.group.instructions.set",
            json!({
                "groupId": group["id"], "content": "Remove with project"
            }),
        )
        .await
        .unwrap();
        let result = request(&st, "projects.remove", json!({"path": root}))
            .await
            .unwrap();
        assert_eq!(result["removed"], true);
        assert!(st
            .lock()
            .await
            .db
            .kv_get("projectGroupInstructions", group["id"].as_str().unwrap())
            .unwrap()
            .is_none());
        request(&st, "projects.create", json!({"path": root}))
            .await
            .unwrap();
        let context = request(&st, "project.group.context", json!({"path": root}))
            .await
            .unwrap();
        assert!(context["context"].is_null());
        request(&st, "projects.remove", json!({"path": root}))
            .await
            .unwrap();
    }
}
