//! Daemon + JSON API + SSE integration tests. Each test runs the real binary
//! against a temp `UNIPI_KANBOARD_HOME`.

mod common;

use common::{cli, http, read_sse, Daemon, Fixture};
use kanboard::model::{Priority, Status};
use std::time::{Duration, Instant};

fn fixture_with_tasks() -> Fixture {
    let fixture = Fixture::new();
    fixture.add_with("first", Status::Todo, Priority::None, &[]);
    fixture.add_with("second", Status::Todo, Priority::High, &[]);
    fixture
}

#[test]
fn health_reports_ok_version_and_pid() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let response = http(daemon.port, "GET", "/api/health", None).expect("health");
    assert_eq!(response.status, 200);
    let payload = response.json();
    assert_eq!(payload["ok"], true);
    assert_eq!(payload["version"], env!("CARGO_PKG_VERSION"));
    assert!(payload["pid"].as_u64().unwrap() > 0);

    // daemon.json mirrors it.
    let info: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(fixture.layout.home.join("daemon.json")).unwrap()).unwrap();
    assert_eq!(info["port"].as_u64().unwrap() as u16, daemon.port);
    assert_eq!(info["pid"].as_u64().unwrap() as u32, payload["pid"].as_u64().unwrap() as u32);
}

#[test]
fn a_second_serve_prints_the_existing_daemon_and_exits_zero() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);

    let output = cli(&fixture, &["serve", "--port", "0", "--json"]);
    assert_eq!(output.status.code(), Some(0), "second serve exits 0");
    let payload: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json");
    assert_eq!(payload["alreadyRunning"], true);
    let info: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(fixture.layout.home.join("daemon.json")).unwrap()).unwrap();
    assert_eq!(payload["daemon"]["pid"], info["pid"], "prints the existing daemon.json");
    assert_eq!(payload["daemon"]["port"].as_u64().unwrap() as u16, daemon.port);
    assert_eq!(payload["daemon"]["version"], env!("CARGO_PKG_VERSION"));

    // Human output names the port too.
    let human = cli(&fixture, &["serve", "--port", "0"]);
    assert_eq!(human.status.code(), Some(0));
    let text = String::from_utf8_lossy(&human.stdout);
    assert!(text.contains("already running"), "{text}");
}

#[test]
fn a_stale_daemon_json_is_replaced_by_a_fresh_serve() {
    let fixture = fixture_with_tasks();
    std::fs::create_dir_all(&fixture.layout.home).unwrap();
    // A pid that cannot exist, with a plausible port nobody listens on.
    let stale = serde_json::json!({
        "pid": 0x7fff_fffeu32,
        "port": 1,
        "version": "0.0.1",
        "startedAt": "2020-01-01T00:00:00Z",
    });
    std::fs::write(
        fixture.layout.home.join("daemon.json"),
        serde_json::to_string_pretty(&stale).unwrap(),
    )
    .unwrap();

    // No lock is held, so serve starts normally and overwrites daemon.json.
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let info: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(fixture.layout.home.join("daemon.json")).unwrap()).unwrap();
    assert_ne!(info["pid"].as_u64().unwrap(), 0x7fff_fffe);
    assert_eq!(info["port"].as_u64().unwrap() as u16, daemon.port);
    assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
}

#[test]
fn status_reports_the_daemon_and_liveness() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let output = cli(&fixture, &["status", "--json"]);
    let payload: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json");
    assert_eq!(payload["alive"], true);
    assert_eq!(payload["daemon"]["port"].as_u64().unwrap() as u16, daemon.port);
}

#[test]
fn stop_terminates_the_daemon_and_removes_daemon_json() {
    let fixture = fixture_with_tasks();
    let mut daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let pid = daemon.child.id();

    let output = cli(&fixture, &["stop", "--timeout", "15", "--json"]);
    let payload: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json");
    assert_eq!(payload["stopped"], true, "{payload}");
    assert_eq!(payload["pid"].as_u64().unwrap() as u32, pid);

    // The child is reaped by the test harness; daemon.json must be gone.
    let _ = daemon.child.wait();
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && fixture.layout.home.join("daemon.json").exists() {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        !fixture.layout.home.join("daemon.json").exists(),
        "daemon.json must be removed on exit"
    );
}

