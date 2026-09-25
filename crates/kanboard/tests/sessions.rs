//! Session-scoped rules: one claim per session, at most two sessions per
//! project, dead-pid reaping, `claim-next --id`, the per-session queue, agent
//! edit/block ownership, the `[agent:<session>]` activity tag, and the
//! read-only `next`/`chain`/`search` commands.

mod common;

use common::{Fixture, cli, id_of, task_from};
use kanboard::commands::{self, ClaimArgs, Common, EditArgs};
use kanboard::model::{Actor, ChainGate, Priority, Status};
use kanboard::store::Project;
use serde_json::Value;

fn claim(fixture: &Fixture, session: &str, pid: u32) -> Result<Value, kanboard::error::Error> {
    let host = commands::hostname();
    let args = ClaimArgs {
        session,
        pid,
        host: &host,
        mode: kanboard::model::RunMode::Direct,
        id: None,
    };
    commands::claim_next(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        &args,
        fixture.common.now,
    )
}

fn claim_id(
    fixture: &Fixture,
    session: &str,
    pid: u32,
    id: &str,
) -> Result<Value, kanboard::error::Error> {
    let host = commands::hostname();
    let args = ClaimArgs {
        session,
        pid,
        host: &host,
        mode: kanboard::model::RunMode::Direct,
        id: Some(id),
    };
    commands::claim_next(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        &args,
        fixture.common.now,
    )
}

fn agent(fixture: &Fixture, session: Option<&str>) -> Common {
    let mut common = fixture.common.clone();
    common.actor = Actor::Agent;
    common.session = session.map(|value| value.to_string());
    common
}

#[test]
fn a_session_holds_one_claim_and_two_sessions_is_the_cap() {
    let fixture = Fixture::new();
    let pid = std::process::id();
    for title in ["a", "b", "c", "d"] {
        fixture.add_with(title, Status::Todo, Priority::None, &[]);
    }

    let first = claim(&fixture, "s1", pid).expect("s1 claims");
    assert!(first["task"].is_object());
    // The same session cannot take a second task.
    let err = claim(&fixture, "s1", pid).unwrap_err();
    assert!(err.to_string().contains("already runs"), "{err}");

    // A second session is fine; a third hits the cap.
    assert!(claim(&fixture, "s2", pid).expect("s2 claims")["task"].is_object());
    let err = claim(&fixture, "s3", pid).unwrap_err();
    assert!(
        err.to_string().contains("s1") && err.to_string().contains("s2"),
        "{err}"
    );
    assert!(err.to_string().contains("sessions"), "{err}");
}

#[test]
fn the_session_cap_is_per_project() {
    let fixture = Fixture::new();
    let other_root = tempfile::TempDir::new().unwrap();
    let other = Project::create(
        &fixture.layout,
        other_root.path(),
        Some("Other"),
        Some("OTH"),
    )
    .unwrap();
    let pid = std::process::id();

    fixture.add_with("a", Status::Todo, Priority::None, &[]);
    fixture.add_with("b", Status::Todo, Priority::None, &[]);
    claim(&fixture, "s1", pid).unwrap();
    claim(&fixture, "s2", pid).unwrap();
    assert!(
        claim(&fixture, "s3", pid).is_err(),
        "third session refused here"
    );

    // The other project is unaffected.
    commands::add(
        &fixture.layout,
        other.clone(),
        &fixture.common,
        "x",
        None,
        Some(Status::Todo),
        Priority::None,
        &[],
        &[],
    )
    .unwrap();
    let host = commands::hostname();
    let args = ClaimArgs {
        session: "s3",
        pid,
        host: &host,
        mode: kanboard::model::RunMode::Direct,
        id: None,
    };
    let value = commands::claim_next(
        &fixture.layout,
        other,
        ChainGate::InReview,
        &args,
        fixture.common.now,
    )
    .unwrap();
    assert!(value["task"].is_object(), "s3 claims in the other project");
}

