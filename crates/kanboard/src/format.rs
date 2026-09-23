//! Task file format: frontmatter + body + append-only `## Activity`.
//!
//! Parsing is strict and line-oriented so `validate` can report the exact line
//! that broke a rule; rendering is deterministic so files round-trip.

use chrono::{DateTime, SecondsFormat, Utc};

use crate::error::{Problem, Result};
use crate::model::{ActivityEntry, Actor, Priority, Run, RunMode, Status, Task};

pub const ACTIVITY_HEADING: &str = "## Activity";

const FRONTMATTER_KEYS: [&str; 9] = [
    "id", "title", "status", "priority", "order", "deps", "labels", "created", "updated",
];

/// Render a task to its canonical file text.
pub fn render(task: &Task) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("id: {}\n", task.id));
    out.push_str(&format!("title: {}\n", yaml_scalar(&task.title)));
    out.push_str(&format!("status: {}\n", task.status.as_str()));
    out.push_str(&format!("priority: {}\n", task.priority.as_str()));
    out.push_str(&format!("order: {}\n", task.order));
    out.push_str(&format!("deps: {}\n", flow_list(&task.deps)));
    out.push_str(&format!("labels: {}\n", flow_list(&task.labels)));
    out.push_str(&format!("created: {}\n", iso(task.created)));
    out.push_str(&format!("updated: {}\n", iso(task.updated)));
    match &task.run {
        Some(run) => {
            out.push_str("run:\n");
            out.push_str(&format!("  session: {}\n", yaml_scalar(&run.session)));
            out.push_str(&format!("  pid: {}\n", run.pid));
            out.push_str(&format!("  host: {}\n", yaml_scalar(&run.host)));
            out.push_str(&format!("  mode: {}\n", run.mode.as_str()));
            out.push_str(&format!(
                "  goal: {}\n",
                run.goal.as_deref().map(yaml_scalar).unwrap_or_else(|| "null".to_string())
            ));
            out.push_str(&format!("  started: {}\n", iso(run.started)));
        }
        None => out.push_str("run:\n"),
    }
    out.push_str("---\n");

    let body = task.body.trim_end_matches('\n');
    if !body.trim().is_empty() {
        out.push('\n');
        out.push_str(body);
        out.push('\n');
    }

    out.push('\n');
    out.push_str(ACTIVITY_HEADING);
    out.push('\n');
    for entry in &task.activity {
        let mut lines = entry.text.split('\n');
        let first = lines.next().unwrap_or("");
        out.push_str(&format!(
            "- {} [{}] {}\n",
            iso(entry.at),
            entry.actor.as_str(),
            first
        ));
        for line in lines {
            // A blank continuation line would render as `  ` and make the file
            // permanently non-canonical (validate would refuse the board).
            if line.trim().is_empty() {
                continue;
            }
            out.push_str(&format!("  {line}\n"));
        }
    }
    out
}