#[test]
fn move_that_needs_a_comment_answers_409_then_succeeds_with_one() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;

    // Drive a task to in_review through the runner path (system transitions).
    // claim-next picks by priority, so use whatever it actually claimed.
    let claimed = cli(
        &fixture,
        &[
            "claim-next",
            "--session",
            "s-test",
            "--pid",
            &std::process::id().to_string(),
            "--host",
            "test-host",
            "--json",
        ],
    );
    assert!(claimed.status.success());
    let claimed: serde_json::Value = serde_json::from_slice(&claimed.stdout).expect("claim json");
    let task = fixture
        .tasks()
        .into_iter()
        .find(|candidate| candidate.id == claimed["task"]["id"].as_str().unwrap())
        .expect("claimed task");
    let released = cli(
        &fixture,
        &["release", &task.id, "--to", "in_review", "--comment", "done", "--json"],
    );
    assert!(released.status.success(), "{}", String::from_utf8_lossy(&released.stderr));

    // in_review → todo needs a rework note: 409 + needsComment.
    let response = http(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/{}/move", task.id),
        Some(r#"{"status":"todo"}"#),
    )
    .expect("move");
    assert_eq!(response.status, 409, "{}", response.body);
    let payload = response.json();
    assert_eq!(payload["needsComment"], true);
    // The UI/API names what is missing; only the CLI talks about `--comment`.
    assert_eq!(
        payload["error"],
        "in_review → todo requires a comment (rework note)"
    );
    assert!(!payload["error"].as_str().unwrap().contains("--comment"));

    // With the comment it goes through and lands in the file.
    let response = http(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/{}/move", task.id),
        Some(r#"{"status":"todo","comment":"needs a reconnect test"}"#),
    )
    .expect("move with comment");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.json()["status"], "todo");

    let stored = fixture.tasks().into_iter().find(|candidate| candidate.id == task.id).unwrap();
    assert_eq!(stored.status, Status::Todo);
    assert!(stored
        .activity
        .iter()
        .any(|entry| entry.text == "rework: needs a reconnect test"));
}

#[test]
fn api_errors_are_4xx_with_the_rule_message() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;

    // Unknown task → 404.
    let response = http(daemon.port, "GET", &format!("/api/tasks/{slug}/DEM-404"), None).expect("get");
    assert_eq!(response.status, 404);
    assert!(response.json()["error"].as_str().unwrap().contains("not found"));

    // A rule violation → 400 with the rule text.
    let task = fixture.tasks().into_iter().next().unwrap();
    let response = http(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/{}/move", task.id),
        Some(r#"{"status":"in_progress"}"#),
    )
    .expect("move");
    assert_eq!(response.status, 400);
    assert!(response.json()["error"].as_str().unwrap().contains("system only"));

    // Unknown project → 404.
    let response = http(daemon.port, "GET", "/api/projects/nope/tasks", None).expect("get");
    assert_eq!(response.status, 404);
}

#[test]
fn create_and_read_tasks_over_the_api() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;

    let created = http(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/create"),
        Some(r#"{"title":"from the UI","body":"details","priority":"urgent"}"#),
    )
    .expect("create");
    assert_eq!(created.status, 200, "{}", created.body);
    let created = created.json();
    assert_eq!(created["title"], "from the UI");
    assert_eq!(created["status"], "backlog");
    assert_eq!(created["priority"], "urgent");

    // It is on disk (the CLI sees it) and in the listing.
    let list = cli(&fixture, &["list", "--json"]);
    let tasks: serde_json::Value = serde_json::from_slice(&list.stdout).unwrap();
    assert!(tasks
        .as_array()
        .unwrap()
        .iter()
        .any(|task| task["title"] == "from the UI"));

    let listed = http(daemon.port, "GET", &format!("/api/projects/{slug}/tasks"), None).expect("list");
    assert_eq!(listed.status, 200);
    assert_eq!(listed.json().as_array().unwrap().len(), 3);

    // `ready` filtering works through the API too.
    let ready = http(
        daemon.port,
        "GET",
        &format!("/api/projects/{slug}/tasks?ready=true"),
        None,
    )
    .expect("ready");
    // Backlog tasks are never ready; the two todo tasks are.
    assert_eq!(ready.json().as_array().unwrap().len(), 2);
}

