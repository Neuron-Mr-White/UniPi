//! Cold storage: retention sweep moves old Archived/Cancelled tasks to
//! projects/<slug>/cold/, out of every scan but resolvable for dep checks.

mod common;

use common::{Fixture, cli};
use kanboard::model::{Priority, Status};

fn set_updated(fixture: &Fixture, id: &str, days_ago: i64) {
    let board = kanboard::board::Board::open(&fixture.layout, fixture.project.clone()).unwrap();
    let mut task = board.get(id).unwrap();
    task.updated = fixture.common.now - chrono::Duration::days(days_ago);
    board.save(&task).unwrap();
}

fn archive_done(fixture: &Fixture, title: &str) -> String {
    let task = fixture.add_with(title, Status::Todo, Priority::None, &[]);
    let id = common::claimed_id(&fixture.claim_next("s", 999_999)).unwrap();
    assert_eq!(id, task.id);
    let _ = cli(
        fixture,
        &["release", &id, "--to", "in_review", "--comment", "done"],
    );
    fixture.move_to(&id, Status::Done);
    fixture.move_to(&id, Status::Archived);
    id
}

#[test]
fn retention_moves_old_archived_and_cancelled_to_cold() {
    let fixture = Fixture::new();
    let old = archive_done(&fixture, "old archived");
    let cancelled = fixture.add_with("old cancelled", Status::Todo, Priority::None, &[]);
    fixture.move_to(&cancelled.id, Status::Cancelled);
    let fresh = archive_done(&fixture, "fresh archived");
    set_updated(&fixture, &old, 100);
    set_updated(&fixture, &cancelled.id, 100);
    set_updated(&fixture, &fresh, 10);

    let output = cli(
        &fixture,
        &[
            "archive-sweep",
            "--after-days",
            "0",
            "--retention-days",
            "90",
            "--json",
        ],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let cold: Vec<String> = serde_json::from_value(value["cold"].clone()).unwrap();
    assert!(cold.contains(&old), "{cold:?}");
    assert!(cold.contains(&cancelled.id), "{cold:?}");
    assert!(!cold.contains(&fresh), "{cold:?}");

    // The file moved, keeps its frozen status, and carries the note.
    let dir = fixture
        .layout
        .project_dir(&fixture.project.slug)
        .join("cold");
    let text = std::fs::read_to_string(dir.join(format!("{old}.md"))).unwrap();
    assert!(text.contains("status: archived"), "{text}");
    assert!(
        text.contains("moved to cold storage after 90 days"),
        "{text}"
    );
    assert!(
        !fixture
            .layout
            .task_path(&fixture.project.slug, &old)
            .exists()
    );

    // list/board never show cold tasks; show errors clearly.
    let listed = cli(&fixture, &["list", "--json"]);
    let tasks: serde_json::Value = serde_json::from_slice(&listed.stdout).unwrap();
    let ids: Vec<String> = tasks["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["id"].as_str().map(str::to_string))
        .collect();
    assert!(
        !ids.iter().any(|id| id == &old),
        "cold task in list: {ids:?}"
    );
    let shown = cli(&fixture, &["show", &old]);
    assert!(!shown.status.success());
    assert!(String::from_utf8_lossy(&shown.stderr).contains("cold storage"));

    // New ids never reuse a cold one.
    let next = fixture.add("new task");
    assert_ne!(next.id, old);
}

#[test]
fn a_cold_dep_resolves_with_its_frozen_status() {
    let fixture = Fixture::new();
    let dep = archive_done(&fixture, "dependency");
    let dependent = fixture.add_with(
        "dependent",
        Status::Todo,
        Priority::None,
        std::slice::from_ref(&dep),
    );
    set_updated(&fixture, &dep, 100);
    cli(
        &fixture,
        &["archive-sweep", "--retention-days", "90", "--json"],
    );

    // Dep is in cold storage but its frozen `archived` status satisfies the gate.
    let next = cli(&fixture, &["next", "--json"]);
    let value: serde_json::Value = serde_json::from_slice(&next.stdout).unwrap();
    assert_eq!(
        value["task"]["id"], dependent.id,
        "cold archived dep satisfies"
    );
    let dep_entry = value["waiting"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["id"] == dependent.id)
        .expect("dependent listed");
    assert_eq!(
        dep_entry["waitingFor"],
        serde_json::json!([]),
        "not waiting on a cold dep"
    );

    // A cancelled cold dep keeps cancelled semantics: never satisfies.
    let gone = fixture.add_with("gone dep", Status::Todo, Priority::None, &[]);
    fixture.move_to(&gone.id, Status::Cancelled);
    let stuck = fixture.add_with(
        "stuck",
        Status::Todo,
        Priority::None,
        std::slice::from_ref(&gone.id),
    );
    set_updated(&fixture, &gone.id, 100);
    cli(
        &fixture,
        &["archive-sweep", "--retention-days", "90", "--json"],
    );
    let next = cli(&fixture, &["next", "--json"]);
    let value: serde_json::Value = serde_json::from_slice(&next.stdout).unwrap();
    let waiting: Vec<serde_json::Value> = serde_json::from_value(value["waiting"].clone()).unwrap();
    assert!(
        waiting
            .iter()
            .any(|w| w["id"] == stuck.id && w["waitingFor"][0] == gone.id)
    );
}
