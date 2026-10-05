//! UNI-100: agent-created labels must reuse an existing project label unless
//! `--new-label` explicitly opts in; matching is case-insensitive and trimmed,
//! the stored (first-seen) spelling wins, and the union spans every lane
//! including archived.

mod common;

use common::{Fixture, task_from};
use kanboard::commands::{self, Common, EditArgs};
use kanboard::model::{Actor, Priority, Status};

fn agent(fixture: &Fixture) -> Common {
    let mut common = fixture.common.clone();
    common.actor = Actor::Agent;
    common
}

#[test]
fn an_unknown_label_is_refused_with_the_sorted_existing_list() {
    let fixture = Fixture::new();
    fixture.add_labeled("first", Status::Backlog, Priority::None, &[], &["web".to_string()]);
    fixture.add_labeled(
        "second",
        Status::Backlog,
        Priority::None,
        &[],
        &["Mobile".to_string()],
    );

    let err = commands::add(
        &fixture.layout,
        fixture.project.clone(),
        &agent(&fixture),
        "third",
        None,
        Some(Status::Backlog),
        Priority::None,
        &[],
        &[],
        &["backend".to_string()],
        false,
    )
    .unwrap_err();
    assert_eq!(
        err.to_string(),
        "unknown label \"backend\" — existing labels: Mobile, web. Reuse one, or pass --new-label to create it on purpose."
    );
}

/// The "no labels exist yet" case carries no "unknown label" prefix and no
/// trailing period — exact wording: `no labels exist yet — pass --new-label
/// to create "X"`.
#[test]
fn no_labels_yet_names_the_attempted_label_in_the_none_case() {
    let fixture = Fixture::new();
    let err = commands::add(
        &fixture.layout,
        fixture.project.clone(),
        &agent(&fixture),
        "first",
        None,
        Some(Status::Backlog),
        Priority::None,
        &[],
        &[],
        &["backend".to_string()],
        false,
    )
    .unwrap_err();
    assert_eq!(
        err.to_string(),
        "no labels exist yet — pass --new-label to create \"backend\""
    );
}

#[test]
fn new_label_opts_in_to_creating_an_unknown_one() {
    let fixture = Fixture::new();
    let value = commands::add(
        &fixture.layout,
        fixture.project.clone(),
        &agent(&fixture),
        "first",
        None,
        Some(Status::Backlog),
        Priority::None,
        &[],
        &[],
        &["backend".to_string()],
        true,
    )
    .unwrap();
    assert_eq!(value["labels"], serde_json::json!(["backend"]));
}

/// Matching is case-insensitive and trimmed, and the stored (first-seen)
/// spelling is what lands on the new task — not whatever case the caller typed.
#[test]
fn matching_is_case_insensitive_and_trimmed_and_keeps_the_stored_spelling() {
    let fixture = Fixture::new();
    fixture.add_labeled(
        "canon",
        Status::Backlog,
        Priority::None,
        &[],
        &["Backend".to_string()],
    );

    let value = commands::add(
        &fixture.layout,
        fixture.project.clone(),
        &agent(&fixture),
        "reuse",
        None,
        Some(Status::Backlog),
        Priority::None,
        &[],
        &[],
        &["  backend  ".to_string()],
        false,
    )
    .unwrap();
    assert_eq!(value["labels"], serde_json::json!(["Backend"]));
}

/// The union spans every lane, including archived tasks.
#[test]
fn the_existing_label_set_includes_archived_tasks() {
    let fixture = Fixture::new();
    let archived = fixture.add_labeled(
        "old",
        Status::Backlog,
        Priority::None,
        &[],
        &["legacy".to_string()],
    );
    // Backlog/Todo → Cancelled → Archived is the one path open to a plain
    // user actor without a claim.
    commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &archived.id,
        Status::Cancelled,
        None,
    )
    .expect("cancel");
    commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &archived.id,
        Status::Archived,
        None,
    )
    .expect("archive");

    let value = commands::add(
        &fixture.layout,
        fixture.project.clone(),
        &agent(&fixture),
        "new",
        None,
        Some(Status::Backlog),
        Priority::None,
        &[],
        &[],
        &["LEGACY".to_string()],
        false,
    )
    .unwrap();
    assert_eq!(value["labels"], serde_json::json!(["legacy"]));
}

/// UNI-100's guard is agent-only (the web UI/user keeps creating labels on
/// the spot, same as before); an agent may only edit a task it created
/// while in backlog/todo, so the task under test is created by the agent too.
#[test]
fn edit_labels_follow_the_same_rule() {
    let fixture = Fixture::new();
    fixture.add_labeled(
        "first",
        Status::Backlog,
        Priority::None,
        &[],
        &["web".to_string()],
    );
    let agent_common = agent(&fixture);
    let task = task_from(
        &commands::add(
            &fixture.layout,
            fixture.project.clone(),
            &agent_common,
            "to edit",
            None,
            Some(Status::Backlog),
            Priority::None,
            &[],
            &[],
            &[],
            true,
        )
        .unwrap(),
    );

    let err = commands::edit(
        &fixture.layout,
        fixture.project.clone(),
        &agent_common,
        &task.id,
        EditArgs {
            title: None,
            body: None,
            priority: None,
            labels: Some(vec!["mobile".to_string()]),
            new_label: false,
        },
    )
    .unwrap_err();
    assert_eq!(
        err.to_string(),
        "unknown label \"mobile\" — existing labels: web. Reuse one, or pass --new-label to create it on purpose."
    );

    let value = commands::edit(
        &fixture.layout,
        fixture.project.clone(),
        &agent_common,
        &task.id,
        EditArgs {
            title: None,
            body: None,
            priority: None,
            labels: Some(vec!["WEB".to_string()]),
            new_label: false,
        },
    )
    .expect("reuse an existing label, any case");
    assert_eq!(value["labels"], serde_json::json!(["web"]));

    let value = commands::edit(
        &fixture.layout,
        fixture.project.clone(),
        &agent_common,
        &task.id,
        EditArgs {
            title: None,
            body: None,
            priority: None,
            labels: Some(vec!["mobile".to_string()]),
            new_label: true,
        },
    )
    .expect("edit --new-label opts in");
    assert_eq!(value["labels"], serde_json::json!(["mobile"]));
}

#[test]
fn duplicate_unknown_labels_in_one_call_report_the_first_offender() {
    let fixture = Fixture::new();
    fixture.add_labeled(
        "first",
        Status::Backlog,
        Priority::None,
        &[],
        &["web".to_string()],
    );
    let err = commands::add(
        &fixture.layout,
        fixture.project.clone(),
        &agent(&fixture),
        "second",
        None,
        Some(Status::Backlog),
        Priority::None,
        &[],
        &[],
        &["web".to_string(), "nope".to_string()],
        false,
    )
    .unwrap_err();
    assert!(err.to_string().contains("unknown label \"nope\""), "{err}");
}

// CLI-level coverage (the real binary's `add --label`/`edit --labels` and
// `--new-label` round-trip) lives in tests/cli.rs, per the user's request to
// keep binary-exercising label tests there rather than here.