#[test]
fn claim_reaps_dead_sessions_and_leaves_foreign_hosts_alone() {
    let fixture = Fixture::new();
    // Foreign first: the ghost's claim runs reap before claiming, and a
    // foreign-host claim must survive it.
    let foreign = fixture.add_with("foreign", Status::Todo, Priority::None, &[]);
    let claimed = commands::claim_next(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        &ClaimArgs {
            session: "elsewhere",
            pid: 999_998,
            host: "not-this-host",
            mode: kanboard::model::RunMode::Direct,
            id: Some(&foreign.id),
        },
        fixture.common.now,
    )
    .unwrap();
    assert_eq!(claimed["task"]["id"], foreign.id.as_str());

    let task = fixture.add_with("t", Status::Todo, Priority::None, &[]);
    // 999_999 is not a live pid on this host.
    claim(&fixture, "ghost", 999_999).unwrap();
    let ghost_claimed = fixture
        .tasks()
        .into_iter()
        .find(|t| t.id == task.id)
        .unwrap();
    assert_eq!(ghost_claimed.status, Status::InProgress);

    let dry = commands::reap(
        &fixture.layout,
        fixture.project.clone(),
        true,
        fixture.common.now,
    )
    .unwrap();
    assert_eq!(dry["released"], serde_json::json!([task.id]));
    assert_eq!(dry["unknown"], serde_json::json!([foreign.id]));
    // Dry-run writes nothing.
    let still = fixture
        .tasks()
        .into_iter()
        .find(|t| t.id == task.id)
        .unwrap();
    assert_eq!(still.status, Status::InProgress);

    let run = commands::reap(
        &fixture.layout,
        fixture.project.clone(),
        false,
        fixture.common.now,
    )
    .unwrap();
    assert_eq!(run["released"], serde_json::json!([task.id]));
    assert_eq!(run["unknown"], serde_json::json!([foreign.id]));

    let reaped = fixture
        .tasks()
        .into_iter()
        .find(|t| t.id == task.id)
        .unwrap();
    assert_eq!(reaped.status, Status::Todo);
    assert!(reaped.run.is_none());
    assert!(
        reaped
            .activity
            .iter()
            .any(|entry| entry.text == "session lost: ghost (pid 999999) ended without releasing")
    );

    // The foreign claim survived.
    let foreign_now = fixture
        .tasks()
        .into_iter()
        .find(|t| t.id == foreign.id)
        .unwrap();
    assert_eq!(foreign_now.status, Status::InProgress);
    assert_eq!(foreign_now.run.as_ref().unwrap().host, "not-this-host");
}

#[test]
fn claim_next_id_claims_one_task_or_says_why_not() {
    let fixture = Fixture::new();
    let dep = fixture.add_with("dep", Status::Todo, Priority::None, &[]);
    let waiting = fixture.add_with(
        "waiting",
        Status::Todo,
        Priority::None,
        std::slice::from_ref(&dep.id),
    );
    let parked = fixture.add_with("parked", Status::Backlog, Priority::None, &[]);
    let pid = std::process::id();

    // Not todo → named reason.
    let err = claim_id(&fixture, "s1", pid, &parked.id).unwrap_err();
    assert!(
        err.to_string().contains("not todo") || err.to_string().contains("backlog"),
        "{err}"
    );
    // Todo but waiting → the dep is named.
    let err = claim_id(&fixture, "s1", pid, &waiting.id).unwrap_err();
    assert!(err.to_string().contains(&dep.id), "{err}");
    // Ready → claimed.
    let value = claim_id(&fixture, "s1", pid, &dep.id).unwrap();
    assert_eq!(value["task"]["id"], dep.id.as_str());
}

