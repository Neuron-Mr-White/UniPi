//! Command implementations. Every one returns the JSON payload printed by
//! `--json`; the human rendering is derived from it in `main`.

use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};

use crate::board::Board;
use crate::deps;
use crate::error::{Error, Result};
use crate::format;
use crate::model::{Actor, ChainGate, Priority, Run, RunMode, RunOwner, Staleness, Status, Task};
use crate::order;
use crate::store::{self, Layout, Project};
use crate::transitions;

/// Options shared by every command.
#[derive(Debug, Clone)]
pub struct Common {
    pub actor: Actor,
    pub gate: ChainGate,
    /// Session id from --session / $UNIPI_KANBOARD_SESSION (agent calls carry it).
    pub session: Option<String>,
    pub now: DateTime<Utc>,
}

impl Common {
    pub fn new(actor: Actor, gate: ChainGate) -> Self {
        Common {
            actor,
            gate,
            session: None,
            now: Utc::now(),
        }
    }

    /// The session tag recorded on agent writes (None for user/system).
    fn tag(&self) -> Option<&str> {
        match self.actor {
            Actor::Agent => self.session.as_deref(),
            _ => None,
        }
    }
}

pub fn task_json(board: &Board<'_>, task: &Task, all: &[Task], gate: ChainGate) -> Value {
    let by_id = board.dep_lookup(all);
    let blocked = deps::blocked_by(task, &by_id, gate);
    let mut value = serde_json::to_value(task).unwrap_or(Value::Null);
    if let Value::Object(ref mut map) = value {
        map.insert(
            "path".into(),
            json!(board.task_path(&task.id).to_string_lossy()),
        );
        map.insert("displayTitle".into(), json!(task.display_title()));
        map.insert("creator".into(), json!(task.creator_of().as_str()));
        map.insert("ready".into(), json!(deps::is_ready(task, &by_id, gate)));
        map.insert("staleness".into(), json!(staleness_of(task)));
        map.insert(
            "allowedMoves".into(),
            json!(
                transitions::allowed_targets(task.status, Actor::User)
                    .iter()
                    .map(|status| status.as_str())
                    .collect::<Vec<_>>()
            ),
        );
        map.insert(
            "depsStatus".into(),
            json!(
                task.deps
                    .iter()
                    .map(|dep| json!({
                        "id": dep,
                        "status": by_id(dep).map(|task| task.status),
                    }))
                    .collect::<Vec<_>>()
            ),
        );
        map.insert(
            "lockedBy".into(),
            json!(deps::locked_by(task, &by_id, gate)),
        );
        if task.status == Status::Blocked {
            // The comment on the latest move *into* blocked is the reason.
            let reason = task
                .activity
                .iter()
                .rev()
                .find(|entry| entry.text.starts_with("blocked"))
                .map(|entry| {
                    json!({
                        "text": entry.text.trim_start_matches("blocked").trim_start_matches([':', '—', ' ']),
                        "actor": entry.actor.as_str(),
                        "at": entry.at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    })
                });
            if let Some(reason) = reason {
                map.insert("blockedReason".into(), reason);
            }
        }
        if let Some(report) = status_report(task) {
            map.insert("statusReport".into(), report);
        }
        map.insert(
            "attachments".into(),
            json!(crate::attachments::list(
                board.layout,
                &board.project.slug,
                &task.id
            )),
        );
        map.insert(
            "waitingFor".into(),
            match blocked {
                Some(blocked) => json!(
                    blocked
                        .pending
                        .iter()
                        .map(|(id, _)| id.clone())
                        .collect::<Vec<_>>()
                ),
                None => json!([]),
            },
        );
    }
    value
}

// ─── project ────────────────────────────────────────────────────────────────

pub fn project_add(
    layout: &Layout,
    root: Option<&std::path::Path>,
    name: Option<&str>,
    prefix: Option<&str>,
) -> Result<Value> {
    let cwd = std::env::current_dir()?;
    let root = root
        .map(|path| path.to_path_buf())
        .unwrap_or_else(|| store::resolve_root(&cwd));
    let slug = store::slug_for(&store::canonical_root(&root)?);
    // Re-registering a project must never reset its id counter: a reset hands
    // out ids that already exist on disk and overwrites those tasks.
    let existing = Project::load(layout, &slug).ok();
    let mut project = Project::create(layout, &root, name, prefix)?;
    if let Some(previous) = existing {
        project.next_id = project.next_id.max(previous.next_id);
        // Onboarding an archived project's folder brings it back.
        project.archived = false;
        project.save(layout)?;
    }
    Ok(json!(project))
}

pub fn project_list(layout: &Layout) -> Result<Value> {
    let projects = layout.list_projects()?;
    Ok(json!(projects))
}

/// `project archive|unarchive <slug>` — user only, checked by the caller.
pub fn project_set_archived(layout: &Layout, slug: &str, archived: bool) -> Result<Value> {
    let mut project = Project::load(layout, slug)?;
    project.archived = archived;
    project.save(layout)?;
    Ok(json!(project))
}

/// `project rebind <slug> --root <path>` — user only, checked by the caller.
/// Repoints a registered project at a new root (the folder moved on disk):
/// the slug, tasks and history are untouched — only `root` changes. The new
/// root is canonicalized (it must exist) and must not already be used by
/// another registered project; the write goes through the same atomic
/// `project.json` write and the same per-project `board.lock` every other
/// write uses, so a concurrent writer never sees a half-written file.
pub fn project_rebind(layout: &Layout, slug: &str, root: &std::path::Path) -> Result<Value> {
    let canonical = store::canonical_root(root)?;
    let lock = layout.lock_board(slug)?;
    let mut project = Project::load(layout, slug)?;
    if project.root == canonical {
        return Err(Error::rule(format!(
            "project {slug} is already rooted at {}",
            canonical.display()
        )));
    }
    for other in layout.list_projects()? {
        if other.slug != slug && other.root == canonical {
            return Err(Error::rule(format!(
                "{} is already registered at {} — refusing to bind two projects to the same root",
                other.slug,
                canonical.display()
            )));
        }
    }
    project.root = canonical;
    project.save(layout)?;
    drop(lock);
    Ok(json!(project))
}

pub fn project_show(layout: &Layout, project: &Project) -> Result<Value> {
    let board = Board::open(layout, project.clone())?;
    let tasks = board.tasks()?;
    let mut counts = serde_json::Map::new();
    for status in Status::ALL {
        let count = tasks.iter().filter(|task| task.status == status).count();
        counts.insert(status.as_str().to_string(), json!(count));
    }
    Ok(json!({
        "project": project,
        "counts": counts,
        "total": tasks.len(),
    }))
}

// ─── tasks ──────────────────────────────────────────────────────────────────

/// Trim, drop empties and dedupe case-insensitively, preserving first-seen
/// order and the first-seen spelling of each one.
fn clean_labels(labels: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for label in labels {
        let label = label.trim();
        if label.is_empty() {
            continue;
        }
        if !out.iter().any(|existing: &String| existing.eq_ignore_ascii_case(label)) {
            out.push(label.to_string());
        }
    }
    out
}