/// Parse a task file. Returns the task (when the frontmatter is usable) plus
/// every problem found — with line numbers — so `validate` can report them all.
pub fn parse(file: &str, text: &str) -> (Option<Task>, Vec<Problem>) {
    let mut problems = Vec::new();
    let lines: Vec<&str> = text.lines().collect();

    if lines.first().map(|l| l.trim_end()) != Some("---") {
        problems.push(Problem::new(file, 1, "missing frontmatter: expected a line with `---`"));
        return (None, problems);
    }

    let close = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, line)| line.trim_end() == "---")
        .map(|(index, _)| index);
    let Some(close) = close else {
        problems.push(Problem::new(file, 1, "unterminated frontmatter: no closing `---`"));
        return (None, problems);
    };

    let mut fields: Vec<(usize, String, String)> = Vec::new();
    let mut run_fields: Vec<(usize, String, String)> = Vec::new();
    let mut in_run = false;

    for (index, raw) in lines.iter().enumerate().take(close).skip(1) {
        let line_no = index + 1;
        let line = raw.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if in_run && indented {
            match split_key_value(line.trim_start()) {
                Some((key, value)) => run_fields.push((line_no, key.to_string(), value.to_string())),
                None => problems.push(Problem::new(
                    file,
                    line_no,
                    format!("malformed run field: \"{}\"", line.trim()),
                )),
            }
            continue;
        }
        in_run = false;
        let Some((key, value)) = split_key_value(line) else {
            problems.push(Problem::new(
                file,
                line_no,
                format!("malformed frontmatter line: \"{line}\""),
            ));
            continue;
        };
        if key == "run" {
            in_run = true;
            if !value.trim().is_empty() && value.trim() != "null" {
                problems.push(Problem::new(
                    file,
                    line_no,
                    "run must be a block (session/pid/host/mode/goal/started) or empty",
                ));
            }
            continue;
        }
        if !FRONTMATTER_KEYS.contains(&key) {
            problems.push(Problem::new(
                file,
                line_no,
                format!(
                    "unknown frontmatter key \"{key}\" (expected {})",
                    FRONTMATTER_KEYS.join(", ")
                ),
            ));
            continue;
        }
        fields.push((line_no, key.to_string(), value.to_string()));
    }

    let body_start = close + 1;
    let (body, activity) = parse_body(file, &lines, body_start, &mut problems);

    let get = |key: &str| -> Option<(usize, String)> {
        fields
            .iter()
            .find(|(_, field, _)| field == key)
            .map(|(line, _, value)| (*line, value.clone()))
    };

    let id = match get("id") {
        Some((_, value)) if !value.trim().is_empty() => value.trim().trim_matches('"').to_string(),
        Some((line, _)) => {
            problems.push(Problem::new(file, line, "id must not be empty"));
            String::new()
        }
        None => {
            problems.push(Problem::new(file, 1, "missing required frontmatter key \"id\""));
            String::new()
        }
    };
    let title = match get("title") {
        Some((line, value)) => match unquote(&value) {
            Ok(text) => text,
            Err(message) => {
                problems.push(Problem::new(file, line, message));
                String::new()
            }
        },
        None => {
            problems.push(Problem::new(file, 1, "missing required frontmatter key \"title\""));
            String::new()
        }
    };
    let status = match get("status") {
        Some((line, value)) => match value.trim().parse::<Status>() {
            Ok(status) => Some(status),
            Err(_) => {
                problems.push(Problem::new(
                    file,
                    line,
                    format!(
                        "unknown status \"{}\" (expected {})",
                        value.trim(),
                        Status::ALL
                            .iter()
                            .map(|s| s.as_str())
                            .collect::<Vec<_>>()
                            .join("|")
                    ),
                ));
                None
            }
        },
        None => {
            problems.push(Problem::new(file, 1, "missing required frontmatter key \"status\""));
            None
        }
    };
    let priority = match get("priority") {
        Some((line, value)) => match value.trim().parse::<Priority>() {
            Ok(priority) => priority,
            Err(_) => {
                problems.push(Problem::new(
                    file,
                    line,
                    format!(
                        "unknown priority \"{}\" (expected {})",
                        value.trim(),
                        Priority::ALL
                            .iter()
                            .map(|p| p.as_str())
                            .collect::<Vec<_>>()
                            .join("|")
                    ),
                ));
                Priority::None
            }
        },
        None => Priority::None,
    };
    let order = match get("order") {
        Some((line, value)) => match value.trim().parse::<i64>() {
            Ok(order) => order,
            Err(_) => {
                problems.push(Problem::new(
                    file,
                    line,
                    format!("order must be an integer, got \"{}\"", value.trim()),
                ));
                0
            }
        },
        None => 0,
    };
    let deps = parse_list(file, get("deps"), "deps", &mut problems);
    let labels = parse_list(file, get("labels"), "labels", &mut problems);
    let created = parse_date(file, get("created"), "created", &mut problems);
    let updated = parse_date(file, get("updated"), "updated", &mut problems);

    let run = if run_fields.is_empty() {
        None
    } else {
        parse_run(file, &run_fields, &mut problems)
    };

    if problems.iter().any(|problem| {
        !problem.fixable
            && !problem.message.starts_with("unknown frontmatter key")
            && !problem.message.starts_with("unknown status")
            && !problem.message.starts_with("order must be an integer")
    }) {
        // Unrecoverable structure problems: still return what we could read so
        // `validate` can print everything, but callers must treat it as invalid.
        return (
            Some(build(id, title, status, priority, order, deps, labels, created, updated, run, body, activity)),
            problems,
        );
    }

    if status.is_none() {
        return (None, problems);
    }

    let task = Some(build(
        id,
        title,
        status,
        priority,
        order,
        deps,
        labels,
        created,
        updated,
        run,
        body,
        activity,
    ));
    (task, problems)
}

