//! Command implementations. Every one returns the JSON payload printed by
//! `--json`; the human rendering is derived from it in `main`.

use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};

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
    pub now: DateTime<Utc>,
}

impl Common {
    pub fn new(actor: Actor, gate: ChainGate) -> Self {
        Common {
            actor,
            gate,
            now: Utc::now(),
        }
    }
}

fn task_json(board: &Board<'_>, task: &Task, all: &[Task], gate: ChainGate) -> Value {
    let by_id = |id: &str| all.iter().find(|candidate| candidate.id == id).cloned();
    let blocked = deps::blocked_by(task, &by_id, gate);
    let mut value = serde_json::to_value(task).unwrap_or(Value::Null);
    if let Value::Object(ref mut map) = value {
        map.insert("path".into(), json!(board.task_path(&task.id).to_string_lossy()));
        map.insert("ready".into(), json!(deps::is_ready(task, &by_id, gate)));
        map.insert("staleness".into(), json!(staleness_of(task)));
        map.insert(
            "allowedMoves".into(),
            json!(transitions::allowed_targets(task.status, Actor::User)
                .iter()
                .map(|status| status.as_str())
                .collect::<Vec<_>>()),
        );
        map.insert(
            "depsStatus".into(),
            json!(task
                .deps
                .iter()
                .map(|dep| json!({
                    "id": dep,
                    "status": by_id(dep).map(|task| task.status),
                }))
                .collect::<Vec<_>>()),
        );
        map.insert("lockedBy".into(), json!(deps::locked_by(task, &by_id, gate)));
        map.insert(
            "waitingFor".into(),
            match blocked {
                Some(blocked) => json!(blocked.pending.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>()),
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
    let root = root.map(|path| path.to_path_buf()).unwrap_or_else(|| store::resolve_root(&cwd));
    let slug = store::slug_for(&store::canonical_root(&root)?);
    // Re-registering a project must never reset its id counter: a reset hands
    // out ids that already exist on disk and overwrites those tasks.
    let existing = Project::load(layout, &slug).ok();
    let mut project = Project::create(layout, &root, name, prefix)?;
    if let Some(previous) = existing {
        project.next_id = project.next_id.max(previous.next_id);
        project.save(layout)?;
    }
    Ok(json!(project))
}

pub fn project_list(layout: &Layout) -> Result<Value> {
    let projects = layout.list_projects()?;
    Ok(json!(projects))
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
    let mut task = Task::new(id.clone(), title.to_string(), status, priority, order::bottom_of(&lane), common.now);
    task.body = body.unwrap_or("").trim().to_string();
    task.deps = after.to_vec();
    task.push_activity(common.now, common.actor, format!("created in {status}"));
    board.save(&task)?;
    drop(lock);

    let mut value = task_json(&board, &task, &tasks, common.gate);
    if let Value::Object(ref mut map) = value {
        map.insert("id".into(), json!(id));
    }
    Ok(value)
}

/// `[{file, line, error}]` — the shape the CLI and the UI both report.
pub fn problems_json(problems: &[crate::error::Problem]) -> Value {
    json!(problems
        .iter()
        .map(|problem| json!({
            "file": problem.file,
            "line": problem.line,
            "error": problem.message,
            "fixable": problem.fixable,
        }))
        .collect::<Vec<_>>())
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
    let by_id = |id: &str| tasks.iter().find(|task| task.id == id).cloned();

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
    let task = Board::find(&tasks, id)?;
    Ok(task_json(&board, task, &tasks, gate))
}

pub fn note(layout: &Layout, project: Project, common: &Common, id: &str, text: &str) -> Result<Value> {
    if text.trim().is_empty() {
        return Err(Error::usage("note text must not be empty"));
    }
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let mut task = board.get(id)?;
    task.push_activity(common.now, common.actor, text.trim());
    board.save(&task)?;
    drop(lock);
    let tasks = board.tasks()?;
    Ok(task_json(&board, &task, &tasks, common.gate))
}

pub struct EditArgs<'a> {
    pub title: Option<&'a str>,
    pub body: Option<&'a str>,
    pub priority: Option<Priority>,
    pub labels: Option<Vec<String>>,
}

pub fn edit(layout: &Layout, project: Project, common: &Common, id: &str, args: EditArgs<'_>) -> Result<Value> {
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let mut task = board.get(id)?;
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
        return Err(Error::usage("edit needs at least one of --title/--body/--priority/--labels"));
    }
    task.push_activity(common.now, common.actor, format!("edited {}", changed.join(", ")));
    board.save(&task)?;
    drop(lock);
    let tasks = board.tasks()?;
    Ok(task_json(&board, &task, &tasks, common.gate))
}

pub fn link(layout: &Layout, project: Project, common: &Common, gate: ChainGate, id: &str, dep: &str, remove: bool) -> Result<Value> {
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let tasks = board.tasks()?;
    let mut task = Board::find(&tasks, id)?.clone();

    if remove {
        if !task.deps.iter().any(|existing| existing == dep) {
            return Err(Error::rule(format!("{id} does not depend on {dep}")));
        }
        task.deps.retain(|existing| existing != dep);
        task.push_activity(common.now, common.actor, format!("unlinked {dep}"));
    } else {
        if !tasks.iter().any(|candidate| candidate.id == dep) {
            return Err(Error::not_found(format!("--after {dep}: no such task")));
        }
        if task.deps.iter().any(|existing| existing == dep) {
            return Err(Error::rule(format!("{id} already depends on {dep}")));
        }
        deps::check_cycle(&tasks, id, dep)?;
        task.deps.push(dep.to_string());
        task.push_activity(common.now, common.actor, format!("linked after {dep}"));
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

pub fn order(layout: &Layout, project: Project, common: &Common, id: &str, target: OrderTarget<'_>) -> Result<Value> {
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
    task.push_activity(common.now, common.actor, format!("ordered (position {new_order})"));
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
        OrderTarget::Top => Some(
            lane.first()
                .map(|task| task.order)
                .unwrap_or(order::STEP)
                - order::STEP,
        ),
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
}

pub fn claim_next(layout: &Layout, project: Project, gate: ChainGate, args: &ClaimArgs<'_>, now: DateTime<Utc>) -> Result<Value> {
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let tasks = board.tasks()?;
    let by_id = |id: &str| tasks.iter().find(|task| task.id == id).cloned();

    let mut candidates: Vec<&Task> = tasks
        .iter()
        .filter(|task| deps::is_ready(task, &by_id, gate))
        .collect();
    candidates.sort_by(|a, b| {
        b.priority
            .rank()
            .cmp(&a.priority.rank())
            .then_with(|| a.order.cmp(&b.order))
            .then_with(|| a.id.cmp(&b.id))
    });

    let Some(chosen) = candidates.first() else {
        let waiting: Vec<Value> = tasks
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
            .collect();
        drop(lock);
        return Ok(json!({ "task": Value::Null, "waiting": waiting }));
    };

    let mut task = (*chosen).clone();
    transitions::check(Status::Todo, Status::InProgress, Actor::System, None, Staleness::Running)?;
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
    task.push_activity(now, Actor::System, format!("released to {to}: {}", comment.trim()));
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
    task.push_activity(common.now, common.actor, text);

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
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        // kill(pid, 0): 0 = alive, EPERM = alive but not ours.
        let result = unsafe { libc_kill(pid as i32) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(1)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

#[cfg(unix)]
unsafe fn libc_kill(pid: i32) -> i32 {
    // Edition 2024 requires the unsafe marker on extern blocks.
    unsafe extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe { kill(pid, 0) }
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
    task.push_activity(common.now, common.actor, format!("duplicated from {id}"));
    board.save(&task)?;
    drop(lock);
    Ok(task_json(&board, &task, &tasks, common.gate))
}

pub fn archive_sweep(
    layout: &Layout,
    project: Project,
    after_days: i64,
    now: DateTime<Utc>,
) -> Result<Value> {
    if after_days <= 0 {
        return Ok(json!({ "archived": [], "skipped": "archiveAfterDays is 0 (off)" }));
    }
    let lock = layout.lock_board(&project.slug)?;
    let board = Board::open(layout, project)?;
    let tasks = board.tasks()?;
    let cutoff = now - Duration::days(after_days);
    let mut archived = Vec::new();
    for task in tasks.iter().filter(|task| {
        matches!(task.status, Status::Done | Status::Cancelled) && task.updated < cutoff
    }) {
        let mut task = task.clone();
        transitions::check(task.status, Status::Archived, Actor::System, None, Staleness::Running)?;
        task.status = Status::Archived;
        task.push_activity(now, Actor::System, format!("archived automatically after {after_days} days"));
        board.save(&task)?;
        archived.push(task.id);
    }
    drop(lock);
    Ok(json!({ "archived": archived }))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidateResult {
    pub problems: Vec<crate::error::Problem>,
    pub fixed: Vec<String>,
}

pub fn validate(layout: &Layout, project: Project, fix: bool) -> Result<ValidateResult> {
    let lock = if fix { Some(layout.lock_board(&project.slug)?) } else { None };
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
        let fixable: Vec<&crate::error::Problem> = problems.iter().filter(|problem| problem.fixable).collect();
        let fixable_files: Vec<String> = fixable.iter().map(|problem| problem.file.clone()).collect();
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
