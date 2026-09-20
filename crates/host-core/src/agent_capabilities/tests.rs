use super::*;
use tempfile::tempdir;

#[test]
fn front_matter_and_body_round_trip() {
    let (fields, body) =
        parse_front_matter("---\nname: Review\ndescription: Check code\n---\n\nDo it.\n");
    assert_eq!(fields.get("name").map(String::as_str), Some("Review"));
    assert_eq!(
        fields.get("description").map(String::as_str),
        Some("Check code")
    );
    assert_eq!(body, "Do it.");
}

#[test]
fn front_matter_reads_folded_yaml_descriptions() {
    let raw = "---\nname: find-skills\ndescription: >\n  Discover skills when asked\n  how to do X.\n---\n\nFollow the steps.\n";
    let (fields, body) = parse_front_matter(raw);
    assert_eq!(fields.get("name").map(String::as_str), Some("find-skills"));
    assert_eq!(
        fields.get("description").map(String::as_str),
        Some("Discover skills when asked how to do X.")
    );
    assert_eq!(body, "Follow the steps.");
}

#[test]
fn capability_id_falls_back_to_skill_directory_then_hash() {
    let dir_skill = Path::new("/tmp/code-review/SKILL.md");
    assert_eq!(capability_id("代码审查", dir_skill, 64), "code-review");
    assert_eq!(path_stem_for_id(dir_skill), "code-review");

    let hashed = capability_id("代码审查", Path::new("/tmp/代码审查.md"), 64);
    assert!(hashed.starts_with("skill-"));
    assert!(valid_capability_id(&hashed, 64));
    assert_eq!(
        hashed,
        capability_id("代码审查", Path::new("/elsewhere/代码审查.md"), 64)
    );
    assert_eq!(
        capability_id("代码审查", Path::new("/Users/me/Downloads/SKILL.md"), 64),
        hashed
    );
    assert_ne!(
        capability_id("代码审查", Path::new("/Users/me/Downloads/SKILL.md"), 64),
        "downloads"
    );
}

#[test]
fn state_defaults_on_and_is_project_specific() {
    let dir = tempdir().unwrap();
    let mut state = CapabilityState::new(dir.path(), "skills");
    assert!(state.enabled("skills", CapabilityLevel::Global, "review", Some("/a")));
    state
        .set_enabled(
            "skills",
            CapabilityLevel::Global,
            "review",
            Some("/a"),
            false,
        )
        .unwrap();
    assert!(!state.enabled("skills", CapabilityLevel::Global, "review", Some("/a")));
    assert!(state.enabled("skills", CapabilityLevel::Global, "review", Some("/b")));
    let reopened = CapabilityState::new(dir.path(), "skills");
    assert!(!reopened.enabled("skills", CapabilityLevel::Global, "review", Some("/a")));

    let mut orphaned = reopened;
    orphaned
        .prune(
            "skills",
            CapabilityLevel::Global,
            None,
            &std::collections::HashSet::new(),
        )
        .unwrap();
    assert!(orphaned.enabled("skills", CapabilityLevel::Global, "review", Some("/a")));
}

#[test]
fn suffix_keeps_the_preferred_id_when_it_is_free() {
    let taken = HashSet::new();
    assert_eq!(
        suffixed_capability_id("review", &taken, 64),
        Some(("review".to_string(), 0))
    );
}

#[test]
fn suffix_walks_past_every_taken_id_and_stays_inside_the_budget() {
    let taken: HashSet<String> = ["review".to_string(), "review-2".to_string()]
        .into_iter()
        .collect();
    assert_eq!(
        suffixed_capability_id("review", &taken, 64),
        Some(("review-3".to_string(), 3))
    );

    // A 64-character id has no room for the suffix, so the base is trimmed
    // rather than the candidate growing past what the id validator accepts.
    let long = "a".repeat(64);
    let taken: HashSet<String> = [long.clone()].into_iter().collect();
    let (candidate, ordinal) = suffixed_capability_id(&long, &taken, 64).unwrap();
    assert_eq!(ordinal, 2);
    assert_eq!(candidate.len(), 64);
    assert!(valid_capability_id(&candidate, 64));
}

#[test]
fn suffix_reports_exhaustion_instead_of_reusing_a_taken_id() {
    let taken: HashSet<String> = ["review".to_string()].into_iter().collect();
    // `max_chars` below the suffix length leaves nothing to build on.
    assert_eq!(suffixed_capability_id("review", &taken, 2), None);
}

