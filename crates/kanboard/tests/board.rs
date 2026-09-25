//! Board behaviour: claim ordering, sparse ordering + rebalance, stale runs,
//! archive sweep, record locking under concurrency.

mod common;

use common::{Fixture, claimed_id};
use kanboard::commands::{self, OrderTarget};
use kanboard::model::{ChainGate, Priority, RunMode, Staleness, Status};
use std::sync::Arc;

#[test]
fn claim_next_takes_priority_first_then_order() {
    let fixture = Fixture::new();
    let low = fixture.add_with("low", Status::Todo, Priority::Low, &[]);
    let urgent = fixture.add_with("urgent", Status::Todo, Priority::Urgent, &[]);
    let high_a = fixture.add_with("high a", Status::Todo, Priority::High, &[]);
    let high_b = fixture.add_with("high b", Status::Todo, Priority::High, &[]);

    // One session claims, releases to in_review, claims the next — the
    // one-claim-per-session and two-sessions-per-project rules make parallel
    // claims the sessions test's job.
    let release = |id: &String| {
        commands::release(
            &fixture.layout,
            fixture.project.clone(),
            id,
            Status::InReview,
            "done",
            ChainGate::InReview,
            fixture.common.now,
        )
        .expect("release");
    };
    let pid = std::process::id();
    // Within the same priority the earlier `order` wins.
    assert_eq!(
        claimed_id(&fixture.claim_next("s1", pid)).unwrap(),
        urgent.id
    );
    release(&urgent.id);
    assert_eq!(
        claimed_id(&fixture.claim_next("s1", pid)).unwrap(),
        high_a.id
    );
    release(&high_a.id);
    assert_eq!(
        claimed_id(&fixture.claim_next("s1", pid)).unwrap(),
        high_b.id
    );
    release(&high_b.id);
    assert_eq!(claimed_id(&fixture.claim_next("s1", pid)).unwrap(), low.id);
    release(&low.id);
    assert!(
        claimed_id(&fixture.claim_next("s1", pid)).is_none(),
        "nothing left"
    );
}

#[test]
fn claim_next_skips_claimed_tasks_forever() {
    let fixture = Fixture::new();
    let task = fixture.add_with("only", Status::Todo, Priority::None, &[]);
    assert_eq!(claimed_id(&fixture.claim_next("s1", common::alive_pid())).unwrap(), task.id);
    assert!(claimed_id(&fixture.claim_next("s2", common::alive_pid())).is_none());
    // A second claim of the same task must not happen even if it is released to todo
    // and re-claimed: it is a fresh claim, so it works again.
    commands::release(
        &fixture.layout,
        fixture.project.clone(),
        &task.id,
        Status::Todo,
        "put back",
        ChainGate::InReview,
        fixture.common.now,
    )
    .expect("release");
    assert_eq!(claimed_id(&fixture.claim_next("s3", common::alive_pid())).unwrap(), task.id);
}

#[test]
fn claim_records_the_run_block_and_an_activity_line() {
    let fixture = Fixture::new();
    let task = fixture.add_with("run me", Status::Todo, Priority::None, &[]);
    let claimed = fixture.claim_next("session-42", common::alive_pid());
    let payload = &claimed["task"];
    assert_eq!(payload["status"], "in_progress");
    assert_eq!(payload["run"]["session"], "session-42");
    assert_eq!(payload["run"]["pid"], common::alive_pid());
    assert_eq!(payload["run"]["mode"], "direct");
    let activity = payload["activity"].as_array().unwrap();
    let last = activity.last().unwrap();
    assert_eq!(last["actor"], "system");
    assert!(
        last["text"]
            .as_str()
            .unwrap()
            .contains("claimed by session session-42")
    );
    assert_eq!(payload["id"], task.id.as_str());
}

