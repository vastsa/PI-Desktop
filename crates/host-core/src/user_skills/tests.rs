use super::*;
use crate::agent_capabilities::test_support;
use tempfile::tempdir;

fn input(name: &str, level: &str, project_path: Option<&str>) -> UserSkillInput {
    UserSkillInput {
        name: Some(name.into()),
        level: Some(level.into()),
        project_path: project_path.map(str::to_string),
        description: Some("Check the relevant files".into()),
        body: Some("Do the thing.".into()),
        ..Default::default()
    }
}

#[test]
fn imports_one_file_into_the_selected_agents_directory() {
    let app = tempdir().unwrap();
    let source = app.path().join("incoming.md");
    let raw = "---\nname: Review\ndescription: Check code\n---\n\nDo it.\n";
    fs::write(&source, raw).unwrap();
    let mut registry = UserSkillRegistry::new(app.path());
    let record = registry
        .import(
            source.to_str().unwrap(),
            input("Ignored", "project", Some(app.path().to_str().unwrap())),
        )
        .unwrap();
    let target = app.path().join(".agents/skills/review.md");
    assert_eq!(record.level.as_deref(), Some("project"));
    let normalized_project =
        crate::agent_capabilities::normalize_project_path(app.path().to_str().unwrap());
    let expected = crate::agent_capabilities::capability_dir(
        CapabilityLevel::Project,
        Some(&normalized_project),
        "skills",
    )
    .unwrap()
    .join("review.md");
    assert_eq!(record.path, expected.to_string_lossy());
    assert_eq!(fs::read_to_string(target).unwrap(), raw);
    assert!(source.is_file());
}

#[test]
fn project_skills_shadow_global_skills_by_name() {
    let app = tempdir().unwrap();
    let global = app.path().join("global");
    let project = app.path().join("project");
    fs::create_dir_all(global.join("skills")).unwrap();
    fs::create_dir_all(project.join(".agents/skills")).unwrap();
    fs::write(
        global.join("skills/review.md"),
        "---\nname: Review\n---\n\nGlobal\n",
    )
    .unwrap();
    fs::write(
        project.join(".agents/skills/review.md"),
        "---\nname: Review\n---\n\nProject\n",
    )
    .unwrap();
    let (fields, body) =
        parse_front_matter(&fs::read_to_string(project.join(".agents/skills/review.md")).unwrap());
    assert_eq!(fields.get("name").map(String::as_str), Some("Review"));
    assert_eq!(body, "Project");
}

#[test]
fn disabled_project_skill_shadows_global_skill() {
    let global = UserSkillRecord {
        id: "review".into(),
        name: "Review".into(),
        level: Some("global".into()),
        project_path: None,
        description: Some("Global".into()),
        enabled: true,
        scope: ActivationScope::default(),
        source: "imported".into(),
        path: "/global/review.md".into(),
        size_bytes: 1,
        created_at: String::new(),
        updated_at: String::new(),
    };
    let mut project = global.clone();
    project.level = Some("project".into());
    project.project_path = Some("/repo".into());
    project.enabled = false;

    let active = merge_active_records(vec![global.clone()], vec![project]);
    assert!(active.is_empty());

    let mut project = global.clone();
    project.level = Some("project".into());
    project.project_path = Some("/repo".into());
    project.path = "/repo/.agents/skills/review.md".into();
    let active = merge_active_records(vec![global], vec![project.clone()]);
    assert_eq!(active, vec![project]);
}

#[test]
fn capability_state_is_not_written_into_skill_documents() {
    let app = tempdir().unwrap();
    let mut state = CapabilityState::new(app.path(), SKILL_KIND);
    state
        .set_enabled(
            SKILL_KIND,
            CapabilityLevel::Project,
            "review",
            Some("/repo"),
            false,
        )
        .unwrap();
    assert!(!app
        .path()
        .join("agent-capabilities/skills.json")
        .to_string_lossy()
        .contains(".agents"));
}

