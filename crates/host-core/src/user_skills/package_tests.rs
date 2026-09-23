use super::*;
use tempfile::tempdir;

/// Builds a directory-shaped skill and returns its registry, id, and on-disk
/// package root, so package-limit tests only state what they assert.
fn packaged_skill(app: &tempfile::TempDir) -> (UserSkillRegistry, String, PathBuf) {
    let project = app.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let mut registry = UserSkillRegistry::new(app.path());
    let record = registry
        .create(UserSkillInput {
            id: Some("packaged".into()),
            name: Some("Packaged".into()),
            level: Some("project".into()),
            project_path: Some(project.to_str().unwrap().into()),
            description: Some("Check the relevant files".into()),
            body: Some("Do the thing.".into()),
            shape: Some("dir".into()),
            ..UserSkillInput::default()
        })
        .unwrap();
    let root = PathBuf::from(&record.path).parent().unwrap().to_path_buf();
    (registry, record.id, root)
}

#[test]
fn directory_skill_package_accepts_resources_above_the_document_limit() {
    let app = tempdir().unwrap();
    let (mut registry, id, _) = packaged_skill(&app);
    let project = app.path().join("project");
    let project_path = Some(project.to_str().unwrap());
    // Eight times the document cap, still inside the per-resource cap.
    let big = vec![b'x'; MAX_SKILL_BYTES * 8];
    assert!(big.len() <= MAX_SKILL_RESOURCE_BYTES);
    registry
        .write_package_files(
            &id,
            CapabilityLevel::Project,
            project_path,
            &[("data/fonts.csv".into(), big.clone())],
        )
        .unwrap();
    let files = registry
        .package_files(&id, CapabilityLevel::Project, project_path)
        .unwrap();
    assert_eq!(files, vec![("data/fonts.csv".into(), big)]);
}

/// The package a real design-reference skill needs: 128 resources, about
/// 3.8 MiB in total, and one 808 KiB data file. It is over every bound the
/// packager used to carry — 64 resources, 512 KiB per package, 128 KiB per
/// resource — so this test fails if any of them comes back.
#[test]
fn directory_skill_package_accepts_a_data_shaped_package() {
    const LARGEST: usize = 808 * 1024;
    const SMALLEST: usize = 24 * 1024;
    const SMALLEST_COUNT: usize = 127;
    let app = tempdir().unwrap();
    let (mut registry, id, root) = packaged_skill(&app);
    let project = app.path().join("project");
    let project_path = Some(project.to_str().unwrap());
    fs::create_dir_all(root.join("data")).unwrap();
    for index in 0..SMALLEST_COUNT {
        // Sparse files: capture checks metadata length before reading bytes.
        fs::File::create(root.join(format!("data/{index}.csv")))
            .unwrap()
            .set_len(SMALLEST as u64)
            .unwrap();
    }
    fs::File::create(root.join("data/fonts.csv"))
        .unwrap()
        .set_len(LARGEST as u64)
        .unwrap();
    let expected_total = LARGEST + SMALLEST * SMALLEST_COUNT;
    let files = registry
        .package_files(&id, CapabilityLevel::Project, project_path)
        .unwrap();
    assert!(
        LARGEST > MAX_SKILL_BYTES && files.len() > 64,
        "fixture must exceed the document and file-count bounds this replaces"
    );
    assert_eq!(files.len(), SMALLEST_COUNT + 1);
    assert_eq!(
        files.iter().map(|(_, bytes)| bytes.len()).sum::<usize>(),
        expected_total
    );
}

#[test]
fn directory_skill_package_rejects_a_resource_above_the_resource_limit() {
    let app = tempdir().unwrap();
    let (mut registry, id, root) = packaged_skill(&app);
    let project = app.path().join("project");
    let project_path = Some(project.to_str().unwrap());
    let error = registry
        .write_package_files(
            &id,
            CapabilityLevel::Project,
            project_path,
            &[(
                "data/huge.json".into(),
                vec![b'x'; MAX_SKILL_RESOURCE_BYTES + 1],
            )],
        )
        .unwrap_err()
        .to_string();
    assert!(error.contains("SKILL_LIMIT_EXCEEDED"), "error = {error}");
    // A resource already on disk is refused on capture at the same bound.
    fs::create_dir_all(root.join("data")).unwrap();
    fs::write(
        root.join("data/huge.json"),
        vec![b'x'; MAX_SKILL_RESOURCE_BYTES + 1],
    )
    .unwrap();
    let error = registry
        .package_files(&id, CapabilityLevel::Project, project_path)
        .unwrap_err()
        .to_string();
    assert!(error.contains("SKILL_LIMIT_EXCEEDED"), "error = {error}");
}

#[test]
fn directory_skill_package_rejects_more_files_than_the_limit() {
    let app = tempdir().unwrap();
    let (mut registry, id, root) = packaged_skill(&app);
    let project = app.path().join("project");
    let project_path = Some(project.to_str().unwrap());
    let files = (0..=MAX_SKILL_PACKAGE_FILES)
        .map(|index| (format!("data/{index}.txt"), b"x".to_vec()))
        .collect::<Vec<_>>();
    let error = registry
        .write_package_files(&id, CapabilityLevel::Project, project_path, &files)
        .unwrap_err()
        .to_string();
    assert!(error.contains("SKILL_LIMIT_EXCEEDED"), "error = {error}");
    // Capture refuses the same package found on disk.
    fs::create_dir_all(root.join("data")).unwrap();
    for (relative, bytes) in &files {
        fs::write(root.join(relative), bytes).unwrap();
    }
    let error = registry
        .package_files(&id, CapabilityLevel::Project, project_path)
        .unwrap_err()
        .to_string();
    assert!(error.contains("SKILL_LIMIT_EXCEEDED"), "error = {error}");
}

#[test]
fn directory_skill_package_rejects_a_package_above_the_total_limit() {
    let app = tempdir().unwrap();
    let (mut registry, id, root) = packaged_skill(&app);
    let project = app.path().join("project");
    let project_path = Some(project.to_str().unwrap());
    let count = MAX_SKILL_PACKAGE_BYTES / MAX_SKILL_RESOURCE_BYTES + 1;
    assert!(
        count <= MAX_SKILL_PACKAGE_FILES,
        "fixture must fit the file cap"
    );
    fs::create_dir_all(root.join("data")).unwrap();
    for index in 0..count {
        // Sparse files: the cap is checked against metadata length first.
        let file = fs::File::create(root.join(format!("data/{index}.bin"))).unwrap();
        file.set_len(MAX_SKILL_RESOURCE_BYTES as u64).unwrap();
    }
    let error = registry
        .package_files(&id, CapabilityLevel::Project, project_path)
        .unwrap_err()
        .to_string();
    assert!(error.contains("SKILL_LIMIT_EXCEEDED"), "error = {error}");
}

#[test]
fn skill_document_limit_still_matches_the_prompt_sized_cap() {
    let app = tempdir().unwrap();
    let project = app.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let mut registry = UserSkillRegistry::new(app.path());
    let payload = UserSkillInput {
        name: Some("Too big".into()),
        level: Some("project".into()),
        project_path: Some(project.to_str().unwrap().into()),
        body: Some("x".repeat(MAX_SKILL_BYTES)),
        ..UserSkillInput::default()
    };
    let error = registry.create(payload).unwrap_err().to_string();
    assert!(error.contains("document exceeds"), "error = {error}");
}
