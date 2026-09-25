//! JSON API. Every handler calls the same library functions the CLI uses, so
//! the UI cannot drift from the terminal rules.

use std::sync::Arc;

use std::time::Duration;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::commands::{self, ClaimArgs, Common, EditArgs, OrderTarget};
use crate::error::Error;
use crate::model::{Actor, ChainGate, Priority, RunMode, Status};
use crate::store::{self, Project};

use super::AppState;

/// JSON response with an explicit status code.
pub struct ApiResponse {
    pub status: StatusCode,
    pub body: Value,
}

impl ApiResponse {
    pub fn ok(body: Value) -> Self {
        ApiResponse {
            status: StatusCode::OK,
            body,
        }
    }

    pub fn error(status: StatusCode, error: &Error) -> Self {
        ApiResponse {
            status,
            body: json!({
                "ok": false,
                "error": ui_message(error),
                "kind": match error {
                    Error::Usage(_) => "usage",
                    Error::NotFound(_) => "not_found",
                    _ => "rule",
                },
            }),
        }
    }
}

impl IntoResponse for ApiResponse {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

pub fn ok(body: Value) -> ApiResponse {
    ApiResponse::ok(body)
}

pub fn err(status: StatusCode, error: &Error) -> ApiResponse {
    ApiResponse::error(status, error)
}

/// The same rule message reads differently on the two surfaces: the CLI names
/// the flag a human must type, the UI/API says what is missing. Only the CLI
/// may mention `--comment`.
pub fn ui_message(error: &Error) -> String {
    error
        .to_string()
        .replace("requires --comment", "requires a comment")
}

/// Rule violations are client errors: 404 for missing things, 400 otherwise.
/// A move that needs a comment is 409 so the UI can open its comment prompt.
pub fn map_error(error: Error, needs_comment: bool) -> ApiResponse {
    if needs_comment {
        let mut response = ApiResponse::error(StatusCode::CONFLICT, &error);
        if let Value::Object(ref mut map) = response.body {
            map.insert("needsComment".into(), json!(true));
        }
        return response;
    }
    let status = match error {
        Error::NotFound(_) => StatusCode::NOT_FOUND,
        _ => StatusCode::BAD_REQUEST,
    };
    ApiResponse::error(status, &error)
}

pub fn gate() -> ChainGate {
    // The extension sets UNIPI_KANBOARD_CHAIN_GATE when it spawns the daemon,
    // so readiness here matches the configured chain gate (default in_review).
    match std::env::var("UNIPI_KANBOARD_CHAIN_GATE").as_deref() {
        Ok("done") => ChainGate::Done,
        _ => ChainGate::InReview,
    }
}

fn common() -> Common {
    // The UI is a human: every action is `user`.
    Common::new(Actor::User, gate())
}

pub fn project_by_slug(state: &AppState, slug: &str) -> Result<Project, Error> {
    store::Project::load(&state.layout, slug)
}

// ─── health & projects ──────────────────────────────────────────────────────

pub async fn health(State(state): State<Arc<AppState>>) -> ApiResponse {
    // A remote bind must not leak the daemon's pid.
    if super::auth::is_loopback(&state.host) {
        ok(json!({
            "ok": true,
            "version": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
        }))
    } else {
        ok(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
    }
}

pub async fn projects(State(state): State<Arc<AppState>>) -> ApiResponse {
    match state.layout.list_projects() {
        Ok(projects) => {
            let payload: Vec<Value> = projects
                .iter()
                .map(|project| project_summary(&state, project))
                .collect();
            ok(json!(payload))
        }
        Err(error) => err(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

pub fn project_summary(state: &AppState, project: &Project) -> Value {
    let mut counts = Map::new();
    let mut total = 0usize;
    let mut problems = Vec::new();
    let mut running = 0usize;
    let mut updated_at: Option<String> = None;
    if let Ok(opened) = crate::board::Board::open(&state.layout, project.clone())
        && let Ok((task_list, found)) = opened.state()
    {
        problems = found;
        total = task_list.len();
        running = task_list.iter().filter(|item| item.run.is_some()).count();
        updated_at = task_list
            .iter()
            .map(|item| item.updated)
            .max()
            .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        for status in Status::ALL {
            counts.insert(
                status.as_str().to_string(),
                json!(
                    task_list
                        .iter()
                        .filter(|item| item.status == status)
                        .count()
                ),
            );
        }
    }
    json!({
        "slug": project.slug,
        "name": project.name,
        "root": project.root,
        "prefix": project.prefix,
        "nextId": project.next_id,
        "counts": counts,
        "total": total,
        // Tasks with a live run block, and the newest task change — the sidebar's
        // project list shows both without fetching every board.
        "running": running,
        "updatedAt": updated_at,
        "archived": project.archived,
        "problems": commands::problems_json(&problems),
    })
}

/// `PUT /api/projects/{slug} {archived}` — archive/unarchive one project.
#[derive(Deserialize)]
pub struct ProjectPatch {
    pub archived: Option<bool>,
}

pub async fn update_project(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(patch): Json<ProjectPatch>,
) -> ApiResponse {
    state.touch();
    match project_by_slug(&state, &slug) {
        Ok(mut project) => {
            if let Some(archived) = patch.archived {
                if let Err(error) =
                    commands::project_set_archived(&state.layout, &project.slug, archived)
                {
                    return err(StatusCode::INTERNAL_SERVER_ERROR, &error);
                }
                project.archived = archived;
                state.bump(&slug);
            }
            ok(project_summary(&state, &project))
        }
        Err(error) => err(StatusCode::NOT_FOUND, &error),
    }
}

// ─── rules ──────────────────────────────────────────────────────────────────

/// The transition table as JSON, for the `user` actor — so the UI can dim
/// invalid drop targets and limit the status select without hard-coding the
/// rules a second time.
pub async fn rules() -> ApiResponse {
    let actor = Actor::User;
    let mut allowed_moves = Map::new();
    let mut comment_required = Map::new();
    for from in Status::ALL {
        let targets = crate::transitions::allowed_targets(from, actor);
        allowed_moves.insert(
            from.as_str().to_string(),
            json!(
                targets
                    .iter()
                    .map(|status| status.as_str())
                    .collect::<Vec<_>>()
            ),
        );
        let mut per_from = Map::new();
        for to in Status::ALL {
            if let Some(rule) = crate::transitions::rule_for(from, to)
                && let crate::transitions::Comment::Required(hint) = rule.comment
            {
                per_from.insert(to.as_str().to_string(), json!(hint));
            }
        }
        if !per_from.is_empty() {
            comment_required.insert(from.as_str().to_string(), Value::Object(per_from));
        }
    }
    let table: Vec<Value> = crate::transitions::RULES
        .iter()
        .map(|rule| {
            json!({
                "from": rule.from.as_str(),
                "to": rule.to.as_str(),
                "actors": rule.actors.iter().map(|actor| actor.as_str()).collect::<Vec<_>>(),
                "commentRequired": matches!(rule.comment, crate::transitions::Comment::Required(_)),
            })
        })
        .collect();
    ok(json!({
        "statuses": Status::ALL.iter().map(|status| status.as_str()).collect::<Vec<_>>(),
        "allowedMoves": allowed_moves,
        "commentRequired": comment_required,
        "final": ["done", "cancelled", "archived"],
        "table": table,
        // Tooltips render these live.
        "chainGate": gate().as_str(),
        "maxSessions": crate::commands::max_sessions(),
        "queueMax": crate::commands::queue_max(),
    }))
}

// ─── tasks ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct TasksQuery {
    status: Option<String>,
    ready: Option<String>,
}

pub async fn tasks(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Query(query): Query<TasksQuery>,
) -> ApiResponse {
    state.touch();
    let status = query
        .status
        .as_deref()
        .and_then(|value| value.parse::<Status>().ok());
    let ready_only = query.ready.as_deref() == Some("true");
    let project = match project_by_slug(&state, &slug) {
        Ok(project) => project,
        Err(error) => return err(StatusCode::NOT_FOUND, &error),
    };
    match commands::list(&state.layout, project, gate(), status, ready_only) {
        Ok(value) => ok(value),
        Err(error) => map_error(error, false),
    }
}

pub async fn task(
    State(state): State<Arc<AppState>>,
    Path((slug, id)): Path<(String, String)>,
) -> ApiResponse {
    state.touch();
    let project = match project_by_slug(&state, &slug) {
        Ok(project) => project,
        Err(error) => return err(StatusCode::NOT_FOUND, &error),
    };
    match commands::show(&state.layout, project, &id, gate()) {
        Ok(value) => ok(value),
        Err(error) => map_error(error, false),
    }
}

#[derive(Deserialize)]
pub struct CreateRequest {
    pub title: String,
    pub body: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    #[serde(default)]
    pub after: Vec<String>,
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(request): Json<CreateRequest>,
) -> ApiResponse {
    state.touch();
    let project = match project_by_slug(&state, &slug) {
        Ok(project) => project,
        Err(error) => return err(StatusCode::NOT_FOUND, &error),
    };
    let status = match request
        .status
        .as_deref()
        .map(str::parse::<Status>)
        .transpose()
    {
        Ok(status) => status,
        Err(error) => return map_error(error, false),
    };
    let priority = match request
        .priority
        .as_deref()
        .map(str::parse::<Priority>)
        .transpose()
    {
        Ok(priority) => priority.unwrap_or(Priority::None),
        Err(error) => return map_error(error, false),
    };
    let result = commands::add(
        &state.layout,
        project,
        &common(),
        &request.title,
        request.body.as_deref(),
        status,
        priority,
        &request.after,
        &[],
    );
    match result {
        Ok(value) => ok(value),
        Err(error) => map_error(error, false),
    }
}

#[derive(Deserialize)]
pub struct MoveRequest {
    pub status: String,
    pub comment: Option<String>,
}

pub async fn move_task(
    State(state): State<Arc<AppState>>,
    Path((slug, id)): Path<(String, String)>,
    Json(request): Json<MoveRequest>,
) -> ApiResponse {
    state.touch();
    let project = match project_by_slug(&state, &slug) {
        Ok(project) => project,
        Err(error) => return err(StatusCode::NOT_FOUND, &error),
    };
    let Ok(to) = request.status.parse::<Status>() else {
        return err(
            StatusCode::BAD_REQUEST,
            &Error::usage(format!("unknown status \"{}\"", request.status)),
        );
    };

    // Ask the library whether this move needs a comment *before* attempting it,
    // so the UI gets 409 + needsComment instead of a generic refusal.
    let needs_comment = match commands::show(&state.layout, project.clone(), &id, gate()) {
        Ok(value) => value
            .get("status")
            .and_then(|status| status.as_str())
            .and_then(|status| status.parse::<Status>().ok())
            .map(|from| {
                crate::transitions::comment_required(from, to)
                    && request.comment.as_deref().unwrap_or("").trim().is_empty()
            })
            .unwrap_or(false),
        Err(error) => return map_error(error, false),
    };

    let result = commands::move_task(
        &state.layout,
        project,
        &common(),
        &id,
        to,
        request.comment.as_deref(),
    );
    match result {
        Ok(value) => ok(value),
        Err(error) => map_error(error, needs_comment),
    }
}

#[derive(Deserialize)]
pub struct NoteRequest {
    pub text: String,
}

pub async fn note(
    State(state): State<Arc<AppState>>,
    Path((slug, id)): Path<(String, String)>,
    Json(request): Json<NoteRequest>,
) -> ApiResponse {
    state.touch();
    let project = match project_by_slug(&state, &slug) {
        Ok(project) => project,
        Err(error) => return err(StatusCode::NOT_FOUND, &error),
    };
    match commands::note(&state.layout, project, &common(), &id, &request.text) {
        Ok(value) => ok(value),
        Err(error) => map_error(error, false),
    }
}

#[derive(Deserialize)]
pub struct EditRequest {
    pub title: Option<String>,
    pub body: Option<String>,
    pub priority: Option<String>,
    pub labels: Option<Vec<String>>,
}

pub async fn edit(
    State(state): State<Arc<AppState>>,
    Path((slug, id)): Path<(String, String)>,
    Json(request): Json<EditRequest>,
) -> ApiResponse {
    state.touch();
    let project = match project_by_slug(&state, &slug) {
        Ok(project) => project,
        Err(error) => return err(StatusCode::NOT_FOUND, &error),
    };
    let priority = match request
        .priority
        .as_deref()
        .map(str::parse::<Priority>)
        .transpose()
    {
        Ok(priority) => priority,
        Err(error) => return map_error(error, false),
    };
    let args = EditArgs {
        title: request.title.as_deref(),
        body: request.body.as_deref(),
        priority,
        labels: request.labels,
    };
    match commands::edit(&state.layout, project, &common(), &id, args) {
        Ok(value) => ok(value),
        Err(error) => map_error(error, false),
    }
}

#[derive(Deserialize)]
pub struct LinkRequest {
    pub dep: String,
}

pub async fn link(
    state: State<Arc<AppState>>,
    path: Path<(String, String)>,
    request: Json<LinkRequest>,
) -> ApiResponse {
    link_impl(state, path, request, false).await
}

pub async fn unlink(
    state: State<Arc<AppState>>,
    path: Path<(String, String)>,
    request: Json<LinkRequest>,
) -> ApiResponse {
    link_impl(state, path, request, true).await
}

async fn link_impl(
    State(state): State<Arc<AppState>>,
    Path((slug, id)): Path<(String, String)>,
    Json(request): Json<LinkRequest>,
    remove: bool,
) -> ApiResponse {
    state.touch();
    let project = match project_by_slug(&state, &slug) {
        Ok(project) => project,
        Err(error) => return err(StatusCode::NOT_FOUND, &error),
    };
    let result = commands::link(
        &state.layout,
        project,
        &common(),
        gate(),
        &id,
        &request.dep,
        remove,
    );
    match result {
        Ok(value) => ok(value),
        Err(error) => map_error(error, false),
    }
}

#[derive(Deserialize)]
pub struct OrderRequest {
    pub before: Option<String>,
    pub after_pos: Option<String>,
    pub top: Option<bool>,
    pub bottom: Option<bool>,
}

pub async fn order(
    State(state): State<Arc<AppState>>,
    Path((slug, id)): Path<(String, String)>,
    Json(request): Json<OrderRequest>,
) -> ApiResponse {
    state.touch();
    let project = match project_by_slug(&state, &slug) {
        Ok(project) => project,
        Err(error) => return err(StatusCode::NOT_FOUND, &error),
    };
    let target = match (
        request.before.as_deref(),
        request.after_pos.as_deref(),
        request.top.unwrap_or(false),
        request.bottom.unwrap_or(false),
    ) {
        (Some(before), None, false, false) => OrderTarget::Before(before),
        (None, Some(after), false, false) => OrderTarget::AfterPos(after),
        (None, None, true, false) => OrderTarget::Top,
        (None, None, false, true) => OrderTarget::Bottom,
        _ => {
            return err(
                StatusCode::BAD_REQUEST,
                &Error::usage("order needs exactly one of before/after_pos/top/bottom"),
            );
        }
    };
    match commands::order(&state.layout, project, &common(), &id, target) {
        Ok(value) => ok(value),
        Err(error) => map_error(error, false),
    }
}

pub async fn duplicate(
    State(state): State<Arc<AppState>>,
    Path((slug, id)): Path<(String, String)>,
) -> ApiResponse {
    state.touch();
    let project = match project_by_slug(&state, &slug) {
        Ok(project) => project,
        Err(error) => return err(StatusCode::NOT_FOUND, &error),
    };
    match commands::duplicate(&state.layout, project, &common(), &id) {
        Ok(value) => ok(value),
        Err(error) => map_error(error, false),
    }
}

/// Claim/runner endpoints are deliberately absent: the UI never starts work
/// (spec principle 1). Only these helpers exist for tests and the pi runner.
pub fn claim_for_runner(
    layout: &crate::store::Layout,
    project: Project,
    args: &ClaimArgs<'_>,
    mode: RunMode,
) -> Result<Value, Error> {
    let _ = mode;
    commands::claim_next(layout, project, gate(), args, chrono::Utc::now())
}

#[cfg(test)]
mod phrasing_tests {
    use super::*;

    #[test]
    fn ui_messages_do_not_name_cli_flags() {
        let error = Error::rule("in_review → todo requires --comment (rework note)");
        assert_eq!(
            ui_message(&error),
            "in_review → todo requires a comment (rework note)"
        );
        // A message without a flag is untouched.
        let other = Error::rule("todo → in_progress is system only — claim it with `claim-next`");
        assert_eq!(ui_message(&other), other.to_string());
    }
}

// ─── panel settings ─────────────────────────────────────────────────────────

fn settings_payload(state: &AppState) -> Value {
    let settings = super::settings::load(&state.layout);
    json!({
        "piCommand": settings.pi_command,
        "models": settings.models,
        "summaryModel": settings.summary_model,
        "summaryInstruction": settings.effective_instruction(),
        "defaultSummaryInstruction": super::settings::DEFAULT_SUMMARY_INSTRUCTION,
    })
}

/// `GET /api/settings` — the effective settings plus the built-in defaults.
pub async fn get_settings(State(state): State<Arc<AppState>>) -> ApiResponse {
    state.touch();
    ok(settings_payload(&state))
}

#[derive(Deserialize)]
pub struct SettingsPatch {
    /// Unknown/absent command fields are ignored — the daemon only ever runs
    /// the piCommand argv the extension wrote.
    #[serde(rename = "summaryModel")]
    pub summary_model: Option<String>,
    #[serde(rename = "summaryInstruction")]
    pub summary_instruction: Option<String>,
}

/// `PUT /api/settings` — partial patch. `summaryModel` is whitelisted against
/// the `models` the extension reported, so remote binds can only ever pick a
/// model the user actually has.
pub async fn put_settings(
    State(state): State<Arc<AppState>>,
    Json(patch): Json<SettingsPatch>,
) -> ApiResponse {
    state.touch();
    let mut settings = super::settings::load(&state.layout);
    if let Some(model) = patch.summary_model {
        let model = model.trim().to_string();
        if !model.is_empty() && !settings.models.iter().any(|known| known == &model) {
            return err(
                StatusCode::BAD_REQUEST,
                &Error::rule("summary model must be one of the models the extension reported"),
            );
        }
        settings.summary_model = model;
    }
    if let Some(instruction) = patch.summary_instruction {
        // Blank means "use the default" — stored as written, resolved on read.
        settings.summary_instruction = instruction;
    }
    match super::settings::save(&state.layout, &settings) {
        Ok(()) => ok(settings_payload(&state)),
        Err(error) => err(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

// ─── summarize & archive ────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SummarizeRequest {
    pub instruction: Option<String>,
}

/// `POST /api/projects/{slug}/summarize` — run the configured agent over the
/// done tasks: prompt on stdin, summary on stdout.
pub async fn summarize(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(request): Json<SummarizeRequest>,
) -> ApiResponse {
    state.touch();
    let project = match project_by_slug(&state, &slug) {
        Ok(project) => project,
        Err(error) => return err(StatusCode::NOT_FOUND, &error),
    };
    let settings = super::settings::load(&state.layout);
    if settings.pi_command.is_empty() {
        let mut response = ApiResponse::error(
            StatusCode::CONFLICT,
            &Error::rule(
                "Open the board from pi once (/unipi:kanboard open) so it knows how to run pi",
            ),
        );
        if let Value::Object(ref mut map) = response.body {
            map.insert("needsAgent".into(), json!(true));
        }
        return response;
    }

    let done: Vec<crate::model::Task> =
        match crate::board::Board::open(&state.layout, project.clone())
            .and_then(|board| board.tasks())
        {
            Ok(tasks) => tasks
                .into_iter()
                .filter(|task| task.status == Status::Done)
                .collect(),
            Err(error) => return err(StatusCode::INTERNAL_SERVER_ERROR, &error),
        };
    if done.is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            &Error::rule("no done tasks to summarize"),
        );
    }

    let instruction = request
        .instruction
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| settings.effective_instruction());
    // The fixed style tail always applies — the editable part never carries it.
    let mut prompt = format!(
        "{}\n\n{}",
        instruction.trim(),
        super::settings::SUMMARY_STYLE
    );
    prompt.push_str("\n\n");
    for task in &done {
        prompt.push_str(&format!("## {} — {}\n\n", task.id, task.title));
        if !task.body.trim().is_empty() {
            prompt.push_str(task.body.trim());
            prompt.push_str("\n\n");
        }
        for entry in &task.activity {
            prompt.push_str(&format!(
                "- {} [{}] {}\n",
                entry.at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                entry.actor.as_str(),
                entry.text
            ));
        }
        prompt.push('\n');
    }

    match run_agent(&settings, &prompt, &project, &state.layout).await {
        Ok(summary) => ok(json!({
            "summary": summary,
            "taskIds": done.iter().map(|task| task.id.clone()).collect::<Vec<_>>(),
        })),
        Err((status, message)) => err(status, &Error::rule(message)),
    }
}

/// Spawn pi (`piCommand -p --no-session --no-tools --no-extensions --no-skills
/// --no-context-files --no-prompt-templates [--model <summaryModel>]`), feed
/// `prompt` to its stdin, collect stdout. Ten minutes is generous on purpose —
/// a real model can think for a while; a hung one still gets killed.
async fn run_agent(
    settings: &super::settings::PanelSettings,
    prompt: &str,
    project: &Project,
    layout: &crate::store::Layout,
) -> std::result::Result<String, (StatusCode, String)> {
    use tokio::io::AsyncWriteExt;

    let mut argv = settings.pi_command.clone();
    argv.extend([
        "-p".into(),
        "--no-session".into(),
        "--no-tools".into(),
        "--no-extensions".into(),
        "--no-skills".into(),
        "--no-context-files".into(),
        "--no-prompt-templates".into(),
    ]);
    if !settings.summary_model.trim().is_empty() {
        argv.push("--model".into());
        argv.push(settings.summary_model.trim().to_string());
    }
    let display = argv.join(" ");

    let cwd = if project.root.is_dir() {
        project.root.clone()
    } else {
        layout.home.clone()
    };
    let mut builder = tokio::process::Command::new(&argv[0]);
    builder
        .args(&argv[1..])
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // Dropping a timed-out future must kill the child, not orphan it.
        .kill_on_drop(true);
    let mut child = builder.spawn().map_err(|error| {
        (
            StatusCode::BAD_GATEWAY,
            format!("could not start `{display}`: {error}"),
        )
    })?;

    // Write the prompt in the background: a big prompt could fill the pipe
    // before the agent starts reading, and an early-exiting agent EPIPEs —
    // neither should fail the request.
    if let Some(mut stdin) = child.stdin.take() {
        let bytes = prompt.as_bytes().to_vec();
        tokio::spawn(async move {
            let _ = stdin.write_all(&bytes).await;
            let _ = stdin.shutdown().await;
        });
    }

    let output =
        match tokio::time::timeout(Duration::from_secs(600), child.wait_with_output()).await {
            Ok(result) => result.map_err(|error| {
                (
                    StatusCode::BAD_GATEWAY,
                    format!("agent `{display}` failed: {error}"),
                )
            })?,
            Err(_) => {
                return Err((
                    StatusCode::BAD_GATEWAY,
                    format!("agent `{display}` did not finish within 10 minutes"),
                ));
            }
        };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr
            .trim()
            .chars()
            .rev()
            .take(2000)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let detail = if tail.is_empty() {
            format!("exit {}", output.status)
        } else {
            format!("exit {} — {}", output.status, tail)
        };
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("agent `{display}` produced no summary ({detail})"),
        ));
    }
    Ok(stdout)
}