#[test]
fn import_uses_parent_directory_when_name_is_not_ascii() {
    let app = tempdir().unwrap();
    let source_dir = app.path().join("incoming/code-review");
    fs::create_dir_all(&source_dir).unwrap();
    let source = source_dir.join("SKILL.md");
    fs::write(
        &source,
        "---\nname: 代码审查\ndescription: >\n  Review diffs before merge.\n---\n\nCheck the patch.\n",
    )
    .unwrap();
    let mut registry = UserSkillRegistry::new(app.path());
    let record = registry
        .import(
            source.to_str().unwrap(),
            input("Ignored", "project", Some(app.path().to_str().unwrap())),
        )
        .unwrap();
    assert_eq!(record.id, "code-review");
    assert_eq!(record.name, "代码审查");
    assert_eq!(
        record.description.as_deref(),
        Some("Review diffs before merge.")
    );
    let listed = registry
        .list(CapabilityLevel::Project, Some(app.path().to_str().unwrap()))
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, "code-review");
    assert_eq!(listed[0].name, "代码审查");
}

#[test]
fn directory_skills_do_not_collide_on_the_skill_file_stem() {
    let app = tempdir().unwrap();
    let project = app.path().to_str().unwrap();
    fs::create_dir_all(app.path().join(".agents/skills/pdf")).unwrap();
    fs::create_dir_all(app.path().join(".agents/skills/docx")).unwrap();
    fs::write(
        app.path().join(".agents/skills/pdf/SKILL.md"),
        "# PDF\n\nExtract text.\n",
    )
    .unwrap();
    fs::write(
        app.path().join(".agents/skills/docx/SKILL.md"),
        "# DOCX\n\nEdit documents.\n",
    )
    .unwrap();
    let mut registry = UserSkillRegistry::new(app.path());
    let listed = registry
        .list(CapabilityLevel::Project, Some(project))
        .unwrap();
    let ids: Vec<_> = listed.iter().map(|record| record.id.as_str()).collect();
    assert_eq!(ids, vec!["docx", "pdf"]);
}

/// A global skill document plus the project directory it can move into.
fn skill_home(home: &Path) {
    fs::create_dir_all(home.join("skills")).unwrap();
}

fn project_dir(project: &Path) -> String {
    project.to_str().unwrap().to_string()
}