/// UNI-100: resolve `labels` (trimmed) against `existing` project labels
/// (also trimmed, case-insensitive match, union of every lane including
/// archived — see `Board::project_labels`). Known labels are rewritten to
/// their stored (canonical) spelling. Unless `allow_new`, a label matching
/// nothing already on the project is refused before anything is written —
/// the task/edit is unaffected by the attempt; with `allow_new` any label is
/// accepted as typed (still trimmed/deduped).
fn resolve_labels(labels: &[String], existing: &[String], allow_new: bool) -> Result<Vec<String>> {
    let cleaned = clean_labels(labels);
    let mut out = Vec::new();
    for label in cleaned {
        match existing.iter().find(|candidate| candidate.eq_ignore_ascii_case(&label)) {
            Some(canonical) => {
                if !out.iter().any(|seen: &String| seen.eq_ignore_ascii_case(canonical)) {
                    out.push(canonical.clone());
                }
            }
            None => {
                if allow_new {
                    out.push(label);
                    continue;
                }
                if existing.is_empty() {
                    return Err(Error::rule(format!(
                        "no labels exist yet — pass --new-label to create \"{label}\""
                    )));
                }
                let mut sorted: Vec<&String> = existing.iter().collect();
                sorted.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
                let list = sorted
                    .iter()
                    .map(|label| label.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(Error::rule(format!(
                    "unknown label \"{label}\" — existing labels: {list}. Reuse one, or pass --new-label to create it on purpose."
                )));
            }
        }
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
pub fn add(
    layout: &Layout,
    project: Project,
    common: &Common,
    title: &str,
    body: Option<&str>,
    status: Option<Status>,
    priority: Priority,
    after: &[String],
    attach: &[std::path::PathBuf],
    labels: &[String],
    new_label: bool,
) -> Result<Value> {
    let status = status.unwrap_or(Status::Backlog);
    if !matches!(status, Status::Backlog | Status::Todo) {
        return Err(Error::usage(format!(
            "new tasks start in backlog or todo, not {status}"
        )));
    }
    // A task needs a point: a title or a description. The body here is the
    // user's text — attachment embeds are appended below and count for nothing.
    if title.trim().is_empty() && body.unwrap_or("").trim().is_empty() {
        return Err(Error::usage("a task needs a title or a description"));
    }
    let lock = layout.lock_board(&project.slug)?;
    // Re-read under the lock: a stale in-memory copy would hand out a used id.
    let mut project = Project::load(layout, &project.slug)?;
    let id = project.reserve_id(layout)?;
    let board = Board::open(layout, project.clone())?;
    let tasks = board.tasks()?;

    for dep in after {
        if !tasks.iter().any(|task| task.id == *dep) {
            return Err(Error::not_found(format!(
                "--after {dep}: no such task (dependencies must exist)"
            )));
        }
    }
    for dep in after {
        deps::check_cycle(&tasks, &id, dep)?;
    }

    let lane = order::lane(tasks.iter().filter(|task| task.status == status));
    let mut task = Task::new(
        id.clone(),
        title.trim().to_string(),
        status,
        priority,
        order::bottom_of(&lane),
        common.now,
    );
    let mut body = body.unwrap_or("").trim().to_string();
    for file in attach {
        let bytes = std::fs::read(file)
            .map_err(|err| Error::usage(format!("cannot read {}: {err}", file.display())))?;
        let original = file
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".into());
        let attachment = crate::attachments::store(layout, &project.slug, &id, &original, &bytes)?;
        body = embed_attachment(&body, &file.to_string_lossy(), &attachment.markdown);
    }
    task.body = body.trim().to_string();
    task.deps = after.to_vec();
    // UNI-100: the agent-created guard applies to the agent actor only (a
    // human picking from the same label list stays free to create one on
    // the spot, same as the web UI) — a label must already exist on the
    // project (trimmed, case-insensitive) unless --new-label opts in; a
    // match is rewritten to its stored spelling.
    task.labels = if common.actor == Actor::Agent {
        let existing_labels = board.project_labels()?;
        resolve_labels(labels, &existing_labels, new_label)?
    } else {
        clean_labels(labels)
    };
    // The creator is written once here and never again (UNI-59).
    task.creator = Some(common.actor);
    task.push_activity_session(
        common.now,
        common.actor,
        common.tag(),
        format!("created in {status}"),
    );
    board.save(&task)?;
    drop(lock);

    let mut value = task_json(&board, &task, &tasks, common.gate);
    if let Value::Object(ref mut map) = value {
        map.insert("id".into(), json!(id));
    }
    Ok(value)
}

/// The report behind the task's current status — what the reviewer or the
/// person unblocking it reads: for in_review the latest `finished:` (agent) or
/// `released to in_review:` (legacy runner) entry, for blocked the latest
/// `blocked:` entry. The status prefix is stripped; the text is the full,
/// untruncated comment (markdown).
fn status_report(task: &Task) -> Option<Value> {
    let (kind, prefixes): (&str, &[&str]) = match task.status {
        Status::InReview => ("review", &["finished:", "released to in_review:"]),
        Status::Blocked => ("blocked", &["blocked:", "blocked"]),
        _ => return None,
    };
    task.activity.iter().rev().find_map(|entry| {
        let prefix = prefixes.iter().find(|prefix| entry.text.starts_with(**prefix))?;
        let text = entry.text[prefix.len()..].trim_start_matches([':', '—', ' ']).trim();
        Some(json!({
            "kind": kind,
            "text": text,
            "actor": entry.actor.as_str(),
            "at": entry.at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        }))
    })
}

/// Splice an attachment reference into a body: `![label](path)` / `[label](path)`
/// constructs containing the file's path are replaced wholesale; a bare path
/// occurrence is replaced in place; absent entirely, it is appended.
fn embed_attachment(body: &str, path: &str, markdown: &str) -> String {
    let mut out = body.to_string();
    // Markdown-wrapped occurrences first: `..](path)` back to its `[`/`![`.
    let wrapped = format!("]({path})");
    while let Some(close) = out.find(&wrapped) {
        // `close` sits on the `]`; walk back to the `[` that opens the label.
        let head = &out[..close];
        let Some(open) = head.rfind('[') else { break };
        let start = if open > 0 && head.as_bytes()[open - 1] == b'!' {
            open - 1
        } else {
            open
        };
        out.replace_range(start..close + wrapped.len(), markdown);
    }
    // Bare path occurrences.
    while let Some(at) = out.find(path) {
        out.replace_range(at..at + path.len(), markdown);
    }
    if !out.contains(markdown) {
        if out.is_empty() {
            out = markdown.to_string();
        } else {
            out = format!("{out}\n\n{markdown}");
        }
    }
    out
}

/// Store `files` on task `id` and splice their markdown into `text` (a file's
/// path in the text is replaced; otherwise the reference is appended). Used by
/// `note`, `move` and `finish --attach` so a comment can carry evidence.
fn embed_files(
    layout: &Layout,
    slug: &str,
    id: &str,
    text: &str,
    files: &[std::path::PathBuf],
) -> Result<String> {
    let mut out = text.trim().to_string();
    for file in files {
        let bytes = std::fs::read(file)
            .map_err(|err| Error::usage(format!("cannot read {}: {err}", file.display())))?;
        let original = file
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".into());
        let attachment = crate::attachments::store(layout, slug, id, &original, &bytes)?;
        out = embed_attachment(&out, &file.to_string_lossy(), &attachment.markdown);
    }
    Ok(out)
}

/// `[{file, line, error}]` — the shape the CLI and the UI both report.
pub fn problems_json(problems: &[crate::error::Problem]) -> Value {
    json!(
        problems
            .iter()
            .map(|problem| json!({
                "file": problem.file,
                "line": problem.line,
                "error": problem.message,
                "fixable": problem.fixable,
            }))
            .collect::<Vec<_>>()
    )
}

pub fn list(
    layout: &Layout,
    project: Project,
    gate: ChainGate,
    statuses: &[Status],
    ready_only: bool,
) -> Result<Value> {
    let board = Board::open(layout, project)?;
    let (tasks, problems) = board.state()?;
    let by_id = board.dep_lookup(&tasks);

    let mut selected: Vec<&Task> = tasks
        .iter()
        .filter(|task| statuses.contains(&task.status))
        .collect();
    if ready_only {
        selected.retain(|task| deps::is_ready(task, &by_id, gate));
    }
    let mut lane = order::lane(selected.iter().copied());
    lane.sort_by(|a, b| {
        b.priority
            .rank()
            .cmp(&a.priority.rank())
            .then_with(|| a.order.cmp(&b.order))
            .then_with(|| a.id.cmp(&b.id))
    });

    let items: Vec<Value> = lane
        .iter()
        .map(|task| {
            let mut value = task_json(&board, task, &tasks, gate);
            if let Value::Object(ref mut map) = value {
                map.insert("ready".into(), json!(deps::is_ready(task, &by_id, gate)));
            }
            value
        })
        .collect();
    Ok(json!({
        "tasks": items,
        "problems": problems_json(&problems),
    }))
}

pub fn show(layout: &Layout, project: Project, id: &str, gate: ChainGate) -> Result<Value> {
    let board = Board::open(layout, project)?;
    let tasks = board.tasks()?;
    // Cold tasks aren't in the scan — `get` reports them as "in cold storage".
    let task = match Board::find(&tasks, id) {
        Ok(task) => task.clone(),
        // Cold tasks aren't in the scan — `get` reports "in cold storage".
        Err(_) => board.get(id)?,
    };
    Ok(task_json(&board, &task, &tasks, gate))
}

pub fn note(
    layout: &Layout,
    project: Project,
    common: &Common,
    id: &str,
    text: &str,
) -> Result<Value> {
    note_with(layout, project, common, id, text, &[])
}

/// `note` with files attached to the comment (`note --attach`).
pub fn note_with(
    layout: &Layout,
    project: Project,
    common: &Common,
    id: &str,
    text: &str,
    attach: &[std::path::PathBuf],
) -> Result<Value> {
    if text.trim().is_empty() && attach.is_empty() {
        return Err(Error::usage("note text must not be empty"));
    }
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let mut task = board.get(id)?;
    let text = embed_files(layout, &board.project.slug, &task.id, text, attach)?;
    task.push_activity_session(common.now, common.actor, common.tag(), &text);
    board.save(&task)?;
    drop(lock);
    let tasks = board.tasks()?;
    Ok(task_json(&board, &task, &tasks, common.gate))
}

/// Attach a file to a task; with `note`, also log a comment that embeds it.
pub fn attach(
    layout: &Layout,
    project: Project,
    common: &Common,
    id: &str,
    original_name: &str,
    bytes: &[u8],
    note: Option<&str>,
) -> Result<Value> {
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let mut task = board.get(id)?;
    let attachment =
        crate::attachments::store(layout, &board.project.slug, &task.id, original_name, bytes)?;
    let text = match note.map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => format!("{text}\n{}", attachment.markdown),
        None => format!("attached {}", attachment.markdown),
    };
    task.push_activity_session(common.now, common.actor, common.tag(), &text);
    board.save(&task)?;
    drop(lock);
    let tasks = board.tasks()?;
    let mut value = task_json(&board, &task, &tasks, common.gate);
    if let Value::Object(ref mut map) = value {
        map.insert("attachment".into(), json!(attachment));
    }
    Ok(value)
}

/// Store a file without logging activity (the UI uploads first, then posts the
/// comment that references it — so one comment can carry several files).
pub fn upload(
    layout: &Layout,
    project: Project,
    id: &str,
    original_name: &str,
    bytes: &[u8],
) -> Result<Value> {
    let board = Board::open(layout, project)?;
    let task = board.get(id)?;
    let attachment =
        crate::attachments::store(layout, &board.project.slug, &task.id, original_name, bytes)?;
    Ok(json!(attachment))
}

pub struct EditArgs<'a> {
    pub title: Option<&'a str>,
    pub body: Option<&'a str>,
    pub priority: Option<Priority>,
    pub labels: Option<Vec<String>>,
    /// UNI-100: opt in to creating labels that do not already exist on the
    /// project. Ignored when `labels` is `None`.
    pub new_label: bool,
}

pub fn edit(
    layout: &Layout,
    project: Project,
    common: &Common,
    id: &str,
    args: EditArgs<'_>,
) -> Result<Value> {
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let mut task = board.get(id)?;
    // Agents may rewrite only their own drafts: created by an agent (the first
    // activity entry) and not yet claimed/scheduled beyond todo.
    if common.actor == Actor::Agent {
        let owned = task.activity.first().map(|entry| entry.actor) == Some(Actor::Agent);
        let draft = matches!(task.status, Status::Backlog | Status::Todo);
        if !(owned && draft) {
            return Err(Error::rule(
                "agents may only edit tasks they created while in backlog/todo — add a note instead",
            ));
        }
    }
    let mut changed = Vec::new();
    if let Some(title) = args.title {
        task.title = title.trim().to_string();
        changed.push("title");
    }
    if let Some(body) = args.body {
        task.body = body.trim().to_string();
        changed.push("body");
    }
    if let Some(priority) = args.priority {
        task.priority = priority;
        changed.push("priority");
    }
    if let Some(labels) = args.labels {
        // UNI-100: the agent-created guard applies to the agent actor only
        // (the web UI/user keeps creating labels on the spot); resolve
        // against the whole-project label union — a label this task
        // already carries always matches there too.
        task.labels = if common.actor == Actor::Agent {
            let existing_labels = board.project_labels()?;
            resolve_labels(&labels, &existing_labels, args.new_label)?
        } else {
            clean_labels(&labels)
        };
        changed.push("labels");
    }
    if changed.is_empty() {
        return Err(Error::usage(
            "edit needs at least one of --title/--body/--priority/--labels",
        ));
    }
    // An empty title is fine as long as the body carries the point (and vice
    // versa) — the task must not end up with neither.
    if task.title.trim().is_empty() && task.body.trim().is_empty() {
        return Err(Error::usage("a task needs a title or a description"));
    }
    task.push_activity_session(
        common.now,
        common.actor,
        common.tag(),
        format!("edited {}", changed.join(", ")),
    );
    board.save(&task)?;
    drop(lock);
    let tasks = board.tasks()?;
    Ok(task_json(&board, &task, &tasks, common.gate))
}

pub fn link(
    layout: &Layout,
    project: Project,
    common: &Common,
    gate: ChainGate,
    id: &str,
    dep: &str,
    remove: bool,
) -> Result<Value> {
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let tasks = board.tasks()?;
    let mut task = Board::find(&tasks, id)?.clone();

    if remove {
        if !task.deps.iter().any(|existing| existing == dep) {
            return Err(Error::rule(format!("{id} does not depend on {dep}")));
        }
        task.deps.retain(|existing| existing != dep);
        task.push_activity_session(
            common.now,
            common.actor,
            common.tag(),
            format!("unlinked {dep}"),
        );
    } else {
        if !tasks.iter().any(|candidate| candidate.id == dep) {
            return Err(Error::not_found(format!("--after {dep}: no such task")));
        }
        if task.deps.iter().any(|existing| existing == dep) {
            return Err(Error::rule(format!("{id} already depends on {dep}")));
        }
        deps::check_cycle(&tasks, id, dep)?;
        task.deps.push(dep.to_string());
        task.push_activity_session(
            common.now,
            common.actor,
            common.tag(),
            format!("linked after {dep}"),
        );
    }
    board.save(&task)?;
    drop(lock);
    Ok(task_json(&board, &task, &tasks, gate))
}

pub enum OrderTarget<'a> {
    Top,
    Bottom,
    Before(&'a str),
    AfterPos(&'a str),
}

pub fn order(
    layout: &Layout,
    project: Project,
    common: &Common,
    id: &str,
    target: OrderTarget<'_>,
) -> Result<Value> {
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let tasks = board.tasks()?;
    let mut task = Board::find(&tasks, id)?.clone();

    let mut lane_tasks: Vec<Task> = tasks
        .iter()
        .filter(|candidate| candidate.status == task.status && candidate.id != task.id)
        .cloned()
        .collect();

    let mut rebalanced = 0usize;
    let new_order = match slot(&lane_tasks, &target) {
        Some(value) => value,
        None => {
            rebalanced = rebalance_lane(&board, &lane_tasks)?;
            lane_tasks = board
                .tasks()?
                .into_iter()
                .filter(|candidate| candidate.status == task.status && candidate.id != task.id)
                .collect();
            slot(&lane_tasks, &target).ok_or_else(|| {
                Error::rule("cannot place the task even after rebalancing the lane")
            })?
        }
    };

    task.order = new_order;
    task.push_activity_session(
        common.now,
        common.actor,
        common.tag(),
        format!("ordered (position {new_order})"),
    );
    board.save(&task)?;
    drop(lock);

    let tasks = board.tasks()?;
    let current = tasks.iter().find(|t| t.id == id).cloned().unwrap_or(task);
    let mut value = task_json(&board, &current, &tasks, common.gate);
    if let Value::Object(ref mut map) = value {
        map.insert("rebalanced".into(), json!(rebalanced));
    }
    Ok(value)
}

/// Target slot for a placement, or `None` when the lane needs rebalancing first.
fn slot(lane_tasks: &[Task], target: &OrderTarget<'_>) -> Option<i64> {
    let lane = order::lane(lane_tasks.iter());
    match target {
        OrderTarget::Top => {
            Some(lane.first().map(|task| task.order).unwrap_or(order::STEP) - order::STEP)
        }
        OrderTarget::Bottom => Some(order::bottom_of(&lane)),
        OrderTarget::Before(target_id) => order::before(&lane, target_id).ok().flatten(),
        OrderTarget::AfterPos(target_id) => order::after(&lane, target_id).ok().flatten(),
    }
}

fn rebalance_lane(board: &Board<'_>, lane_tasks: &[Task]) -> Result<usize> {
    let lane = order::lane(lane_tasks.iter());
    let rewritten = order::rebalance(&lane);
    for (id, new_order) in &rewritten {
        let mut task = board.get(id)?;
        task.order = *new_order;
        board.save(&task)?;
    }
    Ok(rewritten.len())
}

// ─── start / finish / release / reap ──────────────────────────────────────────────

/// At most `max_sessions()` distinct sessions hold in_progress tasks.
fn session_cap(tasks: &[Task], session: &str) -> Result<()> {
    let mut others: Vec<&str> = Vec::new();
    for task in tasks {
        if task.status != Status::InProgress {
            continue;
        }
        let Some(run) = &task.run else { continue };
        if run.session != session && !others.contains(&run.session.as_str()) {
            others.push(run.session.as_str());
        }
    }
    if others.len() >= max_sessions() {
        return Err(Error::rule(format!(
            "{} sessions already run tasks here ({}) — wait for one to finish",
            others.len(),
            others.join(", ")
        )));
    }
    Ok(())
}

/// Release every in-progress task whose run pid is dead on this host.
/// `tasks` is updated to reflect the releases even on `dry_run` (nothing is
/// written then); returns (released ids, foreign-host claims we cannot judge).
fn reap_dead(
    board: &Board<'_>,
    tasks: &mut [Task],
    now: DateTime<Utc>,
    dry_run: bool,
) -> (Vec<String>, Vec<String>) {
    let host = hostname();
    let mut released = Vec::new();
    let mut unknown = Vec::new();
    for task in tasks.iter_mut() {
        if task.status != Status::InProgress {
            continue;
        }
        let Some(run) = task.run.clone() else {
            continue;
        };
        if run.host != host {
            unknown.push(task.id.clone());
            continue;
        }
        if pid_alive(run.pid) {
            continue;
        }
        released.push(task.id.clone());
        task.status = Status::Todo;
        task.run = None;
        if !dry_run {
            task.push_activity(
                now,
                Actor::System,
                format!(
                    "session lost: {} (pid {}) ended without releasing",
                    run.session, run.pid
                ),
            );
            if let Err(err) = board.save(task) {
                eprintln!("reap could not write {}: {err}", task.id);
            }
        }
    }
    (released, unknown)
}

/// `reap [--dry-run]`: release claims whose pid is gone on this host.
pub fn reap(layout: &Layout, project: Project, dry_run: bool, now: DateTime<Utc>) -> Result<Value> {
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let mut tasks = board.tasks()?;
    let (released, unknown) = reap_dead(&board, &mut tasks, now, dry_run);
    drop(lock);
    Ok(json!({ "released": released, "unknown": unknown }))
}

/// The order `next` suggests ready tasks in: priority desc, then order, then id.
fn claim_sort(a: &&Task, b: &&Task) -> std::cmp::Ordering {
    b.priority
        .rank()
        .cmp(&a.priority.rank())
        .then_with(|| a.order.cmp(&b.order))
        .then_with(|| a.id.cmp(&b.id))
}

fn waiting_json(
    by_id: &dyn Fn(&str) -> Option<Task>,
    tasks: &[Task],
    gate: ChainGate,
) -> Vec<Value> {
    tasks
        .iter()
        .filter(|task| task.status == Status::Todo)
        .map(|task| {
            json!({
                "id": task.id,
                "waitingFor": deps::blocked_by(task, &by_id, gate)
                    .map(|blocked| blocked.pending.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>())
                    .unwrap_or_default(),
                "lockedBy": deps::locked_by(task, &by_id, gate),
            })
        })
        .collect()
}

pub struct StartArgs<'a> {
    pub session: &'a str,
    /// The long-lived process that owns the claim (the pi process, not the
    /// short-lived CLI) — the stale-claim reaper checks it.
    pub pid: u32,
    pub host: &'a str,
}

/// `start <ID>`: the agent self-claims a todo task for its session
/// (todo → in_progress, actor agent), or resumes a task it blocked
/// (blocked → in_progress — UNI-105: the same claim and session-cap rules
/// apply either way). Deps must be satisfied, the task not already claimed,
/// and the per-project session cap free; a session may hold several started
/// tasks.
pub fn start(
    layout: &Layout,
    project: Project,
    gate: ChainGate,
    id: &str,
    args: &StartArgs<'_>,
    now: DateTime<Utc>,
) -> Result<Value> {
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let mut tasks = board.tasks()?;
    // Dead sessions give their tasks back first.
    reap_dead(&board, &mut tasks, now, false);
    let by_id = board.dep_lookup(&tasks);
    let task = tasks
        .iter()
        .find(|task| task.id == id)
        .ok_or_else(|| Error::not_found(format!("start {id}: no such task")))?;
    if task.status == Status::InProgress {
        let owner = task.run.as_ref();
        if owner.is_some_and(|run| run.session == args.session) {
            return Err(Error::rule(format!(
                "start {id}: already in progress for this session — `finish {id} --comment \"…\"` when done"
            )));
        }
        return Err(Error::rule(format!(
            "start {id}: already claimed by {} {}",
            owner.map(|run| run.owner.as_str()).unwrap_or("nobody"),
            owner.map(|run| run.session.as_str()).unwrap_or("?"),
        )));
    }
    // UNI-105: `start` also resumes a task the agent itself blocked — same
    // claim and session-cap rules as a fresh todo claim.
    if !matches!(task.status, Status::Todo | Status::Blocked) {
        return Err(Error::rule(format!(
            "start {id}: the task is {}, not todo or blocked{}",
            task.status,
            if task.status == Status::Backlog {
                " — move it to todo first"
            } else {
                ""
            }
        )));
    }
    let from = task.status;
    if task.is_claimed() {
        return Err(Error::rule(format!(
            "start {id}: the task is already claimed"
        )));
    }
    // UNI-105 regression: `blocked_by` only evaluates todo tasks — resuming
    // a blocked one must not bypass the same dependency gate a fresh todo
    // claim is held to, so the status-agnostic check runs for both.
    if let Some(blocked) = deps::pending_deps_regardless_of_status(task, &by_id, gate) {
        return Err(Error::rule(format!(
            "start {id}: {}",
            blocked.describe(gate)
        )));
    }
    session_cap(&tasks, args.session)?;
    transitions::check(from, Status::InProgress, Actor::Agent, None, Staleness::Running)?;

    let mut task = task.clone();
    task.status = Status::InProgress;
    task.run = Some(Run {
        session: args.session.to_string(),
        pid: args.pid,
        host: args.host.to_string(),
        mode: RunMode::None,
        goal: None,
        started: now,
        owner: RunOwner::Agent,
    });
    task.push_activity_session(
        now,
        Actor::Agent,
        Some(args.session),
        if from == Status::Blocked {
            format!("resumed from blocked (pid {} on {})", args.pid, args.host)
        } else {
            format!("started (pid {} on {})", args.pid, args.host)
        },
    );
    board.save(&task)?;
    drop(lock);

    let tasks = board.tasks()?;
    let mut value = task_json(&board, &task, &tasks, gate);
    if let Value::Object(ref mut map) = value {
        map.insert("handoffNotes".into(), json!(task.handoff_notes()));
    }
    Ok(value)
}

/// `finish <ID> --comment "…"`: the agent hands a task it `start`ed to review
/// (in_progress → in_review, actor agent). Refused for another session's claim
/// and for legacy system claims (not taken with `start`; a user releases those).
#[allow(clippy::too_many_arguments)]
pub fn finish(
    layout: &Layout,
    project: Project,
    gate: ChainGate,
    id: &str,
    session: &str,
    comment: &str,
    attach: &[std::path::PathBuf],
    now: DateTime<Utc>,
) -> Result<Value> {
    let summary = comment.trim();
    if summary.is_empty() {
        return Err(Error::rule(format!(
            "finish {id} requires --comment (a summary of what you did — the reviewer reads it)"
        )));
    }
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let mut task = board.get(id)?;
    if task.status != Status::InProgress {
        return Err(Error::rule(format!(
            "finish {id}: the task is {}, not in_progress{}",
            task.status,
            if task.status == Status::Todo {
                format!(" — `start {id}` first")
            } else {
                String::new()
            }
        )));
    }
    match task.run.as_ref() {
        None => {
            return Err(Error::rule(format!(
                "finish {id}: the task has no claim (run `validate`)"
            )));
        }
        Some(run) if run.owner != RunOwner::Agent => {
            return Err(Error::rule(format!(
                "finish {id}: held by a system claim (session {}), not one taken with `start` — a user releases it (`release {id} --to in_review|todo --comment …`)",
                run.session
            )));
        }
        Some(run) if run.session != session => {
            return Err(Error::rule(format!(
                "finish {id}: started by session {}, not this one ({session}) — only the session that started it can finish it",
                run.session
            )));
        }
        Some(_) => {}
    }
    transitions::check(
        Status::InProgress,
        Status::InReview,
        Actor::Agent,
        Some(summary),
        Staleness::Running,
    )?;
    let summary = embed_files(layout, &board.project.slug, &task.id, summary, attach)?;
    task.status = Status::InReview;
    task.run = None;
    task.push_activity_session(
        now,
        Actor::Agent,
        Some(session),
        format!("finished: {summary}"),
    );
    board.save(&task)?;
    drop(lock);
    let tasks = board.tasks()?;
    Ok(task_json(&board, &task, &tasks, gate))
}

pub fn release(
    layout: &Layout,
    project: Project,
    id: &str,
    to: Status,
    comment: &str,
    gate: ChainGate,
    now: DateTime<Utc>,
) -> Result<Value> {
    if !matches!(to, Status::Todo | Status::InReview | Status::Blocked) {
        return Err(Error::usage(
            "release --to must be todo, in_review or blocked (release only hands back an in-progress claim)",
        ));
    }
    if comment.trim().is_empty() {
        return Err(Error::rule(format!(
            "release to {to} requires --comment (the note is what the next reader sees)"
        )));
    }
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let mut task = board.get(id)?;
    let from = task.status;
    transitions::check(from, to, Actor::System, Some(comment), Staleness::Running)?;
    task.status = to;
    task.run = None;
    task.push_activity(
        now,
        Actor::System,
        format!("released to {to}: {}", comment.trim()),
    );
    board.save(&task)?;
    drop(lock);
    let tasks = board.tasks()?;
    Ok(task_json(&board, &task, &tasks, gate))
}

// ─── move ───────────────────────────────────────────────────────────────────

pub fn move_task(
    layout: &Layout,
    project: Project,
    common: &Common,
    id: &str,
    to: Status,
    comment: Option<&str>,
) -> Result<Value> {
    move_task_with(layout, project, common, id, to, comment, &[])
}

/// `move` with files attached to the comment (`move --attach`).
pub fn move_task_with(
    layout: &Layout,
    project: Project,
    common: &Common,
    id: &str,
    to: Status,
    comment: Option<&str>,
    attach: &[std::path::PathBuf],
) -> Result<Value> {
    let (value, _) = move_task_undoable(layout, project, common, id, to, comment, attach)?;
    Ok(value)
}

/// The material an undo needs: the exact pre-move task and the exact
/// post-move task (compared wholesale — activity included — to reject any
/// intervening change).
#[derive(Debug, Clone)]
pub struct UndoMove {
    pub before: Task,
    pub after: Task,
}

/// `move` that also reports undo material. The pre-move task is captured
/// under the same board lock that performs the write, so the snapshot can
/// never race another writer. `UndoMove` is `Some` only for hard-to-reverse
/// user transitions to a terminal lane (see `transitions::undo_worthy`) on a
/// task with no live claim — claims are never revived (UNI-57).
#[allow(clippy::too_many_arguments)]
pub fn move_task_undoable(
    layout: &Layout,
    project: Project,
    common: &Common,
    id: &str,
    to: Status,
    comment: Option<&str>,
    attach: &[std::path::PathBuf],
) -> Result<(Value, Option<UndoMove>)> {
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let read = board.get(id)?;
    let undoable =
        transitions::undo_worthy(read.status, to, common.actor) && read.run.is_none();
    let before = read.clone();
    let mut task = read;
    let from = task.status;
    let staleness = staleness_of(&task);
    // The self-claim moves have their own commands: `move` would skip the
    // claim bookkeeping (run block, ownership, summary).
    if common.actor == Actor::Agent {
        match (from, to) {
            (Status::Todo, Status::InProgress) => {
                return Err(Error::rule(format!(
                    "use `start {id}` to begin a task (it claims it for your session)"
                )));
            }
            (Status::Blocked, Status::InProgress) => {
                return Err(Error::rule(format!(
                    "use `start {id}` to resume a blocked task (it claims it for your session)"
                )));
            }
            (Status::InProgress, Status::InReview) => {
                return Err(Error::rule(format!(
                    "use `finish {id} --comment \"<summary>\"` to hand a task you started to review"
                )));
            }
            _ => {}
        }
    }
    transitions::check(from, to, common.actor, comment, staleness)?;

    // An agent may block only the task its own session is running.
    if common.actor == Actor::Agent && from == Status::InProgress && to == Status::Blocked {
        let claimed_by = task.run.as_ref().map(|run| run.session.as_str());
        match common.session.as_deref() {
            None => {
                return Err(Error::rule(format!(
                    "agent may block {id} only while its own session runs it (no --session given{}; claimed by {})",
                    claimed_by.map(|_| "").unwrap_or(" and it has no run block"),
                    claimed_by.unwrap_or("nobody"),
                )));
            }
            Some(session) if claimed_by != Some(session) => {
                return Err(Error::rule(format!(
                    "agent may block {id} only while its own session runs it (session {session}; claimed by {})",
                    claimed_by.unwrap_or("nobody"),
                )));
            }
            _ => {}
        }
    }

    task.status = to;
    let note = embed_files(layout, &board.project.slug, &task.id, comment.unwrap_or(""), attach)?;
    let note = note.as_str();
    let text = match (from, to) {
        (_, Status::Blocked) => format!("blocked: {note}"),
        (Status::Blocked, Status::Todo) => {
            // UNI-106: the answer is optional — an empty note reads as a bare
            // "unblocked", not "unblocked: " with nothing after the colon.
            if note.is_empty() {
                "unblocked".to_string()
            } else {
                format!("unblocked: {note}")
            }
        }
        (Status::InReview, Status::Todo) | (Status::InReview, Status::Backlog) => {
            // UNI-106: the rework note is optional.
            if note.is_empty() {
                "rework".to_string()
            } else {
                format!("rework: {note}")
            }
        }
        (_, Status::Cancelled) => {
            if note.is_empty() {
                "cancelled".to_string()
            } else {
                format!("cancelled: {note}")
            }
        }
        (_, Status::Archived) => "archived".to_string(),
        _ => {
            if note.is_empty() {
                format!("moved {from} → {to}")
            } else {
                format!("moved {from} → {to}: {note}")
            }
        }
    };
    task.push_activity_session(common.now, common.actor, common.tag(), text);

    // Leaving in_progress always clears the run block.
    if from == Status::InProgress && to != Status::InProgress {
        task.run = None;
    }
    board.save(&task)?;
    drop(lock);
    let tasks = board.tasks()?;
    let value = task_json(&board, &task, &tasks, common.gate);
    let undo = undoable.then(|| UndoMove {
        before,
        after: task.clone(),
    });
    Ok((value, undo))
}

/// Undo one move: restore the exact pre-move task — status and everything —
/// after verifying nothing has changed since the move. The comparison is the
/// full canonical file text (activity included), so any intervening write —
/// note, edit, reorder, another move, even within the same second — is caught
/// (in-memory timestamps carry nanoseconds the file format rounds away, so
/// raw struct equality would both miss and misfire). The token itself is
/// checked by the caller's daemon-held store; undo is a user surface only
/// (UNI-57).
pub fn undo_move(
    layout: &Layout,
    project: Project,
    common: &Common,
    expected_after: &Task,
    before: Task,
) -> Result<Value> {
    // Defence in depth against direct library callers: undo is a user
    // surface, the snapshot must name the very task it restores, and a
    // snapshot that still carries a claim is never revived (UNI-57).
    if common.actor != Actor::User {
        return Err(Error::rule(
            "undo is a user surface — agents and system cannot undo moves",
        ));
    }
    if before.id != expected_after.id {
        return Err(Error::rule(
            "the undo snapshot does not name this task — refusing it",
        ));
    }
    if before.run.is_some() {
        return Err(Error::rule(
            "the undo snapshot carries a live claim — claims are never revived",
        ));
    }
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let current = board.get(&expected_after.id)?;
    if crate::format::render(&current) != crate::format::render(expected_after) {
        return Err(Error::rule(
            "the task changed since that move — undo is no longer available (move it back by hand)",
        ));
    }
    let to = current.status;
    let mut task = before;
    let from = task.status;
    task.push_activity_session(
        common.now,
        common.actor,
        common.tag(),
        format!("undo: {to} → {from} (state restored)"),
    );
    board.save(&task)?;
    drop(lock);
    let tasks = board.tasks()?;
    Ok(task_json(&board, &task, &tasks, common.gate))
}

/// Stale-run detection: same host → check the pid; other host → unknown.
pub fn staleness_of(task: &Task) -> Staleness {
    let Some(run) = task.run.as_ref() else {
        return Staleness::Running;
    };
    let host = hostname();
    if run.host != host {
        return Staleness::Unknown;
    }
    if pid_alive(run.pid) {
        Staleness::Running
    } else {
        Staleness::Stale
    }
}

fn env_usize(name: &str, default: usize, min: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .map(|value| value.max(min))
        .unwrap_or(default.max(min))
}

/// Distinct sessions that may hold in_progress tasks per project.
/// `UNIPI_KANBOARD_MAX_SESSIONS`, default 2, minimum 1.
pub fn max_sessions() -> usize {
    env_usize("UNIPI_KANBOARD_MAX_SESSIONS", 2, 1)
}

pub fn hostname() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::fs::read_to_string("/proc/sys/kernel/hostname")
                .ok()
                .map(|value| value.trim().to_string())
        })
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .unwrap_or_else(|| "unknown".to_string())
}