#[allow(clippy::too_many_arguments)]
fn build(
    id: String,
    title: String,
    status: Option<Status>,
    priority: Priority,
    order: i64,
    deps: Vec<String>,
    labels: Vec<String>,
    created: DateTime<Utc>,
    updated: DateTime<Utc>,
    run: Option<Run>,
    body: String,
    activity: Vec<ActivityEntry>,
) -> Task {
    Task {
        id,
        title,
        status: status.unwrap_or(Status::Backlog),
        priority,
        order,
        deps,
        labels,
        created,
        updated,
        run,
        body,
        activity,
    }
}

fn parse_body(
    file: &str,
    lines: &[&str],
    start: usize,
    problems: &mut Vec<Problem>,
) -> (String, Vec<ActivityEntry>) {
    let activity_index = lines
        .iter()
        .enumerate()
        .skip(start)
        .find(|(_, line)| line.trim_end() == ACTIVITY_HEADING)
        .map(|(index, _)| index);

    let body_end = activity_index.unwrap_or(lines.len());
    let body = lines[start..body_end].join("\n").trim().to_string();

    let mut activity = Vec::new();
    let Some(activity_index) = activity_index else {
        return (body, activity);
    };

    let mut pending: Option<ActivityEntry> = None;
    for (index, raw) in lines.iter().enumerate().skip(activity_index + 1) {
        let line_no = index + 1;
        let line = raw.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("- ") {
            if let Some(entry) = pending.take() {
                activity.push(entry);
            }
            match parse_activity_line(rest) {
                Some(entry) => pending = Some(entry),
                None => problems.push(Problem::new(
                    file,
                    line_no,
                    format!(
                        "malformed activity entry: expected `- <iso8601> [user|agent|system] <text>`, got \"{}\"",
                        line
                    ),
                )),
            }
            continue;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            match pending.as_mut() {
                Some(entry) => {
                    entry.text.push('\n');
                    entry.text.push_str(line.trim_start());
                }
                None => problems.push(Problem::new(
                    file,
                    line_no,
                    "indented continuation line without a preceding activity entry",
                )),
            }
            continue;
        }
        problems.push(Problem::new(
            file,
            line_no,
            format!("unexpected content after `{ACTIVITY_HEADING}`: \"{line}\""),
        ));
    }
    if let Some(entry) = pending {
        activity.push(entry);
    }

    for (offset, entry) in activity.iter().enumerate() {
        if entry.text.trim().is_empty() {
            problems.push(Problem::new(
                file,
                activity_index + 2 + offset,
                "activity entry has no text",
            ));
        }
    }

    (body, activity)
}

fn parse_activity_line(rest: &str) -> Option<ActivityEntry> {
    let (stamp, tail) = rest.split_once(' ')?;
    let at = DateTime::parse_from_rfc3339(stamp).ok()?.with_timezone(&Utc);
    let tail = tail.trim_start();
    let (actor, text) = tail.split_once(' ')?;
    let actor = actor.strip_prefix('[')?.strip_suffix(']')?;
    let actor: Actor = actor.parse().ok()?;
    Some(ActivityEntry {
        at,
        actor,
        text: text.trim_start().to_string(),
    })
}

