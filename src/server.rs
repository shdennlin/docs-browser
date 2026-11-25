//! HTTP layer (PRD 11 and 12): routes, status codes, headers, Host/Origin validation.

use std::collections::HashMap;
use std::convert::Infallible;
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::{Body, Bytes};
use axum::extract::rejection::{PathRejection, QueryRejection};
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{stream, Stream, StreamExt};
use rust_embed::RustEmbed;
use tokio::io::AsyncReadExt;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{broadcast, watch, OwnedSemaphorePermit, Semaphore};

use crate::resolve::{Denied, Endpoint, Resolver};
use crate::tree::{scan, TreeState};
use crate::watch::LiveEvent;

/// The URL `--open` should open for a bound address. A wildcard address is not browsable, so the
/// loopback address of the same family is used instead (PRD 9.1).
pub fn browse_url(local: SocketAddr) -> String {
    let ip = if local.ip().is_unspecified() {
        if local.is_ipv6() {
            std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)
        } else {
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
        }
    } else {
        local.ip()
    };
    format!("http://{}/", SocketAddr::new(ip, local.port()))
}

/// Concurrent SSE streams allowed (PRD 8.3).
pub const MAX_SSE_STREAMS: usize = 32;
/// Capacity of the live-event broadcast channel.
pub const EVENT_CAPACITY: usize = 256;

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
#[exclude = "*.test.js"]
struct Assets;

pub struct AppState {
    pub resolver: Resolver,
    pub tree: RwLock<Arc<TreeState>>,
    /// Live-reload events for `/api/events` (PRD 8.3).
    pub events: broadcast::Sender<LiveEvent>,
    pub sse_slots: Arc<Semaphore>,
    /// Why live reload is off, if it is (PRD 8.5).
    pub unavailable: RwLock<Option<String>>,
    /// Flips to true on shutdown so open SSE streams can say `bye` and end.
    pub shutdown: watch::Sender<bool>,
    /// `--verbose`: log every request (PRD 9.3).
    pub verbose: AtomicBool,
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
            events: broadcast::channel(EVENT_CAPACITY).0,
            sse_slots: Arc::new(Semaphore::new(MAX_SSE_STREAMS)),
            unavailable: RwLock::new(None),
            shutdown: watch::channel(false).0,
            verbose: AtomicBool::new(false),
            allowed_hosts,
        })
    }

    /// Broadcasts a live event; having no subscriber is not an error.
    pub fn send_event(&self, event: LiveEvent) {
        let _ = self.events.send(event);
    }
}

/// The event stream behind `/api/events`. A subscriber that falls behind gets one `resync`; a
/// shutdown yields `bye` and ends the stream; `permit` (an SSE slot) is held until the stream ends.
pub fn live_events(
    rx: broadcast::Receiver<LiveEvent>,
    shutdown: watch::Receiver<bool>,
    initial: Option<LiveEvent>,
    permit: Option<OwnedSemaphorePermit>,
) -> impl Stream<Item = LiveEvent> {
    struct Live {
        rx: broadcast::Receiver<LiveEvent>,
        shutdown: watch::Receiver<bool>,
        initial: Option<LiveEvent>,
        done: bool,
        _permit: Option<OwnedSemaphorePermit>,
    }
    stream::unfold(
        Live { rx, shutdown, initial, done: false, _permit: permit },
        |mut st| async move {
            if st.done {
                return None;
            }
            if let Some(event) = st.initial.take() {
                return Some((event, st));
            }
            if *st.shutdown.borrow() {
                st.done = true;
                return Some((LiveEvent::Bye, st));
            }
            tokio::select! {
                received = st.rx.recv() => match received {
                    Ok(event) => Some((event, st)),
                    Err(RecvError::Lagged(_)) => Some((LiveEvent::Resync, st)),
                    Err(RecvError::Closed) => None,
                },
                _ = st.shutdown.changed() => {
                    st.done = true;
                    Some((LiveEvent::Bye, st))
                }
            }
        },
    )
}

