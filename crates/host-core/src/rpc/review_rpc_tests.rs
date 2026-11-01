use super::*;
use crate::review::{finalize_change, prepare_change, ReviewChange};
use tempfile::{tempdir, TempDir};

struct Fixture {
    data: TempDir,
    root: TempDir,
    session: String,
    state: Arc<Mutex<AppState>>,
}

impl Fixture {
    async fn new() -> Self {
        let data = tempdir().unwrap();
        let root = tempdir().unwrap();
        let mut app = AppState::open(data.path()).unwrap();
        app.handshook = true;
        let state = Arc::new(Mutex::new(app));
        let result = handle_request(
            state.clone(),
            "session.create",
            json!({"mode":"agent", "projectPath":root.path().to_string_lossy()}),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
        let session = result["id"]
            .as_str()
            .or_else(|| result["session"]["id"].as_str())
            .unwrap()
            .to_owned();
        Self {
            data,
            root,
            session,
            state,
        }
    }

    async fn call(&self, method: &str, mut params: Value) -> Value {
        params["sessionId"] = json!(self.session);
        handle_request(
            self.state.clone(),
            method,
            params,
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap()
    }

    async fn append(&self, message: Value, turn: Option<&str>) {
        self.call(
            "session.appendMessage",
            json!({"message":message, "turnId":turn}),
        )
        .await;
    }

    async fn user(&self, id: &str, turn: Option<&str>) {
        self.append(
            json!({"id":id,"role":"user","content":format!("Prompt {id} {}", "界".repeat(90)),
            "createdAt":"2026-10-20T00:00:00Z"}),
            turn,
        )
        .await;
    }

    fn capture(&self, root: &Path, id: &str, text: &str) -> ReviewChange {
        let target = root.join("file.txt");
        let pending = prepare_change(
            self.data.path(),
            &self.session,
            id,
            Some(root),
            &ContainedRoots::new(),
            "Write",
            &json!({"path":"file.txt"}),
            false,
        )
        .unwrap()
        .unwrap();
        std::fs::write(target, text).unwrap();
        finalize_change(&pending).unwrap()
    }

    async fn tool(&self, id: &str, review: Value, parent: Option<&str>, turn: Option<&str>) {
        self.append(json!({"id":id,"role":"tool","content":"large tool body must not cross IPC",
            "createdAt":"2026-10-20T00:00:01Z", "toolName":"Write", "toolCallId":format!("call-{id}"),
            "toolStatus":"success", "toolArgs":{"path":"file.txt","content":"private input body"},
            "parentToolCallId":parent, "toolResult":{"content":[{"type":"text","text":"raw result body"}],
                "details":{"root":"workspace", "review":review}}}), turn).await;
    }

    async fn indexed_turn(&self, id: &str) {
        self.state.lock().await.db.conn().execute(
            "INSERT INTO turns (id, session_id, status, started_at) VALUES (?1, ?2, 'completed', 1)",
            rusqlite::params![id, self.session]).unwrap();
    }
}

#[tokio::test]
async fn review_rpc_latest_turn_late_delegate_dedup_roots_and_restart() {
    let mut f = Fixture::new().await;
    f.indexed_turn("turn-one").await;
    f.indexed_turn("turn-two").await;
    f.user("u1", Some("turn-one")).await;
    f.append(
        json!({"id":"task","role":"tool","content":"","createdAt":"2026-10-20T00:00:00Z",
        "toolName":"Task","toolCallId":"task-call","toolStatus":"success"}),
        Some("turn-one"),
    )
    .await;
    let first = f.capture(f.root.path(), "first", "one\n");
    f.tool("first", json!(first), None, Some("turn-one")).await;
    f.user("u2", Some("turn-two")).await;
    let second = f.capture(f.root.path(), "second", "two\n");
    f.tool("second", json!(second), None, Some("turn-two"))
        .await;
    // A different checkout, same relative path; parent Task, not arrival time
    // or the accidentally inherited turn-two index, owns this late result.
    let delegate = tempdir().unwrap();
    let late = f.capture(delegate.path(), "late", "delegate\n");
    f.tool("late", json!(late), Some("task-call"), Some("turn-two"))
        .await;
    f.tool("duplicate", json!(late), Some("task-call"), None)
        .await;
    // Non-delegate terminal results also honor their durable turn_id index.
    let old = f.capture(f.root.path(), "old-result", "old result\n");
    f.tool("old-result", json!(old), None, Some("turn-one"))
        .await;
    f.user("no-changes", None).await;
    assert_eq!(f.call("review.changes", json!({})).await["turnId"], "u2");
    let page = f.call("review.turns", json!({"limit":1})).await;
    assert_eq!(page["turns"][0]["id"], "u2");
    assert_eq!(page["turns"][0]["userMessageId"], "u2");
    assert_eq!(
        page["turns"][0]["title"].as_str().unwrap().chars().count(),
        80
    );
    let older = f
        .call(
            "review.turns",
            json!({"before":page["nextBefore"],"limit":1}),
        )
        .await;
    assert_eq!(older["turns"][0]["id"], "u1");
    assert_eq!(older["turns"][0]["changeCount"], 3);
    assert_eq!(page["turns"][0]["additions"], second.additions);
    assert_eq!(page["turns"][0]["deletions"], second.deletions);
    assert_eq!(
        older["turns"][0]["additions"],
        first.additions + late.additions + old.additions
    );
    assert_eq!(
        older["turns"][0]["deletions"],
        first.deletions + late.deletions + old.deletions
    );
    assert!(older.get("nextBefore").is_none());
    let changes = f
        .call("review.changes", json!({"snapshotId":late.snapshot_id}))
        .await;
    assert_eq!(changes["turnId"], "u1");
    assert_eq!(changes["changes"].as_array().unwrap().len(), 3);
    assert_ne!(changes["changes"][0]["root"], changes["changes"][1]["root"]);
    assert_eq!(
        changes["changes"][1]["message"]["parentToolCallId"],
        "task-call"
    );
    assert_eq!(
        changes["changes"][1]["message"]["toolResult"]["details"]["review"]["reversible"],
        false
    );
    assert!(!changes.to_string().contains("private input body"));
    assert!(!changes.to_string().contains("raw result body"));
    assert!(!changes.to_string().contains("large tool body"));
    assert_eq!(
        f.call("review.changes", json!({"snapshotId":"absent"}))
            .await,
        json!({"turnId":null,"changes":[]})
    );
    assert_eq!(
        f.call("review.changes", json!({"turnId":"no-changes"}))
            .await,
        json!({"turnId":null,"changes":[]})
    );
    assert_eq!(
        f.call("review.rollback", json!({"snapshotId":late.snapshot_id}))
            .await["status"],
        "unavailable"
    );
    let previous = f.call("review.turns", json!({})).await;
    let mut app = AppState::open(f.data.path()).unwrap();
    app.handshook = true;
    f.state = Arc::new(Mutex::new(app));
    assert_eq!(f.call("review.turns", json!({})).await, previous);
    assert_eq!(
        f.call("review.changes", json!({"snapshotId":late.snapshot_id}))
            .await,
        changes
    );
    assert!(f
        .call(
            "review.context",
            json!({"snapshotId":second.snapshot_id,"context":3})
        )
        .await["hunks"]
        .is_array());
}

#[tokio::test]
async fn review_rpc_pages_over_a_hundred_turns_and_changes_without_tool_bodies() {
    let f = Fixture::new().await;
    for i in 0..105 {
        f.user(&format!("u{i}"), None).await;
        let review = f.capture(f.root.path(), &format!("m{i}"), &format!("version {i}\n"));
        f.tool(&format!("m{i}"), json!(review), None, None).await;
    }
    let page = f.call("review.turns", json!({"limit":999})).await;
    assert_eq!(page["turns"].as_array().unwrap().len(), 100);
    assert_eq!(page["turns"][0]["id"], "u104");
    let tail = f
        .call(
            "review.turns",
            json!({"before":page["nextBefore"],"limit":100}),
        )
        .await;
    assert_eq!(tail["turns"].as_array().unwrap().len(), 5);
    assert_eq!(tail["turns"][4]["id"], "u0");
    f.user("many", None).await;
    for i in 0..105 {
        let id = format!("many-{i}");
        let review = f.capture(f.root.path(), &id, &format!("many {i}\n"));
        f.tool(&id, json!(review), None, None).await;
    }
    let page = f.call("review.changes", json!({"limit":999})).await;
    assert_eq!(page["turnId"], "many");
    assert_eq!(page["changes"].as_array().unwrap().len(), 100);
    assert_eq!(page["nextOffset"], 100);
    let tail = f
        .call(
            "review.changes",
            json!({"turnId":"many","offset":page["nextOffset"],"limit":100}),
        )
        .await;
    assert_eq!(tail["changes"].as_array().unwrap().len(), 5);
    assert_eq!(tail["changes"][4]["message"]["id"], "many-104");
    assert!(tail.get("nextOffset").is_none());
    assert_eq!(
        f.call("review.changes", json!({"limit":0})).await["changes"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn review_rpc_filters_invalid_evidence_and_marks_oversized_hunks() {
    let f = Fixture::new().await;
    f.user("u", None).await;
    let review = f.capture(f.root.path(), "valid", "changed\n");
    for (id, patch) in [
        ("failed", json!({"toolStatus":"error"})),
        (
            "unknown-root",
            json!({"toolResult":{"details":{"root":"unknown","review":review}}}),
        ),
        ("read", json!({"toolName":"Read"})),
        (
            "invalid",
            json!({"toolResult":{"details":{"root":"workspace","review":{"snapshotId":"bad"}}}}),
        ),
    ] {
        let mut message = json!({"id":id,"role":"tool","content":"","createdAt":"2026-10-20T00:00:00Z",
            "toolName":"Write","toolStatus":"success","toolCallId":id,
            "toolResult":{"details":{"root":"workspace","review":review}}});
        for (key, value) in patch.as_object().unwrap() {
            message[key] = value.clone();
        }
        f.append(message, None).await;
    }
    assert_eq!(f.call("review.turns", json!({})).await, json!({"turns":[]}));
    let mut large = json!(review);
    large["hunks"] =
        json!([{"header":"@@ -1,1 +1,1 @@","lines":[{"type":"add","text":"x".repeat(100_000)}]}]);
    f.tool("valid", large, None, None).await;
    let result = f.call("review.changes", json!({})).await;
    assert_eq!(result["changes"].as_array().unwrap().len(), 1);
    assert_eq!(
        result["changes"][0]["message"]["toolResult"]["details"]["review"]["truncated"],
        true
    );
    assert!(serde_json::to_vec(&result).unwrap().len() < 32 * 1024);
    let catalog = f.call("review.turns", json!({})).await;
    assert_eq!(catalog["turns"][0]["additions"], review.additions);
    assert_eq!(catalog["turns"][0]["deletions"], review.deletions);
    let orphan = f.capture(f.root.path(), "orphan", "orphan result\n");
    f.tool("orphan", json!(orphan), Some("missing-legacy-task"), None)
        .await;
    let result = f.call("review.changes", json!({})).await;
    assert_eq!(result["changes"].as_array().unwrap().len(), 2);
    let path = f
        .data
        .path()
        .join("review-changes")
        .join(&f.session)
        .join(&orphan.snapshot_id)
        .join("meta.json");
    std::fs::remove_file(&path).unwrap();
    let result = f.call("review.changes", json!({})).await;
    assert_eq!(result["changes"].as_array().unwrap().len(), 2);
    assert_eq!(
        result["changes"][1]["message"]["toolResult"]["details"]["review"]["reversible"],
        false
    );
    std::fs::write(path, b"corrupt metadata").unwrap();
    let error = handle_request(
        f.state.clone(),
        "review.changes",
        json!({"sessionId":f.session}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap_err();
    assert_eq!(error.data.unwrap()["errorCode"], "INTERNAL");
}

#[tokio::test]
async fn review_rpc_legacy_delegate_is_read_only_but_parent_rollback_still_works() {
    let f = Fixture::new().await;
    f.user("u", None).await;
    f.append(
        json!({"id":"task","role":"tool","content":"","createdAt":"2026-10-20T00:00:00Z",
        "toolName":"Task","toolCallId":"task-call","toolStatus":"success"}),
        None,
    )
    .await;
    let review = f.capture(f.root.path(), "legacy", "legacy\n");
    let path = f
        .data
        .path()
        .join("review-changes")
        .join(&f.session)
        .join(&review.snapshot_id)
        .join("meta.json");
    let mut meta: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    meta.as_object_mut().unwrap().remove("root");
    std::fs::write(&path, serde_json::to_vec(&meta).unwrap()).unwrap();
    let mut legacy = json!(review);
    legacy.as_object_mut().unwrap().remove("root");
    f.tool("legacy", legacy, Some("task-call"), None).await;
    let result = f.call("review.changes", json!({})).await;
    assert_eq!(result["turnId"], "u");
    assert_eq!(
        result["changes"][0]["message"]["toolResult"]["details"]["review"]["reversible"],
        false
    );
    assert_eq!(
        f.call("review.rollback", json!({"snapshotId":review.snapshot_id}))
            .await["status"],
        "unavailable"
    );
    let normal = f.capture(f.root.path(), "normal", "normal\n");
    f.tool("normal", json!(normal), None, None).await;
    for expected in ["rolledBack", "alreadyRolledBack"] {
        assert_eq!(
            f.call("review.rollback", json!({"snapshotId":normal.snapshot_id}))
                .await["status"],
            expected
        );
    }
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("file.txt")).unwrap(),
        "legacy\n"
    );
    let result = f
        .call("review.changes", json!({"snapshotId":normal.snapshot_id}))
        .await;
    assert_eq!(
        result["changes"][1]["message"]["toolResult"]["details"]["review"]["state"],
        "rolledBack"
    );
}

#[tokio::test]
async fn review_rpc_rejects_invalid_parameters_and_missing_sessions() {
    let f = Fixture::new().await;
    for (method, params) in [
        (
            "review.context",
            json!({"sessionId":f.session,"snapshotId":"snapshot","context":0}),
        ),
        (
            "review.context",
            json!({"sessionId":f.session,"snapshotId":"../escape","context":3}),
        ),
        ("review.changes", json!({"sessionId":f.session,"offset":-1})),
        (
            "review.turns",
            json!({"sessionId":f.session,"before":"bad"}),
        ),
        ("review.turns", json!({})),
    ] {
        let error = handle_request(f.state.clone(), method, params, mpsc::unbounded_channel().0)
            .await
            .unwrap_err();
        assert_eq!(error.data.unwrap()["errorCode"], "INVALID_PARAMS");
    }
    let error = handle_request(
        f.state.clone(),
        "review.turns",
        json!({"sessionId":"missing"}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap_err();
    assert_eq!(error.data.unwrap()["errorCode"], "SESSION_NOT_FOUND");
}

#[tokio::test]
async fn review_rpc_remote_boundary_and_newline_only_records() {
    let f = Fixture::new().await;
    f.user("u", None).await;
    f.append(
        json!({"id":"task","role":"tool","content":"","createdAt":"2026-10-20T00:00:00Z",
        "toolName":"Task","toolCallId":"task-call","toolStatus":"success"}),
        None,
    )
    .await;
    f.user("later-user", None).await;
    std::fs::write(f.root.path().join("file.txt"), "unchanged").unwrap();
    let review = f.capture(f.root.path(), "newline", "unchanged\n");
    assert!(review.hunks.is_empty()); // Preserve the old three-line record.
    f.tool("newline", json!([review, review]), Some("task-call"), None)
        .await;
    assert_eq!(
        f.call("review.turns", json!({})).await["turns"][0]["id"],
        "u"
    );
    assert_eq!(
        f.call("review.turns", json!({})).await["turns"][0]["changeCount"],
        1
    );
    let expanded = f
        .call(
            "review.context",
            json!({"snapshotId":review.snapshot_id,"context":1}),
        )
        .await;
    assert!(expanded.to_string().contains("No newline"));
    let group = f
        .state
        .lock()
        .await
        .db
        .create_remote_project_group(
            "Remote",
            crate::db::RemoteWorkspace {
                host_key: "test-host".into(),
                path: "/workspace/project".into(),
            },
        )
        .unwrap();
    let remote = handle_request(
        f.state.clone(),
        "session.create",
        json!({"projectPath":group.primary_path}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let id = remote["session"]["id"]
        .as_str()
        .or_else(|| remote["id"].as_str())
        .unwrap();
    for method in [
        "review.turns",
        "review.changes",
        "review.context",
        "review.rollback",
        "review.fileTarget",
        "review.rollbackFile",
    ] {
        let error = handle_request(
            f.state.clone(),
            method,
            json!({"sessionId":id,"snapshotId":"snapshot","context":3}),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap_err();
        assert_eq!(error.data.unwrap()["errorCode"], "CAPABILITY_UNAVAILABLE");
    }
}

#[tokio::test]
async fn review_file_rollback_preflights_chain_and_restores_once() {
    for conflict in [false, true] {
        let f = Fixture::new().await;
        f.user("file-round", None).await;
        std::fs::write(f.root.path().join("file.txt"), "original\n").unwrap();
        let first = f.capture(f.root.path(), "file-first", "one\n");
        f.tool("file-first", json!(first), None, None).await;
        let second = f.capture(f.root.path(), "file-second", "two\n");
        f.tool("file-second", json!(second), None, None).await;
        if conflict {
            std::fs::write(f.root.path().join("file.txt"), "user edit\n").unwrap();
        }
        let result = f
            .call(
                "review.rollbackFile",
                json!({"snapshotId":first.snapshot_id}),
            )
            .await;
        assert_eq!(
            result["status"],
            if conflict { "conflict" } else { "rolledBack" }
        );
        assert_eq!(
            std::fs::read_to_string(f.root.path().join("file.txt")).unwrap(),
            if conflict {
                "user edit\n"
            } else {
                "original\n"
            }
        );
        let changes = f.call("review.changes", json!({})).await;
        for row in changes["changes"].as_array().unwrap() {
            assert_eq!(
                row["message"]["toolResult"]["details"]["review"]["state"],
                if conflict { "active" } else { "rolledBack" }
            );
        }
        if !conflict {
            assert_eq!(result["changes"].as_array().unwrap().len(), 2);
            assert_eq!(
                f.call(
                    "review.rollbackFile",
                    json!({"snapshotId":second.snapshot_id})
                )
                .await["status"],
                "alreadyRolledBack"
            );
        }
    }
}

#[tokio::test]
async fn review_file_rollback_rejects_broken_intermediate_history_without_partial_write() {
    let f = Fixture::new().await;
    f.user("broken-round", None).await;
    let first = f.capture(f.root.path(), "broken-first", "one\n");
    f.tool("broken-first", json!(first), None, None).await;
    std::fs::write(f.root.path().join("file.txt"), "unrecorded\n").unwrap();
    let second = f.capture(f.root.path(), "broken-second", "two\n");
    f.tool("broken-second", json!(second), None, None).await;
    let result = f
        .call(
            "review.rollbackFile",
            json!({"snapshotId":second.snapshot_id}),
        )
        .await;
    assert_eq!(result["status"], "conflict");
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("file.txt")).unwrap(),
        "two\n"
    );
}

#[tokio::test]
async fn review_file_target_is_exact_session_owned_and_rejects_replaced_paths() {
    let f = Fixture::new().await;
    f.user("open-round", None).await;
    let parent = tempdir().unwrap();
    let external = parent.path().join("external");
    std::fs::create_dir(&external).unwrap();
    let review = f.capture(&external, "outside-open", "current\n");
    f.tool("outside-open", json!(review), None, None).await;
    let result = f
        .call(
            "review.fileTarget",
            json!({"snapshotId":review.snapshot_id}),
        )
        .await;
    assert_eq!(
        Path::new(result["path"].as_str().unwrap()),
        crate::workspace::simple_canonicalize(&external.join("file.txt")).unwrap()
    );
    let other = Fixture::new().await;
    assert!(handle_request(
        other.state.clone(),
        "review.fileTarget",
        json!({"sessionId":other.session,"snapshotId":review.snapshot_id}),
        mpsc::unbounded_channel().0
    )
    .await
    .is_err());
    let redirected = tempdir().unwrap();
    std::fs::write(redirected.path().join("file.txt"), "different\n").unwrap();
    std::fs::remove_dir_all(&external).unwrap();
    crate::session_worktrees::test_support::link_dir(redirected.path(), &external);
    assert!(handle_request(
        f.state.clone(),
        "review.fileTarget",
        json!({"sessionId":f.session,"snapshotId":review.snapshot_id}),
        mpsc::unbounded_channel().0
    )
    .await
    .is_err());
}

#[tokio::test]
async fn review_rpc_records_workspace_scratch_and_approved_external_write_edit() {
    let f = Fixture::new().await;
    f.call(
        "session.configure",
        json!({"id":f.session,"mode":"agent","permissionMode":"auto"}),
    )
    .await;
    f.user("outside-round", None).await;
    let outside = tempdir().unwrap();
    let scratch = crate::scratch::session_dir(f.data.path(), &f.session).unwrap();
    std::fs::create_dir_all(&scratch).unwrap();
    let targets = [
        ("workspace", f.root.path().join("same.txt")),
        ("scratch", scratch.join("same.txt")),
        ("external", outside.path().join("same.txt")),
    ];
    for (index, (kind, target)) in targets.iter().enumerate() {
        let id = format!("write-{index}");
        let write = f.call("tools.execute", json!({"toolCallId":id,"toolName":"Write","args":{"path":target.to_string_lossy(),"content":"before\n"},"mode":"agent"})).await;
        assert_eq!(write["ok"], true, "{write}");
        assert_eq!(write["content"]["root"], *kind);
        let review = &write["content"]["review"];
        assert!(
            review.is_object(),
            "successful {kind} Write must carry review: {write}"
        );
        let expected = if *kind == "workspace" {
            "same.txt".into()
        } else {
            crate::workspace::simple_canonicalize(target)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/")
        };
        assert_eq!(review["path"], expected);
        assert_eq!(review["reversible"], *kind == "workspace");
        f.append(json!({"id":id,"role":"tool","content":"","createdAt":"2026-10-20T00:00:01Z","toolName":"Write","toolCallId":id,"toolStatus":"success","toolResult":{"details":write["content"]}}),None).await;
        let edit_id = format!("edit-{index}");
        let edit = f.call("tools.execute", json!({"toolCallId":edit_id,"toolName":"Edit","args":{"path":target.to_string_lossy(),"tag":write["content"]["tag"],"ops":"PUT 1.=1:\n+after\n"},"mode":"agent"})).await;
        assert_eq!(edit["ok"], true, "{edit}");
        assert!(
            edit["content"]["review"].is_object(),
            "{kind} Edit must carry review: {edit}"
        );
        assert_eq!(edit["content"]["review"]["path"], expected);
        let snapshot = edit["content"]["review"]["snapshotId"].as_str().unwrap();
        let saved = f
            .call("review.context", json!({"snapshotId":snapshot,"context":5}))
            .await;
        assert!(saved["hunks"].to_string().contains("before"));
        assert!(saved["hunks"].to_string().contains("after"));
        f.append(json!({"id":edit_id,"role":"tool","content":"","createdAt":"2026-10-20T00:00:02Z","toolName":"Edit","toolCallId":edit_id,"toolStatus":"success","toolResult":{"details":edit["content"]}}),None).await;
        if *kind != "workspace" {
            let rollback = f
                .call("review.rollback", json!({"snapshotId":snapshot}))
                .await;
            assert_eq!(
                rollback["status"], "unavailable",
                "snapshot never grants outside write access"
            );
            assert_eq!(std::fs::read_to_string(target).unwrap(), "after\n");
        }
    }
    let changes = f.call("review.changes", json!({})).await;
    assert_eq!(changes["changes"].as_array().unwrap().len(), 6);
    for (index, (kind, _)) in targets.iter().enumerate() {
        assert_eq!(
            changes["changes"][index * 2]["message"]["toolResult"]["details"]["root"],
            *kind
        );
    }
    assert_eq!(
        f.call("review.turns", json!({})).await["turns"][0]["changeCount"],
        6
    );
    let failed = f.call("tools.execute",json!({"toolCallId":"failed-edit","toolName":"Edit","args":{"path":targets[2].1.to_string_lossy(),"old_string":"missing text","new_string":"replacement"},"mode":"agent"})).await;
    assert_eq!(failed["ok"], false);
    assert!(failed["content"].get("review").is_none());
    let bash = f.call("tools.execute",json!({"toolCallId":"shell-only","toolName":"Bash","args":{"command":"echo review-test"},"mode":"agent"})).await;
    assert!(
        bash["content"].get("review").is_none(),
        "Bash never produces review"
    );
}

#[tokio::test]
async fn review_rpc_denied_external_write_never_reads_or_captures_before_approval() {
    let f = Fixture::new().await;
    f.call(
        "session.configure",
        json!({"id":f.session,"mode":"agent","permissionMode":"ask"}),
    )
    .await;
    let outside = tempdir().unwrap();
    let target = outside.path().join("outside.txt");
    std::fs::write(&target, "untouched\n").unwrap();
    let state = f.state.clone();
    let params = json!({"sessionId":f.session,"toolCallId":"denied-external","toolName":"Write","args":{"path":target.to_string_lossy(),"content":"new\n"},"mode":"agent"});
    let (tx, mut rx) = mpsc::unbounded_channel();
    let pending =
        tokio::spawn(async move { handle_request(state, "tools.execute", params, tx).await });
    let notification: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
    assert_eq!(notification["method"], "permissions.request");
    assert!(!f
        .data
        .path()
        .join("review-changes")
        .join(&f.session)
        .exists());
    f.call(
        "permissions.resolve",
        json!({"requestId":notification["params"]["requestId"],"decision":"deny"}),
    )
    .await;
    let result = pending.await.unwrap().unwrap();
    assert_eq!(result["ok"], false);
    assert!(result["content"].get("review").is_none());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "untouched\n");
    assert!(!f
        .data
        .path()
        .join("review-changes")
        .join(&f.session)
        .exists());
}

#[tokio::test]
async fn review_rollbacks_wait_for_active_host_file_mutations() {
    use std::future::{poll_fn, Future};
    use std::task::Poll;
    for method in ["review.rollback", "review.rollbackFile"] {
        let f = Fixture::new().await;
        f.user("before-mutation", None).await;
        std::fs::write(f.root.path().join("file.txt"), "before\n").unwrap();
        let change = f.capture(f.root.path(), "captured-write", "after\n");
        f.tool("captured-write", json!(change), None, None).await;
        let budget = f.state.lock().await.tool_budget.clone();
        let active = budget
            .acquire_files(
                "other-session",
                "Write",
                false,
                crate::file_resources::FileResources::fence(true),
                None,
            )
            .await
            .unwrap();
        let mut rollback = Box::pin(f.call(method, json!({"snapshotId":change.snapshot_id})));
        poll_fn(|cx| {
            assert!(
                rollback.as_mut().poll(cx).is_pending(),
                "rollback bypassed active file mutation: {method}"
            );
            if budget.snapshot().queued == 1 {
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        })
        .await;
        assert_eq!(
            std::fs::read_to_string(f.root.path().join("file.txt")).unwrap(),
            "after\n"
        );
        drop(active);
        assert_eq!(rollback.await["status"], "rolledBack");
        assert_eq!(
            std::fs::read_to_string(f.root.path().join("file.txt")).unwrap(),
            "before\n"
        );
        assert_eq!(budget.snapshot().active, 0);
        assert_eq!(budget.snapshot().queued, 0);
    }
}

#[tokio::test]
async fn review_turn_totals_do_not_invent_binary_or_truncated_line_counts() {
    let f = Fixture::new().await;
    for (id, binary, truncated) in [("binary-round", true, false), ("large-round", false, true)] {
        f.user(id, None).await;
        let mut change = f.capture(f.root.path(), id, id);
        change.binary = binary;
        change.truncated = truncated;
        f.tool(id, json!(change), None, None).await;
    }
    let page = f.call("review.turns", json!({})).await;
    for turn in page["turns"].as_array().unwrap() {
        assert_eq!(turn["changeCount"], 1);
        assert!(turn["additions"].is_null());
        assert!(turn["deletions"].is_null());
    }
}
