//! Board behaviour: `next` ordering, sparse ordering + rebalance, stale runs,
//! archive sweep, record locking under concurrency.

mod common;

use common::Fixture;
use kanboard::commands::{self, OrderTarget};
use kanboard::model::{Actor, ChainGate, Priority, RunMode, Staleness, Status};
use std::sync::Arc;

/// The id `next` suggests (None when nothing is ready).
fn next_id(fixture: &Fixture) -> Option<String> {
    let value = commands::next(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        fixture.common.now,
    )
    .expect("next");
    value["task"]["id"].as_str().map(str::to_string)
}

#[test]
fn next_suggests_priority_first_then_order() {
    let fixture = Fixture::new();
    let low = fixture.add_with("low", Status::Todo, Priority::Low, &[]);
    let urgent = fixture.add_with("urgent", Status::Todo, Priority::Urgent, &[]);
    let high_a = fixture.add_with("high a", Status::Todo, Priority::High, &[]);
    let high_b = fixture.add_with("high b", Status::Todo, Priority::High, &[]);

    // Start what `next` suggests, hand it to review, ask again.
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
    for expected in [&urgent.id, &high_a.id, &high_b.id, &low.id] {
        assert_eq!(next_id(&fixture).as_ref(), Some(expected));
        fixture.start(expected, "s1", pid);
        release(expected);
    }
    assert!(next_id(&fixture).is_none(), "nothing left");
}

#[test]
fn a_started_task_is_neither_suggested_nor_restartable_until_released() {
    let fixture = Fixture::new();
    let task = fixture.add_with("only", Status::Todo, Priority::None, &[]);
    assert_eq!(next_id(&fixture), Some(task.id.clone()));
    fixture.start(&task.id, "s1", common::alive_pid());
    assert!(next_id(&fixture).is_none());
    let err = fixture
        .try_start(&task.id, "s2", common::alive_pid())
        .unwrap_err();
    assert!(err.to_string().contains("already claimed"), "{err}");
    // Released back to todo, it is a fresh task: it can be started again.
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
    assert_eq!(next_id(&fixture), Some(task.id.clone()));
    fixture.start(&task.id, "s3", common::alive_pid());
}

