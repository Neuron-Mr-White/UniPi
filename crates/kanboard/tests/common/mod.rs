//! Shared helpers for the kanboard tests.
//!
//! Each integration test binary uses a subset of these helpers, so dead-code
//! analysis across binaries would otherwise flag the rest.
#![allow(dead_code)]

use kanboard::commands::{self, Common};
use kanboard::model::{Actor, ChainGate, Priority, Status, Task};
use kanboard::store::{Layout, Project};
use serde_json::Value;
use std::path::PathBuf;
use tempfile::TempDir;

pub struct Fixture {
    pub _home: TempDir,
    pub _root: TempDir,
    pub layout: Layout,
    pub project: Project,
    pub common: Common,
}

impl Fixture {
    pub fn new() -> Fixture {
        let home = TempDir::new().expect("home");
        let root = TempDir::new().expect("root");
        let layout = Layout::with_home(home.path());
        let project = Project::create(&layout, root.path(), Some("Fixture"), Some("FIX")).expect("project");
        Fixture {
            _home: home,
            _root: root,
            layout,
            project,
            common: Common::new(Actor::User, ChainGate::InReview),
        }
    }

    pub fn root(&self) -> PathBuf {
        self._root.path().to_path_buf()
    }

    pub fn add(&self, title: &str) -> Task {
        self.add_with(title, Status::Backlog, Priority::None, &[])
    }

    pub fn add_with(&self, title: &str, status: Status, priority: Priority, after: &[String]) -> Task {
        let value = commands::add(
            &self.layout,
            self.project.clone(),
            &self.common,
            title,
            Some("body"),
            Some(status),
            priority,
            after,
        )
        .expect("add");
        task_from(&value)
    }

    pub fn tasks(&self) -> Vec<Task> {
        let board = kanboard::board::Board::open(&self.layout, self.project.clone()).expect("board");
        board.tasks().expect("tasks")
    }

    pub fn claim_next(&self, session: &str, pid: u32) -> Value {
        let host = commands::hostname();
        let args = commands::ClaimArgs {
            session,
            pid,
            host: &host,
            mode: kanboard::model::RunMode::Direct,
        };
        commands::claim_next(
            &self.layout,
            self.project.clone(),
            ChainGate::InReview,
            &args,
            self.common.now,
        )
        .expect("claim")
    }
}

pub fn task_from(value: &Value) -> Task {
    serde_json::from_value(value.clone()).expect("task json")
}

pub fn id_of(value: &Value) -> String {
    value
        .get("id")
        .and_then(|id| id.as_str())
        .expect("id in payload")
        .to_string()
}

pub fn claimed_id(value: &Value) -> Option<String> {
    let task = value.get("task")?;
    if task.is_null() {
        return None;
    }
    task.get("id")?.as_str().map(|id| id.to_string())
}

pub fn write_task_file(fixture: &Fixture, name: &str, contents: &str) -> PathBuf {
    let dir = fixture.layout.tasks_dir(&fixture.project.slug);
    std::fs::create_dir_all(&dir).expect("tasks dir");
    let path = dir.join(format!("{name}.md"));
    std::fs::write(&path, contents).expect("write task");
    path
}

pub const VALID_TASK: &str = "---
id: FIX-900
title: Hand written
status: todo
priority: none
order: 1000
deps: []
labels: []
created: 2026-09-24T10:00:00Z
updated: 2026-09-24T10:00:00Z
run:
---

Body text.

## Activity
- 2026-09-24T10:00:00Z [user] created
";