#[test]
fn display_name_suffix_is_case_insensitive_like_shadowing() {
    let taken: HashSet<String> = ["review".to_string()].into_iter().collect();
    assert_eq!(suffixed_display_name("Review", &taken, 120), "Review (2)");
    assert_eq!(suffixed_display_name("Files", &taken, 120), "Files");
}

#[test]
fn suffix_ignores_id_case_so_a_case_insensitive_volume_keeps_both_files() {
    // Callers pass the taken set lowercased, mirroring the filesystem, so
    // `MyServer` must not be treated as free next to `myserver`.
    let taken: HashSet<String> = ["myserver".to_string()].into_iter().collect();
    assert_eq!(
        suffixed_capability_id("MyServer", &taken, 64),
        Some(("MyServer-2".to_string(), 2))
    );
}

#[test]
fn display_name_suffix_stays_distinct_at_the_character_budget() {
    let full = "a".repeat(120);
    let taken: HashSet<String> = [full.clone()].into_iter().collect();
    let renamed = suffixed_display_name(&full, &taken, 120);
    assert_ne!(renamed, full);
    assert!(renamed.chars().count() <= 120);
    assert_eq!(renamed, format!("{} (2)", "a".repeat(116)));

    // Each ordinal still yields its own candidate once the earlier ones
    // are taken, instead of collapsing onto the truncated base name.
    let taken: HashSet<String> = [full.clone(), renamed.clone()]
        .into_iter()
        .map(|value| value.to_lowercase())
        .collect();
    let third = suffixed_display_name(&full, &taken, 120);
    assert_ne!(third, full);
    assert_ne!(third, renamed);
    assert!(third.chars().count() <= 120);

    // The suffix follows a base that was cut mid-word without a stray
    // space, and ordinal 1 is the plain name.
    assert_eq!(display_name_candidate("Review", 1, 120), "Review");
    assert_eq!(display_name_candidate("Review", 2, 8), "Revi (2)");
    assert_eq!(display_name_candidate("Review  more", 2, 11), "Review (2)");
}

#[test]
fn project_target_requires_a_project_path() {
    assert!(CapabilityTarget::new(CapabilityLevel::Project, None).is_err());
    assert!(CapabilityTarget::new(CapabilityLevel::Project, Some("  ")).is_err());
    assert!(CapabilityTarget::new(CapabilityLevel::Global, None).is_ok());
    assert_eq!(
        CapabilityTarget::new(CapabilityLevel::Project, Some("/repo/"))
            .unwrap()
            .project_path
            .as_deref(),
        Some("/repo")
    );
}

#[test]
fn global_targets_share_one_directory_whatever_project_context_they_carry() {
    let plain = CapabilityTarget::new(CapabilityLevel::Global, None).unwrap();
    let contextual = CapabilityTarget::new(CapabilityLevel::Global, Some("/repo")).unwrap();
    assert!(plain.same_directory(&contextual));
    let project = CapabilityTarget::new(CapabilityLevel::Project, Some("/repo")).unwrap();
    assert!(!plain.same_directory(&project));
    let other = CapabilityTarget::new(CapabilityLevel::Project, Some("/other")).unwrap();
    assert!(!project.same_directory(&other));
}

#[test]
fn global_root_follows_the_environment_override() {
    let dir = tempdir().unwrap();
    test_support::with_global_agents(dir.path(), || {
        assert_eq!(global_agents_dir(), dir.path());
        assert_eq!(
            capability_dir(CapabilityLevel::Global, None, "skills").unwrap(),
            dir.path().join("skills")
        );
    });
}

#[test]
fn forget_drops_every_project_override_for_one_document() {
    let dir = tempdir().unwrap();
    let mut state = CapabilityState::new(dir.path(), "skills");
    state
        .set_enabled("skills", CapabilityLevel::Global, "review", None, false)
        .unwrap();
    state
        .set_enabled(
            "skills",
            CapabilityLevel::Global,
            "review",
            Some("/repo"),
            true,
        )
        .unwrap();
    state
        .set_enabled(
            "skills",
            CapabilityLevel::Project,
            "review",
            Some("/repo"),
            false,
        )
        .unwrap();
    assert!(!state.enabled("skills", CapabilityLevel::Global, "review", None));

    state
        .forget("skills", CapabilityLevel::Global, "review", None)
        .unwrap();
    // Back to the default, and the unrelated project-level entry survives.
    assert!(state.enabled("skills", CapabilityLevel::Global, "review", Some("/repo")));
    assert!(!state.enabled("skills", CapabilityLevel::Project, "review", Some("/repo")));
}

