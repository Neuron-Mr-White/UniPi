//! JSON API. Every handler calls the same library functions the CLI uses, so
//! the UI cannot drift from the terminal rules.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Map, json, Value};

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
        ApiResponse { status: StatusCode::OK, body }
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
    error.to_string().replace("requires --comment", "requires a comment")
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
    // The daemon always evaluates readiness with the spec default; the pi side
    // passes `--gate done` explicitly when the setting says so.
    ChainGate::InReview
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
                json!(task_list.iter().filter(|item| item.status == status).count()),
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
        "problems": commands::problems_json(&problems),
    })
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
            json!(targets.iter().map(|status| status.as_str()).collect::<Vec<_>>()),
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
    let status = query.status.as_deref().and_then(|value| value.parse::<Status>().ok());
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

pub async fn task(State(state): State<Arc<AppState>>, Path((slug, id)): Path<(String, String)>) -> ApiResponse {
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
    let status = match request.status.as_deref().map(str::parse::<Status>).transpose() {
        Ok(status) => status,
        Err(error) => return map_error(error, false),
    };
    let priority = match request.priority.as_deref().map(str::parse::<Priority>).transpose() {
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
    let priority = match request.priority.as_deref().map(str::parse::<Priority>).transpose() {
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

pub async fn duplicate(State(state): State<Arc<AppState>>, Path((slug, id)): Path<(String, String)>) -> ApiResponse {
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
