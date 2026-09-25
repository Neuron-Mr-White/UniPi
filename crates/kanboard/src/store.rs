//! Storage: `~/.unipi/kanboard` layout, project registry, locking, atomic writes.

use chrono::{DateTime, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{Error, Result};

/// Environment override for the state root (tests use it).
pub const HOME_ENV: &str = "UNIPI_KANBOARD_HOME";
/// Environment override for the project slug (the pi extension sets it for the agent).
pub const PROJECT_ENV: &str = "UNIPI_KANBOARD_PROJECT";
/// Environment override for the actor.
pub const ACTOR_ENV: &str = "UNIPI_KANBOARD_ACTOR";

#[derive(Debug, Clone)]
pub struct Layout {
    pub home: PathBuf,
}

impl Layout {
    /// `UNIPI_KANBOARD_HOME`, else `~/.unipi/kanboard`.
    pub fn from_env() -> Result<Layout> {
        if let Ok(home) = std::env::var(HOME_ENV)
            && !home.trim().is_empty()
        {
            return Ok(Layout {
                home: PathBuf::from(home),
            });
        }
        let base = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| Error::usage("neither UNIPI_KANBOARD_HOME nor HOME is set"))?;
        Ok(Layout {
            home: base.join(".unipi").join("kanboard"),
        })
    }

    pub fn with_home(home: impl Into<PathBuf>) -> Self {
        Layout { home: home.into() }
    }

    pub fn projects_root(&self) -> PathBuf {
        self.home.join("projects")
    }

    pub fn project_dir(&self, slug: &str) -> PathBuf {
        self.projects_root().join(slug)
    }

    pub fn project_meta_path(&self, slug: &str) -> PathBuf {
        self.project_dir(slug).join("project.json")
    }

    pub fn tasks_dir(&self, slug: &str) -> PathBuf {
        self.project_dir(slug).join("tasks")
    }

    pub fn task_path(&self, slug: &str, id: &str) -> PathBuf {
        self.tasks_dir(slug).join(format!("{id}.md"))
    }

    pub fn board_lock_path(&self, slug: &str) -> PathBuf {
        self.project_dir(slug).join("board.lock")
    }

    pub fn ensure_project_dirs(&self, slug: &str) -> Result<()> {
        fs::create_dir_all(self.tasks_dir(slug))?;
        Ok(())
    }

    /// Exclusive lock for every write in a project. Dropping it releases.
    pub fn lock_board(&self, slug: &str) -> Result<BoardLock> {
        self.ensure_project_dirs(slug)?;
        let path = self.board_lock_path(slug);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|err| Error::Io(format!("cannot open {}: {err}", path.display())))?;
        file.lock_exclusive()
            .map_err(|err| Error::Io(format!("cannot lock {}: {err}", path.display())))?;
        Ok(BoardLock { file })
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let root = self.projects_root();
        if !root.exists() {
            return Ok(Vec::new());
        }
        let mut projects = Vec::new();
        for entry in fs::read_dir(&root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let slug = entry.file_name().to_string_lossy().to_string();
            if let Ok(project) = Project::load(self, &slug) {
                projects.push(project);
            }
        }
        projects.sort_by(|a, b| a.slug.cmp(&b.slug));
        Ok(projects)
    }
}

/// Held for the duration of a write; releases the flock on drop.
pub struct BoardLock {
    file: File,
}

impl BoardLock {
    /// Re-lock after a fork/exec handoff is not supported; this is a no-op kept
    /// for symmetry with the daemon in K2.
    pub fn file(&self) -> &File {
        &self.file
    }
}

impl Drop for BoardLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.file);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub slug: String,
    pub name: String,
    pub root: PathBuf,
    pub prefix: String,
    #[serde(rename = "nextId")]
    pub next_id: u64,
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    /// Hidden from the sidebar/projects overview until unarchived; still
    /// reachable by URL. Serde default keeps old project.json files working.
    #[serde(default)]
    pub archived: bool,
}

