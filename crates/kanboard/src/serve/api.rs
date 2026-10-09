//! JSON API. Every handler calls the same library functions the CLI uses, so
//! the UI cannot drift from the terminal rules.

use std::sync::Arc;

use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::commands::{self, task_json, Common, EditArgs, OrderTarget};
use crate::deps;
use crate::error::Error;
use crate::model::{Actor, ChainGate, Priority, Status};
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

/// Which web UI this binary embeds (`app` = the UniPi web build, `legacy` =
/// the deprecated kanboard UI) — UNI-117.
fn ui_info() -> Value {
    let version = super::assets::UI_VERSION;
    json!({
        "source": super::assets::UI_SOURCE,
        "version": if version.is_empty() { Value::Null } else { Value::String(version.to_string()) },
    })
}

pub async fn health(State(state): State<Arc<AppState>>) -> ApiResponse {
    // A remote bind must not leak the daemon's pid.
    if super::auth::is_loopback(&state.host) {
        ok(json!({
            "ok": true,
            "version": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
            "ui": ui_info(),
        }))
    } else {
        ok(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION"), "ui": ui_info() }))
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
    // No filter means every lane — the board and the API stay all-inclusive;
    // only the CLI's bare `list` narrows to the active lanes (UNI-62).
    let statuses: Vec<Status> = match query.status.as_deref() {
        Some(value) => match value.parse::<Status>() {
            Ok(status) => vec![status],
            Err(error) => return map_error(error, false),
        },
        None => Status::ALL.to_vec(),
    };
    let ready_only = query.ready.as_deref() == Some("true");
    let project = match project_by_slug(&state, &slug) {
        Ok(project) => project,
        Err(error) => return err(StatusCode::NOT_FOUND, &error),
    };
    match commands::list(&state.layout, project, gate(), &statuses, ready_only) {
        Ok(value) => ok(value),
        Err(error) => map_error(error, false),
    }
}

/// `GET /api/running` — every claimed task across all projects, for the
/// sidebar's global agent list. Each item carries the project (slug + name)
/// plus the full task JSON, so one fetch paints the whole list (UNI-51).
pub async fn running(State(state): State<Arc<AppState>>) -> ApiResponse {
    state.touch();
    let mut items: Vec<Value> = Vec::new();
    if let Ok(projects) = state.layout.list_projects() {
        for project in projects {
            if let Ok(board) = crate::board::Board::open(&state.layout, project.clone())
                && let Ok((tasks, _)) = board.state()
            {
                for task in tasks.iter().filter(|task| task.run.is_some()) {
                    items.push(json!({
                        "slug": project.slug,
                        "project": project.name,
                        "task": task_json(&board, task, &tasks, gate()),
                    }));
                }
            }
        }
    }
    ok(json!({ "running": items }))
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
    #[serde(default)]
    pub title: String,
    pub body: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    #[serde(default)]
    pub after: Vec<String>,
    #[serde(default)]
    pub labels: Vec<String>,
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
    // UNI-100's unknown-label refusal is a CLI/agent guard (`--new-label`
    // opts in); the web UI is a human picking from (or typing into) the
    // same label list and stays free to create one on the spot, as before.
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
        &request.labels,
        true,
    );
    match result {
        Ok(value) => {
            // Live updates must not depend on the file watcher: API writes
            // bump their project's revision themselves.
            state.bump(&slug);
            ok(value)
        }
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

    let result = commands::move_task_undoable(
        &state.layout,
        project,
        &common(),
        &id,
        to,
        request.comment.as_deref(),
        &[],
    );
    match result {
        Ok((mut value, undo)) => {
            // Hard-to-reverse user moves carry a one-shot undo token; the
            // snapshots live in daemon memory and expire (UNI-57).
            if let Some(undo) = undo {
                let token = state
                    .undo
                    .insert(&slug, &undo.after.id.clone(), undo.before, undo.after);
                if let Value::Object(ref mut map) = value {
                    map.insert("undoToken".into(), json!(token));
                }
            }
            state.bump(&slug);
            ok(value)
        }
        Err(error) => map_error(error, needs_comment),
    }
}

#[derive(Deserialize)]
pub struct UndoRequest {
    pub token: String,
}

/// `POST /api/tasks/{slug}/{id}/undo {token}` — restore the exact pre-move
/// task. The token is consumed atomically before any other check (reuse and
/// expiry both refuse), it must name this very task, and the task itself must
/// be byte-identical to its post-move state. User surface only: there is no
/// CLI undo (UNI-57).
pub async fn undo(
    State(state): State<Arc<AppState>>,
    Path((slug, id)): Path<(String, String)>,
    Json(request): Json<UndoRequest>,
) -> ApiResponse {
    state.touch();
    let entry = match state.undo.take(&request.token, &slug, &id) {
        Ok(entry) => entry,
        Err(crate::serve::undo::UndoRejection::Unknown) => {
            return err(
                StatusCode::CONFLICT,
                &Error::rule("that undo is no longer available (expired, used, or the daemon restarted)"),
            );
        }
        Err(crate::serve::undo::UndoRejection::Expired) => {
            return err(
                StatusCode::CONFLICT,
                &Error::rule("that undo expired — move the task back by hand"),
            );
        }
        Err(crate::serve::undo::UndoRejection::WrongTask) => {
            return err(
                StatusCode::CONFLICT,
                &Error::rule("this undo token belongs to a different move"),
            );
        }
    };
    let project = match project_by_slug(&state, &slug) {
        Ok(project) => project,
        Err(error) => return err(StatusCode::NOT_FOUND, &error),
    };
    match commands::undo_move(&state.layout, project, &common(), &entry.after, entry.before) {
        Ok(value) => {
            state.bump(&slug);
            ok(value)
        }
        // A refused undo is a stale-undo conflict, not a bad request.
        Err(error) => err(StatusCode::CONFLICT, &error),
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
        Ok(value) => {
            state.bump(&slug);
            ok(value)
        }
        Err(error) => map_error(error, false),
    }
}

#[derive(Deserialize)]
pub struct EditRequest {
    pub title: Option<String>,
    pub body: Option<String>,
    pub priority: Option<String>,
    pub labels: Option<Vec<String>>,
    /// Accepted only to be refused: the creator is written once at creation
    /// and never changes (UNI-59).
    #[serde(default)]
    pub creator: Option<String>,
}

pub async fn edit(
    State(state): State<Arc<AppState>>,
    Path((slug, id)): Path<(String, String)>,
    Json(request): Json<EditRequest>,
) -> ApiResponse {
    state.touch();
    if request.creator.is_some() {
        return err(
            StatusCode::BAD_REQUEST,
            &Error::rule("the creator of a task is set at creation and cannot be changed"),
        );
    }
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
        // UNI-100's unknown-label refusal is a CLI/agent guard; the web UI
        // keeps creating labels on the spot, as before.
        new_label: true,
    };
    match commands::edit(&state.layout, project, &common(), &id, args) {
        Ok(value) => {
            state.bump(&slug);
            ok(value)
        }
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
        Ok(value) => {
            state.bump(&slug);
            ok(value)
        }
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
        Ok(value) => {
            state.bump(&slug);
            ok(value)
        }
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
        Ok(value) => {
            state.bump(&slug);
            ok(value)
        }
        Err(error) => map_error(error, false),
    }
}

#[cfg(test)]
mod dashboard_tests {
    use super::{entered_status, excerpt_chars, first_non_empty_line, strip_markdown_images};
    use crate::model::Status;

    /// The single vocabulary mapping every dashboard derivation builds on —
    /// mirrors exactly what commands.rs writes (UNI-67).
    #[test]
    fn entered_status_reads_the_write_path_vocabulary() {
        assert_eq!(entered_status("finished: shipped the thing"), Some(Status::InReview));
        assert_eq!(entered_status("released to in_review: looks good"), Some(Status::InReview));
        assert_eq!(entered_status("released to todo: needs work"), Some(Status::Todo));
        assert_eq!(entered_status("moved in_review → done"), Some(Status::Done));
        assert_eq!(entered_status("moved in_review → done (bulk)"), Some(Status::Done));
        assert_eq!(entered_status("moved blocked → done: closed directly"), Some(Status::Done));
        assert_eq!(entered_status("moved todo → in_review"), Some(Status::InReview));
        assert_eq!(entered_status("blocked: what about the retry test?"), Some(Status::Blocked));
        assert_eq!(entered_status("unblocked: fixed in 4f2a"), Some(Status::Todo));
        assert_eq!(entered_status("rework: the fixture still fails"), Some(Status::Todo));
        assert_eq!(entered_status("cancelled"), Some(Status::Cancelled));
        assert_eq!(entered_status("cancelled: duplicate of T-2"), Some(Status::Cancelled));
        assert_eq!(entered_status("archived"), Some(Status::Archived));
        assert_eq!(entered_status("archived from done (bulk)"), Some(Status::Archived));
        assert_eq!(entered_status("undo: done → in_review (state restored)"), Some(Status::InReview));
        assert_eq!(entered_status("created in todo"), Some(Status::Todo));
        // Notes/edits/ordering are not transitions.
        assert_eq!(entered_status("edited title, body"), None);
        assert_eq!(entered_status("ordered (position 3000)"), None);
        assert_eq!(entered_status("keep me"), None);
        assert_eq!(entered_status("session lost: abc (pid 12) ended without releasing"), None);
    }

    #[test]
    fn excerpt_strips_images_takes_first_line_and_truncates() {
        assert_eq!(strip_markdown_images("before ![shot](att:x) after"), "before  after");
        assert_eq!(first_non_empty_line("\n\n  second line\nthird"), "second line");
        let long = format!("{}{}", "x".repeat(200), "![img](att:y)");
        let cut = excerpt_chars(&long, 160);
        assert_eq!(cut.chars().count(), 160);
        assert!(cut.ends_with('\u{2026}'));
        assert!(!cut.contains("!["));
        // A short summary passes through untouched.
        assert_eq!(excerpt_chars("finished: ship it\n\nnotes", 160), "finished: ship it");
    }
}

#[cfg(test)]
mod phrasing_tests {
    use super::*;

    #[test]
    fn parse_list_models_reads_the_table() {
        let out = r#"provider    model                                                  context  max-out  thinking  images
omniroute   antigravity/claude-opus-4-6-thinking                     1.0M     64K      yes       yes
openrouter  anthropic/claude-haiku-4.5                               200K     64K      yes       yes
"#;
        assert_eq!(
            super::parse_list_models(out),
            [
                "omniroute/antigravity/claude-opus-4-6-thinking",
                "openrouter/anthropic/claude-haiku-4.5"
            ]
        );
        // Noise lines and blanks are skipped, nothing is invented.
        assert!(
            super::parse_list_models(
                "  
not-a-table
"
            )
            .is_empty()
        );
    }

    #[test]
    fn unipi_model_cache_lists_chat_models_only() {
        let raw = r#"{"updatedAt":"x","models":[
            {"provider":"openrouter","id":"deepseek/v4-flash","kind":"chat"},
            {"provider":"openrouter","id":"black-forest-labs/flux.2-klein","kind":"images","output":["image"]},
            {"provider":"omniroute","id":"legacy-entry-without-kind"}
        ]}"#;
        assert_eq!(
            super::parse_unipi_model_cache(raw).unwrap(),
            ["openrouter/deepseek/v4-flash", "omniroute/legacy-entry-without-kind"]
        );
        assert!(super::parse_unipi_model_cache(r#"{"models":[]}"#).is_none());
        assert!(super::parse_unipi_model_cache("not json").is_none());
    }

    #[test]
    fn ui_messages_do_not_name_cli_flags() {
        let error = Error::rule("in_review → todo requires --comment (rework note)");
        assert_eq!(
            ui_message(&error),
            "in_review → todo requires a comment (rework note)"
        );
        // A message without a flag is untouched.
        let other = Error::rule("todo → in_progress is agent/system only — claim it with `start <ID>`");
        assert_eq!(ui_message(&other), other.to_string());
    }

    // ─── summarize prompt assembly ──────────────────────────────────────────

    fn task(id: &str, status: Status, activity: usize) -> crate::model::Task {
        let mut task = crate::model::Task::new(
            id.to_string(),
            format!("title {id}"),
            status,
            Priority::High,
            0,
            Utc::now(),
        );
        task.body = format!("body of {id}");
        for index in 0..activity {
            task.push_activity(Utc::now(), Actor::Agent, format!("entry {index}"));
        }
        task
    }

    #[test]
    fn summarize_done_scope_unchanged_shape() {
        let done = task("T-1", Status::Done, 2);
        let lanes = vec![(Status::Done, vec![&done])];
        let prompt = summarize_prompt("INSTR", None, None, &lanes, false, false, None);
        assert!(prompt.starts_with("INSTR\n\n"), "{prompt}");
        assert!(prompt.contains(crate::serve::settings::SUMMARY_STYLE), "{prompt}");
        // No lane headers or meta line in done scope; full activity.
        assert!(!prompt.contains("# done"), "{prompt}");
        assert!(!prompt.contains("priority:"), "{prompt}");
        assert_eq!(prompt.matches("entry ").count(), 2, "{prompt}");
        assert!(!prompt.contains("Previous summary"), "{prompt}");
    }

    #[test]
    fn summarize_board_scope_lanes_order_and_fields() {
        let todo = task("T-1", Status::Todo, 1);
        let done = task("T-9", Status::Done, 7);
        let backlog = task("B-2", Status::Backlog, 0);
        let lanes = vec![
            (Status::Backlog, vec![&backlog]),
            (Status::Todo, vec![&todo]),
            (Status::InProgress, vec![]),
            (Status::InReview, vec![]),
            (Status::Blocked, vec![]),
            (Status::Done, vec![&done]),
        ];
        let prompt = summarize_prompt("BOARD", None, None, &lanes, true, true, Some(BOARD_ACTIVITY_CAP));
        // Lane headers appear in board order, even empty ones.
        let order = |needle: &str| prompt.find(needle).unwrap_or(usize::MAX);
        assert!(
            order("# backlog") < order("# todo")
                && order("# todo") < order("# in_progress")
                && order("# in_progress") < order("# done"),
            "{prompt}"
        );
        // Per-task meta + body; activity capped at the last 5 entries.
        assert!(prompt.contains("status: todo · priority: high"), "{prompt}");
        assert!(prompt.contains("body of T-9"), "{prompt}");
        assert_eq!(prompt.matches("entry ").count(), 1 + BOARD_ACTIVITY_CAP, "{prompt}");
        assert!(!prompt.contains("entry 0\n") || prompt.contains("- "), "{prompt}");
        assert!(!prompt.contains("entry 1"), "last 5 of 7 → entries 2..6 only: {prompt}");
    }

    #[test]
    fn summarize_previous_and_note_block() {
        let done = task("T-1", Status::Done, 0);
        let lanes = vec![(Status::Done, vec![&done])];
        let prompt = summarize_prompt(
            "INSTR",
            Some("  OLD SUMMARY  "),
            Some("focus on bugs"),
            &lanes,
            false,
            false,
            None,
        );
        let block = "Previous summary:\nOLD SUMMARY\n\nThe user's note on it:\nfocus on bugs\n\nWrite an improved summary that follows the note.";
        assert!(prompt.contains(block), "{prompt}");
        // The block sits between the instruction head and the task list.
        assert!(
            prompt.find(block).unwrap() > prompt.find(crate::serve::settings::SUMMARY_STYLE).unwrap()
                && prompt.find(block).unwrap() < prompt.find("## T-1").unwrap(),
            "{prompt}"
        );
        // No note → "(none)".
        let bare = summarize_prompt("INSTR", Some("OLD"), None, &lanes, false, false, None);
        assert!(bare.contains("The user's note on it:\n(none)"), "{bare}");
        // Empty previous → no block at all.
        let empty = summarize_prompt("INSTR", Some("  "), None, &lanes, false, false, None);
        assert!(!empty.contains("Previous summary"), "{empty}");
    }
}

// ─── panel settings ─────────────────────────────────────────────────────────

fn settings_payload(state: &AppState) -> Value {
    let settings = super::settings::load(&state.layout);
    let pi = super::settings::effective_pi_settings();
    json!({
        "piCommand": settings.pi_command,
        "models": settings.models,
        "summaryModel": settings.summary_model,
        "summaryInstruction": settings.effective_instruction(),
        "defaultSummaryInstruction": super::settings::DEFAULT_SUMMARY_INSTRUCTION,
        // Key kept as `runner` for UI compatibility; these are the session
        // limits the agent works under (`start` session cap, `add` budget).
        "runner": {
            "maxSessions": pi.get("maxSessions"),
            "turnAddLimit": pi.get("turnAddLimit"),
            "chainGate": pi.get("chainGate"),
        },
        "archive": {
            "archiveAfterDays": pi.get("archiveAfterDays"),
            "retentionDays": pi.get("retentionDays"),
        },
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
    /// Flat patch of pi-side kanboard settings (validated per key).
    #[serde(flatten)]
    pub pi: serde_json::Map<String, serde_json::Value>,
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
        // The daemon's own catalog wins; the persisted copy is the fallback
        // when list-models cannot run right now.
        let whitelist = fetch_models(&state, false)
            .await
            .ok()
            .filter(|list| !list.is_empty())
            .unwrap_or_else(|| settings.models.clone());
        if !model.is_empty() && !whitelist.iter().any(|known| known == &model) {
            return err(
                StatusCode::BAD_REQUEST,
                &Error::rule("summary model must be one of the models pi reports"),
            );
        }
        settings.summary_model = model;
    }
    if let Some(instruction) = patch.summary_instruction {
        // Blank means "use the default" — stored as written, resolved on read.
        settings.summary_instruction = instruction;
    }
    let pi_patch = match super::settings::validate_pi_patch(&patch.pi) {
        Ok(p) => p,
        Err(message) => return err(StatusCode::BAD_REQUEST, &Error::usage(message)),
    };
    if !pi_patch.is_empty()
        && let Err(error) = super::settings::patch_pi_settings(&pi_patch)
    {
        return err(StatusCode::INTERNAL_SERVER_ERROR, &error);
    }
    match super::settings::save(&state.layout, &settings) {
        Ok(()) => ok(settings_payload(&state)),
        Err(error) => err(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

// ─── model catalog ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ModelsQuery {
    /// Any presence counts (`?refresh`, `?refresh=1`, `?refresh=true`).
    pub refresh: Option<serde_json::Value>,
}

/// `GET /api/models[?refresh=1]` — the pi runtime's own catalog
/// (`piCommand --list-models`), cached in memory for 10 minutes and persisted
/// to settings.json. The daemon owns this list now: it is the same runtime the
/// summarizer uses, not whatever the last pi session happened to see.
pub async fn models(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<ModelsQuery>,
) -> ApiResponse {
    state.touch();
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
    match fetch_models(&state, query.refresh.is_some()).await {
        Ok(list) => ok(json!({ "models": list })),
        Err((status, message)) => err(status, &Error::rule(message)),
    }
}

const MODEL_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(600);

/// The live model list. `force` bypasses the 10-minute cache; the single mutex
/// means concurrent callers share one `pi --list-models` run.
async fn fetch_models(
    state: &Arc<AppState>,
    force: bool,
) -> std::result::Result<Vec<String>, (StatusCode, String)> {
    let mut slot = state.model_cache.lock().await;
    if !force
        && let Some((at, list)) = slot.as_ref()
        && at.elapsed() < MODEL_CACHE_TTL
    {
        return Ok(list.clone());
    }
    // The shared unipi model cache (written by utility on every pi session
    // start) answers instantly; `pi --list-models` is the fallback and the
    // explicit refresh.
    if !force
        && let Some(list) = read_unipi_model_cache()
    {
        *slot = Some((Instant::now(), list.clone()));
        return Ok(list);
    }
    let settings = super::settings::load(&state.layout);
    if settings.pi_command.is_empty() {
        return Err((
            StatusCode::CONFLICT,
            "Open the board from pi once (/unipi:kanboard open) so it knows how to run pi"
                .to_string(),
        ));
    }
    let list = run_list_models(&settings).await?;
    if !list.is_empty() {
        // Persist what the runtime reported: the whitelist and offline reads
        // use the same file.
        let mut updated = super::settings::load(&state.layout);
        updated.models = list.clone();
        let _ = super::settings::save(&state.layout, &updated);
    }
    *slot = Some((Instant::now(), list.clone()));
    Ok(list)
}

/// `~/.unipi/config/models-cache.json` → chat-model `provider/id` rows.
/// `None` when the file is missing, unreadable or lists no chat models.
fn read_unipi_model_cache() -> Option<Vec<String>> {
    let home = std::env::var_os("HOME")?;
    let path = std::path::Path::new(&home).join(".unipi/config/models-cache.json");
    parse_unipi_model_cache(&std::fs::read_to_string(path).ok()?)
}

pub(crate) fn parse_unipi_model_cache(raw: &str) -> Option<Vec<String>> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let list: Vec<String> = parsed
        .get("models")?
        .as_array()?
        .iter()
        .filter(|m| m.get("kind").and_then(Value::as_str) != Some("images"))
        .filter_map(|m| {
            let provider = m.get("provider")?.as_str()?;
            let id = m.get("id")?.as_str()?;
            Some(format!("{provider}/{id}"))
        })
        .collect();
    (!list.is_empty()).then_some(list)
}

/// `piCommand --list-models` → `provider/id` rows. Output is a whitespace table
/// (`provider  model  context  max-out  thinking  images`); only the first two
/// columns matter.
fn parse_list_models(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let provider = fields.next()?;
            let model = fields.next()?;
            if provider == "provider" || model == "model" {
                return None; // header row
            }
            Some(format!("{provider}/{model}"))
        })
        .collect()
}

async fn run_list_models(
    settings: &super::settings::PanelSettings,
) -> std::result::Result<Vec<String>, (StatusCode, String)> {
    let mut argv = settings.pi_command.clone();
    argv.push("--list-models".into());
    let display = argv.join(" ");
    let child = tokio::process::Command::new(&argv[0])
        .args(&argv[1..])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            (
                StatusCode::BAD_GATEWAY,
                format!("could not start `{display}`: {error}"),
            )
        })?;
    let output = match tokio::time::timeout(Duration::from_secs(60), child.wait_with_output()).await
    {
        Ok(result) => result.map_err(|error| {
            (
                StatusCode::BAD_GATEWAY,
                format!("`{display}` failed: {error}"),
            )
        })?,
        Err(_) => {
            return Err((
                StatusCode::BAD_GATEWAY,
                format!("`{display}` did not finish within 60 seconds"),
            ));
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((
            StatusCode::BAD_GATEWAY,
            format!(
                "`{display}` failed: {}",
                stderr.trim().chars().take(400).collect::<String>()
            ),
        ));
    }
    Ok(parse_list_models(&String::from_utf8_lossy(&output.stdout)))
}