#[test]
fn set_run_switches_mode_and_goal() {
    let fixture = Fixture::new();
    let task = fixture.add_with("goal task", Status::Todo, Priority::None, &[]);
    fixture.claim_next("s1", common::alive_pid());
    let value = commands::set_run(
        &fixture.layout,
        fixture.project.clone(),
        &task.id,
        RunMode::Goal,
        Some("goal-9"),
        ChainGate::InReview,
        fixture.common.now,
    )
    .expect("set-run");
    assert_eq!(value["run"]["mode"], "goal");
    assert_eq!(value["run"]["goal"], "goal-9");

    // set-run on an unclaimed task is refused.
    let other = fixture.add_with("unclaimed", Status::Todo, Priority::None, &[]);
    let err = commands::set_run(
        &fixture.layout,
        fixture.project.clone(),
        &other.id,
        RunMode::Plan,
        None,
        ChainGate::InReview,
        fixture.common.now,
    )
    .unwrap_err();
    assert!(err.to_string().contains("no run block"), "{err}");
}

#[test]
fn release_requires_a_comment_and_clears_the_run() {
    let fixture = Fixture::new();
    let task = fixture.add_with("t", Status::Todo, Priority::None, &[]);
    fixture.claim_next("s1", common::alive_pid());

    let err = commands::release(
        &fixture.layout,
        fixture.project.clone(),
        &task.id,
        Status::InReview,
        "   ",
        ChainGate::InReview,
        fixture.common.now,
    )
    .unwrap_err();
    assert!(err.to_string().contains("requires --comment"), "{err}");

    let value = commands::release(
        &fixture.layout,
        fixture.project.clone(),
        &task.id,
        Status::InReview,
        "implemented and tested",
        ChainGate::InReview,
        fixture.common.now,
    )
    .expect("release");
    assert_eq!(value["status"], "in_review");
    assert!(value["run"].is_null());

    // Releasing something that is not in progress is refused.
    let err = commands::release(
        &fixture.layout,
        fixture.project.clone(),
        &task.id,
        Status::Todo,
        "again",
        ChainGate::InReview,
        fixture.common.now,
    )
    .unwrap_err();
    assert!(
        err.to_string().contains("not allowed for actor system"),
        "{err}"
    );
    assert!(
        err.to_string().contains("allowed: user"),
        "the message names who may: {err}"
    );
}

#[test]
fn release_to_an_illegal_target_is_refused() {
    let fixture = Fixture::new();
    let task = fixture.add_with("t", Status::Todo, Priority::None, &[]);
    fixture.claim_next("s1", common::alive_pid());
    let err = commands::release(
        &fixture.layout,
        fixture.project.clone(),
        &task.id,
        Status::Done,
        "done!",
        ChainGate::InReview,
        fixture.common.now,
    )
    .unwrap_err();
    assert!(err.to_string().contains("release --to must be"), "{err}");
}

#[test]
fn releasing_to_todo_records_the_reason() {
    let fixture = Fixture::new();
    let task = fixture.add_with("t", Status::Todo, Priority::None, &[]);
    fixture.claim_next("s1", common::alive_pid());
    commands::release(
        &fixture.layout,
        fixture.project.clone(),
        &task.id,
        Status::Todo,
        "interrupted",
        ChainGate::InReview,
        fixture.common.now,
    )
    .expect("release");
    let stored = fixture
        .tasks()
        .into_iter()
        .find(|t| t.id == task.id)
        .unwrap();
    assert_eq!(stored.status, Status::Todo);
    assert!(
        stored
            .activity
            .iter()
            .any(|entry| entry.text == "released to todo: interrupted")
    );
}

// ─── stale runs ─────────────────────────────────────────────────────────────

