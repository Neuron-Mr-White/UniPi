//! JSON API. Every handler calls the same library functions the CLI uses, so
//! the UI cannot drift from the terminal rules.

use serde::Deserialize;
use serde_json::{json, Value};
use topcoat::{
    Result as TcResult,
    context::Cx,
    router::{
        HeaderValue, StatusCode, content::Json, response::IntoResponse, route,
    },
};

use crate::commands::{self, ClaimArgs, Common, EditArgs, OrderTarget};
use crate::error::Error;
use crate::model::{Actor, ChainGate, Priority, RunMode, Status};
use crate::store::{self, Project};

use super::{AppState, state};

pub fn ok(body: Value) -> TcResult<ApiResponse> {
    Ok(ApiResponse::ok(body))
}

pub fn err(status: StatusCode, error: &Error) -> TcResult<ApiResponse> {
    Ok(ApiResponse::error(status, error))
}

/// JSON response with an explicit status code.
pub use topcoat::router::response::Response;

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
    fn into_response(self, cx: &Cx) -> TcResult<Response> {
        let bytes = serde_json::to_vec(&self.body)?;
        let response = (
            [(
                topcoat::router::header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            )],
            bytes,
        )
            .into_response(cx)?;
        let (mut parts, body) = response.into_parts();
        parts.status = self.status;
        Ok(Response::from_parts(parts, body))
    }
}

/// The same rule message reads differently on the two surfaces: the CLI names
/// the flag a human must type, the UI/API says what is missing. Only the CLI
/// may mention `--comment`.
pub fn ui_message(error: &Error) -> String {
    error.to_string().replace("requires --comment", "requires a comment")
}