fn parse_run(file: &str, fields: &[(usize, String, String)], problems: &mut Vec<Problem>) -> Option<Run> {
    let get = |key: &str| -> Option<&(usize, String, String)> {
        fields.iter().find(|(_, field, _)| field == key)
    };
    for (line, key, _) in fields {
        if !["session", "pid", "host", "mode", "goal", "started"].contains(&key.as_str()) {
            problems.push(Problem::new(
                file,
                *line,
                format!("unknown run field \"{key}\" (expected session, pid, host, mode, goal, started)"),
            ));
        }
    }

    let session = match get("session") {
        Some((line, _, value)) => match unquote(value) {
            Ok(text) if !text.is_empty() => text,
            _ => {
                problems.push(Problem::new(file, *line, "run.session must not be empty"));
                return None;
            }
        },
        None => {
            problems.push(Problem::new(file, 1, "run is present but run.session is missing"));
            return None;
        }
    };
    let pid = match get("pid") {
        Some((line, _, value)) => match value.trim().parse::<u32>() {
            Ok(pid) => pid,
            Err(_) => {
                problems.push(Problem::new(
                    file,
                    *line,
                    format!("run.pid must be a number, got \"{}\"", value.trim()),
                ));
                return None;
            }
        },
        None => {
            problems.push(Problem::new(file, 1, "run is present but run.pid is missing"));
            return None;
        }
    };
    let host = match get("host") {
        Some((line, _, value)) => unquote(value).unwrap_or_else(|_| {
            problems.push(Problem::new(file, *line, "run.host must be a string"));
            String::new()
        }),
        None => {
            problems.push(Problem::new(file, 1, "run is present but run.host is missing"));
            return None;
        }
    };
    let mode = match get("mode") {
        Some((line, _, value)) => match value.trim().parse::<RunMode>() {
            Ok(mode) => mode,
            Err(_) => {
                problems.push(Problem::new(
                    file,
                    *line,
                    format!("unknown run.mode \"{}\" (expected direct|plan|goal)", value.trim()),
                ));
                return None;
            }
        },
        None => {
            problems.push(Problem::new(file, 1, "run is present but run.mode is missing"));
            return None;
        }
    };
    let goal = get("goal").and_then(|(_, _, value)| {
        let trimmed = value.trim();
        if trimmed.is_empty() || trimmed == "null" || trimmed == "~" {
            None
        } else {
            unquote(value).ok().filter(|text| !text.is_empty())
        }
    });
    let started = match get("started") {
        Some((line, _, value)) => match DateTime::parse_from_rfc3339(value.trim()) {
            Ok(stamp) => stamp.with_timezone(&Utc),
            Err(_) => {
                problems.push(Problem::new(
                    file,
                    *line,
                    format!("run.started must be an ISO-8601 timestamp, got \"{}\"", value.trim()),
                ));
                return None;
            }
        },
        None => {
            problems.push(Problem::new(file, 1, "run is present but run.started is missing"));
            return None;
        }
    };

    Some(Run {
        session,
        pid,
        host,
        mode,
        goal,
        started,
    })
}

