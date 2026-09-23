//! Every row of the transition table: allowed actors, denials, comment rules,
//! and final states.

mod common;

use common::Fixture;
use kanboard::error::Error;
use kanboard::model::{Actor, Priority, Status, Staleness};
use kanboard::commands;
use kanboard::transitions::{self, comment_required, rule_for, RULES};

fn allowed(from: Status, to: Status, actor: Actor, comment: Option<&str>, staleness: Staleness) -> bool {
    transitions::check(from, to, actor, comment, staleness).is_ok()
}

const REASON: Option<&str> = Some("because");

#[test]
fn every_table_row_is_reachable_and_gated() {
    assert!(!RULES.is_empty());
    for rule in RULES {
        // The comment rule is enforced where the table demands it.
        let actor = rule.actors[0];
        let comment = if comment_required(rule.from, rule.to) { REASON } else { None };
        assert!(
            allowed(rule.from, rule.to, actor, comment, Staleness::Stale),
            "{} → {} should be allowed for {}",
            rule.from,
            rule.to,
            actor
        );

        // And a missing comment is refused when the row demands one.
        if comment_required(rule.from, rule.to) {
            let err = transitions::check(rule.from, rule.to, actor, None, Staleness::Stale).unwrap_err();
            let message = err.to_string();
            assert!(
                message.contains("requires --comment"),
                "unexpected message: {message}"
            );
            assert!(message.contains(rule.from.as_str()) && message.contains(rule.to.as_str()));
        }
    }
}

#[test]
fn rework_note_message_matches_the_spec_example() {
    let err = transitions::check(Status::InReview, Status::Todo, Actor::User, None, Staleness::Running).unwrap_err();
    assert_eq!(err.to_string(), "in_review → todo requires --comment (rework note)");
}

#[test]
fn blocked_requires_a_comment_from_agent_and_system() {
    for actor in [Actor::Agent, Actor::System] {
        let err = transitions::check(Status::InProgress, Status::Blocked, actor, None, Staleness::Running).unwrap_err();
        assert!(err.to_string().contains("requires --comment"), "{err}");
        assert!(allowed(Status::InProgress, Status::Blocked, actor, REASON, Staleness::Running));
    }
    // The user cannot block a running task (the agent owns that move).
    assert!(!allowed(Status::InProgress, Status::Blocked, Actor::User, REASON, Staleness::Running));
}

#[test]
fn unblocking_requires_the_answer() {
    let err = transitions::check(Status::Blocked, Status::Todo, Actor::User, None, Staleness::Running).unwrap_err();
    assert!(err.to_string().contains("the answer, shown to the agent on next claim"), "{err}");
    assert!(allowed(Status::Blocked, Status::Todo, Actor::User, Some("use json logs"), Staleness::Running));
    // Agents may not unblock themselves.
    assert!(!allowed(Status::Blocked, Status::Todo, Actor::Agent, REASON, Staleness::Running));
}

#[test]
fn claim_and_run_end_are_system_only() {
    assert!(!allowed(Status::Todo, Status::InProgress, Actor::User, None, Staleness::Running));
    assert!(!allowed(Status::Todo, Status::InProgress, Actor::Agent, None, Staleness::Running));
    let err = transitions::check(Status::Todo, Status::InProgress, Actor::User, None, Staleness::Running).unwrap_err();
    assert!(err.to_string().contains("system only"), "{err}");
    assert!(allowed(Status::Todo, Status::InProgress, Actor::System, None, Staleness::Running));

    let err = transitions::check(Status::InProgress, Status::InReview, Actor::User, REASON, Staleness::Running).unwrap_err();
    assert!(err.to_string().contains("system only"), "{err}");
    assert!(allowed(Status::InProgress, Status::InReview, Actor::System, REASON, Staleness::Running));
}

