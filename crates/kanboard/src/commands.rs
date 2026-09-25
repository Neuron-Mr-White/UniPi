//! Command implementations. Every one returns the JSON payload printed by
//! `--json`; the human rendering is derived from it in `main`.

use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};

use crate::board::Board;
use crate::deps;
use crate::error::{Error, Result};
use crate::format;
use crate::model::{Actor, ChainGate, Priority, Run, RunMode, Staleness, Status, Task};
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

fn task_json(board: &Board<'_>, task: &Task, all: &[Task], gate: ChainGate) -> Value {
    let by_id = board.dep_lookup(all);
    let blocked = deps::blocked_by(task, &by_id, gate);
    let mut value = serde_json::to_value(task).unwrap_or(Value::Null);
    if let Value::Object(ref mut map) = value {
        map.insert(
            "path".into(),
            json!(board.task_path(&task.id).to_string_lossy()),
        );
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
) -> Result<Value> {
    let status = status.unwrap_or(Status::Backlog);
    if !matches!(status, Status::Backlog | Status::Todo) {
        return Err(Error::usage(format!(
            "new tasks start in backlog or todo, not {status}"
        )));
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
        title.to_string(),
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
    status: Option<Status>,
    ready_only: bool,
) -> Result<Value> {
    let board = Board::open(layout, project)?;
    let (tasks, problems) = board.state()?;
    let by_id = board.dep_lookup(&tasks);

    let mut selected: Vec<&Task> = tasks
        .iter()
        .filter(|task| status.map(|status| task.status == status).unwrap_or(true))
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
    if text.trim().is_empty() {
        return Err(Error::usage("note text must not be empty"));
    }
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let mut task = board.get(id)?;
    task.push_activity_session(common.now, common.actor, common.tag(), text.trim());
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
        if title.trim().is_empty() {
            return Err(Error::usage("--title must not be empty"));
        }
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
        task.labels = labels;
        changed.push("labels");
    }
    if changed.is_empty() {
        return Err(Error::usage(
            "edit needs at least one of --title/--body/--priority/--labels",
        ));
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

// ─── claim / release / run ──────────────────────────────────────────────────

pub struct ClaimArgs<'a> {
    pub session: &'a str,
    pub pid: u32,
    pub host: &'a str,
    pub mode: RunMode,
    /// `claim-next --id`: claim one specific task instead of the top of the queue.
    pub id: Option<&'a str>,
}

/// One claim per session, at most two sessions per project.
fn claim_guard(tasks: &[Task], session: &str) -> Result<()> {
    if let Some(running) = tasks.iter().find(|task| {
        task.status == Status::InProgress
            && task.run.as_ref().map(|run| run.session.as_str()) == Some(session)
    }) {
        return Err(Error::rule(format!(
            "session {session} already runs {} — release it before claiming another",
            running.id
        )));
    }
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
            "two sessions already run tasks here ({}) — wait for one to finish",
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

/// Sort order shared by `claim-next` and `next`: priority desc, then order, then id.
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

pub fn claim_next(
    layout: &Layout,
    project: Project,
    gate: ChainGate,
    args: &ClaimArgs<'_>,
    now: DateTime<Utc>,
) -> Result<Value> {
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let mut tasks = board.tasks()?;
    // (a) Dead sessions give their tasks back before anyone claims.
    reap_dead(&board, &mut tasks, now, false);
    // (b)+(c) One claim per session, at most two sessions per project.
    claim_guard(&tasks, args.session)?;
    let by_id = board.dep_lookup(&tasks);

    let chosen: Option<Task> = match args.id {
        Some(id) => {
            let task = tasks
                .iter()
                .find(|task| task.id == id)
                .ok_or_else(|| Error::not_found(format!("claim-next --id {id}: no such task")))?;
            if task.status != Status::Todo {
                return Err(Error::rule(format!(
                    "claim-next --id {id}: the task is {}, not todo",
                    task.status
                )));
            }
            if task.is_claimed() {
                return Err(Error::rule(format!(
                    "claim-next --id {id}: the task is already claimed"
                )));
            }
            if let Some(blocked) = deps::blocked_by(task, &by_id, gate) {
                return Err(Error::rule(format!(
                    "claim-next --id {id}: {}",
                    blocked.describe(gate)
                )));
            }
            Some(task.clone())
        }
        None => {
            let mut candidates: Vec<&Task> = tasks
                .iter()
                .filter(|task| deps::is_ready(task, &by_id, gate))
                .collect();
            candidates.sort_by(claim_sort);
            candidates.first().map(|task| (*task).clone())
        }
    };

    let Some(chosen) = chosen else {
        let waiting = waiting_json(&by_id, &tasks, gate);
        drop(lock);
        return Ok(json!({ "task": Value::Null, "waiting": waiting }));
    };

    let mut task = chosen;
    transitions::check(
        Status::Todo,
        Status::InProgress,
        Actor::System,
        None,
        Staleness::Running,
    )?;
    task.status = Status::InProgress;
    task.run = Some(Run {
        session: args.session.to_string(),
        pid: args.pid,
        host: args.host.to_string(),
        mode: args.mode,
        goal: None,
        started: now,
    });
    task.push_activity(
        now,
        Actor::System,
        format!(
            "claimed by session {} (mode {}) pid {} on {}",
            args.session, args.mode, args.pid, args.host
        ),
    );
    board.save(&task)?;
    drop(lock);

    let tasks = board.tasks()?;
    let mut value = task_json(&board, &task, &tasks, gate);
    if let Value::Object(ref mut map) = value {
        map.insert("handoffNotes".into(), json!(task.handoff_notes()));
    }
    Ok(json!({ "task": value, "waiting": [] }))
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
            "release --to must be todo, in_review or blocked (the runner owns those transitions)",
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

pub fn set_run(
    layout: &Layout,
    project: Project,
    id: &str,
    mode: RunMode,
    goal: Option<&str>,
    gate: ChainGate,
    now: DateTime<Utc>,
) -> Result<Value> {
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let mut task = board.get(id)?;
    let Some(run) = task.run.as_mut() else {
        return Err(Error::rule(format!(
            "set-run needs a claimed task ({id} has no run block)"
        )));
    };
    run.mode = mode;
    run.goal = goal.map(|value| value.to_string());
    task.push_activity(
        now,
        Actor::System,
        match goal {
            Some(goal) => format!("mode set to {mode} (goal {goal})"),
            None => format!("mode set to {mode}"),
        },
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
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let mut task = board.get(id)?;
    let from = task.status;
    let staleness = staleness_of(&task);
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
    let note = comment.unwrap_or("").trim();
    let text = match (from, to) {
        (_, Status::Blocked) => format!("blocked: {note}"),
        (Status::Blocked, Status::Todo) => format!("unblocked: {note}"),
        (Status::InReview, Status::Todo) | (Status::InReview, Status::Backlog) => {
            format!("rework: {note}")
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

/// Tasks one session may queue. `UNIPI_KANBOARD_QUEUE_MAX`, default 10, 0 = unlimited.
pub fn queue_max() -> usize {
    env_usize("UNIPI_KANBOARD_QUEUE_MAX", 10, 0)
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

// ─── per-session queue ──────────────────────────────────────────────────────

fn queue_path(layout: &Layout, slug: &str, session: &str) -> std::path::PathBuf {
    // Session ids are caller-chosen; keep the file name inside queues/.
    let safe: String = session
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    layout
        .project_dir(slug)
        .join("queues")
        .join(format!("{safe}.json"))
}

fn queue_read(path: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Topological order over the queue itself: an id whose deps are also queued
/// comes after them, otherwise the caller's order is preserved.
fn queue_topo_order(ids: &[String], tasks: &[Task]) -> Vec<String> {
    let in_queue: std::collections::HashSet<&String> = ids.iter().collect();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(ids.len());
    fn visit(
        id: &str,
        tasks: &[Task],
        in_queue: &std::collections::HashSet<&String>,
        seen: &mut std::collections::HashSet<String>,
        out: &mut Vec<String>,
    ) {
        if !seen.insert(id.to_string()) {
            return;
        }
        if let Some(task) = tasks.iter().find(|task| task.id == id) {
            for dep in &task.deps {
                if in_queue.contains(dep) {
                    visit(dep, tasks, in_queue, seen, out);
                }
            }
        }
        out.push(id.to_string());
    }
    for id in ids {
        visit(id, tasks, &in_queue, &mut seen, &mut out);
    }
    out
}

/// `queue <IDs…>` appends in dependency order, deduped, up to `queue_max()`
/// (0 = unlimited) — ids past the cap come back in `leftOut`, never as an
/// error. `unqueue [IDs…]` removes or clears. Both need the resolved session.
pub fn queue_update(
    layout: &Layout,
    project: Project,
    session: &str,
    add_ids: &[String],
    remove: Option<&[String]>,
) -> Result<Value> {
    let path = queue_path(layout, &project.slug, session);
    let mut queue = queue_read(&path);
    let board = Board::open(layout, project)?;
    let tasks = board.tasks()?;
    let mut left_out: Vec<Value> = Vec::new();
    match remove {
        Some(ids) => {
            if ids.is_empty() {
                queue.clear();
            } else {
                queue.retain(|queued| !ids.contains(queued));
            }
        }
        None => {
            // Validate every id first: a missing or final task fails the whole call.
            for id in add_ids {
                let task = tasks
                    .iter()
                    .find(|task| task.id == *id)
                    .ok_or_else(|| Error::not_found(format!("queue {id}: no such task")))?;
                if task.status.is_final() {
                    return Err(Error::rule(format!(
                        "queue {id}: the task is {} (final)",
                        task.status
                    )));
                }
            }
            let mut combined = queue.clone();
            for id in add_ids {
                if !combined.contains(id) {
                    combined.push(id.clone());
                }
            }
            let ordered = queue_topo_order(&combined, &tasks);
            let cap = queue_max();
            let kept: Vec<String> = if cap == 0 {
                ordered.clone()
            } else {
                ordered.iter().take(cap).cloned().collect()
            };
            for id in &ordered {
                if !kept.contains(id) {
                    left_out.push(json!({ "id": id, "reason": format!("queue limit {cap}") }));
                }
            }
            queue = kept;
        }
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    crate::store::write_atomic(&path, &serde_json::to_string(&queue)?)?;
    let added: Vec<String> = queue
        .iter()
        .filter(|id| add_ids.contains(id))
        .cloned()
        .collect();
    Ok(json!({
        "queue": queue,
        "session": session,
        "added": added,
        "leftOut": left_out,
    }))
}

pub fn queue_list(layout: &Layout, project: &Project, session: &str) -> Result<Value> {
    let queue = queue_read(&queue_path(layout, &project.slug, session));
    Ok(json!({ "queue": queue, "session": session }))
}

// ─── read-only: next / chain / search ───────────────────────────────────────

/// `next`: the task claim-next would pick (after a simulated reap), plus the
/// reasons every todo task is waiting. Writes nothing.
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
            Some(task) => json!({"id": task.id, "title": task.title, "status": task.status}),
            None => json!({"id": wanted, "status": "missing"}),
        }
    };
    let _ = gate;
    Ok(json!({
        "id": task.id,
        "title": task.title,
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
        "queueMax": queue_max(),
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