fn record(id: &str, name: &str) -> UserSkillRecord {
    UserSkillRecord {
        id: id.into(),
        name: name.into(),
        level: None,
        project_path: None,
        description: None,
        enabled: true,
        scope: ActivationScope::default(),
        source: "imported".into(),
        path: String::new(),
        size_bytes: 0,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

/// A level may never list two records with the same id or the same name:
/// either collision makes one of them disappear from the catalog.
fn assert_unique_records(records: &[UserSkillRecord]) {
    let ids: HashSet<&str> = records.iter().map(|record| record.id.as_str()).collect();
    let names: HashSet<String> = records
        .iter()
        .map(|record| record.name.to_lowercase())
        .collect();
    assert_eq!(ids.len(), records.len(), "duplicate ids: {records:?}");
    assert_eq!(names.len(), records.len(), "duplicate names: {records:?}");
}

#[test]
fn a_global_skill_moves_into_a_project() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let project_path = project_dir(project.path());
    test_support::with_global_agents(home.path(), || {
        skill_home(home.path());
        fs::write(
            home.path().join("skills/review.md"),
            "---\nname: Review\ndescription: Check code\n---\n\nDo it.\n",
        )
        .unwrap();
        let mut registry = UserSkillRegistry::new(app.path());

        let moved = registry
            .transfer(
                "review",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap();

        assert_eq!(moved.id, "review");
        assert_eq!(moved.level.as_deref(), Some("project"));
        assert_eq!(moved.project_path.as_deref(), Some(project_path.as_str()));
        assert!(!home.path().join("skills/review.md").exists());
        let target = project.path().join(".agents/skills/review.md");
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "---\nname: Review\ndescription: Check code\n---\n\nDo it.\n"
        );
        assert!(registry
            .list(CapabilityLevel::Global, None)
            .unwrap()
            .is_empty());
    });
}

#[test]
fn a_name_collision_rewrites_only_the_documents_name_line() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let project_path = project_dir(project.path());
    test_support::with_global_agents(home.path(), || {
        skill_home(home.path());
        fs::create_dir_all(project.path().join(".agents/skills")).unwrap();
        // Extra frontmatter and deliberate body formatting: a renaming move
        // must not reformat the document the user only asked to relocate.
        let original = "---\nname: Review\nlicense: MIT\n---\n\n## Step 1\n\n   indented\n";
        fs::write(home.path().join("skills/review.md"), original).unwrap();
        fs::write(
            project.path().join(".agents/skills/review.md"),
            "---\nname: Review\n---\n\nProject copy\n",
        )
        .unwrap();
        let mut registry = UserSkillRegistry::new(app.path());

        let moved = registry
            .transfer(
                "review",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap();

        assert_eq!(moved.id, "review-2");
        assert_eq!(moved.name, "Review (2)");
        let document =
            fs::read_to_string(project.path().join(".agents/skills/review-2.md")).unwrap();
        assert_eq!(
            document,
            "---\nname: Review (2)\nlicense: MIT\n---\n\n## Step 1\n\n   indented\n"
        );
        // The skill that was already there is untouched.
        assert_eq!(
            fs::read_to_string(project.path().join(".agents/skills/review.md")).unwrap(),
            "---\nname: Review\n---\n\nProject copy\n"
        );
    });
}

#[test]
fn a_directory_skill_moves_with_its_resources() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let project_path = project_dir(project.path());
    test_support::with_global_agents(home.path(), || {
        skill_home(home.path());
        let source = home.path().join("skills/pdf");
        fs::create_dir_all(source.join("templates")).unwrap();
        fs::write(source.join("SKILL.md"), "# PDF\n\nExtract text.\n").unwrap();
        fs::write(source.join("templates/page.html"), "<p>page</p>").unwrap();
        let mut registry = UserSkillRegistry::new(app.path());

        let moved = registry
            .transfer(
                "pdf",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap();

        assert_eq!(moved.id, "pdf");
        assert!(!source.exists());
        let target = project.path().join(".agents/skills/pdf");
        assert_eq!(
            fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "# PDF\n\nExtract text.\n"
        );
        // The resource beside the document is part of the skill.
        assert_eq!(
            fs::read_to_string(target.join("templates/page.html")).unwrap(),
            "<p>page</p>"
        );
    });
}

#[test]
fn a_renamed_directory_skill_keeps_its_resources() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let project_path = project_dir(project.path());
    test_support::with_global_agents(home.path(), || {
        skill_home(home.path());
        fs::create_dir_all(project.path().join(".agents/skills/pdf")).unwrap();
        fs::write(
            project.path().join(".agents/skills/pdf/SKILL.md"),
            "# PDF\n\nProject copy.\n",
        )
        .unwrap();
        let source = home.path().join("skills/pdf");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "# PDF\n\nGlobal copy.\n").unwrap();
        fs::write(source.join("notes.txt"), "keep me").unwrap();
        let mut registry = UserSkillRegistry::new(app.path());

        let moved = registry
            .transfer(
                "pdf",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap();

        assert_eq!(moved.id, "pdf-2");
        assert!(!source.exists());
        let target = project.path().join(".agents/skills/pdf-2");
        assert_eq!(
            fs::read_to_string(target.join("notes.txt")).unwrap(),
            "keep me"
        );
        assert_eq!(
            fs::read_to_string(project.path().join(".agents/skills/pdf/SKILL.md")).unwrap(),
            "# PDF\n\nProject copy.\n"
        );
    });
}

#[test]
fn a_disabled_project_skill_becomes_the_global_default() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let project_path = project_dir(project.path());
    test_support::with_global_agents(home.path(), || {
        skill_home(home.path());
        let mut registry = UserSkillRegistry::new(app.path());
        let mut request = input("Review", "project", Some(&project_path));
        request.enabled = Some(false);
        registry.create(request).unwrap();

        let moved = registry
            .transfer(
                "review",
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
            )
            .unwrap();

        assert_eq!(moved.level.as_deref(), Some("global"));
        assert!(!moved.enabled);
        assert!(home.path().join("skills/review.md").is_file());
        assert!(!project.path().join(".agents/skills/review.md").exists());
        // Off everywhere, because the document is off and its state is now
        // the global default rather than one project's leftover override.
        assert!(!registry.state.enabled(
            SKILL_KIND,
            CapabilityLevel::Global,
            "review",
            Some("/elsewhere")
        ));
    });
}

