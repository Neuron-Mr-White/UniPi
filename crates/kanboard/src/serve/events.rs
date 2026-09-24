//! `GET /events?project=<slug>` — one SSE event per board revision, fed by the
//! file watcher (so CLI and agent writes show up in the UI).

use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use axum::extract::{Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::stream::{self, Stream, StreamExt};
use serde::Deserialize;

use super::AppState;

/// Keeps the SSE client count honest even when the stream is dropped.
struct ClientGuard(Arc<AppState>);

impl Drop for ClientGuard {
    fn drop(&mut self) {
        self.0.sse_clients.fetch_sub(1, Ordering::SeqCst);
        // A client leaving restarts the idle window.
        self.0.touch();
    }
}

#[derive(Deserialize)]
pub struct EventsQuery {
    #[serde(default)]
    project: String,
}

pub async fn events(
    State(state): State<Arc<AppState>>,
    Query(query): Query<EventsQuery>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    state.touch();
    let slug = query.project;

    state.sse_clients.fetch_add(1, Ordering::SeqCst);
    let mut broadcast = state.subscribe(&slug);

    // Pump the broadcast channel into an mpsc so the stream owns no borrowed
    // state and the guard lives exactly as long as the stream.
    let (tx, rx) = tokio::sync::mpsc::channel::<u64>(32);
    tokio::spawn(async move {
        loop {
            match broadcast.recv().await {
                Ok(revision) => {
                    if tx.send(revision).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let first = {
        let state = state.clone();
        let slug = slug.clone();
        async move { Ok(Event::default().event("revision").data(state.revision(&slug).to_string())) }
    };

    let stream = stream::once(first).chain(stream::unfold(
        (rx, ClientGuard(state)),
        |(mut rx, guard)| async move {
            let revision = rx.recv().await?;
            Some((
                Ok(Event::default().event("revision").data(revision.to_string())),
                (rx, guard),
            ))
        },
    ));

    Sse::new(stream).keep_alive(KeepAlive::new())
}
