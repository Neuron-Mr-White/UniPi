//! Agent self-claims: `start <ID>` (todo → in_progress, claimed for the
//! session) and `finish <ID> --comment` (in_progress → in_review, own claim
//! only). Runner claims stay the runner's; dead agent claims are reaped.

mod common;

use common::{Fixture, cli_with_env};
use kanboard::commands::{self, ClaimArgs, StartArgs};
use kanboard::model::{Actor, ChainGate, Priority, RunMode, RunOwner, Status};
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

#[test]
fn started_tasks_do_not_block_the_runner_claim_of_the_same_session() {
    let fixture = Fixture::new();
    let mine = fixture.add_with("mine", Status::Todo, Priority::High, &[]);
    fixture.add_with("queued", Status::Todo, Priority::None, &[]);
    start(&fixture, &mine.id, "s1", alive()).unwrap();
    let claimed = fixture.claim_next("s1", alive());
    assert_eq!(claimed["task"]["run"]["owner"], "system");
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
fn finish_refuses_another_sessions_claim_and_runner_claims() {
    let fixture = Fixture::new();
    let theirs = fixture.add_with("theirs", Status::Todo, Priority::None, &[]);
    start(&fixture, &theirs.id, "sess-b", alive()).unwrap();
    let err = finish(&fixture, &theirs.id, "sess-a", "stealing").unwrap_err();
    assert!(
        err.to_string().contains("started by session sess-b"),
        "{err}"
    );
    assert_eq!(stored(&fixture, &theirs.id).status, Status::InProgress);

    // A runner claim — even this session's — is the runner's to release.
    let runner_task = fixture.add_with("runner", Status::Todo, Priority::None, &[]);
    let host = commands::hostname();
    commands::claim_next(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        &ClaimArgs {
            session: "sess-a",
            pid: alive(),
            host: &host,
            mode: RunMode::None,
            id: Some(&runner_task.id),
        },
        fixture.common.now,
    )
    .unwrap();
    let err = finish(&fixture, &runner_task.id, "sess-a", "done").unwrap_err();
    assert!(err.to_string().contains("claimed by the runner"), "{err}");
    assert_eq!(stored(&fixture, &runner_task.id).status, Status::InProgress);

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