async fn api_search(
    State(state): State<Arc<AppState>>,
    method: Method,
    uri: Uri,
    query: Result<Query<HashMap<String, String>>, QueryRejection>,
) -> Response {
    let bad = |why: &str| {
        log_denied(why, &method, uri.path());
        StatusCode::BAD_REQUEST.into_response()
    };
    let Ok(Query(params)) = query else {
        return bad("bad-query");
    };
    let q = match crate::search::validate(params.get("q").map(String::as_str).unwrap_or("")) {
        Ok(q) => q,
        Err(crate::search::BadQuery::TooShort) => return bad("search-query-too-short"),
        Err(crate::search::BadQuery::TooLong) => return bad("search-query-too-long"),
    };
    let tree = state.tree.read().expect("tree lock").clone();
    let st = state.clone();
    // Reading files blocks, so the scan runs off the async workers.
    match tokio::task::spawn_blocking(move || crate::search::search(&st.resolver, &tree, &q)).await {
        Ok(response) => Json(response).into_response(),
        Err(e) => {
            crate::elog!("error: search failed: {}", escape_log(&e.to_string()));
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn api_events(State(state): State<Arc<AppState>>) -> Response {
    let Ok(permit) = state.sse_slots.clone().try_acquire_owned() else {
        crate::elog!("denied: sse-limit GET /api/events");
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let initial = state
        .unavailable
        .read()
        .expect("unavailable lock")
        .as_ref()
        .map(|_| LiveEvent::Unavailable);
    let events = live_events(state.events.subscribe(), state.shutdown.subscribe(), initial, Some(permit))
        .map(|event| {
            let json = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
            Ok::<_, Infallible>(SseEvent::default().data(json))
        });
    Sse::new(events)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("keepalive"))
        .into_response()
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/tree", get(api_tree))
        .route("/api/file", get(api_file))
        .route("/api/events", get(api_events))
        .route("/api/search", get(api_search))
        .route("/api/version", get(api_version))
        .route("/api/info", get(api_info))
        .route("/files/{*path}", get(files))
        .fallback(fallback)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        // Outermost: every response, including the guard's 403, carries the security headers.
        .layer(middleware::from_fn(stamp_headers))
        // Outermost of all, so rejected requests are logged too.
        .layer(middleware::from_fn_with_state(state.clone(), request_log))
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
    crate::elog!("denied: {} {} {}", reason, method, escape_log(target));
}

fn denied_status(d: &Denied) -> StatusCode {
    match d {
        Denied::UnsupportedType => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        _ => StatusCode::NOT_FOUND,
    }
}

/// `--verbose`: one line per request, `METHOD path status duration` (PRD 9.3).
async fn request_log(State(state): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    if !state.verbose.load(Ordering::Relaxed) {
        return next.run(req).await;
    }
    let method = req.method().clone();
    // The path only: query strings can carry file names the user did not expect in a log.
    let target = req.uri().path().to_string();
    let started = Instant::now();
    let resp = next.run(req).await;
    crate::elog!(
        "{} {} {} {}ms",
        method,
        escape_log(&target),
        resp.status().as_u16(),
        started.elapsed().as_millis()
    );
    resp
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

    if let Some(origin_header) = req.headers().get(header::ORIGIN) {
        // The exact value, for the one D11 exception below: only the lowercase `null` browsers send.
        let raw_origin = origin_header.to_str().ok().map(str::to_owned);
        let origin = raw_origin.as_ref().map(|s| s.to_ascii_lowercase());
        let same_origin = match (&origin, &host) {
            // This server speaks plain http only, so only an http:// origin can be its own.
            (Some(o), Some(h)) => o.strip_prefix("http://").map_or(false, |authority| authority == h),
            _ => false,
        };
        // D11: a sandboxed HTML preview has an opaque origin, and some browsers (measured: Chromium 156)
        // send `Origin: null` when it loads its own CSS, scripts and images. Accept that for reading
        // `/files/*` only; `/api/*`, the event stream and every other method stay strictly same-origin.
        let null_origin_for_files = raw_origin.as_deref() == Some("null")
            && (req.method() == Method::GET || req.method() == Method::HEAD)
            && req.uri().path().starts_with("/files/");
        if !same_origin && !null_origin_for_files {
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

/// The version of the running server, shown in the page footer (PRD 7.3).
async fn api_version(State(state): State<Arc<AppState>>) -> Response {
    Json(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "rootKey": root_key(state.resolver.root()),
    }))
    .into_response()
}

/// A short, stable key for a served root, so the browser can keep per-root state (expanded folders)
/// without the server revealing the absolute path. FNV-1a, 64 bits, as 16 hex digits.
pub fn root_key(root: &std::path::Path) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in root.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

async fn api_tree(State(state): State<Arc<AppState>>) -> Response {
    let tree = state.tree.read().expect("tree lock").clone();
    let mut resp = Json(&tree.entries).into_response();
    if tree.truncated {
        resp.headers_mut()
            .insert("x-tree-truncated", HeaderValue::from_static("1"));
    }
    resp
}

/// Created and modified times and git facts for the status bar (PRD 7.3). The path is resolved with the
/// same rules as `/files/*` (so HTML pages have a status bar too).
async fn api_info(
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
    let resolved = match state.resolver.resolve(input, Endpoint::Files) {
        Ok(r) => r,
        Err(d) => {
            log_denied(d.reason(), &method, &uri.to_string());
            return denied_status(&d).into_response();
        }
    };
    let path = resolved.path.clone();
    // The absolute path is shown only to a loopback client (it is used for the VS Code link); on a
    // non-loopback bind it stays out of the response.
    let absolute = state.allowed_hosts.is_some().then(|| path.display().to_string());
    match tokio::task::spawn_blocking(move || crate::info::read(&path)).await {
        Ok(Some(info)) => {
            let mut value = serde_json::to_value(&info).unwrap_or(serde_json::Value::Null);
            if let (Some(abs), Some(obj)) = (absolute, value.as_object_mut()) {
                obj.insert("absolutePath".to_string(), serde_json::Value::String(abs));
            }
            Json(value).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
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
    crate::elog!(
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
        "pdf" => "application/pdf",
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
    fn browse_url_never_uses_a_wildcard_address() {
        let u = |s: &str| browse_url(s.parse().unwrap());
        assert_eq!(u("127.0.0.1:3000"), "http://127.0.0.1:3000/");
        assert_eq!(u("0.0.0.0:4112"), "http://127.0.0.1:4112/");
        assert_eq!(u("[::]:4112"), "http://[::1]:4112/");
        assert_eq!(u("[::1]:80"), "http://[::1]:80/");
        assert_eq!(u("192.168.1.5:9000"), "http://192.168.1.5:9000/");
    }

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
    fn ut_26_root_key_is_stable_per_root_and_hides_the_path() {
        let a = root_key(std::path::Path::new("/srv/docs"));
        assert_eq!(a, root_key(std::path::Path::new("/srv/docs")));
        assert_ne!(a, root_key(std::path::Path::new("/srv/docs2")));
        assert_eq!(a.len(), 16);
        assert!(a.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(!a.contains("srv"));
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