#[test]
fn a_skill_without_frontmatter_gains_a_name_when_it_has_to_rename() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let project_path = project_dir(project.path());
    test_support::with_global_agents(home.path(), || {
        skill_home(home.path());
        fs::create_dir_all(project.path().join(".agents/skills")).unwrap();
        // No frontmatter: the display name falls back to the file stem, so a
        // move that must rename has to open a block to carry the new name.
        fs::write(home.path().join("skills/review.md"), "# Review\n\nDo it.\n").unwrap();
        fs::write(
            project.path().join(".agents/skills/review.md"),
            "---\nname: Review\n---\n\nProject copy\n",
        )
        .unwrap();
        let mut registry = UserSkillRegistry::new(app.path());

        let moved = registry
            .transfer(
                "review",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap();
        // With no stored name the display name is the file stem, so that is
        // what the suffix is applied to.
        assert_eq!(moved.id, "review-2");
        assert_eq!(moved.name, "review (2)");
        assert_eq!(
            fs::read_to_string(project.path().join(".agents/skills/review-2.md")).unwrap(),
            "---\nname: review (2)\n---\n\n# Review\n\nDo it.\n"
        );
    });
}

#[test]
fn placement_uses_the_id_the_scan_will_derive_from_the_name() {
    let directory = tempdir().unwrap();
    let source = record("code-review", "代码审查");
    let existing = vec![record("code-review", "代码审查")];

    let placement = plan_skill_placement(&source, directory.path(), true, &existing).unwrap();
    assert_eq!(placement.name, "代码审查 (2)");
    // The rename's slug is `2`, not the file stem the move started from, so
    // that is what both the directory and the next scan will call it.
    assert_eq!(placement.stem, "2");
    let document = skill_document_path(directory.path(), &placement.stem, true);
    assert_eq!(
        capability_id(&placement.name, &document, 64),
        placement.stem
    );

    // A flat destination derives the same id from the `.md` stem.
    let placement = plan_skill_placement(&source, directory.path(), false, &existing).unwrap();
    let document = skill_document_path(directory.path(), &placement.stem, false);
    assert_eq!(
        capability_id(&placement.name, &document, 64),
        placement.stem
    );
}

#[test]
fn placement_reports_exhaustion_instead_of_reusing_a_taken_name() {
    let directory = tempdir().unwrap();
    let source = record("review", "Review");
    let existing: Vec<UserSkillRecord> = (1..=MAX_ID_SUFFIX)
        .map(|ordinal| {
            record(
                &format!("other-{ordinal}"),
                &display_name_candidate("Review", ordinal, MAX_NAME_CHARS),
            )
        })
        .collect();
    // Every candidate the planner could use is already a displayed name, so
    // there is no collision-free placement and the move must refuse rather
    // than write a duplicate.
    assert!(plan_skill_placement(&source, directory.path(), false, &existing).is_none());
}

#[test]
fn a_chinese_named_skill_moves_without_hiding_the_other_levels_copy() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let project_path = project_dir(project.path());
    test_support::with_global_agents(home.path(), || {
        skill_home(home.path());
        fs::create_dir_all(project.path().join(".agents/skills")).unwrap();
        // Both names slug to nothing, so each document's id comes from its
        // file stem — while the renamed candidate `代码审查 (2)` slugs to
        // `2`, which is nothing like the stem the old move would have used.
        fs::write(
            home.path().join("skills/code-review.md"),
            "---\nname: 代码审查\n---\n\nGlobal copy.\n",
        )
        .unwrap();
        fs::write(
            project.path().join(".agents/skills/code-review.md"),
            "---\nname: 代码审查\n---\n\nProject copy.\n",
        )
        .unwrap();
        let mut registry = UserSkillRegistry::new(app.path());

        let moved = registry
            .transfer(
                "code-review",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap();

        assert_eq!(moved.id, "2");
        assert_eq!(moved.name, "代码审查 (2)");
        assert!(!home.path().join("skills/code-review.md").exists());
        assert_eq!(
            fs::read_to_string(project.path().join(".agents/skills/2.md")).unwrap(),
            "---\nname: 代码审查 (2)\n---\n\nGlobal copy.\n"
        );
        // The project's own copy is untouched and both documents are listed
        // under distinct ids and names.
        assert_eq!(
            fs::read_to_string(project.path().join(".agents/skills/code-review.md")).unwrap(),
            "---\nname: 代码审查\n---\n\nProject copy.\n"
        );
        let listed = registry
            .list(CapabilityLevel::Project, Some(&project_path))
            .unwrap();
        assert_eq!(listed.len(), 2);
        assert_unique_records(&listed);
        assert!(listed.iter().any(|record| record.name == "代码审查"));
        assert!(listed.iter().any(|record| record.name == "代码审查 (2)"));

        // The same document moves back to the global level under its new
        // name, keeping the id the scan gave it.
        let back = registry
            .transfer(
                "2",
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
            )
            .unwrap();
        assert_eq!(back.id, "2");
        assert_eq!(back.name, "代码审查 (2)");
        assert!(home.path().join("skills/2.md").is_file());
        assert_unique_records(
            &registry
                .list(CapabilityLevel::Project, Some(&project_path))
                .unwrap(),
        );
    });
}