// ─── summarize & archive ────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SummarizeRequest {
    pub instruction: Option<String>,
    /// "done" (default — done lane only, unchanged behaviour) or "board"
    /// (every non-archived, non-cancelled task, grouped by lane).
    pub scope: Option<String>,
    /// A prior generated summary fed back in for an improved pass.
    pub previous: Option<String>,
    /// The user's note steering the (re)summary.
    pub note: Option<String>,
}

/// Board scope walks the visible flow minus cancelled/archived.
const SUMMARY_BOARD_LANES: [Status; 6] = [
    Status::Backlog,
    Status::Todo,
    Status::InProgress,
    Status::InReview,
    Status::Blocked,
    Status::Done,
];

/// Board scope without a user prompt.
const DEFAULT_BOARD_INSTRUCTION: &str =
    "Summarize the board: what is in each lane, what matters most next.";

/// Board prompts stay bounded: only the last few activity entries per task.
const BOARD_ACTIVITY_CAP: usize = 5;

/// One `## ID — title` task section. `with_meta` adds the status/priority line
/// (board scope); `activity_cap` trims to the last N entries when set.
fn summarize_task_section(
    task: &crate::model::Task,
    with_meta: bool,
    activity_cap: Option<usize>,
) -> String {
    let mut section = format!("## {} — {}\n\n", task.id, task.display_title());
    if with_meta {
        section.push_str(&format!(
            "status: {} · priority: {}\n\n",
            task.status.as_str(),
            task.priority.as_str()
        ));
    }
    if !task.body.trim().is_empty() {
        section.push_str(task.body.trim());
        section.push_str("\n\n");
    }
    let entries: &[crate::model::ActivityEntry] = match activity_cap {
        Some(cap) if task.activity.len() > cap => &task.activity[task.activity.len() - cap..],
        _ => &task.activity,
    };
    for entry in entries {
        section.push_str(&format!(
            "- {} [{}] {}\n",
            entry.at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            entry.actor.as_str(),
            entry.text
        ));
    }
    section.push('\n');
    section
}

