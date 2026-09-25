//! CLI integration: exit codes, `--json` payloads, error messages, and the
//! cross-process claim race (the spec's "several terminals" case).

mod common;

use common::{Fixture, VALID_TASK};
use kanboard::store::Layout;
use serde_json::Value;
use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_unipi-kanboard")
}

#[derive(Debug)]
struct Run {
    stdout: String,
    stderr: String,
    code: i32,
    json: Value,
}

/// Run the binary with `UNIPI_KANBOARD_HOME` pointed at the fixture (naming it
/// `kb` keeps `let run = kb(..)` shadowing legal).
fn kb(fixture: &Fixture, args: &[&str]) -> Run {
    let output = Command::new(bin())
        .args(args)
        .env("UNIPI_KANBOARD_HOME", &fixture.layout.home)
        .env("UNIPI_KANBOARD_PROJECT", &fixture.project.slug)
        .env("UNIPI_KANBOARD_ACTOR", "user")
        .current_dir(fixture.root())
        .output()
        .expect("run unipi-kanboard");
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let json = if stdout.trim().is_empty() {
        serde_json::from_str(stderr.trim()).unwrap_or(Value::Null)
    } else {
        serde_json::from_str(&stdout).unwrap_or(Value::Null)
    };
    Run {
        stdout,
        stderr,
        code: output.status.code().unwrap_or(-1),
        json,
    }
}

#[test]
fn add_emits_a_task_and_json_matches_the_file() {
    let fixture = Fixture::new();
    let run = kb(
        &fixture,
        &["add", "Write the README", "--json", "--priority", "high"],
    );
    assert_eq!(run.code, 0, "stderr: {}", run.stderr);
    assert_eq!(run.json["id"], "FIX-1");
    assert_eq!(run.json["status"], "backlog");
    assert_eq!(run.json["priority"], "high");
    assert_eq!(run.json["ready"], false);
    assert!(run.json["path"].as_str().unwrap().ends_with("FIX-1.md"));

    let file = fixture.layout.task_path(&fixture.project.slug, "FIX-1");
    let text = std::fs::read_to_string(file).unwrap();
    assert!(text.contains("title: Write the README"));
}

#[test]
fn add_rejects_a_lane_it_may_not_target() {
    let fixture = Fixture::new();
    let run = kb(
        &fixture,
        &["add", "nope", "--status", "in_review", "--json"],
    );
    assert_eq!(run.code, 2, "usage errors exit 2");
    assert!(
        run.json["error"]
            .as_str()
            .unwrap()
            .contains("new tasks start in backlog or todo")
    );
}

#[test]
fn list_ready_uses_the_gate_flag() {
    let fixture = Fixture::new();
    let dep = fixture.add_with(
        "dep",
        kanboard::model::Status::Todo,
        kanboard::model::Priority::None,
        &[],
    );
    let dependent = fixture.add_with(
        "dependent",
        kanboard::model::Status::Todo,
        kanboard::model::Priority::None,
        std::slice::from_ref(&dep.id),
    );

    // Nothing is ready: the dep has no deps but… it *is* ready, so only the
    // dependent is filtered out.
    let run = kb(&fixture, &["list", "--ready", "--json"]);
    let items = run.json["tasks"].as_array().unwrap();
    let ids: Vec<&str> = items.iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec![dep.id.as_str()]);
    assert!(!ids.contains(&dependent.id.as_str()));

    // Move the dep to in_review via the library (the CLI would need the runner).
    fixture.claim_next("s", std::process::id());
    kanboard::commands::release(
        &fixture.layout,
        fixture.project.clone(),
        &dep.id,
        kanboard::model::Status::InReview,
        "ready",
        kanboard::model::ChainGate::InReview,
        fixture.common.now,
    )
    .unwrap();

    let run = kb(&fixture, &["list", "--ready", "--json"]);
    let ids: Vec<&str> = run.json["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec![dependent.id.as_str()],
        "in_review satisfies the default gate"
    );

    let run = kb(&fixture, &["list", "--ready", "--gate", "done", "--json"]);
    assert!(
        run.json["tasks"].as_array().unwrap().is_empty(),
        "nothing reached done"
    );
}

