//! Daemon + JSON API + SSE integration tests. Each test runs the real binary
//! against a temp `UNIPI_KANBOARD_HOME`.

mod common;

use common::{Daemon, Fixture, cli, http, read_sse};
use kanboard::commands;
use kanboard::model::{ChainGate, Priority, Status};
use kanboard::store::Project;
use std::time::{Duration, Instant};


fn watching_enabled() -> bool {
    std::env::var("KB_TEST_NO_WATCH").as_deref() != Ok("1")
}

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
    let info: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fixture.layout.home.join("daemon.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(info["port"].as_u64().unwrap() as u16, daemon.port);
    assert_eq!(
        info["pid"].as_u64().unwrap() as u32,
        payload["pid"].as_u64().unwrap() as u32
    );
}

#[test]
fn a_second_serve_prints_the_existing_daemon_and_exits_zero() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);

    let output = cli(&fixture, &["serve", "--port", "0", "--json"]);
    assert_eq!(output.status.code(), Some(0), "second serve exits 0");
    let payload: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json");
    assert_eq!(payload["alreadyRunning"], true);
    let info: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fixture.layout.home.join("daemon.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        payload["daemon"]["pid"], info["pid"],
        "prints the existing daemon.json"
    );
    assert_eq!(
        payload["daemon"]["port"].as_u64().unwrap() as u16,
        daemon.port
    );
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
    let info: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fixture.layout.home.join("daemon.json")).unwrap(),
    )
    .unwrap();
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
    assert_eq!(
        payload["daemon"]["port"].as_u64().unwrap() as u16,
        daemon.port
    );
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

    // Claim a task with a pid that is dead on this host, so it reads as a
    // confirmed stale run: in_progress → todo for the user actor still
    // requires a note (UNI-106 only lifted the requirement from rework and
    // unblock; releasing a stale run still needs one).
    let task = fixture.tasks().into_iter().next().expect("a task");
    let claimed = cli(
        &fixture,
        &[
            "start",
            &task.id,
            "--actor",
            "agent",
            "--session",
            "s-test",
            "--pid",
            "999999",
            "--json",
        ],
    );
    assert!(
        claimed.status.success(),
        "{}",
        String::from_utf8_lossy(&claimed.stderr)
    );

    // in_progress (stale) → todo needs a note: 409 + needsComment.
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
        "in_progress → todo requires a comment (why the stale run is being released)"
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

    let stored = fixture
        .tasks()
        .into_iter()
        .find(|candidate| candidate.id == task.id)
        .unwrap();
    assert_eq!(stored.status, Status::Todo);
    assert!(
        stored
            .activity
            .iter()
            .any(|entry| entry.text == "moved in_progress → todo: needs a reconnect test")
    );
}

#[test]
fn api_errors_are_4xx_with_the_rule_message() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;

    // Unknown task → 404.
    let response = http(
        daemon.port,
        "GET",
        &format!("/api/tasks/{slug}/DEM-404"),
        None,
    )
    .expect("get");
    assert_eq!(response.status, 404);
    assert!(
        response.json()["error"]
            .as_str()
            .unwrap()
            .contains("not found")
    );

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
    assert!(
        response.json()["error"]
            .as_str()
            .unwrap()
            .contains("system only")
    );

    // Unknown project → 404.
    let response = http(daemon.port, "GET", "/api/projects/nope/tasks", None).expect("get");
    assert_eq!(response.status, 404);
}

