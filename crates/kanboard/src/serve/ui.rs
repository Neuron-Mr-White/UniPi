//! Server-rendered UI: project picker, board, card drawer, and the two static
//! assets (inlined from `assets/` at compile time — no bundling step).

use std::collections::HashMap;

use topcoat::{
    Result as TcResult,
    context::Cx,
    router::{
        content::{Css, Js},
        page, route,
        Router, RouterBuilderDiscoverExt,
    },
    view::{component, view, View, ViewHandle, ViewExt},
};

use crate::commands;
use crate::model::{Status, Task};
use crate::store::{self, Project};

use super::api::{gate, id_param, slug_param};
use super::state;

const CSS: &str = include_str!("../../assets/kanboard.css");
const JS: &str = include_str!("../../assets/kanboard.js");

/// Lanes the board renders, in order. Archive is hidden until toggled.
pub const LANES: [(Status, &str); 8] = [
    (Status::Backlog, "Backlog"),
    (Status::Todo, "Todo"),
    (Status::InProgress, "In Progress"),
    (Status::InReview, "In Review"),
    (Status::Blocked, "Blocked"),
    (Status::Done, "Done"),
    (Status::Cancelled, "Cancelled"),
    (Status::Archived, "Archive"),
];

pub fn router() -> Router {
    Router::builder().discover().build()
}

#[route(GET "/kanboard.css")]
pub async fn stylesheet() -> TcResult<Css<&'static str>> {
    Ok(Css(CSS))
}

#[route(GET "/kanboard.js")]
pub async fn script() -> TcResult<Js<&'static str>> {
    Ok(Js(JS))
}

// ─── pages ──────────────────────────────────────────────────────────────────

#[page("/")]
async fn picker() -> TcResult<impl View> {
    let state = state();
    state.touch();
    let projects = state.layout.list_projects().unwrap_or_default();
    let cards: Vec<ProjectCard> = projects
        .iter()
        .map(|project| {
            let mut counts = Vec::new();
            let mut total = 0usize;
            if let Ok(opened) = crate::board::Board::open(&state.layout, project.clone())
                && let Ok(tasks) = opened.tasks()
            {
                total = tasks.len();
                for status in Status::VISIBLE {
                    let count = tasks.iter().filter(|card| card.status == status).count();
                    if count > 0 {
                        counts.push((status.as_str().to_string(), count));
                    }
                }
            }
            ProjectCard {
                slug: project.slug.clone(),
                name: project.name.clone(),
                root: project.root.to_string_lossy().to_string(),
                counts,
                total,
            }
        })
        .collect();

    Ok(view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>"Kanboard — projects"</title>
                <link rel="stylesheet" href="/kanboard.css">
            </head>
            <body>
                <div class="topbar"><h1>"Kanboard"</h1><span class="spacer"></span>
                    <span class="meta">"pick a project"</span>
                </div>
                <div class="picker">
                    if cards.is_empty() {
                        <p class="empty">"No projects yet — register one with `unipi-kanboard project add`."</p>
                    } else {
                        for card in cards {
                            <a class="project" href=(format!("/p/{}", card.slug))>
                                <span>
                                    <span class="name">(card.name)</span><br>
                                    <span class="root">(card.root)</span>
                                </span>
                                <span class="counts">
                                    <span class="chip">(format!("{} tasks", card.total))</span>
                                    for (lane, count) in card.counts {
                                        <span class="chip">(format!("{lane} {count}"))</span>
                                    }
                                </span>
                            </a>
                        }
                    }
                </div>
            </body>
        </html>
    })
}

struct ProjectCard {
    slug: String,
    name: String,
    root: String,
    counts: Vec<(String, usize)>,
    total: usize,
}

