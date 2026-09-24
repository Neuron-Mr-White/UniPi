//! CLI dispatcher: turns parsed arguments into library calls and renders the
//! result (JSON for `--json`, one-line summaries otherwise).

use std::io::Read;

use serde_json::{json, Value};

use crate::cli::{Cli, Command, ProjectCommand};
use crate::commands::{self, Common, EditArgs, OrderTarget};
use crate::error::{Error, Result};
use crate::model::{Actor, ChainGate, Priority, RunMode, Status};
use crate::store::{self, Layout};

pub fn dispatch(cli: &Cli) -> Result<Value> {
    let layout = Layout::from_env()?;
    let actor = resolve_actor(cli.actor.as_deref());
    let gate: ChainGate = cli.gate.parse().map_err(|_| {
        Error::usage(format!(
            "unknown --gate \"{}\" (expected in_review|done)",
            cli.gate
        ))
    })?;
    let common = Common::new(actor, gate);

    match &cli.command {
        Command::Project(ProjectCommand::Add(args)) => commands::project_add(
            &layout,
            args.root.as_deref(),
            args.name.as_deref(),
            args.prefix.as_deref(),
        ),
        Command::Project(ProjectCommand::List) => commands::project_list(&layout),
        Command::Project(ProjectCommand::Show) => {
            let project = store::resolve_project(&layout, cli.project.as_deref())?;
            commands::project_show(&layout, &project)
        }

        Command::Add {
            title,
            body,
            status,
            priority,
            after,
        } => {
            let project = store::resolve_project(&layout, cli.project.as_deref())?;
            let status = status
                .as_deref()
                .map(crate::cli::parse_status)
                .transpose()?;
            let priority = priority
                .as_deref()
                .map(crate::cli::parse_priority)
                .transpose()?
                .unwrap_or(Priority::None);
            let body = read_body(body.as_deref())?;
            commands::add(
                &layout,
                project,
                &common,
                title,
                body.as_deref(),
                status,
                priority,
                after,
            )
        }

        Command::List { status, ready } => {
            let project = store::resolve_project(&layout, cli.project.as_deref())?;
            let status = status
                .as_deref()
                .map(crate::cli::parse_status)
                .transpose()?;
            commands::list(&layout, project, gate, status, *ready)
        }

        Command::Show { id } => {
            let project = store::resolve_project(&layout, cli.project.as_deref())?;
            commands::show(&layout, project, id, gate)
        }

        Command::Move { id, status, comment } => {
            let project = store::resolve_project(&layout, cli.project.as_deref())?;
            let to = crate::cli::parse_status(status)?;
            commands::move_task(&layout, project, &common, id, to, comment.as_deref())
        }

        Command::Note { id, text } => {
            let text = read_body(Some(text))?.unwrap_or_default();
            let project = store::resolve_project(&layout, cli.project.as_deref())?;
            commands::note(&layout, project, &common, id, &text)
        }

        Command::Edit {
            id,
            title,
            body,
            priority,
            labels,
        } => {
            let project = store::resolve_project(&layout, cli.project.as_deref())?;
            let body = read_body(body.as_deref())?;
            let priority = priority
                .as_deref()
                .map(crate::cli::parse_priority)
                .transpose()?;
            let labels = labels.as_ref().map(|raw| {
                raw.split(',')
                    .map(|item| item.trim().to_string())
                    .filter(|item| !item.is_empty())
                    .collect::<Vec<String>>()
            });
            commands::edit(
                &layout,
                project,
                &common,
                id,
                EditArgs {
                    title: title.as_deref(),
                    body: body.as_deref(),
                    priority,
                    labels,
                },
            )
        }

        Command::Link { id, after } => {
            let project = store::resolve_project(&layout, cli.project.as_deref())?;
            commands::link(&layout, project, &common, gate, id, after, false)
        }

        Command::Unlink { id, after } => {
            let project = store::resolve_project(&layout, cli.project.as_deref())?;
            commands::link(&layout, project, &common, gate, id, after, true)
        }

        Command::Order {
            id,
            before,
            after_pos,
            top,
            bottom,
        } => {
            let project = store::resolve_project(&layout, cli.project.as_deref())?;
            let target = match (before.as_deref(), after_pos.as_deref(), top, bottom) {
                (Some(target), None, false, false) => OrderTarget::Before(target),
                (None, Some(target), false, false) => OrderTarget::AfterPos(target),
                (None, None, true, false) => OrderTarget::Top,
                (None, None, false, true) => OrderTarget::Bottom,
                _ => {
                    return Err(Error::usage(
                        "order needs exactly one of --before ID, --after-pos ID, --top, --bottom",
                    ))
                }
            };
            commands::order(&layout, project, &common, id, target)
        }

        Command::ClaimNext {
            session,
            pid,
            host,
            mode,
        } => {
            let project = store::resolve_project(&layout, cli.project.as_deref())?;
            let mode: RunMode = crate::cli::parse_mode(mode)?;
            let args = commands::ClaimArgs {
                session,
                pid: *pid,
                host,
                mode,
            };
            commands::claim_next(&layout, project, gate, &args, common.now)
        }

        Command::Release { id, to, comment } => {
            let project = store::resolve_project(&layout, cli.project.as_deref())?;
            let to = crate::cli::parse_status(to)?;
            commands::release(&layout, project, id, to, comment, gate, common.now)
        }

        Command::SetRun { id, mode, goal } => {
            let project = store::resolve_project(&layout, cli.project.as_deref())?;
            let mode: RunMode = crate::cli::parse_mode(mode)?;
            commands::set_run(&layout, project, id, mode, goal.as_deref(), gate, common.now)
        }

        Command::Duplicate { id } => {
            let project = store::resolve_project(&layout, cli.project.as_deref())?;
            commands::duplicate(&layout, project, &common, id)
        }

        Command::ArchiveSweep { after_days } => {
            let project = store::resolve_project(&layout, cli.project.as_deref())?;
            let days = after_days
                .or_else(|| {
                    std::env::var("UNIPI_KANBOARD_ARCHIVE_AFTER_DAYS")
                        .ok()
                        .and_then(|value| value.trim().parse().ok())
                })
                .unwrap_or(0);
            commands::archive_sweep(&layout, project, days, common.now)
        }

        Command::Serve {
            host,
            port,
            idle_min,
            idle_secs,
        } => {
            let options = crate::serve::ServeOptions {
                host: host.clone(),
                port: *port,
                idle: match idle_secs {
                    Some(secs) => std::time::Duration::from_secs(*secs),
                    None => std::time::Duration::from_secs(
                        idle_min.unwrap_or(crate::daemon::DEFAULT_IDLE_MIN).max(1) * 60,
                    ),
                },
            };
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .map_err(|err| Error::Io(format!("cannot start the async runtime: {err}")))?;
            runtime.block_on(crate::serve::serve(layout, options))
        }

        Command::Status => crate::daemon::status(&layout),

        Command::Stop { timeout } => {
            crate::daemon::stop(&layout, std::time::Duration::from_secs(*timeout))
        }

        Command::Validate { fix } => {
            let project = store::resolve_project(&layout, cli.project.as_deref())?;
            let result = commands::validate(&layout, project, *fix)?;
            Ok(json!({
                "ok": result.problems.is_empty(),
                "problems": result.problems.iter().map(|problem| json!({
                    "file": problem.file,
                    "line": problem.line,
                    "message": problem.message,
                    "fixable": problem.fixable,
                })).collect::<Vec<_>>(),
                "fixed": result.fixed,
            }))
        }
    }
}