#[test]
fn rules_endpoint_lists_the_transition_table_for_the_user_actor() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);

    let response = http(daemon.port, "GET", "/api/rules", None).expect("rules");
    assert_eq!(response.status, 200, "{}", response.body);
    let payload = response.json();

    // UNI-106: in_review → todo is a user move that no longer needs a
    // comment (the rework note is optional now).
    let allowed: Vec<&str> = payload["allowedMoves"]["in_review"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    assert!(allowed.contains(&"todo"), "{allowed:?}");
    assert!(
        payload["commentRequired"]["in_review"].get("todo").is_none(),
        "{}",
        payload
    );

    // todo → in_progress is system-only, so the user actor never sees it here.
    let todo_moves: Vec<&str> = payload["allowedMoves"]["todo"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    assert!(!todo_moves.contains(&"in_progress"), "{todo_moves:?}");

    assert_eq!(
        payload["final"],
        serde_json::json!(["done", "cancelled", "archived"])
    );
}

#[test]
fn task_json_carries_allowed_moves_for_the_user_actor() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;
    let task = fixture.tasks().into_iter().next().unwrap();

    let response = http(
        daemon.port,
        "GET",
        &format!("/api/tasks/{slug}/{}", task.id),
        None,
    )
    .expect("get");
    assert_eq!(response.status, 200, "{}", response.body);
    let payload = response.json();
    // The task starts in todo: backlog and cancelled are the user-reachable moves.
    let moves: Vec<&str> = payload["allowedMoves"]
        .as_array()
        .expect("allowedMoves array")
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    assert!(moves.contains(&"backlog"), "{moves:?}");
    assert!(moves.contains(&"cancelled"), "{moves:?}");
    assert!(
        !moves.contains(&"in_progress"),
        "system-only move is absent: {moves:?}"
    );
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

    // It is on disk (the CLI sees it) and in the listing (--all: it lands in backlog).
    let list = cli(&fixture, &["list", "--all", "--json"]);
    let payload: serde_json::Value = serde_json::from_slice(&list.stdout).unwrap();
    assert!(
        payload["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|task| task["title"] == "from the UI")
    );

    let listed = http(
        daemon.port,
        "GET",
        &format!("/api/projects/{slug}/tasks"),
        None,
    )
    .expect("list");
    assert_eq!(listed.status, 200);
    assert_eq!(
        listed.json()["tasks"].as_array().unwrap().len(),
        3,
        "{}",
        listed.body
    );
    assert!(listed.json()["problems"].as_array().unwrap().is_empty());

    // `ready` filtering works through the API too.
    let ready = http(
        daemon.port,
        "GET",
        &format!("/api/projects/{slug}/tasks?ready=true"),
        None,
    )
    .expect("ready");
    // Backlog tasks are never ready; the two todo tasks are.
    assert_eq!(ready.json()["tasks"].as_array().unwrap().len(), 2);
}

#[test]
fn api_create_without_a_title_needs_a_body() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;

    // A body without a title is fine: the title stays empty and the UI gets
    // the derived display title.
    let created = http(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/create"),
        Some(r#"{"body":"the body carries the point"}"#),
    )
    .expect("create without title");
    assert_eq!(created.status, 200, "{}", created.body);
    let created = created.json();
    assert_eq!(created["title"], "");
    assert_eq!(created["displayTitle"], "the body carries the point");

    // Neither title nor body is a 400 with the rule message.
    let refused = http(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/create"),
        Some(r#"{}"#),
    )
    .expect("create with neither");
    assert_eq!(refused.status, 400, "{}", refused.body);
    assert_eq!(refused.json()["kind"], "usage");
    assert!(
        refused.json()["error"]
            .as_str()
            .unwrap()
            .contains("a task needs a title or a description")
    );

    // An edit that would leave neither is a 400 too.
    let id = created["id"].as_str().unwrap().to_string();
    let cleared = http(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/{id}/edit"),
        Some(r#"{"body":""}"#),
    )
    .expect("edit body away");
    assert_eq!(cleared.status, 400, "{}", cleared.body);
}

#[test]
fn sse_pushes_a_revision_after_a_cli_write() {
    if !watching_enabled() {
        eprintln!("skipped: KB_TEST_NO_WATCH=1 (no file watcher)");
        return;
    }
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
    let events: Vec<&String> = lines
        .iter()
        .filter(|line| line.starts_with("data:"))
        .collect();
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

/// The daemon must still push revisions when UNIPI_KANBOARD_HOME contains a
/// symlink: watchers may report the watched spelling (Linux) or the canonical
/// spelling (macOS /var → /private/var), so both must resolve to a slug.
#[cfg(unix)]
#[test]
fn sse_pushes_a_revision_when_home_is_a_symlink() {
    if !watching_enabled() {
        eprintln!("skipped: KB_TEST_NO_WATCH=1 (no file watcher)");
        return;
    }
    let fixture = fixture_with_tasks();
    // The link lives inside the fixture's own temp root — /tmp is shared.
    let link = fixture.root().join("linked-home");
    std::os::unix::fs::symlink(&fixture.layout.home, &link).unwrap();

    let daemon = Daemon::start_with_home(&fixture, &["--idle-secs", "120"], &link);
    let slug = fixture.project.slug.clone();
    let port = daemon.port;

    let reader = std::thread::spawn(move || read_sse(port, &format!("/events?project={slug}"), 4));
    std::thread::sleep(Duration::from_millis(600));
    let task = fixture.tasks().into_iter().next().unwrap();
    // Write through the real (non-symlink) path — the event still has to land.
    let note = cli(&fixture, &["note", &task.id, "through a symlinked home"]);
    assert!(note.status.success());

    let lines = reader.join().expect("sse reader");
    let bumped = lines
        .iter()
        .filter(|line| line.starts_with("data:"))
        .filter_map(|line| line.trim_start_matches("data:").trim().parse::<u64>().ok())
        .any(|revision| revision >= 1);
    assert!(
        bumped,
        "no bumped revision through a symlinked home: {lines:?}"
    );
}

#[test]
fn idle_shutdown_removes_daemon_json() {
    let fixture = fixture_with_tasks();
    // Idle window of 3s: the daemon starts, then shuts itself down with no
    // clients connected and no requests.
    let mut command = std::process::Command::new(common::bin());
    command
        .args(["serve", "--port", "0", "--idle-secs", "3"])
        .env("UNIPI_KANBOARD_HOME", fixture.layout.home.as_os_str())
        .current_dir(fixture.root())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if std::env::var("KB_TEST_NO_WATCH").as_deref() == Ok("1") {
        command.env("UNIPI_KANBOARD_NO_WATCH", "1");
    }
    let mut child = command.spawn().expect("spawn serve");

    let info_path = fixture.layout.home.join("daemon.json");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && !info_path.exists() {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(info_path.exists(), "daemon.json was written");

    let exited = child.wait().expect("wait");
    assert!(
        exited.success(),
        "idle shutdown is a clean exit: {exited:?}"
    );
    assert!(
        !info_path.exists(),
        "daemon.json is removed on idle shutdown"
    );
}

#[test]
fn a_corrupt_task_file_shows_up_as_a_repair_banner_and_keeps_the_board_alive() {
    let fixture = fixture_with_tasks();
    let task = fixture.tasks().into_iter().next().unwrap();
    let path = fixture.layout.task_path(&fixture.project.slug, &task.id);
    let text = std::fs::read_to_string(&path)
        .unwrap()
        .replace("status: todo", "status: nonsense");
    std::fs::write(&path, text).unwrap();

    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;

    // The API keeps serving the readable tasks and names the problem.
    let listed = http(
        daemon.port,
        "GET",
        &format!("/api/projects/{slug}/tasks"),
        None,
    )
    .expect("list");
    assert_eq!(listed.status, 200, "{}", listed.body);
    assert_eq!(listed.json()["tasks"].as_array().unwrap().len(), 1);
    let problem = &listed.json()["problems"][0];
    assert_eq!(problem["line"], 4);
    assert!(
        problem["error"]
            .as_str()
            .unwrap()
            .contains("unknown status")
    );

    // The SPA shell is served for any board path (the repair banner is rendered
    // client-side from the same `problems` payload; tests/ui.mjs exercises it).
    let board = http(daemon.port, "GET", &format!("/p/{slug}"), None).expect("board");
    assert_eq!(board.status, 200);
    assert!(
        board.body.to_ascii_lowercase().contains("<!doctype html>"),
        "spa shell"
    );
    assert!(board.body.contains("/assets/"), "hashed bundle referenced");
}

#[test]
fn writing_to_a_corrupt_file_via_the_api_is_refused() {
    let fixture = fixture_with_tasks();
    let task = fixture.tasks().into_iter().next().unwrap();
    let path = fixture.layout.task_path(&fixture.project.slug, &task.id);
    let text = std::fs::read_to_string(&path)
        .unwrap()
        .replace("status: todo", "status: nonsense");
    std::fs::write(&path, text).unwrap();

    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;
    let response = http(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/{}/note", task.id),
        Some(r#"{"text":"hello"}"#),
    )
    .expect("note");
    assert_eq!(response.status, 400);
    let error = response.json()["error"].as_str().unwrap().to_string();
    assert!(error.contains("is unreadable"), "{error}");
    assert!(error.contains("validate --fix"), "{error}");
    assert!(
        !error.contains("--comment"),
        "UI messages keep CLI flags out"
    );
}

#[test]
fn ui_pages_render_the_board_and_the_drawer() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;

    // Any UI path returns the SPA shell, and the hashed bundle is served.
    let picker = http(daemon.port, "GET", "/", None).expect("picker");
    assert_eq!(picker.status, 200);
    assert!(picker.body.to_ascii_lowercase().contains("<!doctype html>"));
    // The embedded UI is the UniPi app's web build (UNI-117) or, as a
    // fallback, the deprecated kanboard UI — both are a hashed Vite bundle.
    let bundle = picker
        .body
        .split("src=\"")
        .filter_map(|rest| rest.split('"').next())
        .find(|src| src.starts_with("/assets/") && src.ends_with(".js"))
        .expect("the shell references its JS bundle");
    let asset = http(daemon.port, "GET", bundle, None).expect("bundle");
    assert_eq!(asset.status, 200, "bundle {bundle} is embedded");
    assert!(asset.body.contains("kanboard") || asset.body.len() > 1000);
    let bundle_body = asset.body.clone();

    let board = http(daemon.port, "GET", &format!("/p/{slug}"), None).expect("board");
    assert_eq!(board.status, 200);
    assert!(
        board.body.to_ascii_lowercase().contains("<!doctype html>"),
        "deep link serves the shell"
    );

    // Lane/panel behaviour is client-side: packages/../tests/ui.mjs drives it.
    let tasks = http(
        daemon.port,
        "GET",
        &format!("/api/projects/{slug}/tasks"),
        None,
    )
    .expect("tasks");
    assert_eq!(tasks.status, 200);
    assert!(!tasks.json()["tasks"].as_array().unwrap().is_empty());

    // The hashed CSS bundle is embedded too (no build step at runtime).
    let css_href = picker
        .body
        .split("href=\"")
        .filter_map(|rest| rest.split('"').next())
        .find(|href| href.ends_with(".css"))
        .expect("the shell references its stylesheet");
    let css = http(daemon.port, "GET", css_href, None).expect("css");
    assert_eq!(css.status, 200, "stylesheet {css_href} is embedded");
    if env!("KANBOARD_UI_SOURCE") == "legacy" {
        // The old UI themes itself (data-theme + a matchMedia default).
        assert!(
            css.body.contains("data-theme"),
            "the stylesheet themes both modes"
        );
        assert!(
            bundle_body.contains("prefers-color-scheme"),
            "prefers-color-scheme drives the default"
        );
    } else {
        // The app web build: the board talks to this daemon's own API.
        assert!(bundle_body.contains("/api/"), "the app bundle calls the daemon API");
    }

    // A missing hashed asset is a real 404 (never the HTML shell).
    let missing = http(daemon.port, "GET", "/assets/nope-123.js", None).expect("missing asset");
    assert_eq!(missing.status, 404);
    // Hashed assets are cacheable forever; the shell always revalidates.
    assert_eq!(
        common::response_header(&asset, "cache-control").as_deref(),
        Some("public, max-age=31536000, immutable")
    );
    assert_eq!(
        common::response_header(&picker, "cache-control").as_deref(),
        Some("no-cache")
    );
    // /api/health reports which UI is embedded.
    let health = http(daemon.port, "GET", "/api/health", None).expect("health");
    assert_eq!(
        health.json()["ui"]["source"].as_str(),
        Some(env!("KANBOARD_UI_SOURCE"))
    );
}

#[test]
fn the_ui_never_claims_tasks() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;
    let task = fixture.tasks().into_iter().next().unwrap();

    // There is no endpoint that claims work: todo → in_progress is an agent
    // session's `start` (or system), and the API has no claim route at all.
    let response = http(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/{}/claim", task.id),
        Some("{}"),
    )
    .expect("claim attempt");
    assert!(
        response.status >= 400,
        "no claim endpoint: {}",
        response.status
    );

    // Nor can it set a run block.
    let response = http(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/{}/set-run", task.id),
        Some(r#"{"mode":"direct"}"#),
    )
    .expect("set-run attempt");
    assert!(
        response.status >= 400,
        "no set-run endpoint: {}",
        response.status
    );
}

// ─── remote access (token gate) ─────────────────────────────────────────────

fn daemon_info(fixture: &Fixture) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(fixture.layout.home.join("daemon.json")).unwrap())
        .unwrap()
}

/// A request with an explicit extra header.
fn http_with(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
    extra: &[(&str, &str)],
) -> common::HttpResponse {
    common::http_with_headers(port, method, path, body, extra).expect("request")
}

#[test]
fn a_remote_bind_requires_the_token() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--host", "0.0.0.0", "--idle-secs", "120"]);
    let info = daemon_info(&fixture);
    assert_eq!(info["host"], "0.0.0.0");
    let token = info["token"]
        .as_str()
        .expect("a token for a remote bind")
        .to_string();
    assert!(token.len() >= 40, "long random token: {token}");

    // No token → 401 with the instruction page.
    let response = http(daemon.port, "GET", "/", None).expect("no token");
    assert_eq!(response.status, 401, "{}", response.body);
    assert!(
        response.body.contains("unipi:kanboard open"),
        "{}",
        response.body
    );
    let response = http(daemon.port, "GET", "/api/projects", None).expect("api without token");
    assert_eq!(response.status, 401);

    // Health is deliberately open (no pid off-loopback).
    let health = http(daemon.port, "GET", "/api/health", None).expect("health without token");
    assert_eq!(health.status, 200, "{}", health.body);
    assert_eq!(health.json()["pid"], serde_json::Value::Null);

    // Wrong token → 401.
    let response = http(daemon.port, "GET", "/?t=wrong", None).expect("wrong token");
    assert_eq!(response.status, 401);

    // Header token → 200.
    let response = http_with(
        daemon.port,
        "GET",
        "/",
        None,
        &[("authorization", &format!("Bearer {token}"))],
    );
    assert_eq!(response.status, 200, "{}", response.body);

    // Query token → 303 + cookie, then the cookie alone works.
    let response = http(daemon.port, "GET", &format!("/?t={token}"), None).expect("query token");
    assert_eq!(response.status, 303, "{}", response.body);
    let location = common::response_header(&response, "location").unwrap_or_default();
    assert_eq!(location, "/", "redirect strips the token");
    let cookie = common::response_header(&response, "set-cookie").unwrap_or_default();
    assert!(cookie.starts_with(&format!("kb_token={token}")), "{cookie}");
    assert!(
        cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"),
        "{cookie}"
    );

    let response = http_with(daemon.port, "GET", "/", None, &[("cookie", &cookie)]);
    assert_eq!(response.status, 200, "cookie is enough");
}

#[test]
fn a_loopback_bind_needs_no_token() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let info = daemon_info(&fixture);
    assert_eq!(info["host"], "127.0.0.1");
    assert!(
        info.get("token").is_none() || info["token"].is_null(),
        "no token on loopback"
    );
    let response = http(daemon.port, "GET", "/", None).expect("open board");
    assert_eq!(response.status, 200);
    let response = http(daemon.port, "GET", "/api/projects", None).expect("open api");
    assert_eq!(response.status, 200);
}

#[test]
fn health_hides_the_pid_when_the_host_is_not_loopback() {
    let fixture = fixture_with_tasks();
    let local = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let payload = http(local.port, "GET", "/api/health", None).unwrap().json();
    assert!(payload["pid"].as_u64().is_some(), "loopback keeps the pid");
    drop(local);

    let fixture = Fixture::new();
    let remote = Daemon::start(&fixture, &["--host", "0.0.0.0", "--idle-secs", "120"]);
    let info = daemon_info(&fixture);
    let token = info["token"].as_str().unwrap();
    let payload = http_with(
        remote.port,
        "GET",
        "/api/health",
        None,
        &[("authorization", &format!("Bearer {token}"))],
    )
    .json();
    assert!(payload["ok"].as_bool().unwrap());
    assert_eq!(
        payload["pid"],
        serde_json::Value::Null,
        "no pid off-loopback"
    );
}

#[test]
fn a_cross_site_post_is_refused_in_both_modes() {
    let fixture = fixture_with_tasks();
    let task = fixture.tasks().into_iter().next().unwrap();
    let slug = fixture.project.slug.clone();

    for extra in [Vec::new(), vec!["--host", "0.0.0.0"]] {
        let mut args = vec!["--idle-secs", "120"];
        args.extend(extra.iter().copied());
        let daemon = Daemon::start(&fixture, &args);
        let token = daemon_info(&fixture)["token"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let auth = if token.is_empty() {
            String::new()
        } else {
            format!("Bearer {token}")
        };
        let mut headers: Vec<(&str, &str)> =
            vec![("origin", "http://evil.example"), ("host", "127.0.0.1")];
        if !auth.is_empty() {
            headers.push(("authorization", &auth));
        }
        let response = http_with(
            daemon.port,
            "POST",
            &format!("/api/tasks/{slug}/{}/note", task.id),
            Some(r#"{"text":"csrf"}"#),
            &headers,
        );
        assert_eq!(
            response.status, 403,
            "cross-site POST refused: {}",
            response.body
        );

        // A same-origin POST still works (the Origin matches our Host).
        let origin = format!("http://127.0.0.1:{}", daemon.port);
        let host = format!("127.0.0.1:{}", daemon.port);
        let mut ok_headers: Vec<(&str, &str)> = vec![("origin", &origin), ("host", &host)];
        if !auth.is_empty() {
            ok_headers.push(("authorization", &auth));
        }
        let response = http_with(
            daemon.port,
            "POST",
            &format!("/api/tasks/{slug}/{}/note", task.id),
            Some(r#"{"text":"same origin"}"#),
            &ok_headers,
        );
        assert_eq!(response.status, 200, "{}", response.body);
        drop(daemon);
    }
}

#[test]
fn a_daemon_on_another_binding_reports_the_change() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    // Asking for a different host/port while one runs → alreadyRunning + the flag.
    let output = cli(
        &fixture,
        &["serve", "--host", "0.0.0.0", "--port", "37473", "--json"],
    );
    assert_eq!(output.status.code(), Some(0));
    let payload: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["alreadyRunning"], true);
    assert_eq!(payload["bindingChanged"], true);
    assert_eq!(payload["requested"]["host"], "0.0.0.0");
    assert_eq!(payload["daemon"]["host"], "127.0.0.1");
    // Same binding → no change reported.
    let output = cli(&fixture, &["serve", "--port", "0", "--json"]);
    let payload: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["bindingChanged"], false, "{payload}");
    drop(daemon);
}

#[test]
fn project_summaries_carry_counts_running_and_updated_at() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let payload = http(daemon.port, "GET", "/api/projects", None)
        .unwrap()
        .json();
    let project = &payload.as_array().expect("array")[0];
    assert_eq!(project["total"], 2);
    assert_eq!(project["counts"]["todo"], 2);
    assert_eq!(project["running"], 0, "no run blocks yet");
    let updated = project["updatedAt"]
        .as_str()
        .expect("updatedAt is set when tasks exist");
    assert!(
        chrono::DateTime::parse_from_rfc3339(updated).is_ok(),
        "{updated}"
    );

    let first = fixture.tasks().into_iter().next().expect("a task");
    let claimed = cli(
        &fixture,
        &[
            "start",
            &first.id,
            "--session",
            "s1",
            "--pid",
            &common::alive_pid().to_string(),
            "--json",
        ],
    );
    assert!(
        claimed.status.success(),
        "{}",
        String::from_utf8_lossy(&claimed.stderr)
    );
    let payload = http(daemon.port, "GET", "/api/projects", None)
        .unwrap()
        .json();
    assert_eq!(payload[0]["running"], 1, "a claimed task counts as running");
}

