//! Dependencies: cycles, readiness under both gates, cancelled deps.

mod common;

use common::Fixture;
use kanboard::model::{ChainGate, Priority, Status};
use kanboard::{commands, deps};

fn by_id(tasks: &[kanboard::model::Task]) -> impl Fn(&str) -> Option<kanboard::model::Task> + '_ {
    move |id: &str| tasks.iter().find(|task| task.id == id).cloned()
}

#[test]
fn a_todo_task_without_deps_is_ready() {
    let fixture = Fixture::new();
    let task = fixture.add_with("plain", Status::Todo, Priority::None, &[]);
    let tasks = fixture.tasks();
    assert!(deps::is_ready(&task, &by_id(&tasks), ChainGate::InReview));
    assert!(deps::blocked_by(&task, &by_id(&tasks), ChainGate::InReview).is_none());
}

#[test]
fn backlog_tasks_are_never_ready() {
    let fixture = Fixture::new();
    let task = fixture.add("in backlog");
    let tasks = fixture.tasks();
    assert!(!deps::is_ready(&task, &by_id(&tasks), ChainGate::InReview));
    assert!(!fixture.claim_next("s", 1)["task"].as_object().is_some());
}

#[test]
fn todo_and_in_progress_dependencies_satisfy_no_gate() {
    let fixture = Fixture::new();
    let dep = fixture.add_with("dependency", Status::Todo, Priority::None, &[]);
    let dependent = fixture.add_with("dependent", Status::Todo, Priority::None, std::slice::from_ref(&dep.id));

    // dep is todo → blocked under both gates.
    let tasks = fixture.tasks();
    let dependent_now = tasks.iter().find(|t| t.id == dependent.id).cloned().unwrap();
    for gate in [ChainGate::InReview, ChainGate::Done] {
        assert!(deps::blocked_by(&dependent_now, &by_id(&tasks), gate).is_some(), "{gate}");
    }

    // dep claimed (in_progress) → still blocked under both gates.
    fixture.claim_next("sess-dep", std::process::id());
    let tasks = fixture.tasks();
    let dependent_now = tasks.iter().find(|t| t.id == dependent.id).cloned().unwrap();
    for gate in [ChainGate::InReview, ChainGate::Done] {
        assert!(deps::blocked_by(&dependent_now, &by_id(&tasks), gate).is_some(), "{gate}");
    }
}

#[test]
fn in_review_satisfies_the_default_gate_but_not_done() {
    let fixture = Fixture::new();
    let mut dep = fixture.add_with("dependency", Status::Todo, Priority::None, &[]);
    let dependent = fixture.add_with("dependent", Status::Todo, Priority::None, std::slice::from_ref(&dep.id));

    // Put the dependency into in_review through the real lifecycle.
    fixture.claim_next("sess-dep", std::process::id());
    commands::release(
        &fixture.layout,
        fixture.project.clone(),
        &dep.id,
        Status::InReview,
        "done, needs review",
        ChainGate::InReview,
        fixture.common.now,
    )
    .expect("release");

    let tasks = fixture.tasks();
    let dependent_now = tasks.iter().find(|t| t.id == dependent.id).cloned().unwrap();
    dep = tasks.iter().find(|t| t.id == dep.id).cloned().unwrap();
    assert_eq!(dep.status, Status::InReview);
    assert!(
        deps::is_ready(&dependent_now, &by_id(&tasks), ChainGate::InReview),
        "in_review satisfies the default gate"
    );
    assert!(
        !deps::is_ready(&dependent_now, &by_id(&tasks), ChainGate::Done),
        "in_review does not satisfy the done gate"
    );

    // And claim-next honours the gate it is given.
    let claimed = commands::claim_next(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::Done,
        &commands::ClaimArgs {
            session: "s",
            pid: 1,
            host: "h",
            mode: kanboard::model::RunMode::Direct,
        },
        fixture.common.now,
    )
    .expect("claim");
    assert!(claimed["task"].is_null(), "nothing ready under the done gate");

    let claimed = commands::claim_next(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        &commands::ClaimArgs {
            session: "s",
            pid: 1,
            host: "h",
            mode: kanboard::model::RunMode::Direct,
        },
        fixture.common.now,
    )
    .expect("claim");
    assert_eq!(claimed["task"]["id"], dependent.id.as_str());
}