#[test]
fn move_denied_reports_the_rule_and_exits_one() {
    let fixture = Fixture::new();
    let task = fixture.add_with(
        "t",
        kanboard::model::Status::Todo,
        kanboard::model::Priority::None,
        &[],
    );
    fixture.claim_next("s", std::process::id());
    // in_progress → in_review as a user needs a comment AND the system actor.
    let run = kb(&fixture, &["move", &task.id, "in_review", "--json"]);
    assert_eq!(run.code, 1);
    assert!(
        run.json["error"].as_str().unwrap().contains("system only"),
        "{run:?}"
    );

    // in_review → todo without a comment is the spec's headline message.
    kanboard::commands::release(
        &fixture.layout,
        fixture.project.clone(),
        &task.id,
        kanboard::model::Status::InReview,
        "for review",
        kanboard::model::ChainGate::InReview,
        fixture.common.now,
    )
    .unwrap();
    let run = kb(&fixture, &["move", &task.id, "todo", "--json"]);
    assert_eq!(run.code, 1);
    assert_eq!(
        run.json["error"].as_str().unwrap(),
        "in_review → todo requires --comment (rework note)"
    );

    // With the comment it goes through.
    let run = kb(
        &fixture,
        &[
            "move",
            &task.id,
            "todo",
            "--comment",
            "needs tests",
            "--json",
        ],
    );
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(run.json["status"], "todo");
    let activity = run.json["activity"].as_array().unwrap();
    assert!(activity.last().unwrap()["text"] == "rework: needs tests");
}

#[test]
fn move_to_a_final_lane_is_refused_with_a_hint() {
    let fixture = Fixture::new();
    let task = fixture.add_with(
        "t",
        kanboard::model::Status::Todo,
        kanboard::model::Priority::None,
        &[],
    );
    let run = kb(&fixture, &["move", &task.id, "done", "--json"]);
    assert_eq!(run.code, 1);
    let message = run.json["error"].as_str().unwrap();
    assert!(message.contains("not an allowed transition"), "{message}");

    let run = kb(&fixture, &["move", &task.id, "archived", "--json"]);
    assert!(
        run.json["error"]
            .as_str()
            .unwrap()
            .contains("only done/cancelled"),
        "{}",
        run.stderr
    );
}

#[test]
fn claim_next_json_reports_waiting_reasons_and_chains_exactly_once() {
    let fixture = Fixture::new();
    let dep = fixture.add_with(
        "dep",
        kanboard::model::Status::Todo,
        kanboard::model::Priority::None,
        &[],
    );
    let dependent = fixture.add_with(
        "dependent",
        kanboard::model::Status::Todo,
        kanboard::model::Priority::None,
        std::slice::from_ref(&dep.id),
    );

    let run = kb(
        &fixture,
        &[
            "claim-next",
            "--session",
            "s1",
            "--pid",
            &std::process::id().to_string(),
            "--host",
            "test-host",
            "--json",
        ],
    );
    assert_eq!(run.code, 0);
    assert_eq!(run.json["task"]["id"], dep.id.as_str());
    assert_eq!(run.json["task"]["run"]["session"], "s1");

    let run = kb(
        &fixture,
        &[
            "claim-next",
            "--session",
            "s2",
            "--pid",
            "999998",
            "--host",
            "test-host",
            "--json",
        ],
    );
    assert!(
        run.json["task"].is_null(),
        "the dependent task is not ready"
    );
    assert_eq!(run.json["waiting"][0]["id"], dependent.id.as_str());
    assert_eq!(run.json["waiting"][0]["waitingFor"][0], dep.id.as_str());
}

#[test]
fn validate_reports_line_numbers_and_fails_the_exit_code() {
    let fixture = Fixture::new();
    let bad = VALID_TASK.replace("status: todo", "status: nonsense");
    common::write_task_file(&fixture, "FIX-900", &bad);

    let run = kb(&fixture, &["validate", "--json"]);
    assert_eq!(run.code, 1);
    assert_eq!(run.json["ok"], false);
    let problem = &run.json["problems"][0];
    assert_eq!(problem["line"], 4);
    assert!(
        problem["message"]
            .as_str()
            .unwrap()
            .contains("unknown status \"nonsense\"")
    );

    // Human output is `<file>:<line>: <message>`.
    let run = kb(&fixture, &["validate"]);
    assert_eq!(run.code, 1);
    assert!(run.stdout.contains(":4: unknown status"), "{}", run.stdout);
}

