//! HTTP layer (PRD 11 and 12): routes, status codes, headers, Host/Origin validation.

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::{Body, Bytes};
use axum::extract::rejection::{PathRejection, QueryRejection};
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use futures_util::stream;
use rust_embed::RustEmbed;
use tokio::io::AsyncReadExt;

use crate::resolve::{Denied, Endpoint, Resolver};
use crate::tree::{scan, TreeState};

/// `/api/file` refuses files larger than this (PRD 6, 11).
pub const MAX_MARKDOWN_BYTES: u64 = 5 * 1024 * 1024;

const FILES_CSP: &str = "sandbox allow-scripts allow-popups";
const SHELL_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
img-src 'self' data: https:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; \
frame-ancestors 'none'";

#[derive(RustEmbed)]
#[folder = "frontend/"]
#[exclude = "vendor/CHECKSUMS"]
#[exclude = "vendor/VERSIONS"]
#[exclude = "vendor/LICENSE.*"]
struct Assets;

pub struct AppState {
    pub resolver: Resolver,
    pub tree: RwLock<Arc<TreeState>>,
    /// Allowed `Host` header values (lower case) when bound to a loopback address; `None` otherwise.
    allowed_hosts: Option<Vec<String>>,
}

impl AppState {
    /// Builds the state: scans the tree once and derives the Host allowlist from the bound address.
    pub fn new(resolver: Resolver, bound: SocketAddr) -> Arc<Self> {
        let tree = scan(&resolver);
        let allowed_hosts = if bound.ip().is_loopback() {
            let p = bound.port();
            Some(vec![
                format!("127.0.0.1:{p}"),
                format!("localhost:{p}"),
                format!("[::1]:{p}"),
            ])
        } else {
            None
        };
        Arc::new(AppState {
            resolver,
            tree: RwLock::new(Arc::new(tree)),
            allowed_hosts,
        })
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/tree", get(api_tree))
        .route("/api/file", get(api_file))
        .route("/files/{*path}", get(files))
        .fallback(fallback)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        // Outermost: every response, including the guard's 403, carries the security headers.
        .layer(middleware::from_fn(stamp_headers))
        .with_state(state)
}

// ------------------------------------------------------------------ logging helpers

/// Escapes control characters so a request path cannot forge log lines (PRD 9.3).
pub fn escape_log(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_control() {
            out.push_str(&format!("\\x{:02x}", c as u32));
        } else {
            out.push(c);
        }
    }
    out
}

fn log_denied(reason: &str, method: &Method, target: &str) {
    eprintln!("denied: {} {} {}", reason, method, escape_log(target));
}

fn denied_status(d: &Denied) -> StatusCode {
    match d {
        Denied::UnsupportedType => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        _ => StatusCode::NOT_FOUND,
    }
}

// ------------------------------------------------------------------ guard: Host and Origin (PRD 12.1)

async fn guard(State(state): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_ascii_lowercase());

    if let Some(allowed) = &state.allowed_hosts {
        let ok = host.as_ref().map_or(false, |h| allowed.contains(h));
        if !ok {
            log_denied("host-header", req.method(), &req.uri().to_string());
            return StatusCode::FORBIDDEN.into_response();
        }
    }

    if let Some(origin) = req.headers().get(header::ORIGIN) {
        let origin = origin.to_str().ok().map(|s| s.to_ascii_lowercase());
        let same_origin = match (&origin, &host) {
            (Some(o), Some(h)) => o
                .strip_prefix("http://")
                .or_else(|| o.strip_prefix("https://"))
                .map_or(false, |authority| authority == h),
            _ => false,
        };
        if !same_origin {
            log_denied("origin-header", req.method(), &req.uri().to_string());
            return StatusCode::FORBIDDEN.into_response();
        }
    }

    next.run(req).await
}

// ------------------------------------------------------------------ headers (PRD 11 "Headers")

async fn stamp_headers(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    let nosniff = HeaderValue::from_static("nosniff");
    if path.starts_with("/files/") {
        h.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(FILES_CSP),
        );
        h.insert(header::X_CONTENT_TYPE_OPTIONS, nosniff);
        h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    } else if path.starts_with("/api/") {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        h.insert(header::X_CONTENT_TYPE_OPTIONS, nosniff);
    } else {
        h.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(SHELL_CSP),
        );
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        h.insert(header::X_CONTENT_TYPE_OPTIONS, nosniff);
    }
    resp
}

// ------------------------------------------------------------------ handlers

async fn api_tree(State(state): State<Arc<AppState>>) -> Response {
    let tree = state.tree.read().expect("tree lock").clone();
    let mut resp = Json(&tree.entries).into_response();
    if tree.truncated {
        resp.headers_mut()
            .insert("x-tree-truncated", HeaderValue::from_static("1"));
    }
    resp
}

