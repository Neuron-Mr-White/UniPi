//! "Summarize & archive": panel settings, the agent spawn, and the archive
//! sweep — each against the real daemon over HTTP.

mod common;

use common::{Daemon, Fixture, cli, http, http_with_headers};
use kanboard::model::{Priority, Status};

/// Tasks land in Backlog/Todo only, so reach Done the way the UI does:
/// claim → release to review → move to done.
fn finish(fixture: &Fixture, title: &str) {
    fixture.add_with(title, Status::Todo, Priority::None, &[]);
    let claimed = common::claimed_id(&fixture.claim_next("test", 999_999)).expect("claim");
    cli(
        fixture,
        &[
            "release",
            &claimed,
            "--to",
            "in_review",
            "--comment",
            "done",
        ],
    )
    .status
    .success()
    .then_some(())
    .expect("release to review");
    fixture.move_to(&claimed, Status::Done);
}

fn fixture() -> Fixture {
    let fixture = Fixture::new();
    finish(&fixture, "done one");
    finish(&fixture, "done two");
    fixture.add_with("still todo", Status::Todo, Priority::None, &[]);
    fixture
}

fn put_settings(port: u16, body: &str) -> common::HttpResponse {
    http(port, "PUT", "/api/settings", Some(body)).expect("put settings")
}

/// Write a `pi` stand-in shell script into the fixture home and return its
/// path for the piCommand setting. Unix only — on Windows the summarize test
/// is skipped (a .cmd stub would need a different argv shape).
#[cfg(unix)]
fn pi_stub(fixture: &Fixture, body: &str) -> String {
    let path = fixture.layout.home.join("pi-stub.sh");
    std::fs::write(&path, body).unwrap();
    let mut perms = std::fs::metadata(&path).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
    std::fs::set_permissions(&path, perms).unwrap();
    path.to_string_lossy().to_string()
}

fn write_settings(fixture: &Fixture, body: serde_json::Value) {
    std::fs::write(
        fixture.layout.home.join("settings.json"),
        serde_json::to_string_pretty(&body).unwrap(),
    )
    .unwrap();
}