#[test]
fn stop_is_not_held_up_by_an_open_event_stream() {
    // A browser tab keeps /events open forever; graceful shutdown must still finish.
    let fixture = fixture_with_tasks();
    let mut daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", daemon.port)).unwrap();
    use std::io::Write;
    write!(
        stream,
        "GET /events?project={} HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n",
        fixture.project.slug
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(300));

    let started = Instant::now();
    let output = cli(&fixture, &["stop", "--timeout", "8", "--json"]);
    let payload: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json");
    assert_eq!(payload["stopped"], true, "{payload}");
    assert!(
        started.elapsed() < Duration::from_secs(6),
        "stopped in {:?}",
        started.elapsed()
    );
    let _ = daemon.child.wait();
    drop(stream);
}

#[test]
fn require_auth_gates_a_loopback_bind() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120", "--require-auth"]);

    // Without the token → 401 on every API route.
    let response = http(daemon.port, "GET", "/api/projects", None).expect("get");
    assert_eq!(response.status, 401);

    // With the token from daemon.json → 200.
    let info: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fixture.layout.home.join("daemon.json")).unwrap(),
    )
    .unwrap();
    let token = info["token"]
        .as_str()
        .expect("token on loopback require-auth");
    let auth = format!("Bearer {token}");
    let response = common::http_with_headers(
        daemon.port,
        "GET",
        "/api/projects",
        None,
        &[("authorization", auth.as_str())],
    )
    .expect("authed get");
    assert_eq!(response.status, 200);
}

