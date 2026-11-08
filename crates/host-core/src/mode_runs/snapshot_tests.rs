//! Snapshot validation: the Host accepts what the shared parser produces and
//! refuses every security-relevant violation on its own.

use serde_json::{json, Value};

use super::snapshot::{self, valid_artifact_path};

/// The builtin Goal definition as `parseModeDocument` normalizes it.
pub(super) fn goal_snapshot() -> Value {
    json!({
        "version": 1,
        "id": "goal",
        "label": "Goal",
        "description": "Work across turns until the objective is verified",
        "permission": "agent",
        "prompt": "goal prompt",
        "source": "builtin",
        "artifacts": [{
            "id": "goal",
            "path": ".pi/goals/{{run.id}}.md",
            "requiredHeadings": ["Objective", "Acceptance criteria", "Evidence"]
        }],
        "budget": { "maxTurns": 20, "maxTokens": null },
        "returnTo": "agent",
        "stages": [{
            "id": "work",
            "prompt": "work prompt",
            "permission": "agent",
            "loop": true,
            "onEnter": [],
            "onCompaction": [{ "kind": "artifact", "artifact": "goal" }],
            "exit": [{ "kind": "require", "artifact": "goal", "onFail": { "retries": 2 } }]
        }]
    })
}

fn rejects(mutate: impl FnOnce(&mut Value)) -> String {
    let mut value = goal_snapshot();
    mutate(&mut value);
    let error = snapshot::validate(&value, "goal")
        .err()
        .map(|error| error.to_string())
        .unwrap_or_default();
    assert!(
        error.starts_with("MODE_SNAPSHOT_INVALID"),
        "expected MODE_SNAPSHOT_INVALID, got `{error}` for {value}"
    );
    error
}

#[test]
fn builtin_goal_shape_is_accepted_and_hashed_canonically() {
    let value = goal_snapshot();
    let parsed = snapshot::validate(&value, "goal").unwrap();
    assert!(parsed.definition.is_staged());
    assert_eq!(parsed.definition.budget.max_turns, Some(20));
    assert_eq!(parsed.definition.return_to, "agent");
    let again = snapshot::validate(&goal_snapshot(), "goal").unwrap();
    assert_eq!(parsed.hash, again.hash);
    assert_eq!(parsed.hash.len(), 64);
}

#[test]
fn simple_custom_mode_is_accepted() {
    let value = json!({
        "version": 1, "id": "review", "label": "Review", "description": "", "permission": "contract",
        "prompt": "", "source": "user", "artifacts": [], "budget": { "maxTurns": 20, "maxTokens": null },
        "returnTo": "agent", "stages": []
    });
    let parsed = snapshot::validate(&value, "review").unwrap();
    assert!(!parsed.definition.is_staged());
}

#[test]
fn each_invalid_rule_is_rejected() {
    rejects(|v| v["version"] = json!(2));
    rejects(|v| v["id"] = json!("other"));
    rejects(|v| v["permission"] = json!("root"));
    rejects(|v| v["returnTo"] = json!("goal"));
    rejects(|v| v["returnTo"] = json!("Bad Id"));
    rejects(|v| v["stages"][0]["id"] = json!("Work!"));
    rejects(|v| v["stages"][0]["permission"] = json!("admin"));
    rejects(|v| v["stages"][0]["loop"] = json!("yes"));
    rejects(|v| v["stages"][0]["next"] = json!("missing"));
    rejects(|v| v["stages"][0]["exit"][0]["kind"] = json!("deploy"));
    rejects(|v| v["stages"][0]["exit"][0]["artifact"] = json!("undeclared"));
    rejects(|v| v["stages"][0]["exit"][0]["onFail"]["retries"] = json!(11));
    rejects(|v| v["stages"][0]["exit"][0]["onFail"]["goto"] = json!("nowhere"));
    rejects(|v| {
        v["stages"][0]["exit"] = json!([{
            "kind": "run", "command": "x".repeat(2001), "timeoutMinutes": 5, "onFail": { "retries": 0 }
        }])
    });
    rejects(|v| {
        v["stages"][0]["exit"] =
            json!([{ "kind": "run", "command": "true", "timeoutMinutes": 61, "onFail": { "retries": 0 } }])
    });
    rejects(|v| {
        v["stages"][0]["exit"] =
            json!([{ "kind": "run", "command": "true", "timeoutMinutes": 0, "onFail": { "retries": 0 } }])
    });
    rejects(|v| {
        v["stages"][0]["exit"] = json!([
            { "kind": "ask" },
            { "kind": "require", "artifact": "goal", "onFail": { "retries": 0 } }
        ])
    });
    rejects(|v| {
        let gate = json!({ "kind": "require", "artifact": "goal", "onFail": { "retries": 0 } });
        v["stages"][0]["exit"] = Value::Array(vec![gate; 9]);
    });
    rejects(|v| {
        let stages: Vec<Value> = (0..17)
            .map(|i| json!({ "id": format!("s{i}"), "permission": "agent", "exit": [] }))
            .collect();
        v["stages"] = Value::Array(stages);
    });
    rejects(|v| {
        let artifacts: Vec<Value> = (0..17)
            .map(|i| json!({ "id": format!("a{i}"), "path": format!("a{i}.md"), "requiredHeadings": [] }))
            .collect();
        v["artifacts"] = Value::Array(artifacts);
    });
    rejects(|v| v["artifacts"][0]["id"] = json!("Goal"));
    for path in [
        "../escape.md",
        "/etc/passwd",
        "~/notes.md",
        "C:/notes.md",
        "a//b.md",
        "dir/",
        "a\\b.md",
        "{{run.input}}.md",
    ] {
        rejects(|v| v["artifacts"][0]["path"] = json!(path));
    }
    rejects(|v| v["prompt"] = json!("x".repeat(256 * 1024)));
    rejects(|v| *v = json!("not an object"));
}

#[test]
fn artifact_paths_follow_the_workspace_relative_rules() {
    assert!(valid_artifact_path(".pi/goals/{{run.id}}.md"));
    assert!(valid_artifact_path(".pi/goals/{{ run.id }}.md"));
    assert!(valid_artifact_path("notes.md"));
    assert!(!valid_artifact_path(""));
    assert!(!valid_artifact_path("a/../b.md"));
    assert_eq!(
        snapshot::substitute_run_id(".pi/{{ run.id }}/{{run.id}}.md", "r1"),
        ".pi/r1/r1.md"
    );
}