#[page("/p/{slug}")]
async fn board_page(cx: &Cx) -> TcResult<impl View> {
    let state = state();
    state.touch();
    let slug = slug_param(cx).unwrap_or_default();
    let project = store::Project::load(&state.layout, &slug).ok();
    let shell = Shell {
        slug: slug.clone(),
        name: project.as_ref().map(|p| p.name.clone()).unwrap_or_else(|| slug.clone()),
        prefix: project.as_ref().map(|p| p.prefix.clone()).unwrap_or_default(),
        root: project
            .as_ref()
            .map(|p| p.root.to_string_lossy().to_string())
            .unwrap_or_default(),
    };

    Ok(view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>(format!("Kanboard — {}", shell.name))</title>
                <link rel="stylesheet" href="/kanboard.css">
            </head>
            <body data-project=(shell.slug.clone())>
                <div class="topbar">
                    <a class="btn" href="/">"← projects"</a>
                    <h1>(shell.name.clone())</h1>
                    <span class="meta">(shell.prefix.clone())</span>
                    <span class="spacer"></span>
                    if project.is_some() {
                        <button data-toggle-archive="true">"Show archive"</button>
                        <span class="meta">(shell.root.clone())</span>
                    }
                </div>
                if project.is_some() {
                    <div class="board" id="board">board_body(project: project.as_ref())</div>
                    <aside class="drawer" id="drawer" hidden="hidden"></aside>
                    <div class="modal" id="comment-modal" hidden="hidden">
                        <div class="sheet">
                            <p class="prompt"></p>
                            <textarea placeholder="why? (this comment is what the next reader sees)"></textarea>
                            <div class="actions">
                                <button class="cancel">"Cancel"</button>
                                <button class="save primary">"Save & continue"</button>
                            </div>
                        </div>
                    </div>
                    <div id="toasts"></div>
                    <script src="/kanboard.js"></script>
                } else {
                    <p class="empty">(format!("No project registered for \"{}\"", shell.slug))</p>
                }
            </body>
        </html>
    })
}

struct Shell {
    slug: String,
    name: String,
    prefix: String,
    root: String,
}

// ─── fragments ──────────────────────────────────────────────────────────────

#[component]
async fn card_view(task: Task, waiting: Vec<String>) -> TcResult<impl View> {
    let running = task.status == Status::InProgress;
    let stale = is_stale(&task);
    let prio = task.priority.as_str();
    let deps = task.deps.clone();
    let run = task.run.clone();
    let id = task.id.clone();
    let title = task.title.clone();

    Ok(view! {
        <article
            class="card"
            if running { class="card running-card" }
            draggable=(if running { "false" } else { "true" })
            data-id=(id.clone())
            data-running=(if running { "true" } else { "false" })
        >
            <span class="id">(id.clone())</span>
            <span class="title">(title)</span>
            <span class="flags">
                if prio != "none" {
                    <span class=(format!("prio {prio}"))>(prio)</span>
                }
                if !deps.is_empty() {
                    if waiting.is_empty() {
                        <span class="dep">(format!("after {}", deps.join(", ")))</span>
                    } else {
                        <span class="dep waiting">(format!("waiting on {}", waiting.len()))</span>
                    }
                }
                if let Some(run) = run {
                    <span class="running"><span class="dot"></span>(format!("{} · {}", run.session, run.mode))</span>
                }
                if stale {
                    <span class="stale">"stale run"</span>
                }
            </span>
        </article>
    })
}

#[route(GET "/p/{slug}/board")]
async fn board_fragment_route(cx: &Cx) -> TcResult<ViewHandle> {
    let state = state();
    state.touch();
    let slug = slug_param(cx).unwrap_or_default();
    let project = store::Project::load(&state.layout, &slug).ok();
    view! { cx => board_body(project: project.as_ref()) }.single().await
}

#[component]
async fn board_body(project: Option<&Project>) -> TcResult<impl View> {
    let state = state();
    let tasks: Vec<Task> = project
        .and_then(|project| crate::board::Board::open(&state.layout, project.clone()).ok())
        .and_then(|board| board.tasks().ok())
        .unwrap_or_default();
    let by_id: HashMap<String, Task> = tasks.iter().map(|task| (task.id.clone(), task.clone())).collect();

    Ok(view! {
        <div class="board">
            if project.is_none() {
                <p class="empty">"Project not found."</p>
            } else {
                for (status, label) in LANES {
                    <section class="lane" data-lane=(status.as_str()) if status == Status::Archived { hidden="hidden" }>
                        <h2>(label) " " <span class="count">(lane_count(&tasks, status))</span></h2>
                        if status == Status::Backlog || status == Status::Todo {
                            <div class="quick-add">
                                <input placeholder=(format!("add to {label}…")) aria-label=(format!("add to {label}"))>
                            </div>
                        }
                        <div class="cards">
                            for task in lane_tasks(&tasks, status) {
                                card_view(task: task.clone(), waiting: waiting_for(&task, &by_id))
                            }
                        </div>
                    </section>
                }
            }
        </div>
    })
}

#[route(GET "/p/{slug}/card/{id}")]
async fn card_drawer(cx: &Cx) -> TcResult<ViewHandle> {
    let state = state();
    state.touch();
    let slug = slug_param(cx).unwrap_or_default();
    let id = id_param(cx).unwrap_or_default();
    let project = store::Project::load(&state.layout, &slug).ok();
    let task = project
        .as_ref()
        .and_then(|project| commands::show(&state.layout, project.clone(), &id, gate()).ok())
        .and_then(|value| serde_json::from_value::<Task>(value).ok());
    view! { cx => drawer_view(task: task.as_ref()) }.single().await
}

