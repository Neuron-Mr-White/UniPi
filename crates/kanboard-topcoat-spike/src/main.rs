//! Throwaway spike: a two-lane board served by Topcoat.
//!
//! Answers five questions for kanboard v3 (see SPIKE-FINDINGS.md):
//!   (a) can we choose the listener / embed it in an app we own?
//!   (b) drag between lanes?
//!   (c) live updates pushed from the server when files change?
//!   (d) a single static binary without extra assets / build steps?
//!   (e) binary size and compile time?
//!
//! Deliberately does NOT use the `runtime` + `asset` features (which need the
//! Topcoat CLI's asset bundle): reactivity below is plain JS over a
//! server-rendered HTML fragment, which is the (d) question in one line.

use std::future::Future;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::stream::{self, Stream, StreamExt};
use serde::Deserialize;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use topcoat::{
    context::Cx,
    router::{
        content::{
            sse::{Event, KeepAlive, Sse},
            Json,
        },
        page, route, Router, RouterBuilderDiscoverExt,
    },
    view::{component, view, View, ViewExt, ViewHandle},
    Result,
};

#[derive(Clone, serde::Serialize)]
struct Card {
    id: u32,
    title: String,
    lane: String,
}

static LANES: [(&str, &str); 2] = [("todo", "Todo"), ("in_progress", "In Progress")];
static BOARD: OnceLock<Mutex<Vec<Card>>> = OnceLock::new();
static REV: AtomicI64 = AtomicI64::new(0);
static TX: OnceLock<broadcast::Sender<i64>> = OnceLock::new();

fn board() -> &'static Mutex<Vec<Card>> {
    BOARD.get_or_init(|| {
        Mutex::new(vec![
            Card { id: 1, title: "Wire the SSE stream".into(), lane: "todo".into() },
            Card { id: 2, title: "Card detail drawer".into(), lane: "todo".into() },
            Card { id: 3, title: "Fix the footer".into(), lane: "in_progress".into() },
        ])
    })
}

/// Bump the revision and tell every SSE client.
fn bump() {
    let rev = REV.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(tx) = TX.get() {
        let _ = tx.send(rev);
    }
}

// ─── views ──────────────────────────────────────────────────────────────────

#[component]
async fn lanes() -> Result<impl View> {
    let cards = board().lock().expect("board").clone();
    Ok(view! {
        <div class="lanes">
            for (key, label) in LANES {
                <section class="lane" data-lane=(key)>
                    <h2>(label)</h2>
                    <div class="dropzone">
                        for card in cards.iter().filter(|card| card.lane == key).cloned() {
                            <article class="card" draggable="true" data-id=(card.id)>
                                <span class="id">"KS-" (card.id)</span>
                                <span class="title">(card.title)</span>
                            </article>
                        }
                    </div>
                </section>
            }
        </div>
    })
}

const CLIENT_JS: &str = r#"
const board = () => document.getElementById('board');
function swap(html) { board().innerHTML = html; }
function post(id, lane) {
  fetch('/move', { method: 'POST', headers: { 'content-type': 'application/json' },
                   body: JSON.stringify({ id: Number(id), lane: lane }) })
    .then(r => r.text()).then(swap);
}
document.addEventListener('dragstart', e => {
  const card = e.target.closest('.card'); if (card) e.dataTransfer.setData('text/plain', card.dataset.id);
});
for (const zone of document.querySelectorAll('.lane')) {
  zone.addEventListener('dragover', e => e.preventDefault());
  zone.addEventListener('drop', e => { e.preventDefault(); post(e.dataTransfer.getData('text/plain'), zone.dataset.lane); });
}
// Live updates: the server tells us when the board changed; we refetch the fragment.
const events = new EventSource('/events');
events.onmessage = () => fetch('/board').then(r => r.text()).then(swap);
"#;

const CLIENT_CSS: &str = r#"
body { font: 14px/1.4 system-ui, sans-serif; margin: 2rem; }
.lanes { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.lane { border: 1px solid #ccc; border-radius: 8px; padding: .5rem 1rem 1rem; min-height: 8rem; }
.dropzone { min-height: 5rem; display: flex; flex-direction: column; gap: .5rem; }
.card { border: 1px solid #999; border-radius: 6px; padding: .5rem; background: #fafafa; cursor: grab; }
.card .id { color: #888; margin-right: .5rem; }
.lane.dragover { border-color: #4a8; }
"#;

#[page("/")]
async fn board_page() -> Result<impl View> {
    Ok(view! {
        <!DOCTYPE html>
        <html>
            <head>
                <title>"Kanboard spike"</title>
                <style>(CLIENT_CSS)</style>
            </head>
            <body>
                <h1>"Kanboard spike — 2 lanes"</h1>
                <div id="board">lanes()</div>
                <script>(CLIENT_JS)</script>
            </body>
        </html>
    })
}

/// The fragment the client swaps in after a move (server-rendered HTML).
#[route(GET "/board")]
async fn board_fragment(cx: &Cx) -> Result<ViewHandle> {
    Ok(view! { cx => lanes() }.single().await?)
}

#[derive(Deserialize)]
struct MoveRequest {
    id: u32,
    lane: String,
}

#[route(POST "/move")]
async fn move_card(cx: &Cx, Json(request): Json<MoveRequest>) -> Result<ViewHandle> {
    // A real handler would answer 400 for an unknown lane; the spike just keeps
    // the board unchanged so it stays a single small file.
    if LANES.iter().any(|(key, _)| *key == request.lane) {
        let mut cards = board().lock().expect("board");
        if let Some(card) = cards.iter_mut().find(|card| card.id == request.id) {
            card.lane = request.lane.clone();
        }
        drop(cards);
        bump();
    }
    Ok(view! { cx => lanes() }.single().await?)
}

/// SSE: one event per board revision (the client then refetches the fragment).
#[route(GET "/events")]
async fn events() -> Result<Sse<impl Stream<Item = Result<Event>> + use<>>> {
    let tx = TX.get_or_init(|| broadcast::channel(64).0).clone();
    let rx = tx.subscribe();
    let stream = stream::once(async { Ok(Event::default().comment("connected")) }).chain(
        stream::unfold(rx, |mut rx| async move {
            match rx.recv().await {
                Ok(rev) => Some((Ok(Event::default().data(rev.to_string())), rx)),
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    Some((Ok(Event::default().comment("lagged")), rx))
                }
                Err(broadcast::error::RecvError::Closed) => None,
            }
        }),
    );
    Ok(Sse::new(stream).keep_alive(KeepAlive::new()))
}

/// Stand-in for "the files changed": bump the board every N seconds.
async fn fake_file_watcher(seconds: u64) {
    let mut ticker = tokio::time::interval(Duration::from_secs(seconds));
    ticker.tick().await;
    loop {
        ticker.tick().await;
        bump();
    }
}

#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let router = Router::builder().discover().build();

    // (a) WE choose the listener: port 0 = whatever the OS gives us.
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    println!("spike listening on http://{addr}");
    println!("(a) listener chosen by us: {addr} · router handle: {:?}", std::any::type_name_of_val(&router));

    tokio::spawn(fake_file_watcher(5));
    topcoat::serve(listener, router).await?;
    Ok(())
}