#[test]
fn keep_token_survives_restarts_and_rotates() {
    let fixture = fixture_with_tasks();
    let daemon1 = Daemon::start(
        &fixture,
        &["--idle-secs", "120", "--keep-token", "--require-auth"],
    );
    let info1: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fixture.layout.home.join("daemon.json")).unwrap(),
    )
    .unwrap();
    let token1 = info1["token"].as_str().unwrap().to_string();
    drop(daemon1);
    std::thread::sleep(std::time::Duration::from_millis(300));

    let daemon2 = Daemon::start(
        &fixture,
        &["--idle-secs", "120", "--keep-token", "--require-auth"],
    );
    let info2: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fixture.layout.home.join("daemon.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        info2["token"].as_str().unwrap(),
        token1,
        "same token across restarts"
    );
    drop(daemon2);
    std::thread::sleep(std::time::Duration::from_millis(300));

    // rotate-token drops the file; the next start mints a fresh one.
    let output = common::cli(&fixture, &["rotate-token", "--json"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!fixture.layout.home.join("token").exists());

    let daemon3 = Daemon::start(
        &fixture,
        &["--idle-secs", "120", "--keep-token", "--require-auth"],
    );
    let info3: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fixture.layout.home.join("daemon.json")).unwrap(),
    )
    .unwrap();
    assert_ne!(
        info3["token"].as_str().unwrap(),
        token1,
        "fresh token after rotate"
    );
    drop(daemon3);
}