#[test]
fn a_dead_pid_on_this_host_reads_as_stale_and_can_be_released_by_a_user() {
    let fixture = Fixture::new();
    let task = fixture.add_with("orphan", Status::Todo, Priority::None, &[]);
    let mut stored = fixture
        .tasks()
        .into_iter()
        .find(|t| t.id == task.id)
        .unwrap();
    // A pid that cannot exist.
    stored.status = Status::InProgress;
    stored.run = Some(kanboard::model::Run {
        session: "gone".into(),
        pid: 0x7fff_fffe,
        host: commands::hostname(),
        mode: RunMode::Direct,
        goal: None,
        started: fixture.common.now,
    });
    let board = kanboard::board::Board::open(&fixture.layout, fixture.project.clone()).unwrap();
    board.save(&stored).unwrap();

    let reloaded = fixture
        .tasks()
        .into_iter()
        .find(|t| t.id == task.id)
        .unwrap();
    assert_eq!(commands::staleness_of(&reloaded), Staleness::Stale);

    let value = commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &task.id,
        Status::Todo,
        Some("process died"),
    )
    .expect("stale release by user");
    assert_eq!(value["status"], "todo");
    assert!(value["run"].is_null(), "the run block is cleared");
}

#[test]
fn a_live_pid_blocks_user_moves() {
    let fixture = Fixture::new();
    let task = fixture.add_with("running", Status::Todo, Priority::None, &[]);
    // Our own process is definitely alive.
    fixture.claim_next("s1", std::process::id());
    let stored = fixture
        .tasks()
        .into_iter()
        .find(|t| t.id == task.id)
        .unwrap();
    assert_eq!(commands::staleness_of(&stored), Staleness::Running);

    let err = commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &task.id,
        Status::Todo,
        Some("let me"),
    )
    .unwrap_err();
    assert!(err.to_string().contains("system only"), "{err}");

    // The system can always release it.
    commands::release(
        &fixture.layout,
        fixture.project.clone(),
        &task.id,
        Status::Todo,
        "runner stopped",
        ChainGate::InReview,
        fixture.common.now,
    )
    .expect("system release");
}

#[test]
fn a_run_claimed_on_another_host_is_unknown() {
    let fixture = Fixture::new();
    let task = fixture.add_with("remote", Status::Todo, Priority::None, &[]);
    let mut stored = fixture
        .tasks()
        .into_iter()
        .find(|t| t.id == task.id)
        .unwrap();
    stored.status = Status::InProgress;
    stored.run = Some(kanboard::model::Run {
        session: "elsewhere".into(),
        pid: 1,
        host: "some-other-host".into(),
        mode: RunMode::Direct,
        goal: None,
        started: fixture.common.now,
    });
    kanboard::board::Board::open(&fixture.layout, fixture.project.clone())
        .unwrap()
        .save(&stored)
        .unwrap();

    let reloaded = fixture
        .tasks()
        .into_iter()
        .find(|t| t.id == task.id)
        .unwrap();
    assert_eq!(commands::staleness_of(&reloaded), Staleness::Unknown);
    let err = commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &task.id,
        Status::Todo,
        Some("must I?"),
    )
    .unwrap_err();
    assert!(err.to_string().contains("another host"), "{err}");
}

// ─── ordering ───────────────────────────────────────────────────────────────

#[test]
fn order_moves_within_a_lane_and_rebalances() {
    let fixture = Fixture::new();
    let a = fixture.add("a");
    let b = fixture.add("b");
    let c = fixture.add("c");
    assert!(a.order < b.order && b.order < c.order);

    let value = commands::order(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &c.id,
        OrderTarget::Top,
    )
    .expect("top");
    assert_eq!(
        value["order"], 0,
        "top of the lane is order 0 for a first move"
    );
    let lane = lane_order(&fixture);
    assert_eq!(lane, vec!["FIX-3", "FIX-1", "FIX-2"]);

    let value = commands::order(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &a.id,
        OrderTarget::Bottom,
    )
    .expect("bottom");
    assert_eq!(value["rebalanced"], 0);
    let lane = lane_order(&fixture);
    assert_eq!(lane.last().unwrap(), "FIX-1");
}