#[derive(Deserialize)]
pub struct ArchiveSummaryRequest {
    pub markdown: String,
    #[serde(rename = "taskIds", default)]
    pub task_ids: Vec<String>,
}

/// `POST /api/projects/{slug}/archive-summary` — save the summary next to the
/// project's tasks, then archive every listed task that is still done.
pub async fn archive_summary(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(request): Json<ArchiveSummaryRequest>,
) -> ApiResponse {
    state.touch();
    let project = match project_by_slug(&state, &slug) {
        Ok(project) => project,
        Err(error) => return err(StatusCode::NOT_FOUND, &error),
    };
    if request.markdown.trim().is_empty() {
        return err(StatusCode::BAD_REQUEST, &Error::usage("markdown is empty"));
    }

    // Move first, write second: the file must name the tasks that were actually
    // archived, not just the ones the client asked about.
    let mut archived = Vec::new();
    let mut skipped = Vec::new();
    for id in &request.task_ids {
        let still_done = commands::show(&state.layout, project.clone(), id, gate())
            .ok()
            .and_then(|value| {
                value
                    .get("status")
                    .and_then(|status| status.as_str())
                    .map(str::to_string)
            })
            .as_deref()
            == Some("done");
        if !still_done {
            skipped.push(id.clone());
            continue;
        }
        match commands::move_task(
            &state.layout,
            project.clone(),
            &common(),
            id,
            Status::Archived,
            None,
        ) {
            Ok(_) => archived.push(id.clone()),
            Err(_) => skipped.push(id.clone()),
        }
    }

    let dir = state.layout.project_dir(&slug).join("summaries");
    if let Err(error) = std::fs::create_dir_all(&dir) {
        return err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &Error::Io(format!("cannot create {}: {error}", dir.display())),
        );
    }
    let name = format!("{}.md", Utc::now().format("%Y-%m-%d-%H%M%S"));
    let path = dir.join(&name);
    let mut document = format!(
        "# {} — done summary {}\n\nArchived tasks: {}\n",
        project.name,
        Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        archived.join(", "),
    );
    if !skipped.is_empty() {
        document.push_str(&format!("Skipped (not done): {}\n", skipped.join(", ")));
    }
    document.push_str(&format!("\n{}\n", request.markdown.trim()));
    if let Err(error) = crate::store::write_atomic(&path, &document) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, &error);
    }
    // The file watcher's .md bump covers the summary write and each task move;
    // bump once more so clients refresh even if a coalesced event was dropped.
    state.bump(&slug);

    ok(json!({
        "path": path.display().to_string(),
        "archived": archived,
        "skipped": skipped,
    }))
}