#[test]
fn a_cancelled_dependency_blocks_readiness_forever() {
    let fixture = Fixture::new();
    let dep = fixture.add_with("dependency", Status::Todo, Priority::None, &[]);
    let dependent = fixture.add_with("dependent", Status::Todo, Priority::None, std::slice::from_ref(&dep.id));
    commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &dep.id,
        Status::Cancelled,
        None,
    )
    .expect("cancel");

    let tasks = fixture.tasks();
    let dependent = tasks.iter().find(|t| t.id == dependent.id).cloned().unwrap();
    for gate in [ChainGate::InReview, ChainGate::Done] {
        assert!(!deps::is_ready(&dependent, &by_id(&tasks), gate), "{gate}");
        let blocked = deps::blocked_by(&dependent, &by_id(&tasks), gate).unwrap();
        assert_eq!(blocked.pending.len(), 1);
        assert!(blocked.describe(gate).contains(&dep.id));
    }
}

#[test]
fn a_done_dependency_satisfies_both_gates() {
    let fixture = Fixture::new();
    let dep = fixture.add_with("dependency", Status::Todo, Priority::None, &[]);
    let dependent = fixture.add_with("dependent", Status::Todo, Priority::None, std::slice::from_ref(&dep.id));
    fixture.claim_next("sess-dep", std::process::id());
    commands::release(
        &fixture.layout,
        fixture.project.clone(),
        &dep.id,
        Status::InReview,
        "ready for review",
        ChainGate::InReview,
        fixture.common.now,
    )
    .expect("release");
    commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &dep.id,
        Status::Done,
        None,
    )
    .expect("done");

    let tasks = fixture.tasks();
    let dependent = tasks.iter().find(|t| t.id == dependent.id).cloned().unwrap();
    for gate in [ChainGate::InReview, ChainGate::Done] {
        assert!(deps::is_ready(&dependent, &by_id(&tasks), gate), "{gate}");
    }
}

#[test]
fn a_missing_dependency_blocks_readiness() {
    let fixture = Fixture::new();
    let task = fixture.add_with("orphan", Status::Todo, Priority::None, &[]);
    let mut stored = fixture.tasks().into_iter().find(|t| t.id == task.id).unwrap();
    stored.deps = vec!["FIX-404".into()];
    let board = kanboard::board::Board::open(&fixture.layout, fixture.project.clone()).unwrap();
    board.save(&stored).expect("save");

    let tasks = fixture.tasks();
    let task = tasks.iter().find(|t| t.id == task.id).cloned().unwrap();
    assert!(!deps::is_ready(&task, &by_id(&tasks), ChainGate::InReview));
    let blocked = deps::blocked_by(&task, &by_id(&tasks), ChainGate::InReview).unwrap();
    assert_eq!(blocked.pending[0].1, None);
    assert!(blocked.describe(ChainGate::InReview).contains("missing"));
}

#[test]
fn cycles_are_rejected() {
    let fixture = Fixture::new();
    let a = fixture.add_with("a", Status::Todo, Priority::None, &[]);
    let b = fixture.add_with("b", Status::Todo, Priority::None, std::slice::from_ref(&a.id));

    let err = commands::link(&fixture.layout, fixture.project.clone(), &fixture.common, ChainGate::InReview, &a.id, &b.id, false)
        .unwrap_err();
    assert!(err.to_string().contains("cycle"), "{err}");

    let err = commands::link(&fixture.layout, fixture.project.clone(), &fixture.common, ChainGate::InReview, &a.id, &a.id, false)
        .unwrap_err();
    assert!(err.to_string().contains("cannot depend on itself"), "{err}");
}

#[test]
fn longer_cycles_are_rejected_too() {
    let fixture = Fixture::new();
    let a = fixture.add_with("a", Status::Todo, Priority::None, &[]);
    let b = fixture.add_with("b", Status::Todo, Priority::None, std::slice::from_ref(&a.id));
    let c = fixture.add_with("c", Status::Todo, Priority::None, std::slice::from_ref(&b.id));

    let err = commands::link(&fixture.layout, fixture.project.clone(), &fixture.common, ChainGate::InReview, &a.id, &c.id, false)
        .unwrap_err();
    assert!(err.to_string().contains("cycle"), "{err}");
    assert!(err.to_string().contains(&a.id) && err.to_string().contains(&c.id));
}

