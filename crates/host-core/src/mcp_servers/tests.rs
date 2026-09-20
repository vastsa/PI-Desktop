use super::*;
use crate::agent_capabilities::test_support;
use tempfile::tempdir;

/// A registry plus the two directories a level switch needs.
fn scaffolding() -> (tempfile::TempDir, tempfile::TempDir, tempfile::TempDir) {
    (tempdir().unwrap(), tempdir().unwrap(), tempdir().unwrap())
}

fn stdio(id: &str) -> McpServerInput {
    McpServerInput {
        id: id.into(),
        transport: Some("stdio".into()),
        command: Some("npx".into()),
        args: Some(vec!["-y".into(), "server".into()]),
        ..Default::default()
    }
}

#[test]
fn validation_accepts_http_endpoints_and_rejects_bad_ids() {
    assert!(!valid_id("1files"));
    assert!(check_url("http://localhost:3000/mcp").is_ok());
    assert!(check_url("http://192.168.1.20:8080/mcp").is_ok());
    assert!(check_url("https://example.com/mcp").is_ok());
    assert!(check_url("ftp://example.com/mcp").is_err());
    let mut config = McpConfig {
        id: "files".into(),
        label: "Files".into(),
        transport: "stdio".into(),
        command: Some("node..bin".into()),
        ..Default::default()
    };
    assert!(McpServerRegistry::validate_config(&config).is_err());
    config.command = Some("node".into());
    assert!(McpServerRegistry::validate_config(&config).is_ok());
}

#[test]
fn config_round_trips_without_activation_fields() {
    let config = McpConfig {
        id: "files".into(),
        label: "Files".into(),
        transport: "stdio".into(),
        command: Some("npx".into()),
        ..Default::default()
    };
    let raw = serde_json::to_string(&config).unwrap();
    assert!(!raw.contains("enabled"));
    assert_eq!(serde_json::from_str::<McpConfig>(&raw).unwrap().id, "files");
}

#[test]
fn disabled_project_server_shadows_global_server() {
    let global = McpServerRecord {
        id: "files".into(),
        label: "Files".into(),
        level: Some("global".into()),
        project_path: None,
        path: None,
        description: None,
        transport: "stdio".into(),
        command: Some("npx".into()),
        args: Vec::new(),
        env: BTreeMap::new(),
        url: None,
        headers: BTreeMap::new(),
        enabled: true,
        scope: ActivationScope::default(),
        created_at: String::new(),
        updated_at: String::new(),
    };
    let mut project = global.clone();
    project.level = Some("project".into());
    project.project_path = Some("/repo".into());
    project.enabled = false;

    let active = merge_active_records(vec![global], vec![project]);
    assert!(active.is_empty());
}

#[test]
fn project_server_is_copied_and_state_is_pruned_after_removal() {
    let dir = tempdir().unwrap();
    let project_path = dir.path().to_str().unwrap().to_string();
    let mut registry = McpServerRegistry::new(dir.path());
    let mut first = stdio("files");
    first.label = Some("Files".into());
    first.level = Some("project".into());
    first.project_path = Some(project_path.clone());
    let record = registry.upsert(first).unwrap();
    let normalized_project = crate::agent_capabilities::normalize_project_path(&project_path);
    let target = crate::agent_capabilities::capability_dir(
        CapabilityLevel::Project,
        Some(&normalized_project),
        "servers",
    )
    .unwrap()
    .join("files.json");
    assert_eq!(record.path.as_deref(), target.to_str());
    assert!(!fs::read_to_string(&target).unwrap().contains("enabled"));

    let mut duplicate = stdio("other");
    duplicate.label = Some("files".into());
    duplicate.level = Some("project".into());
    duplicate.project_path = Some(project_path.clone());
    assert!(registry.upsert(duplicate).is_err());

    let disabled = registry
        .set_enabled(
            "files",
            false,
            Some(CapabilityLevel::Project),
            Some(&project_path),
        )
        .unwrap()
        .unwrap();
    assert!(!disabled.enabled);
    assert!(!registry.state.enabled(
        MCP_KIND,
        CapabilityLevel::Project,
        "files",
        Some(&project_path)
    ));

    assert!(registry
        .remove("files", Some(CapabilityLevel::Project), Some(&project_path))
        .unwrap());
    assert!(!target.exists());
    assert!(registry.state.enabled(
        MCP_KIND,
        CapabilityLevel::Project,
        "files",
        Some(&project_path)
    ));
}