#[test]
fn the_queue_is_per_session_and_deduped() {
    let fixture = Fixture::new();
    let ids: Vec<String> = (0..6)
        .map(|index| {
            fixture
                .add_with(&format!("t{index}"), Status::Todo, Priority::None, &[])
                .id
        })
        .collect();

    // queue needs a session: the CLI refuses without --session/UNIPI_KANBOARD_SESSION.
    let output = common::cli(&fixture, &["queue", "--list"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("needs a session"));

    let slug = fixture.project.clone();
    commands::queue_update(&fixture.layout, slug.clone(), "s1", &ids[..5], None).unwrap();
    // The default cap (10) is not hit by five — the sixth is a partial accept.
    let sixth =
        commands::queue_update(&fixture.layout, slug.clone(), "s1", &ids[5..], None).unwrap();
    assert_eq!(sixth["queue"].as_array().unwrap().len(), 6);

    // Another session has its own queue.
    let other =
        commands::queue_update(&fixture.layout, slug.clone(), "s2", &ids[..2], None).unwrap();
    assert_eq!(other["queue"], serde_json::json!([ids[0], ids[1]]));
    let listed = commands::queue_list(&fixture.layout, &slug, "s1").unwrap();
    assert_eq!(listed["queue"].as_array().unwrap().len(), 6);

    // Dedupe and unqueue.
    let again =
        commands::queue_update(&fixture.layout, slug.clone(), "s1", &ids[..2], None).unwrap();
    assert_eq!(again["queue"].as_array().unwrap().len(), 6, "dedupe");
    let trimmed =
        commands::queue_update(&fixture.layout, slug.clone(), "s1", &[], Some(&ids[..2])).unwrap();
    assert_eq!(trimmed["queue"].as_array().unwrap().len(), 4);
    let cleared = commands::queue_update(&fixture.layout, slug, "s1", &[], Some(&[])).unwrap();
    assert_eq!(cleared["queue"], serde_json::json!([]));

    // Final tasks cannot be queued.
    let done = fixture.add_with("done", Status::Todo, Priority::None, &[]);
    claim_id(&fixture, "worker", std::process::id(), &done.id).unwrap();
    commands::release(
        &fixture.layout,
        fixture.project.clone(),
        &done.id,
        Status::InReview,
        "done",
        ChainGate::InReview,
        fixture.common.now,
    )
    .unwrap();
    fixture.move_to(&done.id, Status::Done);
    let err = commands::queue_update(
        &fixture.layout,
        fixture.project.clone(),
        "s1",
        &[done.id],
        None,
    )
    .unwrap_err();
    assert!(err.to_string().contains("final"), "{err}");
}

#[test]
fn agents_edit_only_their_own_drafts() {
    let fixture = Fixture::new();
    let user_made = fixture.add("user task");
    let agent_common = agent(&fixture, Some("pi-1"));

    // User-created → refused.
    let err = commands::edit(
        &fixture.layout,
        fixture.project.clone(),
        &agent_common,
        &user_made.id,
        EditArgs {
            title: Some("new title"),
            body: None,
            priority: None,
            labels: None,
        },
    )
    .unwrap_err();
    assert!(err.to_string().contains("add a note instead"), "{err}");

    // Agent-created backlog task → allowed.
    let mine = task_from(
        &commands::add(
            &fixture.layout,
            fixture.project.clone(),
            &agent_common,
            "agent task",
            Some("draft"),
            Some(Status::Backlog),
            Priority::None,
            &[],
            &[],
        )
        .unwrap(),
    );
    let edited = commands::edit(
        &fixture.layout,
        fixture.project.clone(),
        &agent_common,
        &mine.id,
        EditArgs {
            title: None,
            body: Some("revised"),
            priority: None,
            labels: None,
        },
    )
    .expect("agent edits its own backlog task");
    assert_eq!(edited["body"], "revised");

    // Agent-created but already in review → refused.
    let reviewed = task_from(
        &commands::add(
            &fixture.layout,
            fixture.project.clone(),
            &agent_common,
            "agent task 2",
            None,
            Some(Status::Todo),
            Priority::None,
            &[],
            &[],
        )
        .unwrap(),
    );
    claim_id(&fixture, "sess-x", std::process::id(), &reviewed.id).unwrap();
    commands::release(
        &fixture.layout,
        fixture.project.clone(),
        &reviewed.id,
        Status::InReview,
        "done",
        ChainGate::InReview,
        fixture.common.now,
    )
    .unwrap();
    let err = commands::edit(
        &fixture.layout,
        fixture.project.clone(),
        &agent_common,
        &reviewed.id,
        EditArgs {
            title: Some("late edit"),
            body: None,
            priority: None,
            labels: None,
        },
    )
    .unwrap_err();
    assert!(err.to_string().contains("add a note instead"), "{err}");
}

#[test]
fn an_agent_blocks_only_the_task_its_session_runs() {
    let fixture = Fixture::new();
    let first = fixture.add_with("first", Status::Todo, Priority::None, &[]);
    let second = fixture.add_with("second", Status::Todo, Priority::None, &[]);
    let pid = std::process::id();
    claim(&fixture, "sess-a", pid).unwrap();
    claim(&fixture, "sess-b", pid).unwrap();
    let tasks = fixture.tasks();
    let mine = tasks
        .iter()
        .find(|t| t.run.as_ref().map(|r| r.session.as_str()) == Some("sess-a"))
        .unwrap()
        .id
        .clone();
    let theirs = if mine == first.id {
        second.id.clone()
    } else {
        first.id.clone()
    };

    // No session → refused with the reason named.
    let err = commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &agent(&fixture, None),
        &mine,
        Status::Blocked,
        Some("need info"),
    )
    .unwrap_err();
    assert!(err.to_string().contains("no --session"), "{err}");

    // Another session's task → refused.
    let err = commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &agent(&fixture, Some("sess-a")),
        &theirs,
        Status::Blocked,
        Some("need info"),
    )
    .unwrap_err();
    assert!(err.to_string().contains("sess-a"), "{err}");

    // Its own → allowed.
    let value = commands::move_task(
        &fixture.layout,
        fixture.project.clone(),
        &agent(&fixture, Some("sess-a")),
        &mine,
        Status::Blocked,
        Some("need info"),
    )
    .expect("own block");
    assert_eq!(value["status"], "blocked");
}