async fn api_file(
    State(state): State<Arc<AppState>>,
    method: Method,
    uri: Uri,
    query: Result<Query<HashMap<String, String>>, QueryRejection>,
) -> Response {
    let Ok(Query(params)) = query else {
        log_denied("bad-query", &method, &uri.to_string());
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(input) = params.get("path") else {
        log_denied("missing-param", &method, &uri.to_string());
        return StatusCode::NOT_FOUND.into_response();
    };
    let resolved = match state.resolver.resolve(input, Endpoint::ApiFile) {
        Ok(r) => r,
        Err(d) => {
            log_denied(d.reason(), &method, &uri.to_string());
            return denied_status(&d).into_response();
        }
    };
    // Open once and bound the read itself: a file that grows between a size check and the read
    // must not bypass the cap or use unbounded memory.
    let file = match tokio::fs::File::open(&resolved.path).await {
        Ok(f) => f,
        Err(e) => return io_error(&e, &method, &uri),
    };
    match file.metadata().await {
        Ok(m) if !m.is_file() => {
            log_denied("not-a-file", &method, &uri.to_string());
            return StatusCode::NOT_FOUND.into_response();
        }
        Ok(m) if m.len() > MAX_MARKDOWN_BYTES => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        Ok(_) => {}
        Err(e) => return io_error(&e, &method, &uri),
    }
    let mut bytes = Vec::new();
    if let Err(e) = file.take(MAX_MARKDOWN_BYTES + 1).read_to_end(&mut bytes).await {
        return io_error(&e, &method, &uri);
    }
    if bytes.len() as u64 > MAX_MARKDOWN_BYTES {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], bytes).into_response()
}

async fn files(
    State(state): State<Arc<AppState>>,
    method: Method,
    uri: Uri,
    path: Result<Path<String>, PathRejection>,
) -> Response {
    let Ok(Path(input)) = path else {
        log_denied("bad-path", &method, &uri.to_string());
        return StatusCode::NOT_FOUND.into_response();
    };
    let resolved = match state.resolver.resolve(&input, Endpoint::Files) {
        Ok(r) => r,
        Err(d) => {
            log_denied(d.reason(), &method, &uri.to_string());
            return denied_status(&d).into_response();
        }
    };
    let file = match tokio::fs::File::open(&resolved.path).await {
        Ok(f) => f,
        Err(e) => return io_error(&e, &method, &uri),
    };
    let meta = match file.metadata().await {
        Ok(m) => m,
        Err(e) => return io_error(&e, &method, &uri),
    };

    // The content type comes from the listed name's extension through a fixed table (PRD 10.1).
    let content_type = crate::resolve::extension_lower(std::path::Path::new(&resolved.listed_rel))
        .map(|e| content_type_for(&e))
        .unwrap_or("application/octet-stream");

    // Stream at most `meta.len()` bytes so Content-Length stays truthful if the file grows.
    let file = file.take(meta.len());
    let body = Body::from_stream(stream::unfold(file, |mut f| async move {
        let mut buf = vec![0u8; 64 * 1024];
        match f.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<Bytes, io::Error>(Bytes::from(buf)), f))
            }
            Err(e) => Some((Err(e), f)),
        }
    }));

    let mut resp = Response::new(body);
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    if let Ok(len) = HeaderValue::from_str(&meta.len().to_string()) {
        h.insert(header::CONTENT_LENGTH, len);
    }
    if let Ok(modified) = meta.modified() {
        if let Ok(v) = HeaderValue::from_str(&http_date(modified)) {
            h.insert(header::LAST_MODIFIED, v);
        }
    }
    resp
}

/// Embedded frontend assets; every other path is a 404 (PRD 11).
async fn fallback(method: Method, uri: Uri) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let path = uri.path().trim_start_matches('/');
    let key = if path.is_empty() { "index.html" } else { path };
    if key.split('/').any(|seg| seg == "..") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(asset) = Assets::get(key) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let ext = key.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let etag = format!("\"{}\"", hex(&asset.metadata.sha256_hash()));
    let mut resp = Response::new(Body::from(asset.data.into_owned()));
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type_for(&ext)),
    );
    if let Ok(v) = HeaderValue::from_str(&etag) {
        h.insert(header::ETAG, v);
    }
    resp
}

fn io_error(e: &io::Error, method: &Method, uri: &Uri) -> Response {
    // Details stay in the log; the client only sees the status (PRD 11).
    eprintln!(
        "error: {} {} {}",
        method,
        escape_log(&uri.to_string()),
        escape_log(&e.to_string())
    );
    match e.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied => StatusCode::NOT_FOUND,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
    .into_response()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Fixed content-type table for the served-extension whitelist and the embedded frontend.
pub fn content_type_for(ext: &str) -> &'static str {
    match ext {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "md" | "markdown" => "text/markdown; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

/// RFC 7231 IMF-fixdate, e.g. `Tue, 14 Nov 2023 22:13:20 GMT`.
pub fn http_date(t: SystemTime) -> String {
    const WEEKDAY: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTH: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let secs = t
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!(
        "{}, {:02} {} {} {:02}:{:02}:{:02} GMT",
        WEEKDAY[days.rem_euclid(7) as usize],
        day,
        MONTH[(month - 1) as usize],
        year,
        hh,
        mm,
        ss
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn http_date_formats_rfc7231() {
        assert_eq!(http_date(UNIX_EPOCH), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(
            http_date(UNIX_EPOCH + Duration::from_secs(1_700_000_000)),
            "Tue, 14 Nov 2023 22:13:20 GMT"
        );
        // A leap day.
        assert_eq!(
            http_date(UNIX_EPOCH + Duration::from_secs(1_709_164_800)),
            "Thu, 29 Feb 2024 00:00:00 GMT"
        );
    }

    #[test]
    fn escape_log_neutralises_control_characters() {
        assert_eq!(escape_log("a\r\nb\x1b[31m"), "a\\x0d\\x0ab\\x1b[31m");
        assert_eq!(escape_log("docs/中文 筆記.md"), "docs/中文 筆記.md");
    }

    #[test]
    fn content_type_table_covers_the_whitelist() {
        for ext in crate::resolve::SERVED_EXTENSIONS {
            assert_ne!(content_type_for(ext), "application/octet-stream", "{ext}");
        }
        assert_eq!(content_type_for("js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type_for("svg"), "image/svg+xml");
    }
}