#[test]
fn sse_pushes_a_revision_after_a_cli_write() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = fixture.project.slug.clone();
    let port = daemon.port;

    let reader = std::thread::spawn(move || read_sse(port, &format!("/events?project={slug}"), 4));

    // Give the stream a moment to attach, then write through the CLI.
    std::thread::sleep(Duration::from_millis(600));
    let task = fixture.tasks().into_iter().next().unwrap();
    let note = cli(&fixture, &["note", &task.id, "written by the agent"]);
    assert!(note.status.success());

    let lines = reader.join().expect("sse reader");
    let events: Vec<&String> = lines.iter().filter(|line| line.starts_with("data:")).collect();
    assert!(!events.is_empty(), "no SSE data lines: {lines:?}");
    let revisions: Vec<u64> = events
        .iter()
        .filter_map(|line| line.trim_start_matches("data:").trim().parse::<u64>().ok())
        .collect();
    assert!(
        revisions.iter().any(|revision| *revision >= 1),
        "expected a bumped revision, got {revisions:?}"
    );
}

#[test]
fn idle_shutdown_removes_daemon_json() {
    let fixture = fixture_with_tasks();
    // Idle window of 3s: the daemon starts, then shuts itself down with no
    // clients connected and no requests.
    let mut child = std::process::Command::new(common::bin())
        .args(["serve", "--port", "0", "--idle-secs", "3"])
        .env("UNIPI_KANBOARD_HOME", fixture.layout.home.as_os_str())
        .current_dir(fixture.root())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn serve");

    let info_path = fixture.layout.home.join("daemon.json");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && !info_path.exists() {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(info_path.exists(), "daemon.json was written");

    let exited = child.wait().expect("wait");
    assert!(exited.success(), "idle shutdown is a clean exit: {exited:?}");
    assert!(!info_path.exists(), "daemon.json is removed on idle shutdown");
}

#[test]
fn ui_pages_render_the_board_and_the_drawer() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;

    let picker = http(daemon.port, "GET", "/", None).expect("picker");
    assert_eq!(picker.status, 200);
    assert!(picker.body.contains(&format!("/p/{slug}")), "picker links the project");
    assert!(picker.body.contains("/kanboard.css"));

    let board = http(daemon.port, "GET", &format!("/p/{slug}"), None).expect("board");
    assert_eq!(board.status, 200);
    for lane in ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled", "archived"] {
        assert!(board.body.contains(&format!("data-lane=\"{lane}\"")), "lane {lane}");
    }
    // No run button anywhere.
    assert!(!board.body.to_lowercase().contains("run task"), "the UI never starts work");

    let task = fixture.tasks().into_iter().next().unwrap();
    let drawer = http(daemon.port, "GET", &format!("/p/{slug}/card/{}", task.id), None).expect("drawer");
    assert_eq!(drawer.status, 200);
    for form in ["edit", "link", "note"] {
        assert!(drawer.body.contains(&format!("data-form=\"{form}\"")), "drawer {form} form");
    }

    // The assets are served from the binary (no bundling step).
    let js = http(daemon.port, "GET", "/kanboard.js", None).expect("js");
    assert_eq!(js.status, 200);
    assert!(js.body.contains("EventSource"));
    let css = http(daemon.port, "GET", "/kanboard.css", None).expect("css");
    assert_eq!(css.status, 200);
    assert!(css.body.contains("prefers-color-scheme"));
}

#[test]
fn the_ui_never_claims_tasks() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;
    let task = fixture.tasks().into_iter().next().unwrap();

    // There is no endpoint that claims work: todo → in_progress is system-only,
    // and the API has no claim route at all.
    let response = http(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/{}/claim", task.id),
        Some("{}"),
    )
    .expect("claim attempt");
    assert!(response.status >= 400, "no claim endpoint: {}", response.status);

    // Nor can it set a run block.
    let response = http(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/{}/set-run", task.id),
        Some(r#"{"mode":"direct"}"#),
    )
    .expect("set-run attempt");
    assert!(response.status >= 400, "no set-run endpoint: {}", response.status);
}