#[test]
fn activity_entries_carry_the_session_tag() {
    let fixture = Fixture::new();
    let agent_common = agent(&fixture, Some("pi-77"));
    let value = commands::add(
        &fixture.layout,
        fixture.project.clone(),
        &agent_common,
        "agent note",
        None,
        Some(Status::Backlog),
        Priority::None,
        &[],
        &[],
    )
    .unwrap();
    let id = id_of(&value);

    // The JSON exposes the session on agent entries.
    let entry = &value["activity"][0];
    assert_eq!(entry["actor"], "agent");
    assert_eq!(entry["session"], "pi-77");

    // The file renders `[agent:pi-77]` and parses back to the same entry.
    let path = fixture
        .layout
        .tasks_dir(&fixture.project.slug)
        .join(format!("{id}.md"));
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains("[agent:pi-77]"), "{text}");
    let task = fixture.tasks().into_iter().find(|t| t.id == id).unwrap();
    assert_eq!(task.activity[0].session.as_deref(), Some("pi-77"));

    // The old `[agent]` format still parses (session absent).
    let legacy = common::write_task_file(
        &fixture,
        "FIX-901",
        "---\nid: FIX-901\ntitle: old\nstatus: todo\npriority: none\norder: 1000\ndeps: []\nlabels: []\ncreated: 2026-09-24T10:00:00Z\nupdated: 2026-09-24T10:00:00Z\nrun:\n---\n\nB.\n\n## Activity\n- 2026-09-24T10:00:00Z [agent] created\n",
    );
    let (parsed, _) = kanboard::format::parse(
        &legacy.file_name().unwrap().to_string_lossy(),
        &std::fs::read_to_string(&legacy).unwrap(),
    );
    let parsed = parsed.expect("parses");
    assert_eq!(parsed.activity[0].actor, Actor::Agent);
    assert_eq!(parsed.activity[0].session, None);
}