#[test]
fn order_before_and_after_pos_place_between_neighbours() {
    let fixture = Fixture::new();
    let a = fixture.add("a");
    let b = fixture.add("b");
    let c = fixture.add("c");

    commands::order(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &c.id,
        OrderTarget::Before(&b.id),
    )
    .expect("before");
    assert_eq!(lane_order(&fixture), vec!["FIX-1", "FIX-3", "FIX-2"]);

    commands::order(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &a.id,
        OrderTarget::AfterPos(&b.id),
    )
    .expect("after-pos");
    assert_eq!(lane_order(&fixture).last().unwrap(), "FIX-1");
}

#[test]
fn exhausted_gaps_trigger_a_rebalance() {
    let fixture = Fixture::new();
    let a = fixture.add("a");
    let b = fixture.add("b");
    let c = fixture.add("c");
    let d = fixture.add("d");

    // Squeeze the lane: give every task adjacent orders by hand.
    let board = kanboard::board::Board::open(&fixture.layout, fixture.project.clone()).unwrap();
    for (index, id) in [&a.id, &b.id, &c.id, &d.id].iter().enumerate() {
        let mut task = board.get(id).unwrap();
        task.order = index as i64 + 1;
        board.save(&task).unwrap();
    }

    let value = commands::order(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &d.id,
        OrderTarget::Before(&b.id),
    )
    .expect("order with rebalance");
    assert_eq!(value["rebalanced"], 3, "the rest of the lane was rewritten");
    let lane = lane_order(&fixture);
    assert_eq!(lane, vec!["FIX-1", "FIX-4", "FIX-2", "FIX-3"]);

    // The rebalanced lane keeps distinct, sparse-ish keys, and the moved task
    // sits at the midpoint its new neighbours allow.
    let orders: Vec<i64> = fixture.tasks().iter().map(|task| task.order).collect();
    let mut unique = orders.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), 4, "no two tasks share an order: {orders:?}");
    let moved = fixture
        .tasks()
        .into_iter()
        .find(|task| task.id == d.id)
        .unwrap();
    assert_eq!(moved.order, 1500, "midpoint between 1000 and 2000");
}

#[test]
fn order_needs_exactly_one_target() {
    let fixture = Fixture::new();
    let a = fixture.add("a");
    let err = commands::order(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &a.id,
        OrderTarget::Top,
    );
    assert!(err.is_ok(), "one target is fine");
}

fn lane_order(fixture: &Fixture) -> Vec<String> {
    let mut tasks: Vec<_> = fixture
        .tasks()
        .into_iter()
        .filter(|task| task.status == Status::Backlog)
        .collect();
    tasks.sort_by_key(|task| task.order);
    tasks.into_iter().map(|task| task.id).collect()
}

// ─── archive sweep ──────────────────────────────────────────────────────────