/// `<instruction>\n\n<SUMMARY_STYLE>[\n\nPrevious summary block]\n\n<tasks>` —
/// the done scope renders identically to the original flat list.
fn summarize_prompt(
    instruction: &str,
    previous: Option<&str>,
    note: Option<&str>,
    lanes: &[(Status, Vec<&crate::model::Task>)],
    lane_headers: bool,
    with_meta: bool,
    activity_cap: Option<usize>,
) -> String {
    // The fixed style tail always applies — the editable part never carries it.
    let mut prompt = format!(
        "{}\n\n{}",
        instruction.trim(),
        super::settings::SUMMARY_STYLE
    );
    if let Some(previous) = previous.map(str::trim).filter(|text| !text.is_empty()) {
        let note = note
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .unwrap_or("(none)");
        prompt.push_str(&format!(
            "\n\nPrevious summary:\n{previous}\n\nThe user's note on it:\n{note}\n\nWrite an improved summary that follows the note."
        ));
    }
    prompt.push_str("\n\n");
    for (status, tasks) in lanes {
        if lane_headers {
            prompt.push_str(&format!("# {} ({})\n\n", status.as_str(), tasks.len()));
        }
        for task in tasks {
            prompt.push_str(&summarize_task_section(task, with_meta, activity_cap));
        }
    }
    prompt
}

