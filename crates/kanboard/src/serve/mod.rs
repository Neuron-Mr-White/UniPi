//! `serve` — the daemon: single instance, JSON API, embedded UI, SSE, file
//! watch, idle shutdown.

pub mod api;
pub mod assets;
pub mod auth;
pub mod events;

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::middleware;
use axum::routing::{get, post};
use chrono::Utc;
use notify::{RecursiveMode, Watcher as _};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::broadcast;

use crate::daemon::{self, DaemonInfo};
use crate::error::Result;
use crate::store::Layout;

/// Shared, process-global state: the daemon is a singleton by design (the lock
/// enforces it), so handlers reach it through this instead of plumbing it
/// through the framework.
pub struct AppState {
    pub layout: Layout,
    /** Bind address this daemon was started with. */
    pub host: String,
    /** Required when `host` is not loopback (None = open, loopback only). */
    pub token: Option<String>,
    pub started: Instant,
    pub last_activity: Mutex<Instant>,
    pub sse_clients: AtomicUsize,
    pub revisions: Mutex<HashMap<String, u64>>,
    pub senders: Mutex<HashMap<String, broadcast::Sender<u64>>>,
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// Flips on shutdown so open SSE streams end — graceful shutdown waits for
    /// every connection, and an event stream never finishes by itself.
    pub closing: tokio::sync::watch::Sender<bool>,
}

impl AppState {
    fn new(layout: Layout, host: String, token: Option<String>) -> Arc<AppState> {
        Arc::new(AppState {
            layout,
            host,
            token,
            started: Instant::now(),
            last_activity: Mutex::new(Instant::now()),
            sse_clients: AtomicUsize::new(0),
            revisions: Mutex::new(HashMap::new()),
            senders: Mutex::new(HashMap::new()),
            watcher: Mutex::new(None),
            closing: tokio::sync::watch::channel(false).0,
        })
    }

    /// Any HTTP request or SSE connect/disconnect restarts the idle window.
    pub fn touch(&self) {
        if let Ok(mut last) = self.last_activity.lock() {
            *last = Instant::now();
        }
    }

    pub fn revision(&self, slug: &str) -> u64 {
        self.revisions
            .lock()
            .map(|map| map.get(slug).copied().unwrap_or(0))
            .unwrap_or(0)
    }

    /// Bump a project's revision and tell its SSE clients.
    pub fn bump(&self, slug: &str) {
        let revision = {
            let mut revisions = match self.revisions.lock() {
                Ok(revisions) => revisions,
                Err(_) => return,
            };
            let entry = revisions.entry(slug.to_string()).or_insert(0);
            *entry += 1;
            *entry
        };
        if let Ok(senders) = self.senders.lock()
            && let Some(sender) = senders.get(slug)
        {
            let _ = sender.send(revision);
        }
    }

    pub fn subscribe(&self, slug: &str) -> broadcast::Receiver<u64> {
        let mut senders = match self.senders.lock() {
            Ok(senders) => senders,
            Err(_) => return broadcast::channel(1).1,
        };
        senders
            .entry(slug.to_string())
            .or_insert_with(|| broadcast::channel(64).0)
            .subscribe()
    }
}

#[derive(Debug, Clone)]
pub struct ServeOptions {
    /// Bind address: 127.0.0.1 (default) or anything else for remote access.
    pub host: String,
    pub port: u16,
    pub idle: Duration,
}

impl ServeOptions {
    pub fn new(host: impl Into<String>, port: u16, idle_min: u64) -> Self {
        ServeOptions {
            host: host.into(),
            port,
            idle: Duration::from_secs(idle_min.max(1) * 60),
        }
    }
}

/// Run the daemon. Returns the JSON payload for the caller to print; when
/// another daemon already holds the lock, returns the existing daemon.json as
/// `{"alreadyRunning": true, "daemon": …}` (exit code 0).
pub async fn serve(layout: Layout, options: ServeOptions) -> Result<Value> {
    let Some(_lock) = daemon::take_lock(&layout)? else {
        let running = daemon::read_info(&layout);
        // Binding changes need a restart; say so instead of silently ignoring.
        let binding_changed = running
            .as_ref()
            .map(|info| info.host != options.host || (options.port != 0 && info.port != options.port))
            .unwrap_or(false);
        return Ok(json!({
            "alreadyRunning": true,
            "bindingChanged": binding_changed,
            "requested": { "host": options.host, "port": options.port },
            "daemon": running,
        }));
    };

    let listener = TcpListener::bind((options.host.as_str(), options.port))
        .await
        .map_err(|err| crate::error::Error::Io(format!("cannot bind {}:{}: {err}", options.host, options.port)))?;
    let port = listener.local_addr()?.port();

    // Remote binds are token-gated; loopback stays open.
    let token = if auth::is_loopback(&options.host) { None } else { Some(auth::generate_token()) };
    let state = AppState::new(layout.clone(), options.host.clone(), token.clone());

    *state.watcher.lock().expect("watcher slot") = Some(spawn_watcher(state.clone())?);

    let info = DaemonInfo {
        pid: std::process::id(),
        port,
        version: env!("CARGO_PKG_VERSION").to_string(),
        started_at: Utc::now(),
        host: options.host.clone(),
        token: token.clone(),
    };
    daemon::write_info(&layout, &info)?;

    let (shutdown_tx, mut shutdown_rx) = tokio::sync::mpsc::channel::<&'static str>(4);
    spawn_idle_monitor(state.clone(), options.idle, shutdown_tx.clone());

    let router = router(state.clone());
    let signal = async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
            let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
            tokio::select! {
                _ = term.recv() => {}
                _ = int.recv() => {}
                _ = shutdown_rx.recv() => {}
            }
        }
        #[cfg(not(unix))]
        {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = shutdown_rx.recv() => {}
            }
        }
    };

    let closing = state.closing.clone();
    let signal = async move {
        signal.await;
        // End the event streams first, or the graceful drain never completes.
        let _ = closing.send(true);
    };
    let server = axum::serve(listener, router).with_graceful_shutdown(signal);
    let mut closing_rx = state.closing.subscribe();
    let result = tokio::select! {
        result = server => result,
        // Hard ceiling on the drain: a stuck request must not keep a stopped daemon alive.
        _ = async {
            let _ = closing_rx.wait_for(|closing| *closing).await;
            tokio::time::sleep(Duration::from_secs(3)).await;
        } => Ok(()),
    };

    daemon::remove_info(&layout);
    // Keep the flock until the very end so a racing `serve` sees it held.
    drop(_lock);
    *state.watcher.lock().expect("watcher slot") = None;

    result.map_err(|err| crate::error::Error::Io(format!("daemon stopped: {err}")))?;

    Ok(json!({
        "alreadyRunning": false,
        "daemon": info,
        "stopped": true,
    }))
}

