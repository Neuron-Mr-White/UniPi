//! Agent self-claims: `start <ID>` (todo → in_progress, claimed for the
//! session) and `finish <ID> --comment` (in_progress → in_review, own claim
//! only). Legacy system claims in old task files are not `finish`able (a user
//! releases them); dead agent claims are reaped.

mod common;

use common::{Fixture, cli_with_env};
use kanboard::commands::{self, StartArgs};
use kanboard::model::{Actor, ChainGate, Priority, RunOwner, Status};
use serde_json::Value;

fn start(fixture: &Fixture, id: &str, session: &str, pid: u32) -> kanboard::error::Result<Value> {
    let host = commands::hostname();
    commands::start(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        id,
        &StartArgs {
            session,
            pid,
            host: &host,
        },
        fixture.common.now,
    )
}

fn finish(
    fixture: &Fixture,
    id: &str,
    session: &str,
    comment: &str,
) -> kanboard::error::Result<Value> {
    commands::finish(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        id,
        session,
        comment,
        &[],
        fixture.common.now,
    )
}

fn stored(fixture: &Fixture, id: &str) -> kanboard::model::Task {
    fixture.tasks().into_iter().find(|t| t.id == id).unwrap()
}

fn alive() -> u32 {
    std::process::id()
}

#[test]
fn start_claims_the_task_for_the_session_as_the_agent() {
    let fixture = Fixture::new();
    let task = fixture.add_with("work", Status::Todo, Priority::None, &[]);
    let value = start(&fixture, &task.id, "sess-a", alive()).expect("start");
    assert_eq!(value["status"], "in_progress");
    assert_eq!(value["run"]["session"], "sess-a");
    assert_eq!(value["run"]["owner"], "agent");

    let task = stored(&fixture, &task.id);
    assert_eq!(task.status, Status::InProgress);
    let run = task.run.as_ref().unwrap();
    assert_eq!(run.owner, RunOwner::Agent);
    assert_eq!(run.pid, alive());
    let last = task.activity.last().unwrap();
    assert_eq!(last.actor, Actor::Agent);
    assert_eq!(last.session.as_deref(), Some("sess-a"));
    assert!(last.text.starts_with("started"), "{}", last.text);

    // The owner survives the file round-trip (and validates clean).
    let checked = commands::validate(&fixture.layout, fixture.project.clone(), false).unwrap();
    assert!(checked.problems.is_empty(), "{:?}", checked.problems);
}

#[test]
fn start_refuses_non_todo_claimed_and_unready_tasks() {
    let fixture = Fixture::new();
    let backlog = fixture.add("backlog");
    let err = start(&fixture, &backlog.id, "s", alive()).unwrap_err();
    assert!(err.to_string().contains("not todo"), "{err}");

    let dep = fixture.add_with("dep", Status::Todo, Priority::None, &[]);
    let waiting = fixture.add_with("waiting", Status::Todo, Priority::None, std::slice::from_ref(&dep.id));
    let err = start(&fixture, &waiting.id, "s", alive()).unwrap_err();
    assert!(err.to_string().contains(&dep.id), "{err}");

    // Already started by this session / by another session.
    start(&fixture, &dep.id, "s", alive()).unwrap();
    let err = start(&fixture, &dep.id, "s", alive()).unwrap_err();
    assert!(
        err.to_string()
            .contains("already in progress for this session"),
        "{err}"
    );
    let err = start(&fixture, &dep.id, "other", alive()).unwrap_err();
    assert!(
        err.to_string().contains("already claimed by agent s"),
        "{err}"
    );

    let err = start(&fixture, "FIX-999", "s", alive()).unwrap_err();
    assert!(err.to_string().contains("no such task"), "{err}");
}

#[test]
fn a_session_may_start_several_tasks_but_the_session_cap_holds() {
    let fixture = Fixture::new();
    let a = fixture.add_with("a", Status::Todo, Priority::None, &[]);
    let b = fixture.add_with("b", Status::Todo, Priority::None, &[]);
    let c = fixture.add_with("c", Status::Todo, Priority::None, &[]);
    let d = fixture.add_with("d", Status::Todo, Priority::None, &[]);
    start(&fixture, &a.id, "s1", alive()).unwrap();
    start(&fixture, &b.id, "s1", alive()).expect("second start in the same session");
    start(&fixture, &c.id, "s2", alive()).unwrap();
    // Two sessions already hold tasks (default cap 2).
    let err = start(&fixture, &d.id, "s3", alive()).unwrap_err();
    assert!(
        err.to_string().contains("sessions already run tasks"),
        "{err}"
    );
}