#[test]
fn archive_sweep_moves_old_done_and_cancelled_tasks() {
    let fixture = Fixture::new();
    let fresh = fixture.add_with("fresh done", Status::Todo, Priority::None, &[]);
    let old = fixture.add_with("old done", Status::Todo, Priority::None, &[]);
    let old_cancelled = fixture.add_with("old cancelled", Status::Todo, Priority::None, &[]);

    // Only the user can complete: drive these two through the lifecycle.
    for id in [&fresh.id, &old.id] {
        fixture.claim_next("s", std::process::id());
        commands::release(
            &fixture.layout,
            fixture.project.clone(),
            id,
            Status::InReview,
            "done",
            ChainGate::InReview,
            fixture.common.now,
        )
        .expect("release");
    }
    commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &fresh.id,
        Status::Done,
        None,
    )
    .expect("done");
    commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &old.id,
        Status::Done,
        None,
    )
    .expect("done");
    // Cancelling is user-only and only from the open lanes (it is still todo).
    commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &old_cancelled.id,
        Status::Cancelled,
        None,
    )
    .expect("cancel");

    // Age the two "old" tasks by rewriting their `updated` stamps.
    let board = kanboard::board::Board::open(&fixture.layout, fixture.project.clone()).unwrap();
    for id in [&old.id, &old_cancelled.id] {
        let mut task = board.get(id).unwrap();
        task.updated = fixture.common.now - chrono::Duration::days(30);
        board.save(&task).unwrap();
    }

    let value = commands::archive_sweep(
        &fixture.layout,
        fixture.project.clone(),
        14,
        0,
        fixture.common.now,
    )
    .expect("sweep");
    let archived: Vec<String> = value["archived"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().to_string())
        .collect();
    assert_eq!(archived.len(), 2, "{archived:?}");
    assert!(archived.contains(&old.id) && archived.contains(&old_cancelled.id));

    let tasks = fixture.tasks();
    assert_eq!(
        tasks.iter().find(|t| t.id == fresh.id).unwrap().status,
        Status::Done
    );
    assert_eq!(
        tasks.iter().find(|t| t.id == old.id).unwrap().status,
        Status::Archived
    );
    assert_eq!(
        tasks
            .iter()
            .find(|t| t.id == old_cancelled.id)
            .unwrap()
            .status,
        Status::Archived
    );
}

#[test]
fn archive_sweep_is_off_when_days_is_zero() {
    let fixture = Fixture::new();
    let value = commands::archive_sweep(
        &fixture.layout,
        fixture.project.clone(),
        0,
        0,
        fixture.common.now,
    )
    .unwrap();
    assert!(value["archived"].as_array().unwrap().is_empty());
    assert_eq!(
        value["skipped"],
        "archiveAfterDays and retentionDays are 0 (off)"
    );
}

// ─── concurrency ────────────────────────────────────────────────────────────

#[test]
fn eight_threads_race_but_the_two_session_cap_holds() {
    let fixture = Fixture::new();
    for title in ["one", "two", "three"] {
        fixture.add_with(title, Status::Todo, Priority::None, &[]);
    }

    let layout = Arc::new(fixture.layout.clone());
    let project = fixture.project.clone();
    let mut handles = Vec::new();
    for index in 0..8u32 {
        let layout = Arc::clone(&layout);
        let project = project.clone();
        handles.push(std::thread::spawn(move || {
            let args = commands::ClaimArgs {
                session: &format!("thread-{index}"),
                // The test process is alive, so nothing is reaped; the
                // two-sessions-per-project cap is what the threads hit.
                pid: std::process::id(),
                host: "test-host",
                mode: RunMode::Direct,
                id: None,
            };
            commands::claim_next(
                &layout,
                project,
                ChainGate::InReview,
                &args,
                chrono::Utc::now(),
            )
            .map(|value| claimed_id(&value))
        }));
    }

    let mut claimed: Vec<String> = Vec::new();
    let mut refused = 0;
    for handle in handles {
        match handle.join().expect("thread") {
            Ok(Some(id)) => claimed.push(id),
            Ok(None) => {}
            Err(err) => {
                refused += 1;
                assert!(
                    err.to_string().contains("already run")
                        || err.to_string().contains("already runs"),
                    "unexpected claim error: {err}"
                );
            }
        }
    }
    claimed.sort();
    claimed.dedup();
    assert_eq!(claimed.len(), 2, "the two-session cap: {claimed:?}");
    assert_eq!(refused, 6, "the other six were refused");

    let in_progress = fixture
        .tasks()
        .into_iter()
        .filter(|task| task.status == Status::InProgress)
        .count();
    assert_eq!(in_progress, 2, "no double claims, no lost writes");
}