#[test]
fn a_global_server_moves_into_a_project_with_its_state() {
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let mut input = stdio("files");
        input.label = Some("Files".into());
        registry.upsert(input).unwrap();
        // Turned off for this one project only, which is the value a move
        // has to carry because it is what the user was looking at.
        registry
            .set_enabled(
                "files",
                false,
                Some(CapabilityLevel::Global),
                Some(&project_path),
            )
            .unwrap();

        let moved = registry
            .transfer(
                "files",
                &CapabilityTarget::new(CapabilityLevel::Global, Some(&project_path)).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap();

        assert_eq!(moved.level.as_deref(), Some("project"));
        assert_eq!(moved.project_path.as_deref(), Some(project_path.as_str()));
        assert!(!moved.enabled);
        assert!(!home.path().join("servers/files.json").exists());
        assert!(project.path().join(".agents/servers/files.json").is_file());
        assert!(registry
            .list(CapabilityLevel::Global, None)
            .unwrap()
            .is_empty());
        // The global override is gone with the document, not left pointing
        // at an id the global directory no longer holds.
        assert!(registry.state.enabled(
            MCP_KIND,
            CapabilityLevel::Global,
            "files",
            Some(&project_path)
        ));
    });
}

#[test]
fn a_destination_collision_renames_the_arriving_server() {
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let mut global = stdio("files");
        global.label = Some("Files".into());
        registry.upsert(global).unwrap();
        let mut local = stdio("files");
        local.label = Some("Files".into());
        local.level = Some("project".into());
        local.project_path = Some(project_path.clone());
        registry.upsert(local).unwrap();

        let moved = registry
            .transfer(
                "files",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap();

        assert_eq!(moved.id, "files-2");
        assert_eq!(moved.label, "Files (2)");
        assert!(!home.path().join("servers/files.json").exists());
        let listed = registry
            .list(CapabilityLevel::Project, Some(&project_path))
            .unwrap();
        assert_eq!(listed.len(), 2);
        // The server that was already there is untouched.
        assert!(listed
            .iter()
            .any(|record| record.id == "files" && record.label == "Files"));
        let document =
            fs::read_to_string(project.path().join(".agents/servers/files-2.json")).unwrap();
        assert!(document.contains("\"id\": \"files-2\""));
        assert!(document.contains("\"label\": \"Files (2)\""));
    });
}

#[test]
fn a_project_server_moves_to_global_without_leaving_a_project_override() {
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let mut input = stdio("files");
        input.label = Some("Files".into());
        input.level = Some("project".into());
        input.project_path = Some(project_path.clone());
        input.enabled = Some(false);
        registry.upsert(input).unwrap();

        let moved = registry
            .transfer(
                "files",
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
            )
            .unwrap();

        assert_eq!(moved.level.as_deref(), Some("global"));
        assert_eq!(moved.project_path, None);
        assert!(!moved.enabled);
        assert!(home.path().join("servers/files.json").is_file());
        assert!(!project.path().join(".agents/servers/files.json").exists());
        // The disabled state is now the global default: it follows the
        // document, and no project-only entry is left behind.
        assert!(!registry.state.enabled(
            MCP_KIND,
            CapabilityLevel::Global,
            "files",
            Some("/elsewhere")
        ));
        assert!(registry.state.enabled(
            MCP_KIND,
            CapabilityLevel::Project,
            "files",
            Some(&project_path)
        ));
    });
}