#[test]
fn link_and_unlink_round_trip() {
    let fixture = Fixture::new();
    let a = fixture.add_with("a", Status::Todo, Priority::None, &[]);
    let b = fixture.add_with("b", Status::Todo, Priority::None, &[]);

    let value = commands::link(&fixture.layout, fixture.project.clone(), &fixture.common, ChainGate::InReview, &b.id, &a.id, false)
        .expect("link");
    assert_eq!(value["deps"][0], a.id.as_str());

    // Linking twice is refused.
    let err = commands::link(&fixture.layout, fixture.project.clone(), &fixture.common, ChainGate::InReview, &b.id, &a.id, false)
        .unwrap_err();
    assert!(err.to_string().contains("already depends"), "{err}");

    let value = commands::link(&fixture.layout, fixture.project.clone(), &fixture.common, ChainGate::InReview, &b.id, &a.id, true)
        .expect("unlink");
    assert!(value["deps"].as_array().unwrap().is_empty());

    let err = commands::link(&fixture.layout, fixture.project.clone(), &fixture.common, ChainGate::InReview, &b.id, &a.id, true)
        .unwrap_err();
    assert!(err.to_string().contains("does not depend"), "{err}");
}

#[test]
fn linking_a_missing_task_is_refused() {
    let fixture = Fixture::new();
    let a = fixture.add_with("a", Status::Todo, Priority::None, &[]);
    let err = commands::link(&fixture.layout, fixture.project.clone(), &fixture.common, ChainGate::InReview, &a.id, "FIX-999", false)
        .unwrap_err();
    assert!(err.to_string().contains("no such task"), "{err}");
}

#[test]
fn find_cycles_detects_a_closed_loop() {
    let fixture = Fixture::new();
    let a = fixture.add_with("a", Status::Todo, Priority::None, &[]);
    let b = fixture.add_with("b", Status::Todo, Priority::None, std::slice::from_ref(&a.id));
    // Write the back-edge by hand (the CLI refuses it).
    let mut stored = fixture.tasks().into_iter().find(|t| t.id == a.id).unwrap();
    stored.deps = vec![b.id.clone()];
    kanboard::board::Board::open(&fixture.layout, fixture.project.clone())
        .unwrap()
        .save(&stored)
        .unwrap();
    let cycles = deps::find_cycles(&fixture.tasks());
    assert_eq!(cycles.len(), 2, "{cycles:?}");
}

#[test]
fn a_dependency_still_in_backlog_locks_the_dependent() {
    let fixture = Fixture::new();
    let parked = fixture.add("parked parent"); // backlog
    let flowing = fixture.add_with("flowing parent", Status::Todo, Priority::None, &[]);
    let child = fixture.add_with("child", Status::Todo, Priority::None, &[parked.id.clone(), flowing.id.clone()]);
    let tasks = fixture.tasks();
    let child_now = tasks.iter().find(|t| t.id == child.id).cloned().unwrap();

    // Both deps are pending, but only the backlog one needs a human to schedule it.
    assert_eq!(deps::locked_by(&child_now, &by_id(&tasks), ChainGate::InReview), vec![parked.id.clone()]);
    assert!(!deps::is_ready(&child_now, &by_id(&tasks), ChainGate::InReview));

    // The JSON surfaces it for the UI and the runner.
    let listed = fixture.list_json();
    let entry = listed["tasks"].as_array().unwrap().iter().find(|t| t["id"] == child.id).unwrap();
    assert_eq!(entry["lockedBy"], serde_json::json!([parked.id]));

    // claim-next's "waiting" explains the lock too.
    let claim = fixture.claim_next("s", 1);
    // flowing parent is ready and gets claimed; the child still reports its lock.
    assert_eq!(claim["task"]["id"], flowing.id);
    let waiting = claim["waiting"].as_array().cloned().unwrap_or_default();
    let _ = waiting; // only populated when nothing is ready — covered below

    // Once the parent is scheduled, the lock clears (it may still be waiting).
    fixture.move_to(&parked.id, Status::Todo);
    let tasks = fixture.tasks();
    let child_now = tasks.iter().find(|t| t.id == child.id).cloned().unwrap();
    assert!(deps::locked_by(&child_now, &by_id(&tasks), ChainGate::InReview).is_empty());
}

#[test]
fn nothing_ready_reports_which_waits_are_locked() {
    let fixture = Fixture::new();
    let parked = fixture.add("parked parent");
    let child = fixture.add_with("child", Status::Todo, Priority::None, std::slice::from_ref(&parked.id));
    let claim = fixture.claim_next("s", 1);
    assert!(claim["task"].is_null());
    let waiting = claim["waiting"].as_array().unwrap();
    let entry = waiting.iter().find(|w| w["id"] == child.id).unwrap();
    assert_eq!(entry["lockedBy"], serde_json::json!([parked.id]));
}
