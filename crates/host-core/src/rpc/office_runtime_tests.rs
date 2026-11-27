use super::*;
use crate::activation::{ActivationMode, ActivationScope};
use crate::tools::shell::BASH_ID;
use std::fs;
use std::os::unix::fs::PermissionsExt;

#[tokio::test]
async fn office_runtime_is_opt_in_and_follows_the_session_scope() {
    let root = tempfile::tempdir().unwrap();
    let resources = root.path().join("Pie Code/resources");
    let plugins = resources.join("plugins");
    let office = resources.join("office-runtime");
    for (name, content) in [
        ("node/bin/node", "#!/bin/sh\nprintf pie-office"),
        (
            "python/bin/python",
            "#!/bin/sh\nexec timeout 30 soffice --wait-for-stop",
        ),
        ("python/bin/python3", ""),
        (
            "bin/python",
            include_str!("../../../../scripts/office-runtime-bin/python"),
        ),
        ("bin/python3", "#!/bin/sh\n"),
        (
            "bin/office-python",
            include_str!("../../../../scripts/office-runtime-bin/office-python"),
        ),
        (
            "libexec/timeout",
            include_str!("../../../../scripts/office-runtime-bin/timeout"),
        ),
        (
            "bin/soffice",
            include_str!("../../../../scripts/office-runtime-bin/soffice"),
        ),
        (
            "libreoffice/program/oosplash",
            "#!/bin/sh\nprintf '%s' \"$HOME\" > profile-path\nprintf '%s' \"$$\" > calc-pid\nprintf ready > profile-ready\ncase \"$*\" in *--wait-for-stop*) exec sleep 30;; esac",
        ),
        ("libreoffice/program/libsclo.so", ""),
        ("libreoffice/presets/basic/script.xlc", ""),
        ("libreoffice/presets/basic/Standard/script.xlb", ""),
        ("poppler/bin/pdftoppm", "#!/bin/sh\nexit 0"),
        ("bin/pdftoppm", "#!/bin/sh\nprintf ppt-thumbnail"),
        ("python/lib/python3.12/site-packages/PIL/__init__.py", ""),
        ("python/lib/python3.12/site-packages/dateutil/__init__.py", ""),
        ("python/lib/python3.12/site-packages/et_xmlfile/__init__.py", ""),
        ("python/lib/python3.12/site-packages/markitdown/__init__.py", ""),
        ("python/lib/python3.12/site-packages/lxml/__init__.py", ""),
        ("python/lib/python3.12/site-packages/openpyxl/__init__.py", ""),
        ("python/lib/python3.12/site-packages/pandas/__init__.py", ""),
        (
            "python/lib/python3.12/site-packages/defusedxml/__init__.py",
            "",
        ),
        ("node/lib/node_modules/docx/package.json", "{}"),
        ("node/lib/node_modules/pptxgenjs/package.json", "{}"),
    ] {
        let path = office.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let legacy = plugins.join("pie.offline-office");
    fs::create_dir_all(&legacy).unwrap();
    fs::write(legacy.join("manifest.json"), r#"{"schemaVersion":1,"id":"pie.offline-office","name":"Old Office","version":"1.0.0","main":"main.cjs"}"#).unwrap();
    fs::write(legacy.join("main.cjs"), "").unwrap();
    let app_data = root.path().join("data");
    let mut app = AppState::open(&app_data).unwrap();
    app.handshook = true;
    app.plugins.sync_builtin(Some(&plugins)).unwrap();
    let project = root.path().join("project");
    fs::create_dir(&project).unwrap();
    app.plugins
        .set_scope(
            "pie.offline-office",
            ActivationScope {
                mode: ActivationMode::Projects,
                projects: vec![project.to_string_lossy().into_owned()],
            },
        )
        .unwrap();
    let old = plugins.join("pie.office-runtime");
    fs::rename(&legacy, &old).unwrap();
    fs::write(
        old.join("manifest.json"),
        include_str!("../../../../apps/desktop/resources/office-runtime/manifest.json"),
    )
    .unwrap();
    app.plugins.sync_builtin(Some(&plugins)).unwrap();
    assert!(app.plugins.get("pie.offline-office").is_none());

    let make_session = |project_path| {
        let session = sessions::create_session(
            &app.db,
            None,
            Some("agent".into()),
            None,
            None,
            project_path,
        )
        .unwrap();
        sessions::configure_session_with_thinking(
            &app.db,
            &session.id,
            "agent",
            None,
            None,
            None,
            Some("auto"),
        )
        .unwrap();
        session.id
    };
    let temp = make_session(None);
    let bound = make_session(Some(project.to_string_lossy().into_owned()));
    let state = Arc::new(Mutex::new(app));
    let (tx, _rx) = mpsc::unbounded_channel();
    let execute = |session: String, command: String, run_in_background: bool| {
        let state = state.clone();
        let tx = tx.clone();
        async move {
            handle_request(
                state,
                "tools.execute",
                json!({
                    "sessionId": session,
                    "toolCallId": uuid::Uuid::new_v4().to_string(),
                    "toolName": "Bash",
                    "args": { "command": command },
                    "runInBackground": run_in_background,
                    "expectedCommandShellId": BASH_ID,
                    "expectedCommandShellDialect": "posix",
                    "mode": "agent"
                }),
                tx,
            )
            .await
            .unwrap()
        }
    };
    let probe = |session| {
        execute(
            session,
            "if [[ ${NODE_PATH-} == *office-runtime/node/lib/node_modules* ]]; then node; else printf original; fi".into(),
            false,
        )
    };
    assert_eq!(probe(temp.clone()).await["content"]["stdout"], "original");
    state
        .lock()
        .await
        .plugins
        .set_enabled("pie.office-runtime", true)
        .unwrap();
    assert_eq!(probe(temp.clone()).await["content"]["stdout"], "pie-office");
    let thumbnail = execute(
        temp.clone(),
        "test \"$PYTHONDONTWRITEBYTECODE\" = 1 && pdftoppm".into(),
        false,
    )
    .await;
    assert_eq!(thumbnail["content"]["stdout"], "ppt-thumbnail");
    state
        .lock()
        .await
        .plugins
        .set_scope(
            "pie.office-runtime",
            ActivationScope {
                mode: ActivationMode::Projects,
                projects: vec![project.to_string_lossy().into_owned()],
            },
        )
        .unwrap();
    assert_eq!(probe(temp.clone()).await["content"]["stdout"], "original");
    assert_eq!(
        probe(bound.clone()).await["content"]["stdout"],
        "pie-office"
    );
    let background = execute(bound.clone(), "node > background.txt".into(), true).await;
    assert_eq!(background["ok"], true, "{background}");
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if fs::read_to_string(project.join("background.txt"))
                .as_deref()
                .ok()
                == Some("pie-office")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let profile_ready = project.join("profile-ready");
    let profile_path = project.join("profile-path");
    let rendered = execute(bound.clone(), "soffice".into(), false).await;
    assert_eq!(rendered["content"]["exitCode"], 0, "{rendered}");
    let normal_profile = std::path::PathBuf::from(fs::read_to_string(&profile_path).unwrap());
    assert!(!normal_profile.exists(), "profile leaked after normal exit");
    fs::remove_file(&profile_ready).unwrap();
    #[cfg(target_os = "linux")]
    let stop_command = {
        fs::create_dir_all(project.join("scripts/office")).unwrap();
        fs::write(project.join("SKILL.md"), "---\nname: xlsx\n---\n").unwrap();
        fs::write(project.join("scripts/recalc.py"), "").unwrap();
        fs::write(project.join("scripts/office/soffice.py"), "").unwrap();
        "python scripts/recalc.py"
    };
    #[cfg(not(target_os = "linux"))]
    let stop_command = "soffice --wait-for-stop";
    let render = tokio::spawn({
        let state = state.clone();
        let tx = tx.clone();
        let session = bound.clone();
        async move {
            handle_request(
                state,
                "tools.execute",
                json!({
                    "sessionId": session,
                    "toolCallId": "stop-office-render",
                    "toolName": "Bash",
                    "args": { "command": stop_command },
                    "expectedCommandShellId": BASH_ID,
                    "expectedCommandShellDialect": "posix",
                    "mode": "agent"
                }),
                tx,
            )
            .await
            .unwrap()
        }
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !profile_ready.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let profile = std::path::PathBuf::from(fs::read_to_string(&profile_path).unwrap());
    assert!(profile.is_dir());
    #[cfg(target_os = "linux")]
    let calc_stat = {
        let pid = fs::read_to_string(project.join("calc-pid"))
            .unwrap()
            .parse::<u32>()
            .unwrap();
        let path = format!("/proc/{pid}/stat");
        assert!(std::path::Path::new(&path).is_file(), "render already exited before Stop");
        assert!(profile.file_name().unwrap().to_string_lossy().starts_with("python."));
        path
    };
    let aborted = handle_request(
        state.clone(),
        "tools.abort",
        json!({ "sessionId": bound, "toolCallId": "stop-office-render" }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(aborted["found"], true);
    assert_eq!(render.await.unwrap()["errorCode"], "TOOL_ABORTED");
    #[cfg(target_os = "linux")]
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            match fs::read_to_string(&calc_stat) {
                Ok(stat)
                    if stat.rsplit_once(") ").is_some_and(|(_, state)| state.starts_with("Z ")) =>
                {
                    break;
                }
                Ok(_) => tokio::task::yield_now().await,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(error) => panic!("could not read {calc_stat}: {error}"),
            }
        }
    })
    .await
    .expect("Stop left the render running");
    let leaked = profile.exists();
    if leaked {
        fs::remove_dir_all(&profile).unwrap();
    }
    assert!(!leaked, "profile leaked after stopping a render");

    let timeout = office.join("libexec/timeout");
    fs::remove_file(&timeout).unwrap();
    let missing = probe(bound.clone()).await;
    assert_eq!(missing["errorCode"], "TOOL_FAILED", "{missing}");
    assert!(missing["content"]["error"]
        .as_str()
        .unwrap()
        .contains("libexec/timeout"));
    fs::write(
        &timeout,
        include_str!("../../../../scripts/office-runtime-bin/timeout"),
    )
    .unwrap();
    fs::set_permissions(&timeout, fs::Permissions::from_mode(0o755)).unwrap();

    fs::remove_file(office.join("poppler/bin/pdftoppm")).unwrap();
    let missing = probe(bound.clone()).await;
    assert_eq!(missing["errorCode"], "TOOL_FAILED");
    assert!(missing["content"]["error"]
        .as_str()
        .unwrap()
        .contains("poppler/bin/pdftoppm"));
    state
        .lock()
        .await
        .plugins
        .set_enabled("pie.office-runtime", false)
        .unwrap();
    assert_eq!(probe(bound).await["content"]["stdout"], "original");
}