#[test]
fn a_names_slug_is_not_used_when_that_id_belongs_to_another_document() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let project_path = project_dir(project.path());
    test_support::with_global_agents(home.path(), || {
        skill_home(home.path());
        fs::create_dir_all(project.path().join(".agents/skills")).unwrap();
        fs::write(
            home.path().join("skills/code-review.md"),
            "---\nname: 代码审查\n---\n\nGlobal copy.\n",
        )
        .unwrap();
        fs::write(
            project.path().join(".agents/skills/code-review.md"),
            "---\nname: 代码审查\n---\n\nProject copy.\n",
        )
        .unwrap();
        // This document's id is exactly the slug the renamed candidate
        // `代码审查 (2)` would produce, so that candidate cannot be used.
        fs::write(
            project.path().join(".agents/skills/2.md"),
            "---\nname: 2\n---\n\nTakes the id 2.\n",
        )
        .unwrap();
        let mut registry = UserSkillRegistry::new(app.path());

        let moved = registry
            .transfer(
                "code-review",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap();

        assert_eq!(moved.name, "代码审查 (3)");
        assert_eq!(moved.id, "3");
        assert!(project.path().join(".agents/skills/3.md").is_file());
        assert_eq!(
            fs::read_to_string(project.path().join(".agents/skills/2.md")).unwrap(),
            "---\nname: 2\n---\n\nTakes the id 2.\n"
        );
        let listed = registry
            .list(CapabilityLevel::Project, Some(&project_path))
            .unwrap();
        assert_eq!(listed.len(), 3);
        assert_unique_records(&listed);
    });
}
#[test]
fn rewriting_a_name_keeps_the_frontmatter_shaped_document_intact() {
    // The helper is unit-tested directly because it is the only place a move
    // edits a document, and every byte it does not touch is a byte the user
    // gets to keep.
    let with_extra_fields = "---\nlicense: MIT\nname: Review\nallowed-tools: Read\n---\n\nBody\n";
    assert_eq!(
        rewrite_document_name(with_extra_fields, "Review (2)"),
        "---\nlicense: MIT\nname: Review (2)\nallowed-tools: Read\n---\n\nBody\n"
    );
    assert_eq!(
        rewrite_document_name("---\r\nname: A\r\n---\r\n\r\nBody\r\n", "B"),
        "---\nname: B\n---\r\n\r\nBody\r\n"
    );
    assert_eq!(
        rewrite_document_name("no frontmatter\n", "B"),
        "---\nname: B\n---\n\nno frontmatter\n"
    );
    assert_eq!(
        rewrite_document_name("---\nname: A\nnever closed\n", "B"),
        "---\nname: B\n---\n\n---\nname: A\nnever closed\n"
    );
    // A newline in the name would break the block it is written into.
    assert_eq!(
        rewrite_document_name("---\nname: A\n---\n\nBody\n", "Two\nLines"),
        "---\nname: Two Lines\n---\n\nBody\n"
    );
    // The parser keeps the *last* `name:` line, so a stale second one must
    // be dropped: keeping it would make the old name win again on the next
    // scan, silently defeating the rename.
    assert_eq!(
        rewrite_document_name("---\nname: A\nname: B\n---\n\nBody\n", "C"),
        "---\nname: C\n---\n\nBody\n"
    );
    assert_eq!(
        rewrite_document_name("---\nname: A\nlicense: MIT\nname: B\n---\n\nBody\n", "C"),
        "---\nname: C\nlicense: MIT\n---\n\nBody\n"
    );
    // A first line that only trims to `---` still opens frontmatter. Not
    // recognizing it would copy the old block into the new body, leaving
    // two frontmatter blocks in the document.
    assert_eq!(
        rewrite_document_name("--- \nname: A\n---\n\nBody\n", "C"),
        "---\nname: C\n---\n\nBody\n"
    );
    assert_eq!(
        rewrite_document_name("--- \r\nname: A\r\n---\r\n\r\nBody\r\n", "C"),
        "---\nname: C\n---\r\n\r\nBody\r\n"
    );
    // An indented `name:` is a nested map value, not the document's name.
    assert_eq!(
        rewrite_document_name("---\nmeta:\n  name: A\nname: B\n---\n\nBody\n", "C"),
        "---\nmeta:\n  name: A\nname: C\n---\n\nBody\n"
    );
}