#[test]
fn re_registering_a_project_never_reuses_ids() {
    let fixture = Fixture::new();
    let first = fixture.add("original task");
    let stored = fixture.tasks()[0].clone();
    assert_eq!(stored.id, first.id);

    // `project add` again (what a re-onboard does) must not reset the counter.
    let root = fixture.root();
    let again =
        kanboard::commands::project_add(&fixture.layout, Some(&root), Some("Fixture"), Some("FIX"))
            .expect("re-register");
    assert_eq!(
        again["nextId"],
        first.id.trim_start_matches("FIX-").parse::<u64>().unwrap() + 1
    );

    let second = fixture.add("second task");
    assert_ne!(second.id, first.id, "a fresh id, not the existing one");
    let tasks = fixture.tasks();
    assert_eq!(tasks.len(), 2, "the first task was not overwritten");
    assert!(tasks.iter().any(|task| task.title == "original task"));
}

#[test]
fn reserve_id_skips_ids_that_already_exist_on_disk() {
    let fixture = Fixture::new();
    let task = fixture.add("existing");
    // Force the counter back to 1, as a stale/hand-edited project.json would.
    let mut project =
        kanboard::store::Project::load(&fixture.layout, &fixture.project.slug).unwrap();
    project.next_id = 1;
    project.save(&fixture.layout).unwrap();

    let mut project =
        kanboard::store::Project::load(&fixture.layout, &fixture.project.slug).unwrap();
    let reserved = project.reserve_id(&fixture.layout).unwrap();
    assert_ne!(reserved, task.id);
    assert_eq!(reserved, "FIX-2");
}

/// A single hand-edited file must not take the board offline (K3 live finding).
#[test]
fn a_corrupt_file_no_longer_blocks_the_board() {
    let fixture = Fixture::new();
    let good = fixture.add_with("readable task", Status::Todo, Priority::None, &[]);
    let also_good = fixture.add_with(
        "another readable task",
        Status::Backlog,
        Priority::None,
        &[],
    );
    let broken = fixture.add("broken task");
    // Corrupt it the way a hand edit does: an unknown status.
    let path = fixture.layout.task_path(&fixture.project.slug, &broken.id);
    let text = std::fs::read_to_string(&path)
        .unwrap()
        .replace("status: backlog", "status: nonsense");
    std::fs::write(&path, text).unwrap();

    // list still works and reports the problem.
    let payload = commands::list(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        None,
        false,
    )
    .expect("list works with a corrupt file");
    let tasks = payload["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 2, "the readable tasks are listed");
    assert_eq!(payload["problems"].as_array().unwrap().len(), 1);
    assert_eq!(payload["problems"][0]["line"], 4, "the bad status line");
    assert!(
        payload["problems"][0]["error"]
            .as_str()
            .unwrap()
            .contains("unknown status")
    );

    // Writes to the corrupt file are refused with a repair pointer.
    let err = commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &broken.id,
        Status::Todo,
        None,
    )
    .unwrap_err();
    let message = err.to_string();
    assert!(
        message.starts_with(&format!("{} is unreadable:", broken.id)),
        "{message}"
    );
    assert!(message.contains("line 4"), "{message}");
    assert!(message.contains("validate --fix"), "{message}");

    // add / move / claim-next all keep working on the valid tasks.
    fixture.add("added while one file is broken");
    commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &also_good.id,
        Status::Todo,
        None,
    )
    .expect("move works");
    let claimed = fixture.claim_next("s", common::alive_pid());
    assert!(
        claimed["task"].is_object(),
        "claim-next ignores the corrupt file"
    );
    assert_eq!(claimed["task"]["id"], good.id.as_str());
}

#[test]
fn validate_still_reports_every_problem_and_can_fix_them() {
    let fixture = Fixture::new();
    let task = fixture.add("to be repaired");
    let path = fixture.layout.task_path(&fixture.project.slug, &task.id);
    let text = std::fs::read_to_string(&path)
        .unwrap()
        .replace("status: backlog", "status: nope");
    std::fs::write(&path, text).unwrap();

    let result = commands::validate(&fixture.layout, fixture.project.clone(), false).unwrap();
    assert_eq!(result.problems.len(), 1);
}