#[test]
fn validate_fix_rewrites_formatting_only() {
    let fixture = Fixture::new();
    common::write_task_file(&fixture, "FIX-900", VALID_TASK.trim_end());
    let run = kb(&fixture, &["validate", "--fix", "--json"]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(run.json["fixed"][0], "FIX-900");
    assert!(run.json["problems"].as_array().unwrap().is_empty());
}

#[test]
fn project_lifecycle_over_the_cli() {
    let fixture = Fixture::new();
    let run = kb(&fixture, &["project", "list", "--json"]);
    assert_eq!(run.json.as_array().unwrap().len(), 1);

    let run = kb(&fixture, &["project", "show", "--json"]);
    assert_eq!(run.json["total"], 0);
    assert_eq!(run.json["counts"]["backlog"], 0);

    let run = kb(
        &fixture,
        &[
            "project", "add", "--name", "Other", "--prefix", "oth", "--json",
        ],
    );
    assert_eq!(run.json["prefix"], "OTH");
}

#[test]
fn show_includes_deps_status_and_staleness() {
    let fixture = Fixture::new();
    let dep = fixture.add_with(
        "dep",
        kanboard::model::Status::Todo,
        kanboard::model::Priority::None,
        &[],
    );
    let task = fixture.add_with(
        "t",
        kanboard::model::Status::Todo,
        kanboard::model::Priority::High,
        std::slice::from_ref(&dep.id),
    );
    let run = kb(&fixture, &["show", &task.id, "--json"]);
    assert_eq!(run.json["deps"][0], dep.id.as_str());
    assert_eq!(run.json["depsStatus"][0]["status"], "todo");
    assert_eq!(
        run.json["staleness"], "running",
        "no run block means not stale"
    );
    assert_eq!(run.json["waitingFor"][0], dep.id.as_str());
}

#[test]
fn note_edit_link_order_and_duplicate_round_trip() {
    let fixture = Fixture::new();
    let a = fixture.add("a");
    let b = fixture.add("b");

    let run = kb(&fixture, &["note", &a.id, "remember this", "--json"]);
    assert_eq!(
        run.json["activity"].as_array().unwrap().last().unwrap()["text"],
        "remember this"
    );

    let run = kb(
        &fixture,
        &[
            "edit",
            &a.id,
            "--title",
            "renamed",
            "--priority",
            "urgent",
            "--json",
        ],
    );
    assert_eq!(run.json["title"], "renamed");
    assert_eq!(run.json["priority"], "urgent");

    let run = kb(&fixture, &["link", &b.id, "--after", &a.id, "--json"]);
    assert_eq!(run.json["deps"][0], a.id.as_str());
    let run = kb(&fixture, &["unlink", &b.id, "--after", &a.id, "--json"]);
    assert!(run.json["deps"].as_array().unwrap().is_empty());

    let run = kb(&fixture, &["order", &b.id, "--top", "--json"]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    let top_order = run.json["order"].as_i64().unwrap();

    let run = kb(&fixture, &["duplicate", &a.id, "--json"]);
    assert_ne!(run.json["id"], a.id.as_str());
    assert_eq!(run.json["status"], "backlog");

    let run = kb(&fixture, &["order", &a.id, "--before", &b.id, "--json"]);
    assert!(run.json["order"].as_i64().unwrap() < top_order);
}

#[test]
fn archive_sweep_reports_the_days_threshold() {
    let fixture = Fixture::new();
    let run = kb(&fixture, &["archive-sweep", "--json"]);
    assert_eq!(
        run.json["skipped"],
        "archiveAfterDays and retentionDays are 0 (off)"
    );
    let run = kb(&fixture, &["archive-sweep", "--after-days", "7", "--json"]);
    assert_eq!(run.json["archived"].as_array().unwrap().len(), 0);
}

#[test]
fn actor_env_is_honoured_and_reported_in_activity() {
    let fixture = Fixture::new();
    let task = fixture.add("t");
    let output = Command::new(bin())
        .args(["note", &task.id, "from the agent"])
        .env("UNIPI_KANBOARD_HOME", &fixture.layout.home)
        .env("UNIPI_KANBOARD_PROJECT", &fixture.project.slug)
        .env("UNIPI_KANBOARD_ACTOR", "agent")
        .env_remove("UNIPI_KANBOARD_ACTOR_OVERRIDE")
        .current_dir(fixture.root())
        .output()
        .expect("run");
    assert!(output.status.success());
    let stored = fixture
        .tasks()
        .into_iter()
        .find(|t| t.id == task.id)
        .unwrap();
    assert_eq!(
        stored.activity.last().unwrap().actor,
        kanboard::model::Actor::Agent
    );
}

#[test]
fn the_agent_actor_cannot_cancel_and_the_message_forbids_actor_override() {
    let fixture = Fixture::new();
    let task = fixture.add("t");
    let output = Command::new(bin())
        .args(["move", &task.id, "cancelled", "--json"])
        .env("UNIPI_KANBOARD_HOME", &fixture.layout.home)
        .env("UNIPI_KANBOARD_PROJECT", &fixture.project.slug)
        .env("UNIPI_KANBOARD_ACTOR", "agent")
        .current_dir(fixture.root())
        .output()
        .expect("run");
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("suggest cancel"), "{stderr}");
    assert!(stderr.contains("honour system"), "{stderr}");
}

#[test]
fn eight_processes_race_but_at_most_two_sessions_claim() {
    let fixture = Fixture::new();
    for title in ["one", "two", "three"] {
        fixture.add_with(
            title,
            kanboard::model::Status::Todo,
            kanboard::model::Priority::None,
            &[],
        );
    }

    // Two long-lived processes stand in for the running sessions' pids, so the
    // first two claims are not reaped and the cap refuses the other six.
    let mut sleep_a = Command::new("sleep").arg("60").spawn().expect("sleep");
    let mut sleep_b = Command::new("sleep").arg("60").spawn().expect("sleep");
    let live = [sleep_a.id(), sleep_b.id()];

    let mut children = Vec::new();
    for index in 0..8 {
        let pid = live.get(index).copied().unwrap_or(900_000 + index as u32);
        let child = Command::new(bin())
            .args([
                "claim-next",
                "--session",
                &format!("proc-{index}"),
                "--pid",
                &format!("{pid}"),
                "--host",
                "test-host",
                "--json",
            ])
            .env("UNIPI_KANBOARD_HOME", &fixture.layout.home)
            .env("UNIPI_KANBOARD_PROJECT", &fixture.project.slug)
            .current_dir(fixture.root())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn");
        children.push(child);
    }

    let mut claimed = Vec::new();
    let mut refused = 0;
    for child in children {
        let output = child.wait_with_output().expect("wait");
        if output.status.success() {
            let payload: Value = serde_json::from_slice(&output.stdout).expect("json");
            if let Some(id) = payload["task"]["id"].as_str() {
                claimed.push(id.to_string());
            }
        } else {
            refused += 1;
            let payload: Value = serde_json::from_slice(&output.stderr).expect("json error");
            assert!(
                payload["error"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("sessions")
                    || payload["error"]
                        .as_str()
                        .unwrap_or_default()
                        .contains("already runs"),
                "unexpected refusal: {payload}"
            );
        }
    }
    let _ = sleep_a.kill();
    let _ = sleep_b.kill();
    let _ = sleep_a.wait();
    let _ = sleep_b.wait();
    claimed.sort();
    let unique = claimed.clone();
    claimed.dedup();
    assert_eq!(claimed, unique, "no duplicates: {claimed:?}");
    assert_eq!(claimed.len(), 2, "exactly two sessions claim: {claimed:?}");
    assert_eq!(refused, 6, "the cap refused six: {claimed:?}");

    let in_progress = fixture
        .tasks()
        .into_iter()
        .filter(|task| task.status == kanboard::model::Status::InProgress)
        .count();
    assert_eq!(in_progress, 2);
}

#[test]
fn a_corrupt_task_file_stops_writes_with_a_pointer_to_validate() {
    let fixture = Fixture::new();
    common::write_task_file(&fixture, "FIX-900", "not a task at all\n");
    // A corrupt file no longer stops the board; it is reported instead.
    let run = kb(&fixture, &["list", "--json"]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(run.json["problems"].as_array().unwrap().len(), 1);
}

#[test]
fn unknown_project_errors_mention_project_add() {
    let home = tempfile::TempDir::new().unwrap();
    let layout = Layout::with_home(home.path());
    let empty = tempfile::TempDir::new().unwrap();
    let output = Command::new(bin())
        .args(["list", "--json"])
        .env("UNIPI_KANBOARD_HOME", &layout.home)
        .env_remove("UNIPI_KANBOARD_PROJECT")
        .current_dir(empty.path())
        .output()
        .expect("run");
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("no project registered"), "{stderr}");
    assert!(stderr.contains("project add"), "{stderr}");
}

/// Regression (K7 review, found on coffee): the table printer read the raw JSON
/// as a bare array while `list --json` had become `{tasks, problems}`, so every
/// board with tasks printed "no tasks" in the human-readable output.
#[test]
fn list_prints_tasks_and_warns_about_problems() {
    let fixture = Fixture::new();
    fixture.add_with(
        "first",
        kanboard::model::Status::Backlog,
        kanboard::model::Priority::None,
        &[],
    );
    fixture.add_with(
        "second",
        kanboard::model::Status::Todo,
        kanboard::model::Priority::High,
        &[],
    );

    let run = kb(&fixture, &["list"]);
    assert_eq!(run.code, 0);
    assert!(
        !run.stdout.contains("no tasks"),
        "the table must not claim an empty board: {}",
        run.stdout
    );
    assert!(run.stdout.contains("first"), "{}", run.stdout);
    assert!(
        run.stdout.contains("[todo] second (high)"),
        "{}",
        run.stdout
    );

    // A broken task file shows up in the table too, not only in the JSON.
    let mut ids: Vec<String> = std::fs::read_dir(fixture.layout.tasks_dir(&fixture.project.slug))
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    ids.sort();
    let broken = ids.first().expect("the fixture has task files");
    std::fs::write(broken, "---\nid: broken\ntitle: [unclosed\n---\n").unwrap();

    let run = kb(&fixture, &["list"]);
    assert!(run.stdout.contains("need repair"), "{}", run.stdout);
}
