//! Title-optional tasks: `add` needs a title or a body, `edit` may clear
//! either as long as one remains, the file format round-trips empty and
//! missing titles, and `display_title` derives a listing title from the body.

mod common;

use common::{Fixture, task_from, write_task_file};
use kanboard::commands;
use kanboard::model::{Priority, Status, Task};

fn add(fixture: &Fixture, title: &str, body: Option<&str>) -> Result<serde_json::Value, kanboard::error::Error> {
    commands::add(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        title,
        body,
        Some(Status::Backlog),
        Priority::None,
        &[],
        &[],
        &[],
    )
}

#[test]
fn add_with_a_body_only_stores_an_empty_title_and_derives_the_display() {
    let fixture = Fixture::new();
    let value = add(&fixture, "", Some("first line wins\nsecond line")).expect("body-only add");
    assert_eq!(value["title"], "");
    assert_eq!(value["displayTitle"], "first line wins");

    let task = fixture.tasks().remove(0);
    assert_eq!(task.title, "");
    assert_eq!(task.display_title(), "first line wins");
}

#[test]
fn add_with_neither_title_nor_body_is_a_usage_error() {
    let fixture = Fixture::new();
    let err = add(&fixture, "", None).unwrap_err();
    assert!(err.to_string().contains("a task needs a title or a description"));
    assert!(fixture.tasks().is_empty());

    // Whitespace-only counts as empty on both sides.
    let err = add(&fixture, "   ", Some("  \n  ")).unwrap_err();
    assert!(err.to_string().contains("a task needs a title or a description"));
}

#[test]
fn add_with_a_title_only_still_works() {
    let fixture = Fixture::new();
    let value = add(&fixture, "just a title", None).expect("title-only add");
    assert_eq!(value["title"], "just a title");
    assert_eq!(value["displayTitle"], "just a title");
}

#[test]
fn edit_may_clear_the_title_while_the_body_remains() {
    let fixture = Fixture::new();
    let task = fixture.add("clearable");
    let value = commands::edit(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &task.id,
        commands::EditArgs {
            title: Some(""),
            body: None,
            priority: None,
            labels: None,
        },
    )
    .expect("clear title");
    assert_eq!(value["title"], "");
    assert_eq!(value["displayTitle"], "body");
}

#[test]
fn edit_may_clear_the_body_while_the_title_remains() {
    let fixture = Fixture::new();
    let task = fixture.add("still titled");
    let value = commands::edit(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &task.id,
        commands::EditArgs {
            title: None,
            body: Some(""),
            priority: None,
            labels: None,
        },
    )
    .expect("clear body");
    assert_eq!(value["body"], "");
    assert_eq!(value["title"], "still titled");
}

#[test]
fn edit_refuses_to_leave_neither_title_nor_body() {
    let fixture = Fixture::new();
    let value = add(&fixture, "", Some("only the body")).expect("body-only add");
    let task = task_from(&value);
    let err = commands::edit(
        &fixture.layout,
        fixture.project.clone(),
        &fixture.common,
        &task.id,
        commands::EditArgs {
            title: Some(" "),
            body: Some(""),
            priority: None,
            labels: None,
        },
    )
    .unwrap_err();
    assert!(err.to_string().contains("a task needs a title or a description"));
}