#[test]
fn a_running_task_cannot_be_moved_by_a_user() {
    let err = transitions::check(Status::InProgress, Status::Todo, Actor::User, REASON, Staleness::Running).unwrap_err();
    assert!(err.to_string().contains("system only"), "{err}");
    let err = transitions::check(Status::InProgress, Status::Todo, Actor::User, REASON, Staleness::Unknown).unwrap_err();
    assert!(err.to_string().contains("another host"), "{err}");
    // A confirmed stale run may be released by the user.
    assert!(allowed(Status::InProgress, Status::Todo, Actor::User, REASON, Staleness::Stale));
    assert!(allowed(Status::InProgress, Status::Backlog, Actor::User, REASON, Staleness::Stale));
    // …but always with a note.
    assert!(!allowed(Status::InProgress, Status::Todo, Actor::User, None, Staleness::Stale));
}

#[test]
fn agents_cannot_finish_or_cancel() {
    for to in [Status::Done, Status::Cancelled] {
        for from in [Status::InReview, Status::Todo, Status::Backlog, Status::Blocked] {
            assert!(
                !allowed(from, to, Actor::Agent, REASON, Staleness::Running),
                "agent must not move {from} → {to}"
            );
        }
    }
    let err = transitions::check(Status::InReview, Status::Done, Actor::Agent, None, Staleness::Running).unwrap_err();
    assert!(err.to_string().contains("cannot mark tasks done"), "{err}");
    let err = transitions::check(Status::Todo, Status::Cancelled, Actor::Agent, None, Staleness::Running).unwrap_err();
    assert!(err.to_string().contains("suggest cancel"), "{err}");
}

#[test]
fn backlog_and_todo_shift_freely_for_user_and_agent() {
    assert!(allowed(Status::Backlog, Status::Todo, Actor::User, None, Staleness::Running));
    assert!(allowed(Status::Todo, Status::Backlog, Actor::User, None, Staleness::Running));
    assert!(allowed(Status::Backlog, Status::Todo, Actor::Agent, None, Staleness::Running));
    assert!(allowed(Status::Todo, Status::Backlog, Actor::Agent, None, Staleness::Running));
}

#[test]
fn final_states_are_final() {
    for final_status in [Status::Done, Status::Cancelled, Status::Archived] {
        assert!(final_status.is_final());
        for to in Status::ALL {
            // Archiving is the one documented exit for done/cancelled.
            if to == final_status || to == Status::Archived {
                continue;
            }
            assert!(
                !allowed(final_status, to, Actor::User, REASON, Staleness::Stale),
                "{final_status} → {to} must be refused"
            );
        }
    }
    let err = transitions::check(Status::Done, Status::Todo, Actor::User, REASON, Staleness::Running).unwrap_err();
    assert!(err.to_string().contains("final"), "{err}");
    assert!(err.to_string().contains("duplicate"), "hint at duplicate: {err}");
    let err = transitions::check(Status::Archived, Status::Todo, Actor::User, REASON, Staleness::Running).unwrap_err();
    assert!(err.to_string().contains("archived is final"), "{err}");
}

#[test]
fn cancelling_is_user_only_and_only_from_the_open_lanes() {
    for from in [Status::Backlog, Status::Todo, Status::Blocked] {
        assert!(allowed(from, Status::Cancelled, Actor::User, None, Staleness::Running));
    }
    assert!(!allowed(Status::InReview, Status::Cancelled, Actor::User, None, Staleness::Running));
    let err = transitions::check(Status::InReview, Status::Cancelled, Actor::User, None, Staleness::Running).unwrap_err();
    assert!(err.to_string().contains("rework note"), "hint the path back: {err}");
}

#[test]
fn archiving_is_the_only_exit_from_done_and_cancelled() {
    assert!(allowed(Status::Done, Status::Archived, Actor::User, None, Staleness::Running));
    assert!(allowed(Status::Cancelled, Status::Archived, Actor::User, None, Staleness::Running));
    assert!(allowed(Status::Done, Status::Archived, Actor::System, None, Staleness::Running));
    assert!(!allowed(Status::Todo, Status::Archived, Actor::User, None, Staleness::Running));
}