fn pid_alive(pid: u32) -> bool {
    crate::daemon::pid_alive(pid)
}

// ─── duplicate / archive / validate ─────────────────────────────────────────

pub fn duplicate(layout: &Layout, project: Project, common: &Common, id: &str) -> Result<Value> {
    let lock = layout.lock_board(&project.slug)?;
    let mut project = Project::load(layout, &project.slug)?;
    let board = Board::open(layout, project.clone())?;
    let tasks = board.tasks()?;
    let source = Board::find(&tasks, id)?.clone();
    let new_id = project.reserve_id(layout)?;
    let lane = order::lane(tasks.iter().filter(|task| task.status == Status::Backlog));

    let mut task = Task::new(
        new_id.clone(),
        source.title.clone(),
        Status::Backlog,
        source.priority,
        order::bottom_of(&lane),
        common.now,
    );
    task.body = source.body.clone();
    task.labels = source.labels.clone();
    task.deps = source.deps.clone();
    // A duplicate is a new task by whoever duplicated it (UNI-59).
    task.creator = Some(common.actor);
    task.push_activity_session(
        common.now,
        common.actor,
        common.tag(),
        format!("duplicated from {id}"),
    );
    board.save(&task)?;
    drop(lock);
    Ok(task_json(&board, &task, &tasks, common.gate))
}