/// UNI-105: `start` also resumes a task the agent blocked — same claim and
/// session-cap rules as a fresh todo claim.
#[test]
fn start_resumes_a_blocked_task_with_the_same_claim_and_cap_rules() {
    use kanboard::commands;
    let fixture = Fixture::new();
    let task = fixture.add_with("work", Status::Todo, Priority::None, &[]);
    start(&fixture, &task.id, "sess-a", alive()).expect("start");
    let mut agent_common = fixture.common.clone();
    agent_common.actor = Actor::Agent;
    agent_common.session = Some("sess-a".to_string());
    commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &agent_common,
        &task.id,
        Status::Blocked,
        Some("need the log format"),
    )
    .expect("block");
    assert_eq!(stored(&fixture, &task.id).status, Status::Blocked);

    // Resuming it goes through `start` again, same as a fresh claim.
    let value = start(&fixture, &task.id, "sess-a", alive()).expect("resume");
    assert_eq!(value["status"], "in_progress");
    assert_eq!(value["run"]["session"], "sess-a");
    let resumed = stored(&fixture, &task.id);
    assert_eq!(resumed.status, Status::InProgress);
    let last = resumed.activity.last().unwrap();
    assert_eq!(last.actor, Actor::Agent);
    assert!(last.text.starts_with("resumed"), "{}", last.text);

    // The same session cap applies: two sessions already holding tasks blocks a third.
    let other = fixture.add_with("other", Status::Todo, Priority::None, &[]);
    start(&fixture, &other.id, "sess-b", alive()).expect("second session");
    let third = fixture.add_with("third", Status::Todo, Priority::None, &[]);
    let err = start(&fixture, &third.id, "sess-c", alive()).unwrap_err();
    assert!(err.to_string().contains("sessions already run tasks"), "{err}");
}

#[test]
fn finish_moves_the_own_claim_to_review_with_the_summary() {
    let fixture = Fixture::new();
    let task = fixture.add_with("work", Status::Todo, Priority::None, &[]);
    start(&fixture, &task.id, "sess-a", alive()).unwrap();

    // Summary required.
    let err = finish(&fixture, &task.id, "sess-a", "   ").unwrap_err();
    assert!(err.to_string().contains("requires --comment"), "{err}");
    assert_eq!(stored(&fixture, &task.id).status, Status::InProgress);

    let value = finish(&fixture, &task.id, "sess-a", "did the thing").expect("finish");
    assert_eq!(value["status"], "in_review");
    let task = stored(&fixture, &task.id);
    assert!(task.run.is_none());
    let last = task.activity.last().unwrap();
    assert_eq!(last.actor, Actor::Agent);
    assert_eq!(last.session.as_deref(), Some("sess-a"));
    assert_eq!(last.text, "finished: did the thing");

    // Not in progress any more.
    let err = finish(&fixture, &task.id, "sess-a", "again").unwrap_err();
    assert!(err.to_string().contains("not in_progress"), "{err}");
}