#[component]
async fn drawer_view(task: Option<&Task>) -> TcResult<impl View> {
    Ok(view! {
        if let Some(task) = task {
            <header>
                <span class="id">(task.id.clone())</span>
                <span class="grow">(format!("{}", task.status))</span>
                if is_stale(task) {
                    <span class="stale">"stale run"</span>
                }
                <button data-close-drawer="true">"✕"</button>
            </header>
            if let Some(run) = task.run.clone() {
                <p class="meta">(format!(
                    "running · session {} · mode {} · pid {} on {}",
                    run.session, run.mode, run.pid, run.host
                ))</p>
            }
            <form data-form="edit" data-id=(task.id.clone())>
                <label>"Title"</label>
                <input name="title" value=(task.title.clone())>
                <label>"Body"</label>
                <textarea name="body">(task.body.clone())</textarea>
                <label>"Priority"</label>
                <select name="priority">
                    for option in ["none", "low", "medium", "high", "urgent"] {
                        <option value=(option) if option == task.priority.as_str() { selected="selected" }>(option)</option>
                    }
                </select>
                <div class="row"><button class="primary" type="submit">"Save"</button></div>
            </form>

            <form data-form="link" data-id=(task.id.clone())>
                <label>"Dependencies"</label>
                <ul class="deps">
                    for dep in task.deps.clone() {
                        <li>
                            (dep.clone())
                            <button type="button" data-act="unlink" data-id=(task.id.clone()) data-dep=(dep.clone())>"✕"</button>
                        </li>
                    }
                </ul>
                <div class="row">
                    <input name="dep" placeholder=(format!("{} number", task.id.split('-').next().unwrap_or("")))>
                    <button type="submit">"Add"</button>
                </div>
            </form>

            <form data-form="note" data-id=(task.id.clone())>
                <label>"Comment"</label>
                <textarea name="note" placeholder="notes, blocker answers, results…"></textarea>
                <div class="row"><button class="primary" type="submit">"Add comment"</button></div>
            </form>

            <div class="row">
                <button data-act="duplicate" data-id=(task.id.clone())>"Duplicate"</button>
                if can_cancel(task) {
                    <button data-act="move" data-id=(task.id.clone()) data-status="cancelled">"Cancel task"</button>
                }
                if can_archive(task) {
                    <button data-act="archive" data-id=(task.id.clone())>"Archive"</button>
                }
            </div>

            <h2>"Activity"</h2>
            <ul class="activity">
                for entry in task.activity.iter().rev().take(20) {
                    <li>
                        <span class="when">(crate::format::iso(entry.at))</span>
                        <span class="actor">(format!("[{}]", entry.actor))</span>
                        <br>
                        (entry.text.clone())
                    </li>
                }
            </ul>
        } else {
            <header><span class="grow">"Card not found"</span><button data-close-drawer="true">"✕"</button></header>
        }
    })
}

// ─── helpers ────────────────────────────────────────────────────────────────

fn is_stale(task: &Task) -> bool {
    task.status == Status::InProgress
        && crate::commands::staleness_of(task) != crate::model::Staleness::Running
}

fn can_cancel(task: &Task) -> bool {
    crate::transitions::rule_for(task.status, Status::Cancelled)
        .map(|rule| rule.actors.contains(&crate::model::Actor::User))
        .unwrap_or(false)
}

fn can_archive(task: &Task) -> bool {
    crate::transitions::rule_for(task.status, Status::Archived)
        .map(|rule| rule.actors.contains(&crate::model::Actor::User))
        .unwrap_or(false)
}

fn lane_tasks(tasks: &[Task], status: Status) -> Vec<Task> {
    let mut lane: Vec<Task> = tasks.iter().filter(|task| task.status == status).cloned().collect();
    lane.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    lane
}

fn lane_count(tasks: &[Task], status: Status) -> usize {
    tasks.iter().filter(|task| task.status == status).count()
}

/// Dep ids that have not reached the chain gate (the "waiting on N" badge).
fn waiting_for(task: &Task, by_id: &HashMap<String, Task>) -> Vec<String> {
    let lookup = |id: &str| by_id.get(id).cloned();
    crate::deps::blocked_by(task, &lookup, gate())
        .map(|blocked| blocked.pending.iter().map(|(id, _)| id.clone()).collect())
        .unwrap_or_default()
}