fn router(state: Arc<AppState>) -> axum::Router {
    axum::Router::new()
        .route("/api/health", get(api::health))
        .route("/api/projects", get(api::projects))
        .route("/api/rules", get(api::rules))
        .route("/api/projects/{slug}/tasks", get(api::tasks))
        .route("/api/tasks/{slug}/{id}", get(api::task))
        .route("/api/tasks/{slug}/create", post(api::create))
        .route("/api/tasks/{slug}/{id}/move", post(api::move_task))
        .route("/api/tasks/{slug}/{id}/note", post(api::note))
        .route("/api/tasks/{slug}/{id}/edit", post(api::edit))
        .route("/api/tasks/{slug}/{id}/link", post(api::link))
        .route("/api/tasks/{slug}/{id}/unlink", post(api::unlink))
        .route("/api/tasks/{slug}/{id}/order", post(api::order))
        .route("/api/tasks/{slug}/{id}/duplicate", post(api::duplicate))
        .route(
            "/api/tasks/{slug}/{id}/attachments",
            post(api::upload).layer(axum::extract::DefaultBodyLimit::max(crate::attachments::MAX_BYTES + 1024)),
        )
        .route("/api/files/{slug}/{task}/{name}", get(api::file))
        .route("/events", get(events::events))
        .route("/", get(assets::index))
        .route("/{*path}", get(assets::asset))
        .layer(middleware::from_fn_with_state(state.clone(), auth::guard))
        .with_state(state)
}

fn spawn_idle_monitor(state: Arc<AppState>, idle: Duration, shutdown: tokio::sync::mpsc::Sender<&'static str>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        loop {
            ticker.tick().await;
            if state.sse_clients.load(Ordering::SeqCst) > 0 {
                continue;
            }
            let elapsed = state
                .last_activity
                .lock()
                .map(|last| last.elapsed())
                .unwrap_or_default();
            if elapsed >= idle && state.started.elapsed() >= idle {
                let _ = shutdown.send("idle").await;
                return;
            }
        }
    });
}

/// Watch `projects/` and bump the revision of whichever project changed, so CLI
/// and agent writes appear in the UI without polling.
fn spawn_watcher(state: Arc<AppState>) -> Result<notify::RecommendedWatcher> {
    let projects = state.layout.projects_root();
    std::fs::create_dir_all(&projects)?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<std::path::PathBuf>();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        // Only content changes count. Access events would make the UI refetch on
        // its own reads — an endless revision/refetch loop.
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        for path in event.paths {
            let _ = tx.send(path);
        }
    })
    .map_err(|err| crate::error::Error::Io(format!("cannot watch {}: {err}", projects.display())))?;
    watcher
        .watch(&projects, RecursiveMode::Recursive)
        .map_err(|err| crate::error::Error::Io(format!("cannot watch {}: {err}", projects.display())))?;

    let root = projects.clone();
    tokio::spawn(async move {
        // One write is often several events (tmp file, rename, close): coalesce.
        let mut last_bump: std::collections::HashMap<String, std::time::Instant> =
            std::collections::HashMap::new();
        while let Some(path) = rx.recv().await {
            // Ignore lock files and temp files: only real content changes count.
            let name = path.file_name().map(|name| name.to_string_lossy().to_string());
            let relevant = match name.as_deref() {
                Some(name) => name.ends_with(".md") || name == "project.json",
                None => false,
            };
            if !relevant {
                continue;
            }
            if std::env::var("UNIPI_KANBOARD_DEBUG_WATCH").as_deref() == Ok("1") {
                eprintln!("watch event: {}", path.display());
            }
            let Some(slug) = path
                .strip_prefix(&root)
                .ok()
                .and_then(|rest| rest.components().next())
                .map(|first| first.as_os_str().to_string_lossy().to_string())
            else {
                continue;
            };
            if let Some(previous) = last_bump.get(&slug)
                && previous.elapsed() < std::time::Duration::from_millis(150)
            {
                continue;
            }
            last_bump.insert(slug.clone(), std::time::Instant::now());
            state.bump(&slug);
        }
    });

    Ok(watcher)
}