#[test]
fn settings_set_round_trip_and_agent_refusal() {
    let fixture = fixture_with_tasks();

    let output = common::cli(
        &fixture,
        &[
            "settings",
            "set",
            "pi-command",
            r#"["/usr/bin/pi"]"#,
            "--json",
        ],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["piCommand"], serde_json::json!(["/usr/bin/pi"]));

    let output = common::cli(&fixture, &["settings", "show", "--json"]);
    assert!(output.status.success());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["piCommand"], serde_json::json!(["/usr/bin/pi"]));
    assert!(value.get("queueMax").is_none(), "the queue died with the runner");
    assert_eq!(value["maxSessions"], 2);

    // The legacy agent-command key is refused outright.
    let output = common::cli(
        &fixture,
        &["settings", "set", "agent-command", "unipi -p", "--json"],
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("pi-command"));

    // Empty argv clears.
    let output = common::cli(&fixture, &["settings", "set", "pi-command", "[]", "--json"]);
    assert!(output.status.success());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["piCommand"], serde_json::json!([]));

    // actor=agent cannot write settings or rotate the token.
    let output = common::cli(
        &fixture,
        &["settings", "set", "pi-command", "[]", "--actor", "agent"],
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("user/system only"));
    let output = common::cli(&fixture, &["rotate-token", "--actor", "agent"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("user/system only"));
}