#[test]
fn finish_refuses_another_sessions_claim_and_legacy_system_claims() {
    let fixture = Fixture::new();
    let theirs = fixture.add_with("theirs", Status::Todo, Priority::None, &[]);
    start(&fixture, &theirs.id, "sess-b", alive()).unwrap();
    let err = finish(&fixture, &theirs.id, "sess-a", "stealing").unwrap_err();
    assert!(
        err.to_string().contains("started by session sess-b"),
        "{err}"
    );
    assert_eq!(stored(&fixture, &theirs.id).status, Status::InProgress);

    // A legacy system claim (an old file's `run:` block without `owner:`) —
    // even this session's — is not finishable; a user releases it.
    let legacy = fixture.add_with("legacy", Status::Todo, Priority::None, &[]);
    start(&fixture, &legacy.id, "sess-a", alive()).unwrap();
    let board = kanboard::board::Board::open(&fixture.layout, fixture.project.clone()).unwrap();
    let mut task = board.get(&legacy.id).unwrap();
    task.run.as_mut().unwrap().owner = RunOwner::System;
    board.save(&task).unwrap();
    let text = std::fs::read_to_string(board.task_path(&legacy.id)).unwrap();
    assert!(!text.contains("owner:"), "system claims keep the historical shape: {text}");
    let err = finish(&fixture, &legacy.id, "sess-a", "done").unwrap_err();
    assert!(err.to_string().contains("system claim"), "{err}");
    assert_eq!(stored(&fixture, &legacy.id).status, Status::InProgress);

    // A todo task was never started.
    let todo = fixture.add_with("todo", Status::Todo, Priority::None, &[]);
    let err = finish(&fixture, &todo.id, "sess-a", "done").unwrap_err();
    assert!(err.to_string().contains("start"), "{err}");
}

#[test]
fn agent_move_points_at_start_and_finish() {
    let fixture = Fixture::new();
    let task = fixture.add_with("work", Status::Todo, Priority::None, &[]);
    let mut agent = fixture.common.clone();
    agent.actor = Actor::Agent;
    agent.session = Some("s".into());
    let err = commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &agent,
        &task.id,
        Status::InProgress,
        None,
    )
    .unwrap_err();
    assert!(err.to_string().contains("start"), "{err}");

    start(&fixture, &task.id, "s", alive()).unwrap();
    let err = commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &agent,
        &task.id,
        Status::InReview,
        Some("summary"),
    )
    .unwrap_err();
    assert!(err.to_string().contains("finish"), "{err}");

    // An agent can still block the task it started.
    let value = commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &agent,
        &task.id,
        Status::Blocked,
        Some("need the API key"),
    )
    .expect("block own started task");
    assert_eq!(value["status"], "blocked");
}

#[test]
fn a_dead_agent_claim_is_reaped_back_to_todo() {
    let fixture = Fixture::new();
    let task = fixture.add_with("orphan", Status::Todo, Priority::None, &[]);
    // 999_999 is not a live pid on this host.
    start(&fixture, &task.id, "gone", 999_999).unwrap();
    assert_eq!(
        commands::staleness_of(&stored(&fixture, &task.id)),
        kanboard::model::Staleness::Stale
    );
    let reaped = commands::reap(
        &fixture.layout,
        fixture.project.clone(),
        false,
        fixture.common.now,
    )
    .unwrap();
    assert_eq!(reaped["released"], serde_json::json!([task.id]));
    let task = stored(&fixture, &task.id);
    assert_eq!(task.status, Status::Todo);
    assert!(task.run.is_none());
    // And it can be started again.
    start(&fixture, &task.id, "fresh", alive()).expect("restart after reap");
}