pub fn resolve_actor(explicit: Option<&str>) -> Actor {
    if let Some(value) = explicit
        && let Ok(actor) = value.trim().parse()
    {
        return actor;
    }
    if let Ok(value) = std::env::var(store::ACTOR_ENV)
        && let Ok(actor) = value.trim().parse()
    {
        return actor;
    }
    Actor::User
}

fn read_body(value: Option<&str>) -> Result<Option<String>> {
    match value {
        None => Ok(None),
        Some("-") => {
            let mut buffer = String::new();
            std::io::stdin()
                .read_to_string(&mut buffer)
                .map_err(|err| Error::Io(format!("cannot read stdin: {err}")))?;
            Ok(Some(buffer))
        }
        Some(text) => Ok(Some(text.to_string())),
    }
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn text(value: &Value, key: &str) -> String {
    match field(value, key) {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn ids(value: &Value) -> String {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| text(item, "id"))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

/// One-line (or few-line) human summary of a command's payload.
pub fn human(cli: &Cli, payload: &Value) -> String {
    match &cli.command {
        Command::Project(ProjectCommand::Add(args)) => format!(
            "project {} registered (root {}{})",
            text(payload, "slug"),
            text(payload, "root"),
            args.name
                .as_deref()
                .map(|name| format!(", name {name}"))
                .unwrap_or_default()
        ),
        Command::Project(ProjectCommand::List) => {
            let items = payload.as_array().cloned().unwrap_or_default();
            if items.is_empty() {
                return "no projects registered".to_string();
            }
            items
                .iter()
                .map(|project| format!("{}  {}", text(project, "slug"), text(project, "root")))
                .collect::<Vec<_>>()
                .join("\n")
        }
        Command::Project(ProjectCommand::Show) => {
            let counts = field(payload, "counts");
            let lanes = Status::ALL
                .iter()
                .map(|status| format!("{}={}", status.as_str(), field(counts, status.as_str())))
                .collect::<Vec<_>>()
                .join(" ");
            format!(
                "{} ({} tasks)\n  {lanes}",
                text(field(payload, "project"), "slug"),
                field(payload, "total")
            )
        }

        Command::Add { .. } => format!(
            "{} created in {} ({})",
            text(payload, "id"),
            text(payload, "status"),
            text(payload, "title")
        ),
        Command::List { .. } => {
            let items = payload.as_array().cloned().unwrap_or_default();
            if items.is_empty() {
                return "no tasks".to_string();
            }
            items
                .iter()
                .map(|task| {
                    let ready = field(task, "ready").as_bool().unwrap_or(false);
                    let waiting = ids(field(task, "waitingFor"));
                    format!(
                        "{}  [{}] {}{}{}",
                        text(task, "id"),
                        text(task, "status"),
                        text(task, "title"),
                        if field(task, "priority") == &json!("none") {
                            String::new()
                        } else {
                            format!(" ({})", text(task, "priority"))
                        },
                        if !ready && !waiting.is_empty() {
                            format!("  waiting on {waiting}")
                        } else {
                            String::new()
                        }
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        Command::Show { .. } => {
            let status = text(payload, "status");
            let deps = ids(field(payload, "deps"));
            let mut out = format!(
                "{} [{}] {}\n  priority: {}  order: {}  created: {}{}",
                text(payload, "id"),
                status,
                text(payload, "title"),
                text(payload, "priority"),
                text(payload, "order"),
                text(payload, "created"),
                if deps.is_empty() {
                    String::new()
                } else {
                    format!("  deps: {deps}")
                }
            );
            if let Some(run) = payload.get("run").filter(|value| !value.is_null()) {
                out.push_str(&format!(
                    "\n  run: session {} pid {} on {} mode {} ({})",
                    text(run, "session"),
                    text(run, "pid"),
                    text(run, "host"),
                    text(run, "mode"),
                    text(payload, "staleness")
                ));
            }
            let activity = payload
                .get("activity")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();
            for entry in activity.iter().rev().take(5).collect::<Vec<_>>().iter().rev() {
                out.push_str(&format!(
                    "\n  - {} [{}] {}",
                    text(entry, "at"),
                    text(entry, "actor"),
                    text(entry, "text")
                ));
            }
            out
        }

        Command::Move { id, .. } => format!("{id} → {}", text(payload, "status")),
        Command::Note { id, .. } => format!("{id}: note added"),
        Command::Edit { id, .. } => format!("{id}: updated"),
        Command::Link { id, after } => format!("{id}: now depends on {after}"),
        Command::Unlink { id, after } => format!("{id}: no longer depends on {after}"),
        Command::Order { id, .. } => format!(
            "{id}: order {} (rebalanced {})",
            text(payload, "order"),
            field(payload, "rebalanced")
        ),
        Command::ClaimNext { .. } => {
            let task = field(payload, "task");
            if task.is_null() {
                let waiting = field(payload, "waiting")
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|item| {
                        format!(
                            "{} (waiting {})",
                            text(item, "id"),
                            ids(field(item, "waitingFor"))
                        )
                    })
                    .collect::<Vec<_>>();
                if waiting.is_empty() {
                    "no ready task".to_string()
                } else {
                    format!("no ready task; todo but waiting: {}", waiting.join(", "))
                }
            } else {
                format!(
                    "{} claimed (mode {})",
                    text(task, "id"),
                    text(field(task, "run"), "mode")
                )
            }
        }
        Command::Release { id, to, .. } => format!("{id} released to {to}"),
        Command::SetRun { id, mode, .. } => format!("{id} mode {mode}"),
        Command::Duplicate { .. } => format!("{} created (duplicate)", text(payload, "id")),
        Command::ArchiveSweep { .. } => {
            let archived = ids(field(payload, "archived"));
            if archived.is_empty() {
                format!(
                    "nothing archived{}",
                    payload
                        .get("skipped")
                        .and_then(|value| value.as_str())
                        .map(|reason| format!(" ({reason})"))
                        .unwrap_or_default()
                )
            } else {
                format!("archived: {archived}")
            }
        }
        Command::Serve { .. } => {
            if field(payload, "alreadyRunning").as_bool().unwrap_or(false) {
                let daemon = field(payload, "daemon");
                let mut line = format!(
                    "kanboard already running on {}:{} (pid {})",
                    text(daemon, "host"),
                    text(daemon, "port"),
                    text(daemon, "pid")
                );
                if field(payload, "bindingChanged").as_bool().unwrap_or(false) {
                    line.push_str(&format!(
                        " — requested {}:{}; stop it first (unipi-kanboard stop) to rebind",
                        text(field(payload, "requested"), "host"),
                        text(field(payload, "requested"), "port")
                    ));
                }
                line
            } else if field(payload, "stopped").as_bool().unwrap_or(false) {
                let daemon = field(payload, "daemon");
                format!(
                    "kanboard stopped (was pid {} on port {})",
                    text(daemon, "pid"),
                    text(daemon, "port")
                )
            } else {
                let daemon = field(payload, "daemon");
                format!(
                    "kanboard listening on {}:{} (pid {}){}",
                    text(daemon, "host"),
                    text(daemon, "port"),
                    text(daemon, "pid"),
                    if field(daemon, "token").is_null() {
                        String::new()
                    } else {
                        " · remote access requires the token from daemon.json".to_string()
                    }
                )
            }
        }
        Command::Status => {
            let daemon = field(payload, "daemon");
            if daemon.is_null() {
                "no daemon recorded".to_string()
            } else {
                format!(
                    "pid {} · port {} · version {} · started {} · alive={}",
                    text(daemon, "pid"),
                    text(daemon, "port"),
                    text(daemon, "version"),
                    text(daemon, "startedAt"),
                    field(payload, "alive")
                )
            }
        }
        Command::Stop { .. } => {
            if field(payload, "stopped").as_bool().unwrap_or(false) {
                format!("stopped pid {}", text(payload, "pid"))
            } else {
                format!(
                    "not stopped: {}",
                    payload
                        .get("reason")
                        .and_then(|reason| reason.as_str())
                        .unwrap_or("unknown")
                )
            }
        }
        Command::Validate { .. } => {
            let problems = field(payload, "problems")
                .as_array()
                .cloned()
                .unwrap_or_default();
            let fixed = ids(field(payload, "fixed"));
            let mut out = if problems.is_empty() {
                "validate: ok".to_string()
            } else {
                problems
                    .iter()
                    .map(|problem| {
                        format!(
                            "{}:{}: {}",
                            text(problem, "file"),
                            text(problem, "line"),
                            text(problem, "message")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            if !fixed.is_empty() {
                out.push_str(&format!("\nfixed formatting: {fixed}"));
            }
            out
        }
    }
}

/// Exit code: rule violations and validation findings are failures.
pub fn exit_code(cli: &Cli, payload: &Value) -> i32 {
    if let Command::Validate { .. } = cli.command
        && field(payload, "problems")
            .as_array()
            .map(|problems| !problems.is_empty())
            .unwrap_or(false)
    {
        return 1;
    }
    if let Command::ClaimNext { .. } = cli.command {
        // "no ready task" is a normal outcome, not an error.
        return 0;
    }
    0
}

/// Resolve the project without touching the board (used by `main` for context).
pub fn project_for(layout: &Layout, cli: &Cli) -> Result<crate::store::Project> {
    store::resolve_project(layout, cli.project.as_deref())
}

/// Re-exported for `main`/daemon use.
pub fn layout() -> Result<Layout> {
    Layout::from_env()
}

/// Kept public so K2 can build the same `Value` payloads for the JSON API.
pub fn dispatch_value(cli: &Cli) -> Result<Value> {
    dispatch(cli)
}

/// Helper for the daemon: the JSON of a task list is the API payload.
pub fn list_payload(cli: &Cli) -> Result<Value> {
    dispatch(cli)
}

/// Unused-import guard for `Priority` (kept for API symmetry in K2).
#[allow(dead_code)]
fn _priority_marker(_: Priority) {}

/// Convenience for tests and the daemon.
pub fn project_counts(layout: &Layout, project: &crate::store::Project) -> Result<Value> {
    let board = crate::board::Board::open(layout, project.clone())?;
    let tasks = board.tasks()?;
    let mut counts = serde_json::Map::new();
    for status in Status::ALL {
        counts.insert(
            status.as_str().to_string(),
            json!(tasks.iter().filter(|task| task.status == status).count()),
        );
    }
    Ok(Value::Object(counts))
}