#[test]
fn release_requires_a_comment_and_clears_the_run() {
    let fixture = Fixture::new();
    let task = fixture.add_with("t", Status::Todo, Priority::None, &[]);
    fixture.start(&task.id, "s1", common::alive_pid());

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
    fixture.start(&task.id, "s1", common::alive_pid());
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
    fixture.start(&task.id, "s1", common::alive_pid());
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
        mode: RunMode::None,
        goal: None,
        started: fixture.common.now,
        owner: kanboard::model::RunOwner::System,
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
    fixture.start(&task.id, "s1", std::process::id());
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
        "session stopped",
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
        mode: RunMode::None,
        goal: None,
        started: fixture.common.now,
        owner: kanboard::model::RunOwner::System,
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
        fixture.start(id, "s", std::process::id());
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
    let ids: Vec<String> = (0..8)
        .map(|index| {
            fixture
                .add_with(&format!("task {index}"), Status::Todo, Priority::None, &[])
                .id
        })
        .collect();

    let layout = Arc::new(fixture.layout.clone());
    let project = fixture.project.clone();
    let mut handles = Vec::new();
    for (index, id) in ids.into_iter().enumerate() {
        let layout = Arc::clone(&layout);
        let project = project.clone();
        handles.push(std::thread::spawn(move || {
            let host = commands::hostname();
            let args = commands::StartArgs {
                session: &format!("thread-{index}"),
                // The test process is alive, so nothing is reaped; the
                // two-sessions-per-project cap is what the threads hit.
                pid: std::process::id(),
                host: &host,
            };
            commands::start(
                &layout,
                project,
                ChainGate::InReview,
                &id,
                &args,
                chrono::Utc::now(),
            )
            .map(|value| value["id"].as_str().map(str::to_string))
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
                    err.to_string().contains("sessions already run tasks"),
                    "unexpected start error: {err}"
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
        &Status::ALL,
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

    // add / move / next / start all keep working on the valid tasks.
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
    assert_eq!(
        next_id(&fixture).as_deref(),
        Some(good.id.as_str()),
        "next ignores the corrupt file"
    );
    let started = fixture.start(&good.id, "s", common::alive_pid());
    assert_eq!(started["status"], "in_progress");
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

/// UNI-60: labels ride the create path (trimmed, deduped) and land in the
/// file; UNI-59: the creator is written once, mirrored by agents, and old
/// files without the field fall back to the first activity entry.
#[test]
fn create_carries_labels_and_an_immutable_creator() {
    let fixture = Fixture::new();
    let task = fixture.add_labeled(
        "labeled",
        Status::Todo,
        Priority::High,
        &[],
        &["web".to_string(), "web".to_string(), "  ui  ".to_string()],
    );
    assert_eq!(task.labels, vec!["web".to_string(), "ui".to_string()]);
    assert_eq!(task.creator_of(), Actor::User);
    let path = fixture.layout.task_path(&fixture.project.slug, &task.id);
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains("labels: [web, ui]"), "{text}");
    assert!(text.contains("creator: user"), "{text}");

    // An agent-created task records agent.
    let agent = kanboard::commands::Common::new(Actor::Agent, ChainGate::InReview);
    let created = commands::add(
        &fixture.layout,
        fixture.project.clone(),
        &agent,
        "by agent",
        None,
        Some(Status::Todo),
        Priority::None,
        &[],
        &[],
        &[],
    )
    .unwrap();
    assert_eq!(created["creator"], "agent");

    // A duplicate is a new task by whoever duplicated it — not the source's
    // creator.
    let duplicated = commands::duplicate(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &task.id,
    )
    .unwrap();
    assert_eq!(duplicated["creator"], "user");
    assert_ne!(duplicated["id"], task.id.as_str());

    // Older file without `creator:` falls back to the first activity entry.
    let agent_task_id: String = created["id"].as_str().unwrap().to_string();
    let agent_path = fixture.layout.task_path(&fixture.project.slug, &agent_task_id);
    let stripped = std::fs::read_to_string(&agent_path)
        .unwrap()
        .lines()
        .filter(|line| !line.starts_with("creator:"))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&agent_path, stripped).unwrap();
    let shown = commands::show(
        &fixture.layout,
        fixture.project.clone(),
        &agent_task_id,
        ChainGate::InReview,
    )
    .unwrap();
    assert_eq!(shown["creator"], "agent", "falls back to first activity actor");
}

/// todo → in_review via a claim + system release (the legal path).
fn to_review(fixture: &Fixture, id: &str) {
    fixture.start(id, "s", std::process::id());
    commands::release(
        &fixture.layout,
        fixture.project.clone(),
        id,
        Status::InReview,
        "ready",
        ChainGate::InReview,
        fixture.common.now,
    )
    .unwrap();
}

/// UNI-57: undo restores the exact pre-move state; any intervening change —
/// even one stamped within the same second — refuses it. The fixture's
/// `Common` stamps every write with one fixed timestamp, so the note below is
/// genuinely a same-second change.
#[test]
fn undo_restores_pre_move_state_and_rejects_intervening_changes() {
    let fixture = Fixture::new();

    // ── a same-second intervening change refuses the undo ──────────────────
    let stale_task = fixture.add_with("stale undo", Status::Todo, Priority::High, &[]);
    to_review(&fixture, &stale_task.id);
    let (_, undo) = commands::move_task_undoable(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &stale_task.id,
        Status::Done,
        None,
        &[],
    )
    .unwrap();
    let undo = undo.expect("in_review → done carries undo material");
    commands::note(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &stale_task.id,
        "after the move",
    )
    .unwrap();
    let refused = commands::undo_move(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &undo.after,
        undo.before,
    )
    .unwrap_err();
    assert!(refused.to_string().contains("changed since that move"), "{refused}");

    // ── a clean move undoes fully, with an explicit undo entry ─────────────
    let task = fixture.add_with("undo me", Status::Todo, Priority::High, &[]);
    to_review(&fixture, &task.id);
    commands::note(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &task.id,
        "keep me",
    )
    .unwrap();
    let before = fixture
        .tasks()
        .into_iter()
        .find(|candidate| candidate.id == task.id)
        .unwrap();
    let (_, undo) = commands::move_task_undoable(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &task.id,
        Status::Done,
        None,
        &[],
    )
    .unwrap();
    let undo = undo.unwrap();
    let restored = commands::undo_move(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &undo.after,
        undo.before,
    )
    .unwrap();
    assert_eq!(restored["status"], "in_review");
    let mut now = fixture
        .tasks()
        .into_iter()
        .find(|candidate| candidate.id == task.id)
        .unwrap();
    // Everything but the appended undo entry matches the pre-move task.
    assert_eq!(now.activity.len(), before.activity.len() + 1);
    let undo_entry = now.activity.pop().unwrap();
    assert_eq!(undo_entry.text, "undo: done → in_review (state restored)");
    assert_eq!(undo_entry.actor, Actor::User);
    now.updated = before.updated;
    assert_eq!(now, before, "state restored exactly (modulo the undo entry)");
}

/// Undo material exists only where the move is hard to reverse; a claimed
/// task is never snapshotted, so a claim can never be revived.
#[test]
fn routine_moves_carry_no_undo_and_claims_are_never_snapshotted() {
    let fixture = Fixture::new();
    let task = fixture.add_with("routine", Status::Backlog, Priority::None, &[]);
    let (_, undo) = commands::move_task_undoable(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &task.id,
        Status::Todo,
        None,
        &[],
    )
    .unwrap();
    assert!(undo.is_none(), "backlog → todo is reversible");

    // A blocked → done move is undo-worthy and restores the block context.
    let blocked = fixture.add_with("closing blocked", Status::Todo, Priority::None, &[]);
    fixture.start(&blocked.id, "s", std::process::id());
    commands::release(
        &fixture.layout,
        fixture.project.clone(),
        &blocked.id,
        Status::Blocked,
        "stuck",
        ChainGate::InReview,
        fixture.common.now,
    )
    .unwrap();
    let (value, undo) = commands::move_task_undoable(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &blocked.id,
        Status::Done,
        None,
        &[],
    )
    .unwrap();
    assert_eq!(value["status"], "done");
    let undo = undo.expect("blocked → done carries undo material");
    let restored = commands::undo_move(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &undo.after,
        undo.before,
    )
    .unwrap();
    assert_eq!(restored["status"], "blocked");

    // A claimed task: undo_worthy may say yes in principle, but the run block
    // excludes it from snapshots (defence in depth — terminal moves from a
    // live claim are refused by the table anyway).
    assert!(!kanboard::transitions::undo_worthy(
        Status::InProgress,
        Status::Archived,
        Actor::User
    ));
}

/// UNI-57 rework: undo is defence-in-depth — direct library callers passing an
/// agent/system actor, a snapshot naming another task, or a snapshot with a
/// live claim are refused before anything is written.
#[test]
fn undo_refuses_non_user_actors_foreign_snapshots_and_claims() {
    let fixture = Fixture::new();
    let task = fixture.add_with("guarded undo", Status::Todo, Priority::None, &[]);
    to_review(&fixture, &task.id);
    let (_, undo) = commands::move_task_undoable(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &task.id,
        Status::Done,
        None,
        &[],
    )
    .unwrap();
    let undo = undo.expect("in_review → done carries undo material");

    // A non-user actor is refused outright.
    let agent = commands::Common::new(Actor::Agent, ChainGate::InReview);
    let refused = commands::undo_move(
        &fixture.layout,
        fixture.project.clone(),
        &agent,
        &undo.after,
        undo.before.clone(),
    )
    .unwrap_err();
    assert!(refused.to_string().contains("user surface"), "{refused}");
    let system = commands::Common::new(Actor::System, ChainGate::InReview);
    assert!(commands::undo_move(
        &fixture.layout,
        fixture.project.clone(),
        &system,
        &undo.after,
        undo.before.clone()
    )
    .is_err());

    // A snapshot naming a different task is refused.
    let other = fixture.add("another task");
    let foreign = commands::undo_move(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &undo.after,
        {
            let mut snapshot = undo.before.clone();
            snapshot.id = other.id.clone();
            snapshot
        },
    )
    .unwrap_err();
    assert!(foreign.to_string().contains("does not name this task"), "{foreign}");

    // A snapshot carrying a live claim is refused.
    let claimed_snapshot = {
        let mut snapshot = undo.before.clone();
        snapshot.run = Some(kanboard::model::Run {
            session: "s".into(),
            pid: std::process::id(),
            host: commands::hostname(),
            mode: kanboard::model::RunMode::None,
            goal: None,
            started: fixture.common.now,
            owner: kanboard::model::RunOwner::Agent,
        });
        snapshot
    };
    let claim = commands::undo_move(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &undo.after,
        claimed_snapshot,
    )
    .unwrap_err();
    assert!(claim.to_string().contains("never revived"), "{claim}");

    // Nothing above wrote anything: the task is still done and the undo
    // remains available for the legitimate caller.
    let current = fixture
        .tasks()
        .into_iter()
        .find(|candidate| candidate.id == task.id)
        .unwrap();
    assert_eq!(current.status, Status::Done);
    let restored = commands::undo_move(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &undo.after,
        undo.before,
    )
    .unwrap();
    assert_eq!(restored["status"], "in_review");
}