/// UNI-57: the undo endpoint — token issued only for hard-to-reverse moves,
/// consumed once, scoped to its task, rejected after any intervening change.
#[test]
fn undo_token_is_issued_once_scoped_and_refuses_stale_tasks() {
    let fixture = Fixture::new();
    let review = fixture.add_with("review me", Status::Todo, Priority::None, &[]);
    fixture.start(&review.id, "s", common::alive_pid());
    commands::release(
        &fixture.layout,
        fixture.project.clone(),
        &review.id,
        Status::InReview,
        "ready",
        ChainGate::InReview,
        fixture.common.now,
    )
    .unwrap();
    let cancel = fixture.add_with("cancel me", Status::Todo, Priority::None, &[]);
    let routine = fixture.add_with("routine", Status::Backlog, Priority::None, &[]);
    let slug = &fixture.project.slug;
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let post = |path: &str, body: String| {
        http(daemon.port, "POST", path, Some(&body)).expect("http")
    };

    // A routine, reversible move carries no token.
    let response = post(
        &format!("/api/tasks/{slug}/{}/move", routine.id),
        r#"{"status":"todo"}"#.into(),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    assert!(response.json().get("undoToken").is_none(), "{}", response.body);

    // in_review → done carries one; undo restores in_review; reuse refuses.
    let response = post(
        &format!("/api/tasks/{slug}/{}/move", review.id),
        r#"{"status":"done"}"#.into(),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let token = response.json()["undoToken"].as_str().expect("undoToken").to_string();
    let undone = post(
        &format!("/api/tasks/{slug}/{}/undo", review.id),
        format!(r#"{{"token":"{token}"}}"#),
    );
    assert_eq!(undone.status, 200, "{}", undone.body);
    assert_eq!(undone.json()["status"], "in_review");
    let reused = post(
        &format!("/api/tasks/{slug}/{}/undo", review.id),
        format!(r#"{{"token":"{token}"}}"#),
    );
    assert_eq!(reused.status, 409, "{}", reused.body);

    // A cancellation is undoable too — and scoped: the token refuses on a
    // different task's path.
    let response = post(
        &format!("/api/tasks/{slug}/{}/move", cancel.id),
        r#"{"status":"cancelled"}"#.into(),
    );
    let token = response.json()["undoToken"].as_str().expect("undoToken").to_string();
    let cross = post(
        &format!("/api/tasks/{slug}/{}/undo", review.id),
        format!(r#"{{"token":"{token}"}}"#),
    );
    assert_eq!(cross.status, 409, "{}", cross.body);
    let undone = post(
        &format!("/api/tasks/{slug}/{}/undo", cancel.id),
        format!(r#"{{"token":"{token}"}}"#),
    );
    assert_eq!(undone.status, 200, "{}", undone.body);
    assert_eq!(undone.json()["status"], "todo");

    // An intervening change kills the undo even within the same second: the
    // whole task, activity included, must still match the post-move state.
    let response = post(
        &format!("/api/tasks/{slug}/{}/move", review.id),
        r#"{"status":"done"}"#.into(),
    );
    let token = response.json()["undoToken"].as_str().expect("undoToken").to_string();
    let noted = post(
        &format!("/api/tasks/{slug}/{}/note", review.id),
        r#"{"text":"a change after the move"}"#.into(),
    );
    assert_eq!(noted.status, 200);
    let stale = post(
        &format!("/api/tasks/{slug}/{}/undo", review.id),
        format!(r#"{{"token":"{token}"}}"#),
    );
    assert_eq!(stale.status, 409, "{}", stale.body);
    assert!(stale.json()["error"].as_str().unwrap().contains("changed since"), "{}", stale.body);

    // Unknown tokens refuse.
    let unknown = post(
        &format!("/api/tasks/{slug}/{}/undo", review.id),
        r#"{"token":"deadbeefdeadbeefdeadbeefdeadbeef"}"#.into(),
    );
    assert_eq!(unknown.status, 409, "{}", unknown.body);
}

/// UNI-57: expired tokens refuse with an expiry message. The TTL override is
/// passed to the daemon child only — never the test process, where a global
/// would leak into parallel tests.
#[test]
fn undo_tokens_expire() {
    let fixture = Fixture::new();
    let task = fixture.add_with("expire me", Status::Todo, Priority::None, &[]);
    let slug = &fixture.project.slug;
    let daemon = Daemon::start_with_envs(
        &fixture,
        &["--idle-secs", "120"],
        &[("UNIPI_KANBOARD_UNDO_TTL_SECS", "1")],
    );
    let response = http(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/{}/move", task.id),
        Some(r#"{"status":"cancelled"}"#),
    )
    .expect("move");
    let token = response.json()["undoToken"].as_str().expect("undoToken").to_string();
    std::thread::sleep(Duration::from_millis(1300));
    let undone = http(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/{}/undo", task.id),
        Some(&format!(r#"{{"token":"{token}"}}"#)),
    )
    .expect("undo");
    assert_eq!(undone.status, 409, "{}", undone.body);
    assert!(
        undone.json()["error"].as_str().unwrap().contains("expired"),
        "{}",
        undone.body
    );
}

/// UNI-57 rework: API writes carry their own revision bumps, so SSE push works
/// even with the file watcher off (UNIPI_KANBOARD_NO_WATCH on the daemon
/// child). This test never skips — it runs with the watcher forcibly off.
#[test]
fn sse_pushes_on_api_move_and_undo_without_the_watcher() {
    let fixture = Fixture::new();
    let task = fixture.add_with("sse undo", Status::Todo, Priority::None, &[]);
    fixture.start(&task.id, "s", common::alive_pid());
    commands::release(
        &fixture.layout,
        fixture.project.clone(),
        &task.id,
        Status::InReview,
        "ready",
        ChainGate::InReview,
        fixture.common.now,
    )
    .unwrap();
    let slug = fixture.project.slug.clone();
    let daemon = Daemon::start_with_envs(
        &fixture,
        &["--idle-secs", "120"],
        &[("UNIPI_KANBOARD_NO_WATCH", "1")],
    );
    let port = daemon.port;
    let value = slug.clone();
    let reader = std::thread::spawn(move || read_sse(port, &format!("/events?project={value}"), 5));
    std::thread::sleep(Duration::from_millis(600));

    let moved = http(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/{}/move", task.id),
        Some(r#"{"status":"done"}"#),
    )
    .expect("move");
    assert_eq!(moved.status, 200, "{}", moved.body);
    let token = moved.json()["undoToken"].as_str().expect("undoToken").to_string();
    std::thread::sleep(Duration::from_millis(700));
    let undone = http(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/{}/undo", task.id),
        Some(&format!(r#"{{"token":"{token}"}}"#)),
    )
    .expect("undo");
    assert_eq!(undone.status, 200, "{}", undone.body);

    let lines = reader.join().expect("sse reader");
    let revisions: Vec<u64> = lines
        .iter()
        .filter(|line| line.starts_with("data:"))
        .filter_map(|line| line.trim_start_matches("data:").trim().parse::<u64>().ok())
        .collect();
    let bump_count = revisions.iter().filter(|revision| **revision >= 1).count();
    assert!(bump_count >= 2, "expected revisions for move AND undo, got {revisions:?}");
}

/// UNI-51: one endpoint lists every claimed task across all projects.
#[test]
fn running_lists_claimed_tasks_across_projects() {
    let fixture = Fixture::new();
    let first = fixture.add_with("claimed here", Status::Todo, Priority::None, &[]);
    fixture.start(&first.id, "session-a", common::alive_pid());
    let slug = &fixture.project.slug;
    // A second project with its own claimed task.
    let other_root = fixture.root().join("other");
    std::fs::create_dir_all(&other_root).unwrap();
    let other = Project::create(&fixture.layout, &other_root, Some("Other"), Some("OTH")).unwrap();
    let second_value = commands::add(
        &fixture.layout,
        other.clone(),
        &fixture.common,
        "claimed there",
        None,
        Some(Status::Todo),
        Priority::None,
        &[],
        &[],
        &[],
        true,
    )
    .unwrap();
    let second = second_value["id"].as_str().unwrap().to_string();
    let host = commands::hostname();
    commands::start(
        &fixture.layout,
        other.clone(),
        ChainGate::InReview,
        &second,
        &commands::StartArgs { session: "session-b", pid: common::alive_pid(), host: &host },
        fixture.common.now,
    )
    .unwrap();

    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let response = http(daemon.port, "GET", "/api/running", None).expect("running");
    assert_eq!(response.status, 200, "{}", response.body);
    let payload = response.json();
    let items = payload["running"].as_array().expect("array");
    assert_eq!(items.len(), 2, "{}", response.body);
    let slugs: Vec<&str> = items.iter().map(|item| item["slug"].as_str().unwrap()).collect();
    assert!(slugs.contains(&slug.as_str()) && slugs.contains(&other.slug.as_str()), "{slugs:?}");
    for item in items {
        assert!(item["project"].is_string());
        assert!(!item["task"]["run"].is_null());
        assert!(item["task"]["id"].is_string());
    }
}

/// UNI-59/60 over the API: create takes labels; the creator is stamped from
/// the (always-user) API actor and edit refuses to change it.
#[test]
fn api_create_stamps_creator_and_edit_rejects_creator_changes() {
    let fixture = Fixture::new();
    let slug = &fixture.project.slug;
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let created = http(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/create"),
        Some(r#"{"title":"with labels","labels":["web","web"," ui "]}"#),
    )
    .expect("create");
    assert_eq!(created.status, 200, "{}", created.body);
    let task = created.json();
    assert_eq!(task["creator"], "user");
    let labels: Vec<&str> = task["labels"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
    assert_eq!(labels, vec!["web", "ui"]);

    // Creator changes are refused outright (UNI-59: immutable edit API).
    let edit = http(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/{}/edit", task["id"].as_str().unwrap()),
        Some(r#"{"creator":"agent","title":"hijack"}"#),
    )
    .expect("edit");
    assert_eq!(edit.status, 400, "{}", edit.body);
    assert!(
        edit.json()["error"].as_str().unwrap().contains("cannot be changed"),
        "{}",
        edit.body
    );
    // The refused edit changed nothing.
    let shown = http(
        daemon.port,
        "GET",
        &format!("/api/tasks/{slug}/{}", task["id"].as_str().unwrap()),
        None,
    )
    .unwrap();
    assert_eq!(shown.json()["title"], "with labels");
    assert_eq!(shown.json()["creator"], "user");
}

/// UNI-67: the dashboard endpoint — archived projects excluded, inbox ordered
/// oldest-waiting-first with excerpts, upNext filtered to ready todos by
/// priority, activity window/order, doneAt and reviewWaits windows.
#[test]
fn dashboard_endpoint_sections_ordering_and_windows() {
    use kanboard::model::Priority;

    let fixture = Fixture::new();
    let now = fixture.common.now;

    // Old review: entered in_review three days ago and still waiting.
    let old_review = fixture.add_with("old review", Status::Todo, Priority::None, &[]);
    fixture.start(&old_review.id, "s", common::alive_pid());
    kanboard::commands::finish(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        &old_review.id,
        "s",
        "fix login flow\n\nscreenshots ![x](att:1) attached",
        &[],
        now - chrono::Duration::days(3),
    )
    .unwrap();

    // Blocked: released one day ago with the agent's question as the comment.
    let blocked = fixture.add_with("blocked work", Status::Todo, Priority::None, &[]);
    fixture.start(&blocked.id, "s", common::alive_pid());
    kanboard::commands::release(
        &fixture.layout,
        fixture.project.clone(),
        &blocked.id,
        Status::Blocked,
        "need the retry fixture fixed before I can continue",
        ChainGate::InReview,
        now - chrono::Duration::days(1),
    )
    .unwrap();

    // Fresh review: entered in_review just now.
    let fresh_review = fixture.add_with("fresh review", Status::Todo, Priority::None, &[]);
    fixture.start(&fresh_review.id, "s", common::alive_pid());
    kanboard::commands::finish(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        &fresh_review.id,
        "s",
        "just finished\nsecond line",
        &[],
        now,
    )
    .unwrap();

    // Done cycle: in_review then done — one completed review wait + doneAt.
    let done = fixture.add_with("done cycle", Status::Todo, Priority::None, &[]);
    fixture.start(&done.id, "s", common::alive_pid());
    kanboard::commands::finish(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        &done.id,
        "s",
        "cycle summary",
        &[],
        now,
    )
    .unwrap();
    fixture.move_to(&done.id, Status::Done);

    // Ready todos across priorities; one todo parked behind a Backlog dep
    // (never ready) and nine extra urgents to prove the cap.
    fixture.add_labeled("urgent next", Status::Todo, Priority::Urgent, &[], &[]);
    fixture.add_labeled("high next", Status::Todo, Priority::High, &[], &[]);
    fixture.add_labeled("low next", Status::Todo, Priority::Low, &[], &[]);
    let parked = fixture.add("parked parent");
    fixture.add_labeled("not ready", Status::Todo, Priority::Urgent, std::slice::from_ref(&parked.id), &[]);
    for index in 0..6 {
        fixture.add_labeled(&format!("flood {index}"), Status::Todo, Priority::Urgent, &[], &[]);
    }

    // An archived project with a waiting task must not appear anywhere.
    let other_root = fixture.root().join("archived-proj");
    std::fs::create_dir_all(&other_root).unwrap();
    let archived = Project::create(&fixture.layout, &other_root, Some("Archived Proj"), Some("ARP")).unwrap();
    commands::project_set_archived(&fixture.layout, &archived.slug, true).unwrap();

    let slug = &fixture.project.slug;
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let response = http(daemon.port, "GET", "/api/dashboard", None).expect("dashboard");
    assert_eq!(response.status, 200, "{}", response.body);
    let payload = response.json();
    assert!(payload["generatedAt"].is_string());

    // Inbox: oldest waiting first, archived excluded, excerpts derived.
    let inbox = payload["inbox"].as_array().unwrap();
    assert_eq!(inbox.len(), 3, "{}", payload);
    assert_eq!(inbox[0]["task"]["id"], old_review.id.as_str());
    assert_eq!(inbox[1]["task"]["id"], blocked.id.as_str());
    assert_eq!(inbox[2]["task"]["id"], fresh_review.id.as_str());
    let old_since = chrono::DateTime::parse_from_rfc3339(inbox[0]["waitingSince"].as_str().unwrap()).unwrap();
    assert_eq!(old_since.timestamp(), (now - chrono::Duration::days(3)).timestamp());
    assert_eq!(
        inbox[1]["excerpt"].as_str().unwrap(),
        "need the retry fixture fixed before I can continue"
    );
    assert_eq!(inbox[2]["excerpt"], "just finished");
    assert_eq!(inbox[0]["excerpt"], "fix login flow");
    assert!(inbox.iter().all(|item| item["slug"] == slug.as_str()));

    // upNext: ready todos only, urgent-first ordering, capped at 8.
    let up_next = payload["upNext"].as_array().unwrap();
    assert_eq!(up_next.len(), 8, "{}", payload);
    let titles: Vec<&str> = up_next
        .iter()
        .map(|item| item["task"]["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles[0], "urgent next", "{titles:?}");
    assert!(!titles.contains(&"not ready"), "{titles:?}");
    // Priority dominates lane order: `high next` was created before the
    // floods but sorts after every urgent; `low next` falls past the cap.
    assert_eq!(titles[7], "high next", "{titles:?}");

    // Activity: newest first, inside the 48h window (the 3-day-old finish is out).
    let activity = payload["activity"].as_array().unwrap();
    assert!(!activity.is_empty());
    // Newest first, and equal-second entries of one task keep chronological
    // per-task order (the seq tie-break the step trails rely on).
    let stamps: Vec<chrono::DateTime<chrono::Utc>> = activity
        .iter()
        .map(|entry| chrono::DateTime::parse_from_rfc3339(entry["at"].as_str().unwrap()).unwrap().into())
        .collect();
    assert!(now - stamps[0] <= chrono::Duration::hours(48));
    let same_task: Vec<&serde_json::Value> = activity
        .iter()
        .filter(|entry| entry["taskId"] == done.id.as_str())
        .collect();
    assert!(same_task.len() >= 3, "{same_task:?}");
    let texts: Vec<&str> = same_task.iter().map(|entry| entry["text"].as_str().unwrap()).collect();
    assert!(texts[0].starts_with("moved in_review → done"), "{texts:?}");
    assert!(texts.last().unwrap().starts_with("created in"), "{texts:?}");
    assert!(activity
        .iter()
        .any(|entry| entry["text"].as_str().unwrap().contains("need the retry fixture fixed")));

    // Throughput + review waits: one completed cycle today.
    let done_at = payload["doneAt"].as_array().unwrap();
    assert_eq!(done_at.len(), 1);
    let waits = payload["reviewWaits"].as_array().unwrap();
    assert_eq!(waits.len(), 1);
    assert!(waits[0].as_i64().unwrap() >= 0);

    // Per-project health: archived slug absent, counts right.
    let projects = payload["projects"].as_array().unwrap();
    assert_eq!(projects.len(), 1, "{}", payload);
    assert_eq!(projects[0]["slug"], slug.as_str());
    assert_eq!(projects[0]["review"], 2);
    assert_eq!(projects[0]["blocked"], 1);
    assert_eq!(projects[0]["ready"], 9, "ready todos minus the dep-blocked one");
}

/// UNI-67 rework: a done transition that an undo later reverted must not be
/// counted in doneAt — the dashboard never shows throughput that didn't stick.
#[test]
fn dashboard_done_at_excludes_reverted_done() {
    let fixture = Fixture::new();

    // Control: a done that stays done.
    let kept = fixture.add_with("kept done", Status::Todo, Priority::None, &[]);
    fixture.start(&kept.id, "s", common::alive_pid());
    kanboard::commands::finish(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        &kept.id,
        "s",
        "stays",
        &[],
        fixture.common.now,
    )
    .unwrap();
    fixture.move_to(&kept.id, Status::Done);

    // Reverted: moved to done, then undone back to in_review.
    let reverted = fixture.add_with("reverted done", Status::Todo, Priority::None, &[]);
    fixture.start(&reverted.id, "s", common::alive_pid());
    kanboard::commands::finish(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        &reverted.id,
        "s",
        "reverted",
        &[],
        fixture.common.now,
    )
    .unwrap();
    let (_, undo) = commands::move_task_undoable(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &reverted.id,
        Status::Done,
        None,
        &[],
    )
    .unwrap();
    let undo = undo.expect("in_review → done carries undo material");
    let restored = commands::undo_move(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &undo.after,
        undo.before,
    )
    .unwrap();
    assert_eq!(restored["status"], "in_review");

    // One ready todo so readyTotal has something to count.
    fixture.add_labeled("ready after rework", Status::Todo, Priority::None, &[], &[]);

    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let response = http(daemon.port, "GET", "/api/dashboard", None).expect("dashboard");
    let payload = response.json();
    let done_at = payload["doneAt"].as_array().unwrap();
    assert_eq!(done_at.len(), 1, "the reverted done must not count: {payload}");
    let kept_day = chrono::DateTime::parse_from_rfc3339(done_at[0].as_str().unwrap()).unwrap();
    assert_eq!(kept_day.timestamp(), fixture.common.now.timestamp());
    // readyTotal counts every ready todo, uncapped.
    assert_eq!(payload["readyTotal"], 1, "{}", payload);
    assert_eq!(payload["upNext"].as_array().unwrap().len(), 1);
}