#[test]
fn next_chain_and_search_are_read_only() {
    let fixture = Fixture::new();
    let dep = fixture.add_with("base work", Status::Todo, Priority::High, &[]);
    let dependent = fixture.add_with(
        "follow up",
        Status::Todo,
        Priority::None,
        std::slice::from_ref(&dep.id),
    );
    fixture.add_with("unrelated", Status::Backlog, Priority::None, &[]);

    // next: the highest-priority ready todo, no claim, waiting reasons.
    let value = commands::next(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        fixture.common.now,
    )
    .unwrap();
    assert_eq!(value["task"]["id"], dep.id.as_str());
    assert!(
        value["waiting"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w["id"] == dependent.id)
    );
    assert!(
        fixture.tasks().iter().all(|t| t.run.is_none()),
        "next claims nothing"
    );

    // chain: dep upstream for dependent; dependent downstream of dep.
    let chain = commands::chain(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        &dep.id,
    )
    .unwrap();
    assert_eq!(chain["upstream"], serde_json::json!([]));
    assert_eq!(chain["downstream"][0]["id"], dependent.id.as_str());
    let chain = commands::chain(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        &dependent.id,
    )
    .unwrap();
    assert_eq!(chain["upstream"][0]["id"], dep.id.as_str());

    // search: case-insensitive on title/body/id, archived excluded by default.
    let hits = commands::search(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        "FOLLOW",
        false,
    )
    .unwrap();
    assert_eq!(hits["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(hits["tasks"][0]["id"], dependent.id.as_str());

    let old = fixture.add_with("shipped thing", Status::Todo, Priority::None, &[]);
    claim_id(&fixture, "worker", std::process::id(), &old.id).unwrap();
    commands::release(
        &fixture.layout,
        fixture.project.clone(),
        &old.id,
        Status::InReview,
        "done",
        ChainGate::InReview,
        fixture.common.now,
    )
    .unwrap();
    fixture.move_to(&old.id, Status::Done);
    fixture.move_to(&old.id, Status::Archived);
    let hits = commands::search(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        "shipped",
        false,
    )
    .unwrap();
    assert_eq!(
        hits["tasks"].as_array().unwrap().len(),
        0,
        "archived excluded"
    );
    let hits = commands::search(
        &fixture.layout,
        fixture.project.clone(),
        ChainGate::InReview,
        "shipped",
        true,
    )
    .unwrap();
    assert_eq!(hits["tasks"].as_array().unwrap().len(), 1);
}

#[test]
fn add_attach_embeds_markdown_for_bare_and_wrapped_paths() {
    let fixture = Fixture::new();
    let dir = tempfile::TempDir::new().unwrap();
    let shot = dir.path().join("screen.png");
    let log = dir.path().join("run.log");
    let doc = dir.path().join("notes.txt");
    std::fs::write(&shot, b"\x89PNG fake").unwrap();
    std::fs::write(&log, b"log line").unwrap();
    std::fs::write(&doc, b"note").unwrap();

    // Bare path in the body → replaced in place; absent path → appended.
    let value = commands::add(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        "with a bare path",
        Some(&format!("see {}", shot.display())),
        Some(Status::Backlog),
        Priority::None,
        &[],
        &[shot.clone(), doc],
    )
    .unwrap();
    let body = value["body"].as_str().unwrap();
    assert!(body.contains("![screen.png](att:"), "{body}");
    assert!(!body.contains(&shot.display().to_string()), "{body}");
    assert!(body.contains("[notes.txt](att:"), "{body}");

    // `![](path)` in the body → the whole construct is replaced.
    let value = commands::add(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        "wrapped path",
        Some(&format!("look\n\n![]({})\n", log.display())),
        Some(Status::Backlog),
        Priority::None,
        &[],
        std::slice::from_ref(&log),
    )
    .unwrap();
    let body = value["body"].as_str().unwrap();
    assert!(body.contains("[run.log](att:"), "{body}");
    assert!(!body.contains(&log.display().to_string()), "{body}");

    // The files landed in the task's attachments dir.
    let id = id_of(&value);
    let listed = crate::common::task_from(&value);
    assert_eq!(listed.id, id);
    let attachments = kanboard::attachments::list(&fixture.layout, &fixture.project.slug, &id);
    assert_eq!(attachments.len(), 1);
}

#[test]
fn queue_partial_accepts_in_dependency_order_and_reports_left_out() {
    let fixture = Fixture::new();
    let a = fixture.add_with("A", Status::Todo, Priority::None, &[]);
    let b = fixture.add_with(
        "B",
        Status::Todo,
        Priority::None,
        std::slice::from_ref(&a.id),
    );
    let c = fixture.add_with("C", Status::Todo, Priority::None, &[]);
    let d = fixture.add_with("D", Status::Todo, Priority::None, &[]);

    // Cap 3, order B A C D → topological puts A first, then B, C; D is left out.
    let output = common::cli_with_env(
        &fixture,
        &[
            "queue",
            b.id.as_str(),
            a.id.as_str(),
            c.id.as_str(),
            d.id.as_str(),
            "--session",
            "s1",
            "--json",
        ],
        &[("UNIPI_KANBOARD_QUEUE_MAX", "3")],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        value["queue"],
        serde_json::json!([a.id, b.id, c.id]),
        "dependency order A before B, capped at 3"
    );
    assert_eq!(value["leftOut"][0]["id"], d.id.as_str());
    assert_eq!(value["leftOut"][0]["reason"], "queue limit 3");

    // Cap 0 = unlimited.
    let output = common::cli_with_env(
        &fixture,
        &["queue", d.id.as_str(), "--session", "s1", "--json"],
        &[("UNIPI_KANBOARD_QUEUE_MAX", "0")],
    );
    assert!(output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        value["queue"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!(d.id))
    );

    // A missing id fails the whole call (nothing changed).
    let output = common::cli_with_env(
        &fixture,
        &["queue", "KBL-999", "--session", "s1"],
        &[("UNIPI_KANBOARD_QUEUE_MAX", "3")],
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("no such task"));
}

#[test]
fn max_sessions_env_limits_other_sessions() {
    let fixture = Fixture::new();
    let first = fixture.add_with("first", Status::Todo, Priority::None, &[]);
    fixture.add_with("second", Status::Todo, Priority::None, &[]);
    let pid = std::process::id();

    let output = common::cli_with_env(
        &fixture,
        &[
            "claim-next",
            "--id",
            &first.id,
            "--session",
            "s1",
            "--pid",
            &pid.to_string(),
            "--host",
            "test",
        ],
        &[("UNIPI_KANBOARD_MAX_SESSIONS", "1")],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    // A second session is refused while one is already running (MAX_SESSIONS=1).
    let output = common::cli_with_env(
        &fixture,
        &[
            "claim-next",
            "--session",
            "s2",
            "--pid",
            &pid.to_string(),
            "--host",
            "test",
        ],
        &[("UNIPI_KANBOARD_MAX_SESSIONS", "1")],
    );
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("sessions already run tasks"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn in_review_to_archived_is_user_only_and_bulk_lane_works() {
    let fixture = Fixture::new();
    let a = fixture.add_with("a", Status::Todo, Priority::None, &[]);
    let b = fixture.add_with("b", Status::Todo, Priority::None, &[]);
    let done = fixture.add_with("c", Status::Todo, Priority::None, &[]);
    for id in [&a.id, &b.id] {
        let claimed = common::claimed_id(&fixture.claim_next(&format!("s-{id}"), 999_999)).unwrap();
        assert_eq!(&claimed, id);
        let _ = cli(
            &fixture,
            &["release", id, "--to", "in_review", "--comment", "done"],
        );
    }
    let claimed = common::claimed_id(&fixture.claim_next("s-done", 999_999)).unwrap();
    assert_eq!(claimed, done.id);
    let _ = cli(
        &fixture,
        &[
            "release",
            &done.id,
            "--to",
            "in_review",
            "--comment",
            "done",
        ],
    );
    fixture.move_to(&done.id, Status::Done);

    // The rule table allows user in_review → archived.
    assert!(
        kanboard::transitions::allowed_targets(Status::InReview, Actor::User)
            .contains(&Status::Archived)
    );
    assert!(
        !kanboard::transitions::allowed_targets(Status::InReview, Actor::Agent)
            .contains(&Status::Archived)
    );

    // archive_lane: everything in review moves under one call.
    let value = commands::archive_lane(
        &fixture.layout,
        fixture.project.clone(),
        Status::InReview,
        fixture.common.now,
    )
    .unwrap();
    let archived: Vec<String> = serde_json::from_value(value["archived"].clone()).unwrap();
    assert_eq!(archived.len(), 2, "{value}");
    let board = kanboard::board::Board::open(&fixture.layout, fixture.project.clone()).unwrap();
    assert_eq!(board.get(&a.id).unwrap().status, Status::Archived);
    let task = board.get(&a.id).unwrap();
    assert!(
        task.activity
            .iter()
            .any(|entry| entry.text.contains("archived from in_review (bulk)"))
    );

    // Bad lane is a usage error.
    let err = commands::archive_lane(
        &fixture.layout,
        fixture.project.clone(),
        Status::Todo,
        fixture.common.now,
    )
    .unwrap_err();
    assert!(err.to_string().contains("done or in_review"), "{err}");
}

#[test]
fn project_archive_and_unarchive() {
    let fixture = Fixture::new();
    let slug = fixture.project.slug.clone();

    // agent refusal
    let output = cli(&fixture, &["project", "archive", &slug, "--actor", "agent"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("user only"));

    let output = cli(&fixture, &["project", "archive", &slug, "--json"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let project = kanboard::store::Project::load(&fixture.layout, &slug).unwrap();
    assert!(project.archived);

    let output = cli(&fixture, &["project", "unarchive", &slug, "--json"]);
    assert!(output.status.success());
    let project = kanboard::store::Project::load(&fixture.layout, &slug).unwrap();
    assert!(!project.archived);

    // Onboarding an archived project's folder unarchives it.
    cli(&fixture, &["project", "archive", &slug]);
    let output = cli(
        &fixture,
        &["project", "add", "--root", fixture.root().to_str().unwrap()],
    );
    assert!(output.status.success());
    let project = kanboard::store::Project::load(&fixture.layout, &slug).unwrap();
    assert!(!project.archived, "onboard unarchived");
}