// ─── attachments ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct UploadQuery {
    pub name: Option<String>,
}

/// `POST /api/projects/{slug}/archive-lane {status}` — archive every task in
/// the lane (done or in_review), one board lock.
#[derive(Deserialize)]
pub struct ArchiveLaneRequest {
    pub status: String,
}

pub async fn archive_lane(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(request): Json<ArchiveLaneRequest>,
) -> ApiResponse {
    state.touch();
    let status = match request.status.as_str() {
        "done" => Status::Done,
        "in_review" => Status::InReview,
        other => {
            return err(
                StatusCode::BAD_REQUEST,
                &Error::usage(format!(
                    "archive-lane accepts done or in_review, not `{other}`"
                )),
            );
        }
    };
    let project = match project_by_slug(&state, &slug) {
        Ok(project) => project,
        Err(error) => return err(StatusCode::NOT_FOUND, &error),
    };
    match commands::archive_lane(&state.layout, project, status, Utc::now()) {
        Ok(payload) => {
            state.bump(&slug);
            ok(payload)
        }
        Err(error) => err(StatusCode::BAD_REQUEST, &error),
    }
}

/// `POST /api/tasks/{slug}/{id}/attachments?name=<file>` — raw bytes in the body.
/// Stores the file and returns its descriptor (`ref`, `markdown`, `kind`, …); the
/// UI then posts the comment that references it.
pub async fn upload(
    State(state): State<Arc<AppState>>,
    Path((slug, id)): Path<(String, String)>,
    Query(query): Query<UploadQuery>,
    body: axum::body::Bytes,
) -> ApiResponse {
    state.touch();
    let project = match project_by_slug(&state, &slug) {
        Ok(project) => project,
        Err(error) => return err(StatusCode::NOT_FOUND, &error),
    };
    let name = query.name.unwrap_or_else(|| "file".into());
    match commands::upload(&state.layout, project, &id, &name, &body) {
        Ok(value) => ok(value),
        Err(error) => map_error(error, false),
    }
}