pub fn archive_sweep(
    layout: &Layout,
    project: Project,
    after_days: i64,
    retention_days: i64,
    now: DateTime<Utc>,
) -> Result<Value> {
    if after_days <= 0 && retention_days <= 0 {
        return Ok(
            json!({ "archived": [], "cold": [], "skipped": "archiveAfterDays and retentionDays are 0 (off)" }),
        );
    }
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let mut tasks = board.tasks()?;
    let cutoff = now - Duration::days(after_days.max(0));
    let mut archived = Vec::new();
    if after_days > 0 {
        for task in tasks.iter_mut().filter(|task| {
            matches!(task.status, Status::Done | Status::Cancelled) && task.updated < cutoff
        }) {
            transitions::check(
                task.status,
                Status::Archived,
                Actor::System,
                None,
                Staleness::Running,
            )?;
            task.status = Status::Archived;
            task.push_activity(
                now,
                Actor::System,
                format!("archived automatically after {after_days} days"),
            );
            board.save(task)?;
            archived.push(task.id.clone());
        }
    }

    // Retention: old Archived/Cancelled tasks move to cold/ — the file keeps
    // its frozen status; dep lookups still resolve it.
    let mut cold = Vec::new();
    if retention_days > 0 {
        let cold_cutoff = now - Duration::days(retention_days);
        let dir = board.cold_dir();
        for task in tasks.iter_mut().filter(|task| {
            matches!(task.status, Status::Archived | Status::Cancelled)
                && task.updated < cold_cutoff
        }) {
            task.push_activity(
                now,
                Actor::System,
                format!("moved to cold storage after {retention_days} days"),
            );
            let target = board.cold_path(&task.id);
            std::fs::create_dir_all(&dir)?;
            // Write the final file (with the cold-storage note), then remove the live one.
            crate::store::write_atomic(&target, &crate::format::render(task))?;
            std::fs::remove_file(board.task_path(&task.id))?;
            cold.push(task.id.clone());
        }
    }
    drop(lock);
    Ok(json!({ "archived": archived, "cold": cold }))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidateResult {
    pub problems: Vec<crate::error::Problem>,
    pub fixed: Vec<String>,
}

pub fn validate(layout: &Layout, project: Project, fix: bool) -> Result<ValidateResult> {
    let lock = if fix {
        Some(layout.lock_board(&project.slug)?)
    } else {
        None
    };
    let board = Board::open(layout, project)?;
    let (tasks, mut problems) = board.scan()?;

    // Board-level rules.
    let mut seen: Vec<&str> = Vec::new();
    for task in &tasks {
        if seen.contains(&task.id.as_str()) {
            problems.push(crate::error::Problem::new(
                board.task_path(&task.id).to_string_lossy(),
                1,
                format!("duplicate task id {}", task.id),
            ));
        } else {
            seen.push(&task.id);
        }
    }
    for task in &tasks {
        for dep in &task.deps {
            if !tasks.iter().any(|candidate| candidate.id == *dep) {
                let path = board.task_path(&task.id);
                let line = format::find_key_line(
                    &std::fs::read_to_string(&path).unwrap_or_default(),
                    "deps",
                );
                problems.push(crate::error::Problem::new(
                    path.to_string_lossy(),
                    line,
                    format!("dependency {dep} does not exist (it blocks readiness forever)"),
                ));
            }
        }
    }
    for id in deps::find_cycles(&tasks) {
        problems.push(crate::error::Problem::new(
            board.task_path(&id).to_string_lossy(),
            1,
            format!("dependency cycle through {id}"),
        ));
    }
    for task in &tasks {
        if task.status == Status::InProgress && task.run.is_none() {
            problems.push(crate::error::Problem::new(
                board.task_path(&task.id).to_string_lossy(),
                1,
                "in_progress without a run block (release it, or re-claim)",
            ));
        }
        if task.status != Status::InProgress && task.run.is_some() {
            problems.push(crate::error::Problem::new(
                board.task_path(&task.id).to_string_lossy(),
                1,
                format!("run block present while status is {}", task.status),
            ));
        }
    }

    let mut fixed = Vec::new();
    if fix {
        let fixable: Vec<&crate::error::Problem> =
            problems.iter().filter(|problem| problem.fixable).collect();
        let fixable_files: Vec<String> =
            fixable.iter().map(|problem| problem.file.clone()).collect();
        for file in &fixable_files {
            let path = layout.home.join(file);
            let text = match std::fs::read_to_string(&path) {
                Ok(text) => text,
                Err(_) => continue,
            };
            let (task, _) = format::parse(file, &text);
            if let Some(task) = task {
                std::fs::write(&path, format::render(&task))
                    .map_err(|err| Error::Io(format!("cannot fix {}: {err}", path.display())))?;
                fixed.push(task.id);
            }
        }
        problems.retain(|problem| !problem.fixable);
    }
    drop(lock);

    Ok(ValidateResult { problems, fixed })
}

// ─── read-only: next / chain / search ───────────────────────────────────────

/// `next`: the ready todo task to work next (after a simulated reap) — pick it
/// up with `start <ID>` — plus the reasons every todo task is waiting. Writes
/// nothing.
pub fn next(
    layout: &Layout,
    project: Project,
    gate: ChainGate,
    now: DateTime<Utc>,
) -> Result<Value> {
    let board = Board::open(layout, project)?;
    let mut tasks = board.tasks()?;
    reap_dead(&board, &mut tasks, now, true);
    let by_id = board.dep_lookup(&tasks);
    let mut candidates: Vec<&Task> = tasks
        .iter()
        .filter(|task| deps::is_ready(task, &by_id, gate))
        .collect();
    candidates.sort_by(claim_sort);
    let task = candidates
        .first()
        .map(|task| task_json(&board, task, &tasks, gate))
        .unwrap_or(Value::Null);
    Ok(json!({ "task": task, "waiting": waiting_json(&by_id, &tasks, gate) }))
}

/// `chain <ID>`: transitive upstream deps and downstream dependents, with status.
pub fn chain(layout: &Layout, project: Project, gate: ChainGate, id: &str) -> Result<Value> {
    let board = Board::open(layout, project)?;
    let tasks = board.tasks()?;
    let task = Board::find(&tasks, id)?;
    let by_id = board.dep_lookup(&tasks);

    // Upstream: BFS over this task's deps.
    let mut upstream: Vec<String> = Vec::new();
    let mut stack = task.deps.clone();
    while let Some(current) = stack.pop() {
        if upstream.contains(&current) {
            continue;
        }
        upstream.push(current.clone());
        if let Some(dep) = by_id(&current) {
            stack.extend(dep.deps.iter().cloned());
        }
    }
    // Downstream: every task whose transitive deps reach `id`.
    let downstream: Vec<String> = tasks
        .iter()
        .filter(|candidate| {
            candidate.id != task.id && {
                let mut seen: Vec<String> = Vec::new();
                let mut stack = candidate.deps.clone();
                while let Some(current) = stack.pop() {
                    if current == task.id {
                        return true;
                    }
                    if seen.contains(&current) {
                        continue;
                    }
                    seen.push(current.clone());
                    if let Some(dep) = by_id(&current) {
                        stack.extend(dep.deps.iter().cloned());
                    }
                }
                false
            }
        })
        .map(|candidate| candidate.id.clone())
        .collect();

    let describe = |wanted: &str| -> Value {
        match by_id(wanted) {
            Some(task) => json!({
                "id": task.id,
                "title": task.title,
                "displayTitle": task.display_title(),
                "status": task.status
            }),
            None => json!({"id": wanted, "status": "missing"}),
        }
    };
    let _ = gate;
    Ok(json!({
        "id": task.id,
        "title": task.title,
        "displayTitle": task.display_title(),
        "status": task.status,
        "upstream": upstream.iter().map(|id| describe(id)).collect::<Vec<_>>(),
        "downstream": downstream.iter().map(|id| describe(id)).collect::<Vec<_>>(),
    }))
}

/// `search <text>`: case-insensitive match on id/title/body; archived excluded
/// unless `all` is set.
pub fn search(
    layout: &Layout,
    project: Project,
    gate: ChainGate,
    needle: &str,
    all: bool,
) -> Result<Value> {
    let board = Board::open(layout, project)?;
    let tasks = board.tasks()?;
    let needle = needle.to_lowercase();
    let items: Vec<Value> = tasks
        .iter()
        .filter(|task| all || task.status != Status::Archived)
        .filter(|task| {
            task.id.to_lowercase().contains(&needle)
                || task.title.to_lowercase().contains(&needle)
                || task.body.to_lowercase().contains(&needle)
        })
        .map(|task| task_json(&board, task, &tasks, gate))
        .collect();
    Ok(json!({ "tasks": items }))
}

// ─── board settings + token ────────────────────────────────────────────────

/// `settings show`: how pi is invoked, the models whitelist, whether a custom
/// summary instruction is set, and the effective limits (env or defaults).
pub fn settings_show(layout: &Layout) -> Result<Value> {
    let settings = crate::serve::settings::load(layout);
    Ok(json!({
        "piCommand": settings.pi_command,
        "models": settings.models,
        "summaryModel": settings.summary_model,
        "summaryInstructionSet": !settings.summary_instruction.trim().is_empty(),
        "maxSessions": max_sessions(),
    }))
}

/// `settings set <field> <value>` — `pi-command` takes a JSON argv array,
/// `models` a JSON array of "provider/id" strings, `summary-model` a whitelisted
/// "provider/id" (empty clears). Agent actor refused.
pub fn settings_set(layout: &Layout, common: &Common, field: &str, value: &str) -> Result<Value> {
    if common.actor == Actor::Agent {
        return Err(Error::rule("settings set is user/system only"));
    }
    let mut settings = crate::serve::settings::load(layout);
    match field {
        "pi-command" => {
            let argv: Vec<String> = serde_json::from_str(value)
                .map_err(|_| Error::usage("settings set pi-command takes a JSON argv array"))?;
            settings.pi_command = argv;
        }
        "models" => {
            let models: Vec<String> = serde_json::from_str(value)
                .map_err(|_| Error::usage("settings set models takes a JSON array of strings"))?;
            settings.models = models;
        }
        "summary-model" => {
            let model = value.trim().to_string();
            if !model.is_empty() && !settings.models.iter().any(|entry| entry == &model) {
                return Err(Error::rule(format!(
                    "summary-model `{model}` is not in the reported models list"
                )));
            }
            settings.summary_model = model;
        }
        other => {
            return Err(Error::usage(format!(
                "settings set accepts pi-command, models or summary-model — not `{other}`"
            )));
        }
    }
    crate::serve::settings::save(layout, &settings)?;
    Ok(json!({
        "piCommand": settings.pi_command,
        "models": settings.models,
        "summaryModel": settings.summary_model,
    }))
}

/// `rotate-token`: drop <home>/token so the next --keep-token start mints a
/// fresh one. Agent actor refused.
pub fn rotate_token(layout: &Layout, common: &Common) -> Result<Value> {
    if common.actor == Actor::Agent {
        return Err(Error::rule("rotate-token is user/system only"));
    }
    let path = crate::serve::token_path(layout);
    let existed = path.exists();
    if existed {
        std::fs::remove_file(&path)?;
    }
    Ok(json!({
        "rotated": existed,
        "note": "the token rotates on the next daemon start — /unipi:kanboard close, then open",
    }))
}

/// `POST /api/projects/{slug}/archive-lane`: every task currently in `status`
/// (done or in_review) → Archived, under one board lock. User-actor moves.
pub fn archive_lane(
    layout: &Layout,
    project: Project,
    status: Status,
    now: DateTime<Utc>,
) -> Result<Value> {
    if !matches!(status, Status::Done | Status::InReview) {
        return Err(Error::usage(
            "archive-lane accepts status done or in_review",
        ));
    }
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let mut tasks = board.tasks()?;
    let mut archived = Vec::new();
    let mut skipped = Vec::new();
    for task in tasks.iter_mut().filter(|task| task.status == status) {
        match transitions::check(
            task.status,
            Status::Archived,
            Actor::User,
            None,
            Staleness::Running,
        ) {
            Ok(()) => {
                task.status = Status::Archived;
                task.run = None;
                task.push_activity(now, Actor::User, format!("archived from {status} (bulk)"));
                board.save(task)?;
                archived.push(task.id.clone());
            }
            Err(_) => skipped.push(task.id.clone()),
        }
    }
    drop(lock);
    Ok(json!({ "archived": archived, "skipped": skipped }))
}

/// Move every `in_review` task to `done` in one bulk pass (the review lane's
/// "Done all" button). Actor `user` satisfies the transition table.
pub fn review_done(layout: &Layout, project: Project, now: DateTime<Utc>) -> Result<Value> {
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let mut tasks = board.tasks()?;
    let mut moved = Vec::new();
    for task in tasks.iter_mut().filter(|task| task.status == Status::InReview) {
        task.status = Status::Done;
        task.push_activity(now, Actor::User, "moved in_review → done (bulk)".to_string());
        board.save(task)?;
        moved.push(task.id.clone());
    }
    drop(lock);
    Ok(json!({ "moved": moved }))
}