#[test]
fn project_level_forget_keeps_other_projects_entries() {
    let dir = tempdir().unwrap();
    let mut state = CapabilityState::new(dir.path(), "skills");
    state
        .set_enabled(
            "skills",
            CapabilityLevel::Project,
            "review",
            Some("/a"),
            false,
        )
        .unwrap();
    state
        .set_enabled(
            "skills",
            CapabilityLevel::Project,
            "review",
            Some("/b"),
            false,
        )
        .unwrap();

    state
        .forget("skills", CapabilityLevel::Project, "review", Some("/a"))
        .unwrap();
    // Only the owner's entry is gone: another project's same-named document
    // is a different file and keeps its own state.
    assert!(state.enabled("skills", CapabilityLevel::Project, "review", Some("/a")));
    assert!(!state.enabled("skills", CapabilityLevel::Project, "review", Some("/b")));
}

#[test]
fn moving_a_project_document_leaves_other_projects_state_alone() {
    let dir = tempdir().unwrap();
    let mut state = CapabilityState::new(dir.path(), "mcp");
    state
        .set_enabled("mcp", CapabilityLevel::Project, "files", Some("/a"), false)
        .unwrap();
    state
        .set_enabled("mcp", CapabilityLevel::Project, "files", Some("/b"), false)
        .unwrap();

    set_moved_capability_state(
        &mut state,
        "mcp",
        CapabilityLevel::Project,
        "files",
        Some("/a"),
        &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
        "files",
        false,
    )
    .unwrap();

    // The departed project's entry moved with the document; the other
    // project still owns its own state for the same id.
    assert!(state.enabled("mcp", CapabilityLevel::Project, "files", Some("/a")));
    assert!(!state.enabled("mcp", CapabilityLevel::Project, "files", Some("/b")));
    assert!(!state.enabled("mcp", CapabilityLevel::Global, "files", Some("/b")));
}

#[test]
fn copy_directory_tree_overwrites_stale_files_and_can_skip_the_document() {
    let dir = tempdir().unwrap();
    let from = dir.path().join("from");
    let to = dir.path().join("to");
    fs::create_dir_all(from.join("nested")).unwrap();
    fs::write(from.join("SKILL.md"), "doc").unwrap();
    fs::write(from.join("notes.txt"), "keep me").unwrap();
    fs::write(from.join("nested/page.html"), "<p>page</p>").unwrap();
    // A leftover from an interrupted copy must not survive: skipping it
    // would silently drop the resource.
    fs::create_dir_all(&to).unwrap();
    fs::write(to.join("notes.txt"), "stale").unwrap();

    copy_directory_tree(&from, &to, true).unwrap();
    assert!(!to.join("SKILL.md").exists());
    assert_eq!(fs::read_to_string(to.join("notes.txt")).unwrap(), "keep me");
    assert_eq!(
        fs::read_to_string(to.join("nested/page.html")).unwrap(),
        "<p>page</p>"
    );

    let whole = dir.path().join("whole");
    copy_directory_tree(&from, &whole, false).unwrap();
    assert_eq!(fs::read_to_string(whole.join("SKILL.md")).unwrap(), "doc");
}

#[test]
fn moving_a_directory_capability_carries_its_tree() {
    let dir = tempdir().unwrap();
    let from = dir.path().join("skill");
    let to = dir.path().join("moved/skill");
    fs::create_dir_all(from.join("templates")).unwrap();
    fs::write(from.join("SKILL.md"), "doc").unwrap();
    fs::write(from.join("templates/page.html"), "<p>page</p>").unwrap();

    move_capability_file(&from, &to).unwrap();
    assert!(!from.exists());
    assert_eq!(fs::read_to_string(to.join("SKILL.md")).unwrap(), "doc");
    assert_eq!(
        fs::read_to_string(to.join("templates/page.html")).unwrap(),
        "<p>page</p>"
    );
}

#[test]
fn moving_a_file_never_replaces_an_existing_destination() {
    let dir = tempdir().unwrap();
    let from = dir.path().join("from.md");
    let to = dir.path().join("nested/to.md");
    fs::write(&from, "source").unwrap();
    move_capability_file(&from, &to).unwrap();
    assert!(!from.exists());
    assert_eq!(fs::read_to_string(&to).unwrap(), "source");

    fs::write(&from, "second").unwrap();
    assert!(move_capability_file(&from, &to).is_err());
    assert_eq!(fs::read_to_string(&to).unwrap(), "source");
    assert_eq!(fs::read_to_string(&from).unwrap(), "second");
}
