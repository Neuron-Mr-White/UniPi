//! `GET /events?project=<slug>` — one SSE event per board revision, fed by the
//! file watcher (so CLI and agent writes show up in the UI).

use std::sync::atomic::Ordering;

use futures_util::stream::{self, Stream, StreamExt};
use topcoat::{
    Result as TcResult,
    context::Cx,
    router::{
        content::sse::{Event, KeepAlive, Sse},
        route,
    },
};

use super::state;

/// Keeps the SSE client count honest even when the stream is dropped.
struct ClientGuard;

impl Drop for ClientGuard {
    fn drop(&mut self) {
        let state = state();
        state.sse_clients.fetch_sub(1, Ordering::SeqCst);
        // A client leaving restarts the idle window.
        state.touch();
    }
}

#[route(GET "/events")]
pub async fn events(cx: &Cx) -> TcResult<Sse<impl Stream<Item = TcResult<Event>> + use<>>> {
    let state = state();
    state.touch();
    let slug = super::api::query_param(cx, "project").unwrap_or_default();

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
        async move {
            Ok(Event::default()
                .event("revision")
                .data(state.revision(&slug).to_string()))
        }
    };

    let stream = stream::once(first).chain(stream::unfold(
        (rx, ClientGuard),
        |(mut rx, guard)| async move {
            let revision = rx.recv().await?;
            Some((
                Ok(Event::default().event("revision").data(revision.to_string())),
                (rx, guard),
            ))
        },
    ));

    Ok(Sse::new(stream).keep_alive(KeepAlive::new()))
}
