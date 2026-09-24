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
fn rules_endpoint_lists_the_transition_table_for_the_user_actor() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);

    let response = http(daemon.port, "GET", "/api/rules", None).expect("rules");
    assert_eq!(response.status, 200, "{}", response.body);
    let payload = response.json();

    // in_review → todo is a user move that needs a comment (the rework note).
    let allowed: Vec<&str> = payload["allowedMoves"]["in_review"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    assert!(allowed.contains(&"todo"), "{allowed:?}");
    assert_eq!(
        payload["commentRequired"]["in_review"]["todo"],
        "rework note",
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

    assert_eq!(payload["final"], serde_json::json!(["done", "cancelled", "archived"]));
}

#[test]
fn task_json_carries_allowed_moves_for_the_user_actor() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;
    let task = fixture.tasks().into_iter().next().unwrap();

    let response = http(daemon.port, "GET", &format!("/api/tasks/{slug}/{}", task.id), None).expect("get");
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
    assert!(!moves.contains(&"in_progress"), "system-only move is absent: {moves:?}");
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
    let payload: serde_json::Value = serde_json::from_slice(&list.stdout).unwrap();
    assert!(payload["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|task| task["title"] == "from the UI"));

    let listed = http(daemon.port, "GET", &format!("/api/projects/{slug}/tasks"), None).expect("list");
    assert_eq!(listed.status, 200);
    assert_eq!(listed.json()["tasks"].as_array().unwrap().len(), 3, "{}", listed.body);
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
fn a_corrupt_task_file_shows_up_as_a_repair_banner_and_keeps_the_board_alive() {
    let fixture = fixture_with_tasks();
    let task = fixture.tasks().into_iter().next().unwrap();
    let path = fixture.layout.task_path(&fixture.project.slug, &task.id);
    let text = std::fs::read_to_string(&path).unwrap().replace("status: todo", "status: nonsense");
    std::fs::write(&path, text).unwrap();

    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;

    // The API keeps serving the readable tasks and names the problem.
    let listed = http(daemon.port, "GET", &format!("/api/projects/{slug}/tasks"), None).expect("list");
    assert_eq!(listed.status, 200, "{}", listed.body);
    assert_eq!(listed.json()["tasks"].as_array().unwrap().len(), 1);
    let problem = &listed.json()["problems"][0];
    assert_eq!(problem["line"], 4);
    assert!(problem["error"].as_str().unwrap().contains("unknown status"));

    // The SPA shell is served for any board path (the repair banner is rendered
    // client-side from the same `problems` payload; tests/ui.mjs exercises it).
    let board = http(daemon.port, "GET", &format!("/p/{slug}"), None).expect("board");
    assert_eq!(board.status, 200);
    assert!(board.body.contains("<!DOCTYPE html>"), "spa shell");
    assert!(board.body.contains("/assets/"), "hashed bundle referenced");
}

#[test]
fn writing_to_a_corrupt_file_via_the_api_is_refused() {
    let fixture = fixture_with_tasks();
    let task = fixture.tasks().into_iter().next().unwrap();
    let path = fixture.layout.task_path(&fixture.project.slug, &task.id);
    let text = std::fs::read_to_string(&path).unwrap().replace("status: todo", "status: nonsense");
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
    assert!(!error.contains("--comment"), "UI messages keep CLI flags out");
}

#[test]
fn ui_pages_render_the_board_and_the_drawer() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;

    // Any UI path returns the SPA shell, and the hashed bundle is served.
    let picker = http(daemon.port, "GET", "/", None).expect("picker");
    assert_eq!(picker.status, 200);
    assert!(picker.body.contains("<!DOCTYPE html>"));
    let bundle = picker
        .body
        .split("src=\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .expect("the shell references its JS bundle");
    let asset = http(daemon.port, "GET", bundle, None).expect("bundle");
    assert_eq!(asset.status, 200, "bundle {bundle} is embedded");
    assert!(asset.body.contains("kanboard") || asset.body.len() > 1000);
    let bundle_body = asset.body.clone();

    let board = http(daemon.port, "GET", &format!("/p/{slug}"), None).expect("board");
    assert_eq!(board.status, 200);
    assert!(board.body.contains("<!DOCTYPE html>"), "deep link serves the shell");

    // Lane/panel behaviour is client-side: packages/../tests/ui.mjs drives it.
    let tasks = http(daemon.port, "GET", &format!("/api/projects/{slug}/tasks"), None).expect("tasks");
    assert_eq!(tasks.status, 200);
    assert!(!tasks.json()["tasks"].as_array().unwrap().is_empty());

    // The hashed CSS bundle is embedded too (no build step at runtime).
    let css_href = picker
        .body
        .split("href=\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .expect("the shell references its stylesheet");
    let css = http(daemon.port, "GET", css_href, None).expect("css");
    assert_eq!(css.status, 200, "stylesheet {css_href} is embedded");
    // The theme is applied by the app (data-theme + a matchMedia default in the
    // bundle) so both the manual toggle and prefers-color-scheme work.
    assert!(css.body.contains("data-theme"), "the stylesheet themes both modes");
    assert!(bundle_body.contains("prefers-color-scheme"), "prefers-color-scheme drives the default");
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

// ─── remote access (token gate) ─────────────────────────────────────────────

fn daemon_info(fixture: &Fixture) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(fixture.layout.home.join("daemon.json")).unwrap()).unwrap()
}

/// A request with an explicit extra header.
fn http_with(port: u16, method: &str, path: &str, body: Option<&str>, extra: &[(&str, &str)]) -> common::HttpResponse {
    common::http_with_headers(port, method, path, body, extra).expect("request")
}

#[test]
fn a_remote_bind_requires_the_token() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--host", "0.0.0.0", "--idle-secs", "120"]);
    let info = daemon_info(&fixture);
    assert_eq!(info["host"], "0.0.0.0");
    let token = info["token"].as_str().expect("a token for a remote bind").to_string();
    assert!(token.len() >= 40, "long random token: {token}");

    // No token → 401 with the instruction page.
    let response = http(daemon.port, "GET", "/", None).expect("no token");
    assert_eq!(response.status, 401, "{}", response.body);
    assert!(response.body.contains("unipi:kanboard open"), "{}", response.body);
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
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"), "{cookie}");

    let response = http_with(daemon.port, "GET", "/", None, &[("cookie", &cookie)]);
    assert_eq!(response.status, 200, "cookie is enough");
}

#[test]
fn a_loopback_bind_needs_no_token() {
    let fixture = fixture_with_tasks();
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let info = daemon_info(&fixture);
    assert_eq!(info["host"], "127.0.0.1");
    assert!(info.get("token").is_none() || info["token"].is_null(), "no token on loopback");
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
    assert_eq!(payload["pid"], serde_json::Value::Null, "no pid off-loopback");
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
        let token = daemon_info(&fixture)["token"].as_str().unwrap_or("").to_string();
        let auth = if token.is_empty() { String::new() } else { format!("Bearer {token}") };
        let mut headers: Vec<(&str, &str)> = vec![("origin", "http://evil.example"), ("host", "127.0.0.1")];
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
        assert_eq!(response.status, 403, "cross-site POST refused: {}", response.body);

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
    let output = cli(&fixture, &["serve", "--host", "0.0.0.0", "--port", "37473", "--json"]);
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
    let payload = http(daemon.port, "GET", "/api/projects", None).unwrap().json();
    let project = &payload.as_array().expect("array")[0];
    assert_eq!(project["total"], 2);
    assert_eq!(project["counts"]["todo"], 2);
    assert_eq!(project["running"], 0, "no run blocks yet");
    let updated = project["updatedAt"].as_str().expect("updatedAt is set when tasks exist");
    assert!(chrono::DateTime::parse_from_rfc3339(updated).is_ok(), "{updated}");

    let claimed = cli(&fixture, &["claim-next", "--session", "s1", "--pid", "1", "--host", "t", "--json"]);
    assert!(claimed.status.success());
    let payload = http(daemon.port, "GET", "/api/projects", None).unwrap().json();
    assert_eq!(payload[0]["running"], 1, "a claimed task counts as running");
}