#[test]
fn same_status_is_refused() {
    let err = transitions::check(Status::Todo, Status::Todo, Actor::User, None, Staleness::Running).unwrap_err();
    assert!(err.to_string().contains("already in todo"), "{err}");
}

#[test]
fn allowed_targets_are_listed_per_actor() {
    let user_targets = transitions::allowed_targets(Status::InReview, Actor::User);
    assert!(user_targets.contains(&Status::Done));
    assert!(user_targets.contains(&Status::Todo));
    assert!(!user_targets.contains(&Status::InProgress));
    let agent_targets = transitions::allowed_targets(Status::InReview, Actor::Agent);
    assert!(agent_targets.is_empty(), "{agent_targets:?}");
}

#[test]
fn the_table_has_no_duplicate_rows() {
    for (index, rule) in RULES.iter().enumerate() {
        for other in RULES.iter().skip(index + 1) {
            assert!(
                !(rule.from == other.from && rule.to == other.to),
                "duplicate row {} → {}",
                rule.from,
                rule.to
            );
        }
    }
}

// ─── end-to-end through the board (real files, real locks) ──────────────────

#[test]
fn agent_blocks_declares_a_comment_and_the_row_becomes_readable() {
    let fixture = Fixture::new();
    let task = fixture.add_with("agent task", Status::Todo, Priority::None, &[]);
    fixture.claim_next("sess-1", std::process::id());

    let mut agent_common = fixture.common.clone();
    agent_common.actor = Actor::Agent;

    let err = commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &agent_common,
        &task.id,
        Status::Blocked,
        None,
    )
    .unwrap_err();
    assert!(matches!(err, Error::Rule(_)));
    assert!(err.to_string().contains("requires --comment"), "{err}");

    let value = commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &agent_common,
        &task.id,
        Status::Blocked,
        Some("which log format?"),
    )
    .expect("block");
    assert_eq!(value["status"], "blocked");
    let activity = value["activity"].as_array().unwrap();
    assert!(activity
        .iter()
        .any(|entry| entry["text"] == "blocked: which log format?" && entry["actor"] == "agent"));
}

#[test]
fn the_user_answers_a_blocked_task_and_the_note_survives() {
    let fixture = Fixture::new();
    let task = fixture.add_with("blocked task", Status::Todo, Priority::None, &[]);
    fixture.claim_next("sess-1", std::process::id());
    let mut agent_common = fixture.common.clone();
    agent_common.actor = Actor::Agent;
    commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &agent_common,
        &task.id,
        Status::Blocked,
        Some("need the log format"),
    )
    .expect("block");

    let err = commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &task.id,
        Status::Todo,
        None,
    )
    .unwrap_err();
    assert!(err.to_string().contains("requires --comment"));

    commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &task.id,
        Status::Todo,
        Some("json logs"),
    )
    .expect("unblock");

    let stored = fixture
        .tasks()
        .into_iter()
        .find(|candidate| candidate.id == task.id)
        .unwrap();
    assert_eq!(stored.status, Status::Todo);
    assert!(stored.run.is_none(), "unblocking clears the run block");
    assert!(stored
        .activity
        .iter()
        .any(|entry| entry.text == "unblocked: json logs"));
    assert!(stored.handoff_notes().iter().any(|entry| entry.text.contains("json logs")));
}

#[test]
fn duplicate_resets_lifecycle_fields() {
    let fixture = Fixture::new();
    let task = fixture.add_with("original", Status::Todo, Priority::High, &[]);
    fixture.claim_next("sess-1", std::process::id());
    let value = commands::duplicate(&fixture.layout, fixture.project.clone(), &fixture.common, &task.id).unwrap();
    assert_eq!(value["status"], "backlog");
    assert_eq!(value["priority"], "high");
    assert!(value["run"].is_null());
    assert_ne!(value["id"], task.id.as_str());
}

#[test]
fn rule_for_unknown_pairs_is_none() {
    assert!(rule_for(Status::Backlog, Status::Done).is_none());
    assert!(!comment_required(Status::Backlog, Status::Todo));
}