#[test]
fn imports_a_directory_with_skill_md_in_copy_mode() {
    let app = tempdir().unwrap();
    let source_dir = app.path().join("incoming/example-skill");
    fs::create_dir_all(&source_dir).unwrap();
    fs::write(
        source_dir.join("SKILL.md"),
        "---\nname: Example\ndescription: Anthropic-style skill\n---\n\nBody.\n",
    )
    .unwrap();
    fs::write(source_dir.join("resource.txt"), "extra\n").unwrap();

    let mut registry = UserSkillRegistry::new(app.path());
    let record = registry
        .import(
            source_dir.to_str().unwrap(),
            input("Ignored", "project", Some(app.path().to_str().unwrap())),
        )
        .unwrap();
    let normalized_project =
        crate::agent_capabilities::normalize_project_path(app.path().to_str().unwrap());
    let expected_root = crate::agent_capabilities::capability_dir(
        CapabilityLevel::Project,
        Some(&normalized_project),
        "skills",
    )
    .unwrap()
    .join("example");
    assert!(expected_root.is_dir(), "target dir exists");
    assert!(expected_root.join("SKILL.md").is_file(), "SKILL.md placed");
    assert!(
        expected_root.join("resource.txt").is_file(),
        "resources copied"
    );
    assert_eq!(record.name, "Example");
    // The record path points at the SKILL.md the scanner selects.
    assert_eq!(
        record.path,
        expected_root.join("SKILL.md").to_string_lossy()
    );
    // Source is untouched under copy mode.
    assert!(source_dir.join("SKILL.md").is_file());
}

#[test]
fn imports_a_directory_with_skill_md_in_link_mode() {
    let app = tempdir().unwrap();
    let source_dir = app.path().join("incoming/linked-skill");
    fs::create_dir_all(&source_dir).unwrap();
    fs::write(
        source_dir.join("SKILL.md"),
        "---\nname: Linked\n---\n\nBody.\n",
    )
    .unwrap();

    let mut registry = UserSkillRegistry::new(app.path());
    let mut payload = input("Ignored", "project", Some(app.path().to_str().unwrap()));
    payload.mode = Some("link".into());
    let record = registry
        .import(source_dir.to_str().unwrap(), payload)
        .unwrap();
    let normalized_project =
        crate::agent_capabilities::normalize_project_path(app.path().to_str().unwrap());
    let expected_root = crate::agent_capabilities::capability_dir(
        CapabilityLevel::Project,
        Some(&normalized_project),
        "skills",
    )
    .unwrap()
    .join("linked");
    let metadata = fs::symlink_metadata(&expected_root).unwrap();
    assert!(
        metadata.file_type().is_symlink(),
        "link mode leaves a symlink at the destination"
    );
    // The symlink resolves and the scanned SKILL.md path reads back through it.
    assert!(expected_root.join("SKILL.md").is_file());
    assert_eq!(record.name, "Linked");
}