/// Rule violations are client errors: 404 for missing things, 400 otherwise.
/// A move that needs a comment is 409 so the UI can open its comment prompt.
pub fn map_error(error: Error, needs_comment: bool) -> TcResult<ApiResponse> {
    if needs_comment {
        let mut response = ApiResponse::error(StatusCode::CONFLICT, &error);
        if let Value::Object(ref mut map) = response.body {
            map.insert("needsComment".into(), json!(true));
        }
        return Ok(response);
    }
    let status = match error {
        Error::NotFound(_) => StatusCode::NOT_FOUND,
        _ => StatusCode::BAD_REQUEST,
    };
    Ok(ApiResponse::error(status, &error))
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

pub fn project_by_slug(slug: &str) -> Result<Project, Error> {
    store::Project::load(&state().layout, slug)
}

topcoat::router::path_param!(slug);
topcoat::router::path_param!(id);

/// `{slug}` from the matched path.
pub fn slug_param(cx: &Cx) -> Option<String> {
    Some(topcoat::router::path_param::<Slug>(cx).to_string())
}

/// `{id}` from the matched path.
pub fn id_param(cx: &Cx) -> Option<String> {
    Some(topcoat::router::path_param::<Id>(cx).to_string())
}

/// Read a query parameter from the request URI.
pub fn query_param(cx: &Cx, key: &str) -> Option<String> {
    let uri = topcoat::router::request::uri(cx);
    let query = uri.query()?;
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if name == key {
            return Some(percent_decode(value));
        }
    }
    None
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    Err(_) => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

// ─── health & projects ──────────────────────────────────────────────────────

#[route(GET "/api/health")]
pub async fn health() -> TcResult<ApiResponse> {
    let state = state();
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

#[route(GET "/api/projects")]
pub async fn projects() -> TcResult<ApiResponse> {
    let state = state();
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
    let mut counts = serde_json::Map::new();
    let mut total = 0usize;
    let mut problems = Vec::new();
    if let Ok(opened) = crate::board::Board::open(&state.layout, project.clone())
        && let Ok((task_list, found)) = opened.state()
    {
        problems = found;
        total = task_list.len();
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
        "problems": commands::problems_json(&problems),
    })
}

// ─── tasks ──────────────────────────────────────────────────────────────────

#[route(GET "/api/projects/{slug}/tasks")]
pub async fn tasks(cx: &Cx) -> TcResult<ApiResponse> {
    let state = state();
    state.touch();
    let Some(slug) = slug_param(cx) else {
        return err(StatusCode::BAD_REQUEST, &Error::usage("missing slug"));
    };
    let status = query_param(cx, "status").and_then(|value| value.parse::<Status>().ok());
    let ready_only = query_param(cx, "ready").as_deref() == Some("true");
    let project = match project_by_slug(&slug) {
        Ok(project) => project,
        Err(error) => return err(StatusCode::NOT_FOUND, &error),
    };
    match commands::list(&state.layout, project, gate(), status, ready_only) {
        Ok(value) => ok(value),
        Err(error) => map_error(error, false),
    }
}

#[route(GET "/api/tasks/{slug}/{id}")]
pub async fn task(cx: &Cx) -> TcResult<ApiResponse> {
    let state = state();
    state.touch();
    let (Some(slug), Some(id)) = (slug_param(cx), id_param(cx)) else {
        return err(StatusCode::BAD_REQUEST, &Error::usage("missing slug or id"));
    };
    let project = match project_by_slug(&slug) {
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

#[route(POST "/api/tasks/{slug}/create")]
pub async fn create(cx: &Cx, Json(request): Json<CreateRequest>) -> TcResult<ApiResponse> {
    let state = state();
    state.touch();
    let Some(slug) = slug_param(cx) else {
        return err(StatusCode::BAD_REQUEST, &Error::usage("missing slug"));
    };
    let project = match project_by_slug(&slug) {
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

#[route(POST "/api/tasks/{slug}/{id}/move")]
pub async fn move_task(cx: &Cx, Json(request): Json<MoveRequest>) -> TcResult<ApiResponse> {
    let state = state();
    state.touch();
    let (Some(slug), Some(id)) = (slug_param(cx), id_param(cx)) else {
        return err(StatusCode::BAD_REQUEST, &Error::usage("missing slug or id"));
    };
    let project = match project_by_slug(&slug) {
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

#[route(POST "/api/tasks/{slug}/{id}/note")]
pub async fn note(cx: &Cx, Json(request): Json<NoteRequest>) -> TcResult<ApiResponse> {
    let state = state();
    state.touch();
    let (Some(slug), Some(id)) = (slug_param(cx), id_param(cx)) else {
        return err(StatusCode::BAD_REQUEST, &Error::usage("missing slug or id"));
    };
    let project = match project_by_slug(&slug) {
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

#[route(POST "/api/tasks/{slug}/{id}/edit")]
pub async fn edit(cx: &Cx, Json(request): Json<EditRequest>) -> TcResult<ApiResponse> {
    let state = state();
    state.touch();
    let (Some(slug), Some(id)) = (slug_param(cx), id_param(cx)) else {
        return err(StatusCode::BAD_REQUEST, &Error::usage("missing slug or id"));
    };
    let project = match project_by_slug(&slug) {
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

#[route(POST "/api/tasks/{slug}/{id}/link")]
pub async fn link(cx: &Cx, Json(request): Json<LinkRequest>) -> TcResult<ApiResponse> {
    link_impl(cx, request, false).await
}

#[route(POST "/api/tasks/{slug}/{id}/unlink")]
pub async fn unlink(cx: &Cx, Json(request): Json<LinkRequest>) -> TcResult<ApiResponse> {
    link_impl(cx, request, true).await
}

async fn link_impl(cx: &Cx, request: LinkRequest, remove: bool) -> TcResult<ApiResponse> {
    let state = state();
    state.touch();
    let (Some(slug), Some(id)) = (slug_param(cx), id_param(cx)) else {
        return err(StatusCode::BAD_REQUEST, &Error::usage("missing slug or id"));
    };
    let project = match project_by_slug(&slug) {
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

#[route(POST "/api/tasks/{slug}/{id}/order")]
pub async fn order(cx: &Cx, Json(request): Json<OrderRequest>) -> TcResult<ApiResponse> {
    let state = state();
    state.touch();
    let (Some(slug), Some(id)) = (slug_param(cx), id_param(cx)) else {
        return err(StatusCode::BAD_REQUEST, &Error::usage("missing slug or id"));
    };
    let project = match project_by_slug(&slug) {
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

#[route(POST "/api/tasks/{slug}/{id}/duplicate")]
pub async fn duplicate(cx: &Cx) -> TcResult<ApiResponse> {
    let state = state();
    state.touch();
    let (Some(slug), Some(id)) = (slug_param(cx), id_param(cx)) else {
        return err(StatusCode::BAD_REQUEST, &Error::usage("missing slug or id"));
    };
    let project = match project_by_slug(&slug) {
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