#[test]
fn transferring_within_one_directory_changes_nothing() {
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let mut input = stdio("files");
        input.label = Some("Files".into());
        input.level = Some("project".into());
        input.project_path = Some(project_path.clone());
        registry.upsert(input).unwrap();

        let target = CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap();
        let same = registry.transfer("files", &target, &target).unwrap();
        assert_eq!(same.id, "files");
        assert!(project.path().join(".agents/servers/files.json").is_file());
    });
}

#[test]
fn transferring_an_unknown_server_is_an_error() {
    let (home, app, _project) = scaffolding();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let error = registry
            .transfer(
                "missing",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
            )
            .unwrap_err();
        assert!(error.to_string().contains("MCP_INVALID"));
    });
}

#[test]
fn a_case_differing_id_at_the_destination_is_not_overwritten() {
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let mut global = stdio("files");
        global.label = Some("Files".into());
        registry.upsert(global).unwrap();
        let mut local = stdio("FILES");
        local.label = Some("Uppercase files".into());
        local.level = Some("project".into());
        local.project_path = Some(project_path.clone());
        registry.upsert(local).unwrap();
        let existing =
            fs::read_to_string(project.path().join(".agents/servers/FILES.json")).unwrap();

        let moved = registry
            .transfer(
                "files",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap();

        // `FILES` and `files` are the same file on macOS and Windows, so the
        // arriving server must take a genuinely free id instead.
        assert_eq!(moved.id, "files-2");
        assert!(!home.path().join("servers/files.json").exists());
        assert_eq!(
            fs::read_to_string(project.path().join(".agents/servers/FILES.json")).unwrap(),
            existing
        );
        assert!(project
            .path()
            .join(".agents/servers/files-2.json")
            .is_file());
        let listed = registry
            .list(CapabilityLevel::Project, Some(&project_path))
            .unwrap();
        assert_eq!(listed.len(), 2);
    });
}

#[test]
fn a_rename_never_writes_over_a_file_the_scan_does_not_list() {
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let mut global = stdio("files");
        global.label = Some("Files".into());
        registry.upsert(global).unwrap();
        // Two project entries: one listed server whose label forces the
        // arriving server to rename, plus an unparseable file that occupies
        // the destination path without appearing in any scan.
        let mut local = stdio("other");
        local.label = Some("Files".into());
        local.level = Some("project".into());
        local.project_path = Some(project_path.clone());
        registry.upsert(local).unwrap();
        let bogus = project.path().join(".agents/servers/files.json");
        fs::write(&bogus, "not a server config").unwrap();

        let error = registry
            .transfer(
                "files",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap_err();

        assert!(error.to_string().contains("MCP_INVALID"));
        assert_eq!(fs::read_to_string(&bogus).unwrap(), "not a server config");
        // The move refused before deleting anything.
        assert!(home.path().join("servers/files.json").is_file());
    });
}

#[test]
fn moving_one_projects_server_to_global_keeps_another_projects_state() {
    let (home, app, project) = scaffolding();
    let other = tempdir().unwrap();
    let project_a = project.path().to_str().unwrap().to_string();
    let project_b = other.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let mut a = stdio("files");
        a.label = Some("Files".into());
        a.level = Some("project".into());
        a.project_path = Some(project_a.clone());
        a.enabled = Some(false);
        registry.upsert(a).unwrap();
        let mut b = stdio("files");
        b.label = Some("Files".into());
        b.level = Some("project".into());
        b.project_path = Some(project_b.clone());
        b.enabled = Some(false);
        registry.upsert(b).unwrap();

        registry
            .transfer(
                "files",
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_a)).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
            )
            .unwrap();

        // Project B's document and its disabled state survive: moving A's
        // same-id server says nothing about B.
        assert!(other.path().join(".agents/servers/files.json").is_file());
        assert!(!registry.state.enabled(
            MCP_KIND,
            CapabilityLevel::Project,
            "files",
            Some(&project_b)
        ));
        assert!(registry.state.enabled(
            MCP_KIND,
            CapabilityLevel::Project,
            "files",
            Some(&project_a)
        ));
        assert!(!registry
            .state
            .enabled(MCP_KIND, CapabilityLevel::Global, "files", None));
    });
}