#[test]
fn imports_a_file_in_link_mode() {
    let app = tempdir().unwrap();
    let source = app.path().join("incoming/notes.md");
    fs::create_dir_all(source.parent().unwrap()).unwrap();
    fs::write(
        &source,
        "---\nname: Notes\ndescription: linked file\n---\n\nBody.\n",
    )
    .unwrap();

    let mut registry = UserSkillRegistry::new(app.path());
    let mut payload = input("Ignored", "project", Some(app.path().to_str().unwrap()));
    payload.mode = Some("link".into());
    let record = registry.import(source.to_str().unwrap(), payload).unwrap();
    let normalized_project =
        crate::agent_capabilities::normalize_project_path(app.path().to_str().unwrap());
    let expected = crate::agent_capabilities::capability_dir(
        CapabilityLevel::Project,
        Some(&normalized_project),
        "skills",
    )
    .unwrap()
    .join("notes.md");
    let metadata = fs::symlink_metadata(&expected).unwrap();
    assert!(metadata.file_type().is_symlink());
    assert_eq!(record.name, "Notes");
}

#[test]
fn directory_import_without_skill_md_is_rejected() {
    let app = tempdir().unwrap();
    let source_dir = app.path().join("incoming/no-skill");
    fs::create_dir_all(&source_dir).unwrap();
    fs::write(source_dir.join("readme.md"), "just docs\n").unwrap();

    let mut registry = UserSkillRegistry::new(app.path());
    let err = registry
        .import(
            source_dir.to_str().unwrap(),
            input("Ignored", "project", Some(app.path().to_str().unwrap())),
        )
        .unwrap_err()
        .to_string();
    assert!(err.contains("SKILL_INVALID"), "err = {err}");
    assert!(err.contains("SKILL.md"), "err = {err}");
}

#[test]
fn unknown_import_mode_is_rejected() {
    let app = tempdir().unwrap();
    let source = app.path().join("incoming.md");
    fs::write(&source, "---\nname: Any\n---\n\nBody.\n").unwrap();
    let mut registry = UserSkillRegistry::new(app.path());
    let mut payload = input("Ignored", "project", Some(app.path().to_str().unwrap()));
    payload.mode = Some("teleport".into());
    let err = registry
        .import(source.to_str().unwrap(), payload)
        .unwrap_err()
        .to_string();
    assert!(err.contains("unknown import mode"), "err = {err}");
}

#[test]
fn shape_dir_requires_a_directory_source() {
    let app = tempdir().unwrap();
    let source = app.path().join("incoming.md");
    fs::write(&source, "---\nname: X\n---\n\nBody.\n").unwrap();
    let mut registry = UserSkillRegistry::new(app.path());
    let mut payload = input("Ignored", "project", Some(app.path().to_str().unwrap()));
    payload.shape = Some("dir".into());
    let err = registry
        .import(source.to_str().unwrap(), payload)
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("SKILL_INVALID") && err.contains("directory"),
        "err = {err}"
    );
}

#[test]
fn directory_skill_package_resources_round_trip_without_execution() {
    let app = tempdir().unwrap();
    let project = app.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let mut registry = UserSkillRegistry::new(app.path());
    let mut payload = input("Packaged", "project", Some(project.to_str().unwrap()));
    payload.id = Some("packaged".into());
    payload.shape = Some("dir".into());
    let record = registry.create(payload).unwrap();
    registry
        .write_package_files(
            &record.id,
            CapabilityLevel::Project,
            Some(project.to_str().unwrap()),
            &[("scripts/check.txt".into(), b"safe bytes".to_vec())],
        )
        .unwrap();
    let files = registry
        .package_files(
            &record.id,
            CapabilityLevel::Project,
            Some(project.to_str().unwrap()),
        )
        .unwrap();
    assert_eq!(
        files,
        vec![("scripts/check.txt".into(), b"safe bytes".to_vec())]
    );
    assert!(record.path.ends_with("SKILL.md"));
}

#[test]
fn directory_skill_package_rejects_traversal() {
    let app = tempdir().unwrap();
    let project = app.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let mut registry = UserSkillRegistry::new(app.path());
    let mut payload = input("Packaged", "project", Some(project.to_str().unwrap()));
    payload.id = Some("packaged".into());
    payload.shape = Some("dir".into());
    let record = registry.create(payload).unwrap();
    let error = registry
        .write_package_files(
            &record.id,
            CapabilityLevel::Project,
            Some(project.to_str().unwrap()),
            &[("../outside.txt".into(), b"unsafe".to_vec())],
        )
        .unwrap_err()
        .to_string();
    assert!(error.contains("SKILL_INVALID"));
    assert!(!app.path().join("outside.txt").exists());
}
