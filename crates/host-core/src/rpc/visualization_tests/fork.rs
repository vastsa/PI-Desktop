//! Real RPC path: Bash creates a chart, a completed reply references it,
//! the profile moves, then a bounded fork keeps its own chart after deletion.

use super::*;

#[tokio::test]
async fn rpc_bash_created_visualization_survives_relocation_fork_and_source_deletion() {
    let data = tempfile::tempdir().unwrap();
    let parent = workspace::simple_canonicalize(data.path()).unwrap();
    let data_dir = parent.join("old-profile");
    let workspace = parent.join("project");
    fs::create_dir_all(&data_dir).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    let f = Fixture {
        _data: data,
        scratch: scratch::session_dir(&data_dir, "s1").unwrap(),
        visualization: visualizations::session_dir(&data_dir, "s1").unwrap(),
        data_dir,
        workspace,
    };
    let (state, id) = rpc_session(&f, false, "auto").await;
    let root = visualizations::session_dir(&f.data_dir, &id).unwrap();
    let chart = root.join("chart.html");
    let shell = tools::shell::catalog(None).effective.unwrap();
    let quote = |path: &Path| path.to_string_lossy().replace('\'', "'\\''");
    let command = match shell.dialect.as_str() {
        "powershell" => format!(
            "[void][System.IO.Directory]::CreateDirectory('{}'); [System.IO.File]::WriteAllText('{}', '<p>chart</p>')",
            root.to_string_lossy().replace('\'', "''"), chart.to_string_lossy().replace('\'', "''"),
        ),
        "cmd" => format!(
            "if not exist \"{}\" mkdir \"{}\" & > \"{}\" echo ^<p^>chart^</p^>",
            root.display(), root.display(), chart.display(),
        ),
        _ => format!("mkdir -p '{}'; printf '%s' '<p>chart</p>' > '{}'", quote(&root), quote(&chart)),
    };
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        handle_request(
            state.clone(),
            "tools.execute",
            json!({ "sessionId": id, "toolCallId": "bash-chart", "toolName": "Bash",
            "args": { "command": command }, "mode": "agent",
            "expectedCommandShellId": shell.id, "expectedCommandShellDialect": shell.dialect }),
            mpsc::unbounded_channel().0,
        ),
    )
    .await
    .expect("the fixture approves Bash and it finishes within its execution budget")
    .unwrap();
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(fs::read_to_string(&chart).unwrap().trim(), "<p>chart</p>");
    fs::write(root.join("unreferenced.html"), "unused").unwrap();
    let reference = format!("::visualize{}", json!({"path": chart, "title": "Chart"}));
    handle_request(
        state.clone(),
        "session.appendMessage",
        json!({ "sessionId": id, "message": { "id": "chart-reply", "role": "assistant",
            "content": reference, "createdAt": "2026-10-08T00:00:00Z" } }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let later = root.join("later.html");
    fs::write(&later, "later").unwrap();
    handle_request(
        state.clone(), "session.appendMessage",
        json!({ "sessionId": id, "message": { "id": "later-reply", "role": "assistant",
            "content": format!("::visualize{}", json!({"path": later})), "createdAt": "2026-10-08T00:00:01Z" } }),
        mpsc::unbounded_channel().0,
    ).await.unwrap();
    drop(state);

    let moved_data = parent.join("moved-profile");
    fs::rename(&f.data_dir, &moved_data).unwrap();
    let mut moved = AppState::open(&moved_data).unwrap();
    moved.handshook = true;
    let state = Arc::new(Mutex::new(moved));
    let source = handle_request(
        state.clone(),
        "session.get",
        json!({"id": id}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(source["session"]["messages"][0]["content"], reference);
    assert!(!chart.exists());
    let fork = handle_request(
        state.clone(),
        "session.fork",
        json!({"sessionId": id, "throughMessageId": "chart-reply"}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let child_id = fork["session"]["id"].as_str().unwrap();
    let child_root = visualizations::session_dir(&moved_data, child_id).unwrap();
    let child_chart = child_root.join("chart.html");
    assert_eq!(
        fs::read_to_string(&child_chart).unwrap().trim(),
        "<p>chart</p>"
    );
    assert_eq!(fork["session"]["messages"].as_array().unwrap().len(), 1);
    assert_eq!(
        fork["session"]["messages"][0]["content"],
        format!(
            "::visualize{}",
            json!({"path": child_chart, "title": "Chart"})
        )
    );
    assert!(!child_root.join("unreferenced.html").exists());
    assert!(!child_root.join("later.html").exists());
    handle_request(
        state.clone(),
        "session.delete",
        json!({"id": id}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read_to_string(&child_chart).unwrap().trim(),
        "<p>chart</p>"
    );
    let child = handle_request(
        state,
        "session.get",
        json!({"id": child_id}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(
        child["session"]["messages"][0]["content"],
        fork["session"]["messages"][0]["content"]
    );
}

#[tokio::test]
async fn rpc_visualization_fork_index_failure_rolls_back_child_files() {
    let f = fixture();
    let (state, id) = rpc_session(&f, false, "ask").await;
    let source = visualizations::session_dir(&f.data_dir, &id).unwrap();
    fs::create_dir_all(&source).unwrap();
    let chart = source.join("chart.html");
    fs::write(&chart, "source bytes").unwrap();
    handle_request(
        state.clone(), "session.appendMessage",
        json!({ "sessionId": id, "message": {"id": "chart", "role": "assistant",
            "content": format!("::visualize{}", json!({"path": chart})), "createdAt": "2026-10-08T00:00:00Z"} }),
        mpsc::unbounded_channel().0,
    ).await.unwrap();
    let transcripts_before = fs::read_dir(f.data_dir.join("sessions")).unwrap().count();
    state.lock().await.db.conn().execute_batch("CREATE TRIGGER fail_fork BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected index failure'); END;").unwrap();
    let result = handle_request(
        state,
        "session.fork",
        json!({"sessionId": id}),
        mpsc::unbounded_channel().0,
    )
    .await;
    assert!(result.is_err());
    assert_eq!(
        fs::read_dir(f.data_dir.join("sessions")).unwrap().count(),
        transcripts_before
    );
    assert_eq!(
        fs::read_dir(visualizations::base_dir(&f.data_dir))
            .unwrap()
            .count(),
        1
    );
    assert_eq!(fs::read_to_string(chart).unwrap(), "source bytes");
}