impl Project {
    pub fn create(
        layout: &Layout,
        root: &Path,
        name: Option<&str>,
        prefix: Option<&str>,
    ) -> Result<Project> {
        let root = canonical_root(root)?;
        let slug = slug_for(&root);
        let name = name
            .map(|value| value.to_string())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| basename(&root));
        let prefix = match prefix {
            Some(value) => validate_prefix(value)?,
            None => default_prefix(&name),
        };
        let project = Project {
            slug,
            name,
            root,
            prefix,
            next_id: 1,
            created_at: Utc::now(),
            archived: false,
        };
        layout.ensure_project_dirs(&project.slug)?;
        project.save(layout)?;
        Ok(project)
    }

    pub fn load(layout: &Layout, slug: &str) -> Result<Project> {
        let path = layout.project_meta_path(slug);
        let text = fs::read_to_string(&path).map_err(|_| {
            Error::not_found(format!(
                "unknown project \"{slug}\" ({} not found) — run `unipi-kanboard project add`",
                path.display()
            ))
        })?;
        serde_json::from_str(&text).map_err(|err| Error::Json(format!("{}: {err}", path.display())))
    }

    pub fn save(&self, layout: &Layout) -> Result<()> {
        let path = layout.project_meta_path(&self.slug);
        write_atomic(&path, &format!("{}\n", serde_json::to_string_pretty(self)?))
    }

    /// Reserve the next task id (`<PREFIX>-<n>`), persisting the counter.
    ///
    /// Skips ids that already exist on disk: a stale counter (or a project
    /// re-registration) must never hand out an id that would overwrite a task.
    pub fn reserve_id(&mut self, layout: &Layout) -> Result<String> {
        let mut id = format!("{}-{}", self.prefix, self.next_id);
        while layout.task_path(&self.slug, &id).exists() {
            self.next_id += 1;
            id = format!("{}-{}", self.prefix, self.next_id);
        }
        self.next_id += 1;
        self.save(layout)?;
        Ok(id)
    }
}

/// Atomic file write: temp file in the same directory, fsync, rename.
pub fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| Error::Io(format!("{} has no parent directory", path.display())))?;
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.tmp-{}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    {
        let mut file = File::create(&tmp)
            .map_err(|err| Error::Io(format!("cannot create {}: {err}", tmp.display())))?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        Error::Io(format!("cannot replace {}: {err}", path.display()))
    })?;
    Ok(())
}

/// `basename(root)-<first 6 hex of sha256(abs root)>`.
pub fn slug_for(root: &Path) -> String {
    let absolute = canonical_root(root).unwrap_or_else(|_| root.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(absolute.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest
        .iter()
        .take(3)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{}-{hex}", basename(&absolute))
}

fn basename(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "project".to_string())
}

pub fn canonical_root(root: &Path) -> Result<PathBuf> {
    fs::canonicalize(root)
        .map_err(|err| Error::usage(format!("cannot resolve {}: {err}", root.display())))
}

/// Up to three uppercase letters/digits from the name.
pub fn default_prefix(name: &str) -> String {
    let letters: String = name
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_uppercase();
    if letters.is_empty() {
        "TASK".to_string()
    } else {
        letters.chars().take(3).collect()
    }
}

pub fn validate_prefix(prefix: &str) -> Result<String> {
    let trimmed = prefix.trim();
    if trimmed.is_empty() {
        return Err(Error::usage("--prefix must not be empty"));
    }
    if !trimmed.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(Error::usage(format!(
            "--prefix must be letters/digits only, got \"{prefix}\""
        )));
    }
    Ok(trimmed.to_uppercase())
}

/// git toplevel of `cwd`, else `cwd`.
pub fn resolve_root(cwd: &Path) -> PathBuf {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["rev-parse", "--show-toplevel"])
        .output();
    if let Ok(output) = output
        && output.status.success()
    {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }
    cwd.to_path_buf()
}

/// `--project`, else `UNIPI_KANBOARD_PROJECT`, else the project registered for
/// the cwd's git toplevel.
pub fn resolve_project(layout: &Layout, explicit: Option<&str>) -> Result<Project> {
    if let Some(slug) = explicit.filter(|value| !value.trim().is_empty()) {
        return Project::load(layout, slug);
    }
    if let Ok(slug) = std::env::var(PROJECT_ENV) {
        let slug = slug.trim().to_string();
        if !slug.is_empty() {
            return Project::load(layout, &slug);
        }
    }
    let cwd = std::env::current_dir()?;
    let root = canonical_root(&resolve_root(&cwd))?;
    for project in layout.list_projects()? {
        if project.root == root {
            return Ok(project);
        }
    }
    Err(Error::not_found(format!(
        "no project registered for {} — run `unipi-kanboard project add` (or pass --project <slug>)",
        root.display()
    )))
}
