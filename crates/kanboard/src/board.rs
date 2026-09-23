//! Board access: read/write every task file in a project.

use std::fs;
use std::path::PathBuf;

use crate::error::{Error, Problem, Result};
use crate::format;
use crate::model::Task;
use crate::store::{write_atomic, Layout, Project};

pub struct Board<'a> {
    pub layout: &'a Layout,
    pub project: Project,
}

impl<'a> Board<'a> {
    pub fn open(layout: &'a Layout, project: Project) -> Result<Board<'a>> {
        layout.ensure_project_dirs(&project.slug)?;
        Ok(Board { layout, project })
    }

    pub fn tasks_dir(&self) -> PathBuf {
        self.layout.tasks_dir(&self.project.slug)
    }

    pub fn task_path(&self, id: &str) -> PathBuf {
        self.layout.task_path(&self.project.slug, id)
    }

    /// Every task file, parsed. Problems stop the caller: the board must be
    /// readable before anything is written to it.
    pub fn tasks(&self) -> Result<Vec<Task>> {
        let (tasks, problems) = self.scan()?;
        if !problems.is_empty() {
            return Err(Error::rule(format!(
                "{} task file(s) failed to parse — run `unipi-kanboard validate`:\n{}",
                problems.len(),
                problems
                    .iter()
                    .map(|problem| format!("  {problem}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )));
        }
        Ok(tasks)
    }

    /// Parsed tasks plus per-file problems (used by `validate`).
    pub fn scan(&self) -> Result<(Vec<Task>, Vec<Problem>)> {
        let dir = self.tasks_dir();
        let mut tasks = Vec::new();
        let mut problems = Vec::new();
        if !dir.exists() {
            return Ok((tasks, problems));
        }
        let mut entries: Vec<PathBuf> = fs::read_dir(&dir)?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.extension().map(|ext| ext == "md").unwrap_or(false))
            .collect();
        entries.sort();
        for path in entries {
            let text = fs::read_to_string(&path)?;
            let file = path
                .strip_prefix(&self.layout.home)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            let (task, mut file_problems) = format::parse(&file, &text);
            if file_problems.is_empty() {
                if let Some(task) = task {
                    if format::render(&task) != text {
                        file_problems.push(
                            Problem::new(&file, 1, "formatting differs from canonical form").fixable(true),
                        );
                    }
                    tasks.push(task);
                }
            } else if let Some(task) = task {
                tasks.push(task);
            }
            problems.append(&mut file_problems);
        }
        Ok((tasks, problems))
    }

    pub fn get(&self, id: &str) -> Result<Task> {
        let path = self.task_path(id);
        let text = fs::read_to_string(&path).map_err(|_| {
            Error::not_found(format!("task {id} not found ({})", path.display()))
        })?;
        let file = path.to_string_lossy().to_string();
        let (task, problems) = format::parse(&file, &text);
        if !problems.is_empty() {
            return Err(Error::rule(format!(
                "{id} is not readable — run `unipi-kanboard validate`:\n{}",
                problems
                    .iter()
                    .map(|problem| format!("  {problem}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )));
        }
        task.ok_or_else(|| Error::rule(format!("{id} has no usable frontmatter")))
    }

    pub fn save(&self, task: &Task) -> Result<()> {
        write_atomic(&self.task_path(&task.id), &format::render(task))
    }

    /// Replace `task` in a list of already-loaded tasks (for validation passes).
    pub fn find<'t>(tasks: &'t [Task], id: &str) -> Result<&'t Task> {
        tasks
            .iter()
            .find(|task| task.id == id)
            .ok_or_else(|| Error::not_found(format!("task {id} not found")))
    }
}