#[test]
fn format_round_trips_an_empty_and_a_missing_title() {
    let now = chrono::Utc::now();
    let mut task = Task::new("FIX-1".into(), String::new(), Status::Backlog, Priority::None, 1000, now);
    task.body = "the body carries it".into();

    let text = kanboard::format::render(&task);
    assert!(text.contains("title: \"\""), "canonical empty title: {text}");
    let (parsed, problems) = kanboard::format::parse("FIX-1.md", &text);
    assert!(problems.is_empty(), "unexpected problems: {problems:?}");
    let parsed = parsed.expect("task");
    assert_eq!(parsed.title, "");
    assert_eq!(kanboard::format::render(&parsed), text);

    // A hand-written file without a title key parses clean and re-renders
    // with the canonical empty title.
    let fixture = Fixture::new();
    let file = write_task_file(
        &fixture,
        "NOTITLE",
        "---\nid: FIX-2\nstatus: backlog\npriority: none\norder: 1000\ndeps: []\nlabels: []\ncreated: 2026-09-24T10:00:00Z\nupdated: 2026-09-24T10:00:00Z\nrun:\n---\n\nbody line\n\n## Activity\n",
    );
    let text = std::fs::read_to_string(&file).unwrap();
    let (parsed, problems) = kanboard::format::parse("FIX-2.md", &text);
    assert!(problems.is_empty(), "missing title must not be a problem: {problems:?}");
    assert_eq!(parsed.expect("task").title, "");
}

#[test]
fn display_title_strips_markdown_markers_and_skips_embeds() {
    let now = chrono::Utc::now();
    let titled = |body: &str| {
        let mut task = Task::new("FIX-3".into(), String::new(), Status::Backlog, Priority::None, 1000, now);
        task.body = body.into();
        task
    };

    assert_eq!(titled("# Heading first").display_title(), "Heading first");
    assert_eq!(titled("- bullet point").display_title(), "bullet point");
    assert_eq!(titled("* star bullet").display_title(), "star bullet");
    assert_eq!(titled("> quoted note").display_title(), "quoted note");
    assert_eq!(titled("1. ordered item").display_title(), "ordered item");
    assert_eq!(titled("2) paren ordered").display_title(), "paren ordered");
    // Markers combine.
    assert_eq!(titled("> - ## deep").display_title(), "deep");
    // A list/ordered marker only counts when whitespace follows — plain text
    // that merely starts with the character is left alone.
    assert_eq!(titled("-5 degrees tonight").display_title(), "-5 degrees tonight");
    assert_eq!(titled("3.0 release").display_title(), "3.0 release");
    assert_eq!(titled("**Bold** text").display_title(), "**Bold** text");
    // …while the marker forms themselves still strip.
    assert_eq!(titled("- item").display_title(), "item");
    assert_eq!(titled("1. step").display_title(), "step");
    assert_eq!(titled("## Heading").display_title(), "Heading");
    assert_eq!(titled("> quote").display_title(), "quote");
    // Embeds and images are skipped for a real line.
    assert_eq!(
        titled("![shot](att:shot.png)\nreal text here").display_title(),
        "real text here"
    );
    assert_eq!(
        titled("- ![shot](https://x/y.png)\nactual words").display_title(),
        "actual words"
    );
    // An entirely embed-only body has no title at all.
    assert_eq!(titled("![shot](att:shot.png)").display_title(), "(untitled)");
    assert_eq!(titled("   \n\t\n").display_title(), "(untitled)");
    assert_eq!(titled("").display_title(), "(untitled)");
}

#[test]
fn display_title_truncates_by_characters_not_bytes() {
    let now = chrono::Utc::now();
    let titled = |title: &str| {
        let mut task = Task::new("FIX-4".into(), String::new(), Status::Backlog, Priority::None, 1000, now);
        task.body = title.into();
        task
    };

    // CJK: 3 bytes per char — byte slicing would panic mid-glyph.
    let cjk: String = "漢字テスト".repeat(30);
    let derived = titled(&cjk).display_title();
    assert_eq!(derived.chars().count(), 80);
    assert!(derived.ends_with('…'));

    // Emoji (astral plane): 4 bytes, would split mid-codepoint when sliced.
    let emoji: String = "🦀".repeat(100);
    let derived = titled(&emoji).display_title();
    assert_eq!(derived.chars().count(), 80);
    assert!(derived.ends_with('…'));

    // Exactly at the limit: no ellipsis.
    let exact = "a".repeat(80);
    assert_eq!(titled(&exact).display_title(), exact);
}
