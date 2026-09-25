//! Remote access: bearer-token gate + a cross-site request guard.
//!
//! Loopback binds stay open (today's behaviour). Any other bind requires the
//! token from `daemon.json` on every request — as `?t=<token>` (which sets an
//! HttpOnly cookie and redirects), as the `kb_token` cookie, or as
//! `Authorization: Bearer <token>`.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use super::AppState;

pub const COOKIE_NAME: &str = "kb_token";
pub const TOKEN_PARAM: &str = "t";

/// Is this bind reachable only from this machine?
pub fn is_loopback(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host == "localhost" || host == "::1" {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => v4.is_loopback(),
        Ok(std::net::IpAddr::V6(v6)) => v6.is_loopback(),
        Err(_) => false,
    }
}

/// 32 random bytes, base64url without padding (~43 chars).
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    if getrandom::fill(&mut bytes).is_err() {
        // Extremely unlikely; fall back to a time+pid mix so we never hand out
        // an empty token.
        let seed = format!(
            "{}:{}:{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
            bytes.len()
        );
        let digest = <sha2::Sha256 as sha2::Digest>::digest(seed.as_bytes());
        bytes.copy_from_slice(&digest[..32]);
    }
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Constant-time equality: no early exit on the first differing byte.
pub fn tokens_match(expected: &str, presented: &str) -> bool {
    let (a, b) = (expected.as_bytes(), presented.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    let mut diff = 0u8;
    for index in 0..a.len() {
        diff |= a[index] ^ b[index];
    }
    diff == 0
}

fn query_token(uri: &axum::http::Uri) -> Option<String> {
    let query = uri.query()?;
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if name == TOKEN_PARAM && !value.is_empty() {
            return Some(percent_decode(value));
        }
    }
    None
}

fn cookie_token(request: &Request) -> Option<String> {
    let raw = request.headers().get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let (name, value) = part.trim().split_once('=')?;
        if name == COOKIE_NAME && !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

fn header_token(request: &Request) -> Option<String> {
    let raw = request
        .headers()
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    raw.strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// The URL without the token parameter (used by the redirect).
fn url_without_token(uri: &axum::http::Uri) -> String {
    let path = uri.path();
    match uri.query() {
        Some(query) => {
            let kept: Vec<&str> = query
                .split('&')
                .filter(|pair| {
                    !pair.starts_with(&format!("{TOKEN_PARAM}=")) && *pair != TOKEN_PARAM
                })
                .filter(|pair| !pair.is_empty())
                .collect();
            if kept.is_empty() {
                path.to_string()
            } else {
                format!("{path}?{}", kept.join("&"))
            }
        }
        None => path.to_string(),
    }
}

fn plain_page(status: StatusCode, title: &str, body: &str) -> Response {
    let html = format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>{title}</title>\
<style>body{{font:14px/1.5 system-ui,sans-serif;margin:3rem;max-width:38rem}}\
code{{background:#eee;padding:0 .3rem;border-radius:4px}}</style></head>\
<body><h1>{title}</h1><p>{body}</p></body></html>"
    );
    let mut response = Response::new(Body::from(html));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    response
}

fn unauthorized() -> Response {
    plain_page(
        StatusCode::UNAUTHORIZED,
        "kanboard: unauthorized",
        "Open the link printed by <code>/unipi:kanboard open</code> — it carries the access token for this board.",
    )
}

/// Cross-site guard for state-changing requests: a browser sends `Origin` on
/// cross-site POSTs, so a mismatch with our own `Host` means someone else's page
/// is driving the request.
fn cross_site(origin: &str, host_header: Option<&str>) -> bool {
    let Some(rest) = origin.split("://").nth(1) else {
        return true; // unparseable origin → treat as cross-site
    };
    let origin_host = rest.split('/').next().unwrap_or("");
    match host_header {
        Some(host) => origin_host != host,
        None => true,
    }
}

/// The auth + CSRF layer. Wraps every route (including 404s).
pub async fn guard(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    let host_header = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    // 1. Cross-site POSTs are refused in both modes (drive-by CSRF).
    if request.method() == Method::POST
        && let Some(origin) = request
            .headers()
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
        && cross_site(origin, host_header.as_deref())
    {
        return plain_page(
            StatusCode::FORBIDDEN,
            "kanboard: cross-site request refused",
            "This request came from another site. Open the board directly instead.",
        );
    }

    // 2. Liveness is deliberately open (it leaks nothing: see api::health).
    if request.uri().path() == "/api/health" {
        return next.run(request).await;
    }

    // 3. Loopback binds are open, as before.
    let Some(expected) = state.token.as_deref() else {
        return next.run(request).await;
    };

    // 4. Token via header or cookie passes straight through.
    if let Some(presented) = header_token(&request).or_else(|| cookie_token(&request))
        && tokens_match(expected, &presented)
    {
        return next.run(request).await;
    }

    // 5. Token via query: set the cookie and redirect to the clean URL.
    if let Some(presented) = query_token(request.uri())
        && tokens_match(expected, &presented)
    {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::SEE_OTHER;
        if let Ok(location) = HeaderValue::from_str(&url_without_token(request.uri())) {
            response.headers_mut().insert(header::LOCATION, location);
        }
        let cookie = format!("{COOKIE_NAME}={expected}; HttpOnly; SameSite=Strict; Path=/");
        if let Ok(value) = HeaderValue::from_str(&cookie) {
            response.headers_mut().insert(header::SET_COOKIE, value);
        }
        return response;
    }

    unauthorized()
}