// ─── dashboard (UNI-67) ─────────────────────────────────────────────────
//
// Read-only command-center feed for the Dashboard view. Everything derives
// from the SAME activity-text vocabulary the write path emits (see
// `commands::move_task_undoable` / `finish` / `release`): `finished: …`,
// `released to <status>: …`, `moved <from> → <to>[: note][ (bulk)]`,
// `blocked: …`, `unblocked: …`, `rework: …`, `cancelled[: note]`, `archived`
// and `undo: <to> → <from> …`. `entered_status` is the single place that
// maps a text to "the status this entry moved the task into".

/// The status an activity entry moved its task INTO, or None when the entry
/// is not a status transition (notes, edits, ordering, …).
pub(crate) fn entered_status(text: &str) -> Option<Status> {
    let text = text.trim();
    if text.starts_with("finished:") {
        return Some(Status::InReview);
    }
    if let Some(rest) = text.strip_prefix("released to ") {
        return rest.split(':').next()?.trim().parse().ok();
    }
    if text == "blocked" || text.starts_with("blocked:") {
        return Some(Status::Blocked);
    }
    if text == "unblocked" || text.starts_with("unblocked:") || text == "rework" || text.starts_with("rework:") {
        return Some(Status::Todo);
    }
    if text == "cancelled" || text.starts_with("cancelled:") {
        return Some(Status::Cancelled);
    }
    if text == "archived" || text.starts_with("archived ") || text.starts_with("archived:") {
        // The write path only emits these for archive moves — the tail is a
        // note ("… from done (bulk)", "… automatically after N days"), not a
        // parseable status.
        return Some(Status::Archived);
    }
    if let Some(rest) = text.strip_prefix("moved ") {
        // `moved <from> → <to>` / `… : note` / `… (bulk)`.
        let to = rest.rsplit(" → ").next()?.trim();
        let to = to.split(':').next()?.trim();
        let to = to.strip_suffix(" (bulk)").unwrap_or(to);
        return to.parse().ok();
    }
    if let Some(rest) = text.strip_prefix("undo: ") {
        // `undo: <to> → <from> (state restored)` — the task moved back to from.
        let from = rest.rsplit(" → ").next()?.split(" (").next()?.trim();
        return from.parse().ok();
    }
    if let Some(rest) = text.strip_prefix("created in ") {
        return rest.split_whitespace().next()?.parse().ok();
    }
    None
}