#[test]
fn settings_round_trip_with_defaults() {
    let fixture = fixture();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);

    // Fresh home: no pi configured, the built-in instruction, and the default exposed.
    let payload = http(daemon.port, "GET", "/api/settings", None)
        .unwrap()
        .json();
    assert_eq!(payload["piCommand"], serde_json::json!([]));
    assert_eq!(payload["summaryModel"], "");
    let default = payload["defaultSummaryInstruction"].as_str().unwrap();
    assert!(default.contains("Conventional Commit"), "{default}");
    assert!(
        !default.contains("github.com"),
        "no skill/URL reference in the prompt: {default}"
    );
    assert_eq!(payload["summaryInstruction"], default);

    // summaryModel is whitelisted against the reported models.
    write_settings(
        &fixture,
        serde_json::json!({ "models": ["anthropic/claude", "openai/gpt-5"] }),
    );
    let refused = put_settings(daemon.port, r#"{"summaryModel":"evil/mine"}"#);
    assert_eq!(refused.status, 400, "{}", refused.body);
    let ok = put_settings(daemon.port, r#"{"summaryModel":"openai/gpt-5"}"#);
    assert_eq!(ok.status, 200, "{}", ok.body);
    assert_eq!(ok.json()["summaryModel"], "openai/gpt-5");
    // Blank clears back to pi default.
    let cleared = put_settings(daemon.port, r#"{"summaryModel":" "}"#);
    assert_eq!(cleared.json()["summaryModel"], "");

    // Instruction patches stick; a blank resolves to the default.
    let response = put_settings(daemon.port, r#"{"summaryInstruction":"be brief"}"#);
    assert_eq!(response.status, 200);
    assert_eq!(response.json()["summaryInstruction"], "be brief");
    let payload = put_settings(daemon.port, r#"{"summaryInstruction":"  "}"#).json();
    assert_eq!(payload["summaryInstruction"], default, "blank → default");

    // Command fields are no longer accepted — ignored outright.
    let ignored = put_settings(daemon.port, r#"{"agentCommand":"rm -rf /"}"#);
    assert_eq!(ignored.status, 200, "{}", ignored.body);
    let saved: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fixture.layout.home.join("settings.json")).unwrap(),
    )
    .unwrap();
    assert!(
        saved.get("agentCommand").is_none() || saved["agentCommand"] == serde_json::Value::Null
    );
}

#[test]
fn summary_model_whitelist_applies_on_remote_binds() {
    let fixture = fixture();
    write_settings(&fixture, serde_json::json!({ "models": ["a/one"] }));
    let daemon = Daemon::start(&fixture, &["--host", "0.0.0.0", "--idle-secs", "120"]);
    let info: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fixture.layout.home.join("daemon.json")).unwrap(),
    )
    .unwrap();
    let token = info["token"].as_str().expect("remote bind is token-gated");
    let auth = format!("Bearer {token}");

    let refused = http_with_headers(
        daemon.port,
        "PUT",
        "/api/settings",
        Some(r#"{"summaryModel":"not/listed"}"#),
        &[("authorization", &auth)],
    )
    .unwrap();
    assert_eq!(refused.status, 400, "{}", refused.body);

    let allowed = http_with_headers(
        daemon.port,
        "PUT",
        "/api/settings",
        Some(r#"{"summaryInstruction":"custom"}"#),
        &[("authorization", &auth)],
    )
    .unwrap();
    assert_eq!(allowed.status, 200, "{}", allowed.body);
}

#[test]
fn summarize_needs_pi() {
    let fixture = fixture();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;
    let response = http(
        daemon.port,
        "POST",
        &format!("/api/projects/{slug}/summarize"),
        Some("{}"),
    )
    .unwrap();
    assert_eq!(response.status, 409, "{}", response.body);
    assert_eq!(response.json()["needsAgent"], true);
    assert!(
        response.body.contains("/unipi:kanboard open"),
        "{}",
        response.body
    );
}

#[cfg(unix)]
#[test]
fn summarize_runs_pi_and_reports_failures() {
    let fixture = fixture();
    let slug = &fixture.project.slug;
    let done_id = fixture
        .tasks()
        .iter()
        .find(|task| task.status == Status::Done)
        .map(|task| task.id.clone())
        .unwrap();

    // A stub pi that echoes stdin: the summary contains the prompt verbatim.
    let stub = pi_stub(&fixture, "#!/bin/sh\ncat\n");
    write_settings(&fixture, serde_json::json!({ "piCommand": [stub] }));
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let response = http(
        daemon.port,
        "POST",
        &format!("/api/projects/{slug}/summarize"),
        Some(r#"{"instruction":"TEST-INSTRUCTION"}"#),
    )
    .unwrap();
    assert_eq!(response.status, 200, "{}", response.body);
    let payload = response.json();
    let summary = payload["summary"].as_str().unwrap();
    assert!(summary.contains("TEST-INSTRUCTION"), "{summary}");
    assert!(summary.contains(&done_id), "{summary}");
    // The fixed style block is appended even with a custom instruction.
    assert!(summary.contains("Style: plain words only"), "{summary}");
    assert!(!summary.contains("github.com"), "{summary}");
    assert_eq!(payload["taskIds"].as_array().unwrap().len(), 2);

    // A failing pi surfaces stderr, not an empty summary.
    let fail = pi_stub(&fixture, "#!/bin/sh\necho bad-news >&2\nexit 3\n");
    write_settings(&fixture, serde_json::json!({ "piCommand": [fail] }));
    let failed = http(
        daemon.port,
        "POST",
        &format!("/api/projects/{slug}/summarize"),
        Some("{}"),
    )
    .unwrap();
    assert_eq!(failed.status, 502, "{}", failed.body);
    assert!(failed.body.contains("bad-news"), "{}", failed.body);
}

#[test]
fn archive_summary_writes_the_file_and_archives_done_tasks() {
    let fixture = fixture();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;
    let tasks = fixture.tasks();
    let done: Vec<String> = tasks
        .iter()
        .filter(|task| task.status == Status::Done)
        .map(|task| task.id.clone())
        .collect();
    let todo = tasks
        .iter()
        .find(|task| task.status == Status::Todo)
        .unwrap()
        .id
        .clone();

    let body = serde_json::json!({
        "markdown": "## What shipped\n\nThings.",
        "taskIds": [done[0], done[1], todo],
    })
    .to_string();
    let response = http(
        daemon.port,
        "POST",
        &format!("/api/projects/{slug}/archive-summary"),
        Some(&body),
    )
    .unwrap();
    assert_eq!(response.status, 200, "{}", response.body);
    let payload = response.json();
    assert_eq!(payload["archived"].as_array().unwrap().len(), 2);
    assert_eq!(payload["skipped"], serde_json::json!([todo]));

    // The summary file sits under the project's summaries/ directory.
    let path = payload["path"].as_str().unwrap();
    assert!(path.contains("summaries"), "{path}");
    let text = std::fs::read_to_string(path).unwrap();
    assert!(text.contains("## What shipped"), "{text}");
    assert!(
        text.contains(&format!("Archived tasks: {}, {}", done[0], done[1])),
        "{text}"
    );
    assert!(
        text.contains(&format!("Skipped (not done): {todo}")),
        "{text}"
    );

    // Done tasks moved; the todo one was left alone.
    let show = |id: &str| cli(&fixture, &["show", id, "--json"]);
    let json: serde_json::Value = serde_json::from_slice(&show(&done[0]).stdout).unwrap();
    assert_eq!(json["status"], "archived");
    let json: serde_json::Value = serde_json::from_slice(&show(&todo).stdout).unwrap();
    assert_eq!(json["status"], "todo");
}

/// A pi stub that answers `--list-models` and echoes the prompt otherwise.
#[cfg(unix)]
fn pi_stub_with_models(fixture: &Fixture, rows: &[&str]) -> String {
    let table = rows
        .iter()
        .map(|row| format!("    printf '{row}\\n'\n"))
        .collect::<String>();
    pi_stub(
        fixture,
        &format!(
            "#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = \"--list-models\" ]; then\n    printf 'provider model context max-out thinking images\\n'\n{table}    exit 0\n  fi\ndone\ncat\n"
        ),
    )
}

#[cfg(unix)]
#[test]
fn api_models_serves_the_runtime_catalog_and_persists_it() {
    let fixture = fixture();
    let slug = &fixture.project.slug;
    let stub = pi_stub_with_models(
        &fixture,
        &[
            "omni demo-a 1.0M 64K yes yes",
            "omni demo-b 1.0M 64K yes yes",
            "test model-c 1M 64K yes yes",
        ],
    );
    write_settings(
        &fixture,
        serde_json::json!({ "piCommand": [stub], "models": ["stale/old"] }),
    );
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);

    let response = http(daemon.port, "GET", "/api/models", None).unwrap();
    assert_eq!(response.status, 200, "{}", response.body);
    let models = response.json()["models"].as_array().unwrap().clone();
    assert_eq!(
        models,
        serde_json::json!(["omni/demo-a", "omni/demo-b", "test/model-c"])
            .as_array()
            .unwrap()
            .clone(),
        "{}",
        response.body
    );

    // The fetch persists the live list into settings.json (over the stale one).
    let saved: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fixture.layout.home.join("settings.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        saved["models"],
        serde_json::json!(["omni/demo-a", "omni/demo-b", "test/model-c"])
    );

    // The whitelist refreshes against the live catalog, not the stale file.
    let patch = http(
        daemon.port,
        "PUT",
        "/api/settings",
        Some(r#"{"summaryModel":"omni/demo-b"}"#),
    )
    .unwrap();
    assert_eq!(patch.status, 200, "{}", patch.body);
    let refused = http(
        daemon.port,
        "PUT",
        "/api/settings",
        Some(r#"{"summaryModel":"stale/old"}"#),
    )
    .unwrap();
    assert_eq!(refused.status, 400, "{}", refused.body);

    let _ = slug;
}

#[cfg(unix)]
#[test]
fn api_models_without_pi_command_is_needs_agent() {
    let fixture = fixture();
    write_settings(&fixture, serde_json::json!({}));
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let response = http(daemon.port, "GET", "/api/models", None).unwrap();
    assert_eq!(response.status, 409, "{}", response.body);
    assert_eq!(response.json()["needsAgent"], serde_json::json!(true));
}

#[cfg(unix)]
#[test]
fn summarize_runs_ambient_and_marks_the_child() {
    let fixture = fixture();
    let slug = &fixture.project.slug;
    // The stub records its argv + env marker so the ambient contract is provable.
    let stub = pi_stub(
        &fixture,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$UNIPI_KANBOARD_HOME/pi-argv.txt\"\nprintenv UNIPI_KANBOARD_CHILD > \"$UNIPI_KANBOARD_HOME/pi-env.txt\"\ncat\n",
    );
    write_settings(&fixture, serde_json::json!({ "piCommand": [stub] }));
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let response = http(
        daemon.port,
        "POST",
        &format!("/api/projects/{slug}/summarize"),
        Some("{}"),
    )
    .unwrap();
    assert_eq!(response.status, 200, "{}", response.body);

    let argv = std::fs::read_to_string(fixture.layout.home.join("pi-argv.txt")).unwrap();
    assert!(argv.contains("-p"), "{argv}");
    assert!(
        !argv.contains("--no-extensions"),
        "ambient run must load extensions: {argv}"
    );
    assert!(
        argv.contains("--no-session") && argv.contains("--no-tools"),
        "{argv}"
    );
    let env = std::fs::read_to_string(fixture.layout.home.join("pi-env.txt")).unwrap();
    assert_eq!(env.trim(), "1", "the child must be marked");
}