fn parse_list(
    file: &str,
    field: Option<(usize, String)>,
    name: &str,
    problems: &mut Vec<Problem>,
) -> Vec<String> {
    let Some((line, raw)) = field else {
        return Vec::new();
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "[]" || trimmed == "null" {
        return Vec::new();
    }
    let inner = trimmed
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'));
    match inner {
        Some(inner) => inner
            .split(',')
            .map(|item| item.trim().trim_matches('"').trim_matches('\'').to_string())
            .filter(|item| !item.is_empty())
            .collect(),
        None => {
            problems.push(Problem::new(
                file,
                line,
                format!("{name} must be a flow list like `[{name}: A, B]` or `[]`, got \"{trimmed}\""),
            ));
            Vec::new()
        }
    }
}

fn parse_date(
    file: &str,
    field: Option<(usize, String)>,
    name: &str,
    problems: &mut Vec<Problem>,
) -> DateTime<Utc> {
    match field {
        Some((line, value)) => match DateTime::parse_from_rfc3339(value.trim()) {
            Ok(stamp) => stamp.with_timezone(&Utc),
            Err(_) => {
                problems.push(Problem::new(
                    file,
                    line,
                    format!("{name} must be an ISO-8601 timestamp, got \"{}\"", value.trim()),
                ));
                Utc::now()
            }
        },
        None => {
            problems.push(Problem::new(
                file,
                1,
                format!("missing required frontmatter key \"{name}\""),
            ));
            Utc::now()
        }
    }
}

fn split_key_value(line: &str) -> Option<(&str, &str)> {
    let (key, value) = line.split_once(':')?;
    let key = key.trim();
    if key.is_empty() || key.contains(' ') {
        return None;
    }
    Some((key, value.trim_start()))
}

fn unquote(value: &str) -> std::result::Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "null" || trimmed == "~" {
        return Ok(String::new());
    }
    let unquoted = if (trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2)
        || (trimmed.starts_with('\'') && trimmed.ends_with('\'') && trimmed.len() >= 2)
    {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };
    match serde_norway::from_str::<String>(&format!("\"{}\"", escape_yaml(unquoted))) {
        Ok(text) => Ok(text),
        Err(_) => Ok(unquoted.to_string()),
    }
}

fn escape_yaml(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Quote a scalar when YAML would otherwise change its meaning.
pub fn yaml_scalar(value: &str) -> String {
    let needs_quotes = value.is_empty()
        || value.trim() != value
        || value.chars().any(|c| {
            matches!(
                c,
                ':' | '#' | '[' | ']' | '{' | '}' | ',' | '&' | '*' | '!' | '|' | '>' | '\'' | '"' | '%' | '@' | '`'
            )
        })
        || value.starts_with('-')
        || value.starts_with('?')
        || matches!(
            value.to_lowercase().as_str(),
            "true" | "false" | "null" | "~" | "yes" | "no" | "on" | "off"
        )
        || value.parse::<f64>().is_ok();
    if needs_quotes || value.contains('\n') {
        format!("\"{}\"", escape_yaml(value))
    } else {
        value.to_string()
    }
}

fn flow_list(items: &[String]) -> String {
    if items.is_empty() {
        return "[]".to_string();
    }
    let rendered: Vec<String> = items.iter().map(|item| yaml_scalar(item)).collect();
    format!("[{}]", rendered.join(", "))
}

pub fn iso(stamp: DateTime<Utc>) -> String {
    stamp.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// `validate --fix`: normalise a task's own rendering plus known repairs.
pub fn repair(file: &str, text: &str) -> Result<String> {
    let (task, problems) = parse(file, text);
    let Some(task) = task else {
        return Err(crate::error::Error::rule(format!(
            "{file}: cannot fix — the frontmatter is unusable"
        )));
    };
    let unfixable: Vec<&Problem> = problems.iter().filter(|problem| !problem.fixable).collect();
    if !unfixable.is_empty() {
        return Err(crate::error::Error::rule(format!(
            "{file}: cannot fix — {} problem(s) need a human: {}",
            unfixable.len(),
            unfixable
                .iter()
                .map(|problem| problem.to_string())
                .collect::<Vec<_>>()
                .join("; ")
        )));
    }
    Ok(render(&task))
}

/// 1-based line number of a frontmatter key (for board-level validator messages).
pub fn find_key_line(text: &str, key: &str) -> usize {
    let needle = format!("{key}:");
    for (index, line) in text.lines().enumerate() {
        if line.trim_start().starts_with(&needle) {
            return index + 1;
        }
    }
    1
}