/// The latest activity entry that moved `task` INTO `status`.
fn transition_into(task: &crate::model::Task, status: Status) -> Option<&crate::model::ActivityEntry> {
    task.activity
        .iter()
        .rev()
        .find(|entry| entered_status(&entry.text) == Some(status))
}

/// First line that carries text.
fn first_non_empty_line(text: &str) -> &str {
    text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("")
}

/// Strip the transition prefix so the excerpt is just what the agent said:
/// `blocked: <question>`, `released to blocked: <question>`,
/// `finished: <summary>`, `released to in_review: <summary>`.
fn strip_transition_prefix(text: &str) -> &str {
    let text = text.trim();
    if let Some(rest) = text.strip_prefix("released to ") {
        return rest.split_once(':').map(|(_, rest)| rest.trim()).unwrap_or(rest);
    }
    for prefix in ["blocked:", "finished:"] {
        if let Some(rest) = text.strip_prefix(prefix) {
            return rest.trim();
        }
    }
    text
}

/// Remove markdown image embeds (`![alt](url)`) — they never read well in a
/// one-line excerpt.
fn strip_markdown_images(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("![") {
        out.push_str(&rest[..at]);
        let after = &rest[at + 2..];
        match after.find("](") {
            Some(close) => match after[close + 2..].find(')') {
                Some(end) => {
                    rest = &after[close + 2 + end + 1..];
                }
                None => {
                    out.push_str(&rest[at..at + 2]);
                    rest = after;
                }
            },
            None => {
                out.push_str(&rest[at..at + 2]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Char-safe cut with an ellipsis.
fn excerpt_chars(text: &str, max: usize) -> String {
    let trimmed = strip_markdown_images(first_non_empty_line(text)).trim().to_string();
    if trimmed.chars().count() <= max {
        return trimmed;
    }
    let cut: String = trimmed.chars().take(max.saturating_sub(1)).collect();
    format!("{cut}\u{2026}")
}

/// `GET /api/dashboard` — read-only command-center payload for the Dashboard
/// view: what needs the user (in_review/blocked with wait ages), what an
/// agent would pick next, live activity, throughput and per-project health.
/// Archived projects are excluded (UNI-67).
pub async fn dashboard(State(state): State<Arc<AppState>>) -> ApiResponse {
    state.touch();
    let now = Utc::now();
    let activity_window = chrono::Duration::hours(48);
    let throughput_window = chrono::Duration::days(14);

    let mut inbox: Vec<Value> = Vec::new();
    let mut up_next: Vec<Value> = Vec::new();
    let mut up_next_before_cap = 0usize;
    // Newest first; equal timestamps keep per-task chronological order via
    // the push sequence (a stable at-only sort would leave same-second
    // clusters oldest-first and reverse the dashboard's step trails).
    let mut activity: Vec<(chrono::DateTime<Utc>, u64, Value)> = Vec::new();
    let mut activity_seq: u64 = 0;
    let mut done_at: Vec<String> = Vec::new();
    let mut review_waits: Vec<i64> = Vec::new();
    let mut projects: Vec<Value> = Vec::new();

    if let Ok(projects_list) = state.layout.list_projects() {
        for project in projects_list {
            if project.archived {
                continue;
            }
            let Ok(board) = crate::board::Board::open(&state.layout, project.clone()) else {
                continue;
            };
            let Ok((tasks, problems)) = board.state() else {
                continue;
            };
            let by_id = board.dep_lookup(&tasks);
            let gate = gate();
            let mut review = 0usize;
            let mut blocked = 0usize;
            let mut ready = 0usize;
            let mut last_activity: Option<chrono::DateTime<Utc>> = None;

            for task in &tasks {
                last_activity = Some(last_activity.map_or(task.updated, |latest| latest.max(task.updated)));
                match task.status {
                    Status::InReview | Status::Blocked => {
                        if task.status == Status::InReview {
                            review += 1;
                        } else {
                            blocked += 1;
                        }
                        let entry = transition_into(task, task.status);
                        let waiting_since = entry.map(|entry| entry.at).unwrap_or(task.updated);
                        // An undo re-entered the status without carrying the
                        // agent's words — fall back to the previous real
                        // transition into the same status for the excerpt.
                        let excerpt_entry = match entry {
                            Some(entry) if entry.text.starts_with("undo:") => task
                                .activity
                                .iter()
                                .rev()
                                .skip_while(|candidate| candidate.at != entry.at)
                                .skip(1)
                                .find(|candidate| {
                                    !candidate.text.starts_with("undo:")
                                        && entered_status(&candidate.text) == Some(task.status)
                                })
                                .or(Some(entry)),
                            other => other,
                        };
                        let excerpt = match task.status {
                            Status::Blocked | Status::InReview => {
                                excerpt_entry.map(|entry| excerpt_chars(strip_transition_prefix(&entry.text), 160))
                            }
                            _ => None,
                        };
                        inbox.push(json!({
                            "slug": project.slug,
                            "project": project.name,
                            "task": task_json(&board, task, &tasks, gate),
                            "waitingSince": crate::format::iso(waiting_since),
                            "excerpt": excerpt,
                        }));
                    }
                    Status::Todo => {
                        let is_ready = deps::is_ready(task, &by_id, gate);
                        if is_ready {
                            ready += 1;
                        }
                        if is_ready && task.run.is_none() {
                            up_next_before_cap += 1;
                            up_next.push(json!({
                                "slug": project.slug,
                                "project": project.name,
                                "task": task_json(&board, task, &tasks, gate),
                            }));
                        }                    }
                    _ => {}
                }

                // Done events, revert-aware: an `undo: done → …` after a
                // transition into done means that done never happened — drop
                // the recorded stamp (UNI-67 rework).
                let mut done_stamps: Vec<chrono::DateTime<Utc>> = Vec::new();
                for entry in &task.activity {
                    if entered_status(&entry.text) == Some(Status::Done) {
                        done_stamps.push(entry.at);
                    } else if let Some(rest) = entry.text.trim().strip_prefix("undo: ") {
                        let reverted = rest.split(" → ").next().unwrap_or("").trim();
                        if reverted.parse::<Status>().is_ok_and(|status| status == Status::Done) {
                            done_stamps.pop();
                        }
                    }
                }
                for entry in &task.activity {
                    if now - entry.at <= activity_window {
                        activity_seq += 1;
                        activity.push((
                            entry.at,
                            activity_seq,
                            json!({
                                "slug": project.slug,
                                "project": project.name,
                                "taskId": task.id,
                                "title": task.display_title(),
                                "at": crate::format::iso(entry.at),
                                "actor": entry.actor.as_str(),
                                "session": entry.session,
                                "text": entry.text,
                            }),
                        ));
                    }
                }
                done_at.extend(
                    done_stamps
                        .into_iter()
                        .filter(|at| now - *at <= throughput_window)
                        .map(crate::format::iso),
                );

                // Completed review cycles: entering in_review, next status
                // transition leaving it, exit within the window.
                for (index, entry) in task.activity.iter().enumerate() {
                    if entered_status(&entry.text) != Some(Status::InReview) {
                        continue;
                    }
                    let exit = task.activity[index + 1..].iter().find(|later| {
                        let left = entered_status(&later.text);
                        left.is_some() && left != Some(Status::InReview)
                    });
                    if let Some(exit) = exit
                        && now - exit.at <= throughput_window
                    {
                        review_waits.push((exit.at - entry.at).num_seconds().max(0));
                    }
                }
            }

            projects.push(json!({
                "slug": project.slug,
                "review": review,
                "blocked": blocked,
                "ready": ready,
                "lastActivity": last_activity.map(crate::format::iso),
                "problems": problems.len(),
            }));
        }
    }

    inbox.sort_by_key(|item| {
        item["waitingSince"]
            .as_str()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .unwrap_or(now.into())
    });
    up_next.sort_by(|a, b| {
        let rank = |item: &Value| -> u8 {
            item["task"]["priority"]
                .as_str()
                .and_then(|value| value.parse::<Priority>().ok())
                .unwrap_or(Priority::None)
                .rank()
        };
        let order = |item: &Value| -> i64 { item["task"]["order"].as_i64().unwrap_or(0) };
        let created = |item: &Value| -> chrono::DateTime<Utc> {
            item["task"]["created"]
                .as_str()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .map(|value| value.with_timezone(&Utc))
                .unwrap_or(now)
        };
        // Urgent first, then lane order, then creation (UNI-67).
        rank(b)
            .cmp(&rank(a))
            .then_with(|| order(a).cmp(&order(b)))
            .then_with(|| created(a).cmp(&created(b)))
    });
    up_next.truncate(8);
    let ready_total = up_next_before_cap;

    activity.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    activity.truncate(60);
    let activity: Vec<Value> = activity.into_iter().map(|(_, _, value)| value).collect();

    done_at.sort();
    review_waits.sort_unstable();

    ok(json!({
        "generatedAt": crate::format::iso(now),
        "inbox": inbox,
        "upNext": up_next,
        "readyTotal": ready_total,
        "activity": activity,
        "doneAt": done_at,
        "reviewWaits": review_waits,
        "projects": projects,
    }))
}

/// `POST /api/projects/{slug}/summarize` — run the configured agent over the
/// done tasks (default) or the whole board (`scope: "board"`): prompt on
/// stdin, summary on stdout. Board scope summarizes only — no archive action.
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
    let scope = request
        .scope
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("done");
    if scope != "done" && scope != "board" {
        return err(
            StatusCode::BAD_REQUEST,
            &Error::usage(format!("scope must be done or board, not `{scope}`")),
        );
    }
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

    let all: Vec<crate::model::Task> =
        match crate::board::Board::open(&state.layout, project.clone())
            .and_then(|board| board.tasks())
        {
            Ok(tasks) => tasks,
            Err(error) => return err(StatusCode::INTERNAL_SERVER_ERROR, &error),
        };
    let board_scope = scope == "board";
    let lanes: Vec<(Status, Vec<&crate::model::Task>)> = if board_scope {
        SUMMARY_BOARD_LANES
            .iter()
            .map(|status| {
                (
                    *status,
                    all.iter().filter(|task| task.status == *status).collect(),
                )
            })
            .collect()
    } else {
        vec![
            (
                Status::Done,
                all.iter().filter(|task| task.status == Status::Done).collect(),
            ),
        ]
    };
    let total = lanes.iter().map(|(_, tasks)| tasks.len()).sum::<usize>();
    if total == 0 {
        return err(
            StatusCode::BAD_REQUEST,
            &Error::rule(if board_scope {
                "no tasks to summarize"
            } else {
                "no done tasks to summarize"
            }),
        );
    }

    // Board scope takes the user's prompt (instruction, else note) or the
    // board default; done scope keeps the configured instruction.
    let instruction = request
        .instruction
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .or_else(|| {
            board_scope
                .then(|| request.note.as_deref().map(str::trim).filter(|t| !t.is_empty()))
                .flatten()
        })
        .unwrap_or_else(|| {
            if board_scope {
                DEFAULT_BOARD_INSTRUCTION
            } else {
                settings.effective_instruction()
            }
        });
    let prompt = summarize_prompt(
        instruction,
        request.previous.as_deref(),
        request.note.as_deref(),
        &lanes,
        board_scope,
        board_scope,
        board_scope.then_some(BOARD_ACTIVITY_CAP),
    );
    let task_ids: Vec<String> = lanes
        .iter()
        .flat_map(|(_, tasks)| tasks.iter().map(|task| task.id.clone()))
        .collect();

    match run_agent(&settings, &prompt, &project, &state.layout).await {
        Ok(summary) => ok(json!({
            "summary": summary,
            "taskIds": task_ids,
        })),
        Err((status, message)) => err(status, &Error::rule(message)),
    }
}

/// Spawn pi ambient (`piCommand -p --no-session --no-tools --no-skills
/// --no-context-files --no-prompt-templates --no-themes [--model <summaryModel>]`), feed
/// `prompt` to its stdin, collect stdout. Ten minutes is generous on purpose —
/// a real model can think for a while; a hung one still gets killed.
async fn run_agent(
    settings: &super::settings::PanelSettings,
    prompt: &str,
    project: &Project,
    layout: &crate::store::Layout,
) -> std::result::Result<String, (StatusCode, String)> {
    use tokio::io::AsyncWriteExt;

    // Ambient: the same runtime the user drives — extensions load so bridge
    // providers (omniroute & co.) work for summaries too. The child env marks
    // it as ours so the kanboard extension stays out of its way.
    let mut argv = settings.pi_command.clone();
    argv.extend([
        "-p".into(),
        "--no-session".into(),
        "--no-tools".into(),
        "--no-skills".into(),
        "--no-context-files".into(),
        "--no-prompt-templates".into(),
        "--no-themes".into(),
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
        .env("UNIPI_KANBOARD_CHILD", "1")
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

/// `POST /api/projects/{slug}/done-lane` — one-click "Done all" on In Review.
pub async fn done_lane(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> ApiResponse {
    state.touch();
    let project = match project_by_slug(&state, &slug) {
        Ok(project) => project,
        Err(error) => return err(StatusCode::NOT_FOUND, &error),
    };
    match commands::review_done(&state.layout, project, Utc::now()) {
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
