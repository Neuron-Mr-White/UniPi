//! The web UI, embedded from `ui-dist/` at compile time — no runtime
//! filesystem dependency. Since UNI-117 that is the UniPi app's web build
//! (`unipi-app/apps/mobile npm run build:web`, one frontend for phone,
//! desktop and browser); `scripts/build-ui.mjs` fills `ui-dist` and falls
//! back to the deprecated `web/` UI. The app routes with a hash (`#/board`),
//! so every other path is the SPA shell; it reads `/p/<slug>` and
//! `?project=` (the links `/unipi:kanboard open` prints) on load.

use axum::body::Body;
use axum::extract::Path;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "ui-dist"]
#[exclude = ".source.json"]
struct Dist;

/// Which UI is embedded (`app` = the UniPi web build, `legacy` = the old
/// kanboard UI) and its version — from build.rs, shown in `/api/health`.
pub const UI_SOURCE: &str = env!("KANBOARD_UI_SOURCE");
pub const UI_VERSION: &str = env!("KANBOARD_UI_VERSION");

fn serve(path: &str) -> Response {
    match Dist::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            // Hashed bundle files never change; everything else revalidates.
            let cache = if path.starts_with("assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            };
            (
                [
                    (header::CONTENT_TYPE, mime.as_ref().to_string()),
                    (header::CACHE_CONTROL, cache.to_string()),
                ],
                file.data.into_owned(),
            )
                .into_response()
        }
        None => not_found(),
    }
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// `index.html`, whether at `/` or as the SPA fallback for client-side routes.
pub async fn index() -> Response {
    match Dist::get("index.html") {
        Some(file) => {
            let body = Body::from(file.data.into_owned());
            (
                [
                    (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                    // A new daemon build must never be hidden behind a cached shell.
                    (header::CACHE_CONTROL, "no-cache"),
                ],
                body,
            )
                .into_response()
        }
        None => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "index.html missing from embedded build",
        )
            .into_response(),
    }
}

/// Any other path: a real static asset if it exists, otherwise the SPA shell
/// (client-side routing owns everything else — `/p/<slug>`, etc.). A missing
/// hashed asset or API path is a real 404, not the shell (a stale tab asking
/// for an old chunk must fail loudly, not parse HTML as JavaScript).
pub async fn asset(Path(path): Path<String>) -> Response {
    if Dist::get(&path).is_some() {
        return serve(&path);
    }
    if path.starts_with("assets/") || path.starts_with("api/") {
        return not_found();
    }
    index().await
}