/// `GET /api/files/{slug}/{task}/{name}` — serve a stored attachment.
/// Images/video/audio/pdf render inline; everything else downloads. `nosniff` +
/// a sandbox CSP so an uploaded HTML/SVG can never run as the board's origin.
pub async fn file(
    State(state): State<Arc<AppState>>,
    Path((slug, task, name)): Path<(String, String, String)>,
) -> Response {
    state.touch();
    let not_found = || (StatusCode::NOT_FOUND, "attachment not found").into_response();
    if project_by_slug(&state, &slug).is_err() {
        return not_found();
    }
    let Ok(found) = crate::attachments::resolve(&state.layout, &slug, &task, &name) else {
        return not_found();
    };
    let Ok(bytes) = std::fs::read(&found.path) else {
        return not_found();
    };
    let inline = matches!(
        found.kind.as_str(),
        "image" | "video" | "audio" | "pdf" | "text"
    );
    let content_type = if found.kind == "text" {
        "text/plain; charset=utf-8".to_string()
    } else {
        found.mime.clone()
    };
    let disposition = format!(
        "{}; filename=\"{}\"",
        if inline { "inline" } else { "attachment" },
        found.original.replace(['"', '\\'], "")
    );
    (
        [
            (axum::http::header::CONTENT_TYPE, content_type),
            (axum::http::header::CONTENT_DISPOSITION, disposition),
            (axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
            (axum::http::header::CONTENT_SECURITY_POLICY, "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'".to_string()),
            (axum::http::header::CACHE_CONTROL, "private, max-age=31536000, immutable".to_string()),
        ],
        bytes,
    )
        .into_response()
}
