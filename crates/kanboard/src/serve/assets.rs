//! The SolidJS app, embedded from `web/dist` at compile time — no bundling
//! step, no runtime filesystem dependency.

use axum::body::Body;
use axum::extract::Path;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "web/dist"]
struct Dist;

fn serve(path: &str) -> Response {
    match Dist::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            (
                [(header::CONTENT_TYPE, mime.as_ref().to_string())],
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
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                body,
            )
                .into_response()
        }
        None => (StatusCode::INTERNAL_SERVER_ERROR, "index.html missing from embedded build").into_response(),
    }
}

/// Any other path: a real static asset if it exists, otherwise the SPA shell
/// (client-side routing owns everything else — `/p/<slug>`, etc.).
pub async fn asset(Path(path): Path<String>) -> Response {
    if Dist::get(&path).is_some() {
        return serve(&path);
    }
    index().await
}