#[test]
fn cli_start_and_finish_round_trip() {
    let fixture = Fixture::new();
    let task = fixture.add_with("work", Status::Todo, Priority::None, &[]);
    let pid = alive().to_string();
    let env = [
        ("UNIPI_KANBOARD_ACTOR", "agent"),
        ("UNIPI_KANBOARD_SESSION", "cli-s"),
    ];

    // `start` without a session fails loudly.
    let output = cli_with_env(
        &fixture,
        &["start", &task.id],
        &[("UNIPI_KANBOARD_ACTOR", "agent")],
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("needs a session"));

    let output = cli_with_env(
        &fixture,
        &["--json", "start", &task.id, "--pid", &pid],
        &env,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["status"], "in_progress");
    assert_eq!(json["run"]["session"], "cli-s");

    // `UNIPI_KANBOARD_PID` names the owner when --pid is absent.
    let other = fixture.add_with("other", Status::Todo, Priority::None, &[]);
    let output = cli_with_env(
        &fixture,
        &["--json", "start", &other.id],
        &[
            ("UNIPI_KANBOARD_ACTOR", "agent"),
            ("UNIPI_KANBOARD_SESSION", "cli-s"),
            ("UNIPI_KANBOARD_PID", &pid),
        ],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(stored(&fixture, &other.id).run.unwrap().pid, alive());

    // --comment is mandatory at the parser level.
    let output = cli_with_env(&fixture, &["finish", &task.id], &env);
    assert!(!output.status.success());

    let output = cli_with_env(
        &fixture,
        &["finish", &task.id, "--comment", "all done"],
        &env,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("in_review"));
    assert_eq!(stored(&fixture, &task.id).status, Status::InReview);
}

#[test]
fn finish_and_block_can_attach_evidence_files() {
    let fixture = Fixture::new();
    let a = fixture.add_with("a", Status::Todo, Priority::None, &[]);
    let b = fixture.add_with("b", Status::Todo, Priority::None, &[]);
    let pid = alive().to_string();
    let env = [
        ("UNIPI_KANBOARD_ACTOR", "agent"),
        ("UNIPI_KANBOARD_SESSION", "cli-att"),
        ("UNIPI_KANBOARD_PID", pid.as_str()),
    ];
    let shot = fixture.root().join("after.png");
    std::fs::write(&shot, b"\x89PNG\r\n\x1a\nfake").unwrap();
    let log = fixture.root().join("run.log");
    std::fs::write(&log, "ok\n").unwrap();
    let shot_path = shot.to_str().unwrap().to_string();

    for id in [&a.id, &b.id] {
        let output = cli_with_env(&fixture, &["start", id], &env);
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }

    // The file's path in the comment is replaced by the embed.
    let comment = format!("fixed, see {shot_path}");
    let output = cli_with_env(
        &fixture,
        &["finish", &a.id, "--comment", &comment, "--attach", &shot_path],
        &env,
    );
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let text = stored(&fixture, &a.id).activity.last().unwrap().text.clone();
    assert!(text.starts_with("finished: fixed, see ![after.png](att:"), "{text}");
    assert!(!text.contains(&shot_path), "{text}");

    // Absent from the comment, the reference is appended.
    let output = cli_with_env(
        &fixture,
        &[
            "move", &b.id, "blocked", "--comment", "need creds",
            "--attach", log.to_str().unwrap(),
        ],
        &env,
    );
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let text = stored(&fixture, &b.id).activity.last().unwrap().text.clone();
    assert!(text.starts_with("blocked: need creds") && text.contains("[run.log](att:"), "{text}");

    // `note --attach` works too, and the files are listed on the task.
    let output = cli_with_env(
        &fixture,
        &["note", &b.id, "the trace", "--attach", &shot_path],
        &env,
    );
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let output = cli_with_env(&fixture, &["--json", "show", &b.id], &env);
    let json: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["attachments"].as_array().unwrap().len(), 2);
}

#[test]
fn task_json_carries_the_full_status_report_for_review_and_blocked() {
    let fixture = Fixture::new();
    let task = fixture.add_with("r", Status::Todo, Priority::None, &[]);
    let long = format!("**Fixed** the header.\n\n- {}\n- second point", "x".repeat(900));
    start(&fixture, &task.id, "s-r", alive()).expect("start");
    let value = finish(&fixture, &task.id, "s-r", &long).expect("finish");
    assert_eq!(value["statusReport"]["kind"], "review");
    assert_eq!(value["statusReport"]["text"], long.as_str(), "full text, prefix stripped");
    assert_eq!(value["statusReport"]["actor"], "agent");

    let other = fixture.add_with("b", Status::Todo, Priority::None, &[]);
    start(&fixture, &other.id, "s-r", alive()).expect("start");
    let mut common = fixture.common.clone();
    common.actor = Actor::Agent;
    common.session = Some("s-r".into());
    let value = commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &common,
        &other.id,
        Status::Blocked,
        Some("need the token\n\n1. which env?"),
    )
    .expect("block");
    assert_eq!(value["statusReport"]["kind"], "blocked");
    assert_eq!(value["statusReport"]["text"], "need the token\n\n1. which env?");

    let todo = fixture.add_with("t", Status::Todo, Priority::None, &[]);
    let value = commands::show(&fixture.layout, fixture.project.clone(), &todo.id, ChainGate::InReview).unwrap();
    assert!(value.get("statusReport").is_none());
}
