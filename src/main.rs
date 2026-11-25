//! docs-browser entry point (PRD 9): flags, exit codes, startup messages, signals.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;
use docs_browser::entry;
use docs_browser::resolve::{Endpoint, Resolver};
use docs_browser::server::{escape_log, router, AppState};
use docs_browser::watch;

/// Not a port that other dev servers like to take (3000, 4000, 5173, 8000, 8080 ...).
const DEFAULT_PORT: u16 = 4747;
/// Without `--port`, the next ports tried when the default one is busy (4747 to 4766).
const PORT_TRIES: u16 = 20;

#[derive(Parser)]
#[command(name = "docs-browser", version, about = "Zero-config local browser for project documentation")]
struct Cli {
    /// Directory to serve, or a Markdown/HTML file: its git repository (or folder) is served and the file opens
    #[arg(default_value = ".")]
    directory: PathBuf,
    /// TCP port, 0 asks the OS for a free one [default: 4747]
    #[arg(long)]
    port: Option<u16>,
    /// Address to bind (an IP address, or `localhost`)
    #[arg(long, default_value = "127.0.0.1", value_parser = parse_host)]
    host: IpAddr,
    /// Do not open the page in the default browser (it opens by default)
    #[arg(long = "no-open")]
    no_open: bool,
    /// Accepted for compatibility with earlier versions; opening is the default now
    #[arg(long, hide = true)]
    open: bool,
    /// Make dot-prefixed files and folders visible and readable
    #[arg(long)]
    include_hidden: bool,
    /// Log every request to stderr
    #[arg(long, short = 'v')]
    verbose: bool,
}

/// A path for a message: control characters are escaped, so a directory name cannot forge log lines.
fn shown(path: &std::path::Path) -> String {
    escape_log(&path.display().to_string())
}

fn parse_host(s: &str) -> Result<IpAddr, String> {
    if s.eq_ignore_ascii_case("localhost") {
        return Ok(IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
    s.parse().map_err(|_| format!("'{s}' is not an IP address"))
}

/// A startup failure: the message goes to stderr, `code` is the exit code (PRD 9.1).
struct Failure {
    code: i32,
    message: String,
}

#[tokio::main]
async fn main() {
    let code = match run().await {
        Ok(()) => 0,
        Err(f) => {
            docs_browser::elog!("error: {}", f.message);
            f.code
        }
    };
    std::process::exit(code);
}

async fn run() -> Result<(), Failure> {
    // clap reports usage errors (a bad --port or --host) itself and exits with code 2.
    let cli = Cli::parse();

    // A file argument serves its root (the nearest git repository, else its folder) and opens the file.
    let (dir, file_entry) = if std::fs::metadata(&cli.directory).is_ok_and(|m| m.is_file()) {
        let e = entry::resolve_entry(&cli.directory)
            .map_err(|m| Failure { code: 2, message: format!("{m}: {}", shown(&cli.directory)) })?;
        (e.root.clone(), Some(e))
    } else {
        (cli.directory.clone(), None)
    };
    match std::fs::metadata(&dir) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => {
            return Err(Failure { code: 2, message: format!("not a directory: {}", shown(&dir)) })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(Failure { code: 2, message: format!("directory not found: {}", shown(&dir)) })
        }
        Err(e) => {
            return Err(Failure { code: 2, message: format!("cannot read directory: {}: {e}", shown(&dir)) })
        }
    }
    // A directory that exists but cannot be listed would start and serve an empty tree in silence.
    if let Err(e) = std::fs::read_dir(&dir) {
        return Err(Failure { code: 2, message: format!("cannot read directory: {}: {e}", shown(&dir)) });
    }
    let resolver = Resolver::new(&dir, cli.include_hidden).map_err(|e| Failure {
        code: 2,
        message: format!("cannot use directory: {}: {e}", shown(&dir)),
    })?;
    let root = resolver.root().to_path_buf();
    // The file must be servable under the same rules as `/files/*` (hidden files need --include-hidden).
    // HTML entries load through `/files/*`, so the check uses that endpoint's extension whitelist.
    let file_rel = match &file_entry {
        Some(e) => {
            if let Err(d) = resolver.resolve(&e.rel, Endpoint::Files) {
                return Err(Failure { code: 2, message: format!("cannot open file: {}: {}", shown(&cli.directory), d.reason()) });
            }
            Some(e.rel.clone())
        }
        None => None,
    };

    let listener = match cli.port {
        Some(port) => {
            let wanted = SocketAddr::new(cli.host, port);
            tokio::net::TcpListener::bind(wanted)
                .await
                .map_err(|e| Failure { code: 1, message: format!("cannot bind {wanted}: {e}") })?
        }
        None => bind_default(cli.host).await.map_err(|e| Failure { code: 1, message: e })?,
    };
    let local = listener.local_addr().map_err(|e| Failure { code: 1, message: e.to_string() })?;
    if cli.port.is_none() && local.port() != DEFAULT_PORT {
        docs_browser::elog!("note: port {DEFAULT_PORT} is busy, using {}", local.port());
    }

    if !local.ip().is_loopback() {
        docs_browser::elog!(
            "WARNING: binding to {} exposes every visible file under {} to your network.",
            local.ip(),
            shown(&root)
        );
    }

    let state = AppState::new(resolver, local);
    state.verbose.store(cli.verbose, std::sync::atomic::Ordering::Relaxed);
    docs_browser::elog!("Serving {} at http://{}", shown(&root), local);
    // With a file argument the page opens that file; the URL is printed so it can be used without the browser.
    let url = match &file_rel {
        Some(rel) => entry::file_url(&docs_browser::server::browse_url(local), rel),
        None => docs_browser::server::browse_url(local),
    };
    if file_rel.is_some() {
        docs_browser::elog!("Opening {url}");
    }
    if !cli.no_open {
        if let Err(e) = open::that_detached(&url) {
            docs_browser::elog!("warning: could not open a browser for {url}: {e}");
        }
    }

    // Live reload: if the OS watcher cannot start, the server keeps serving (PRD 8.5).
    let include_hidden = state.resolver.include_hidden();
    let live = watch::init_live(&state, &root, |r, tx| watch::start_watcher(r, include_hidden, tx));
    let _watcher_guard = live.map(|(handle, rx)| {
        let pipeline = Arc::new(watch::Pipeline::new(state.clone()));
        tokio::spawn(watch::run(pipeline.clone(), rx));
        // The first scan ran before the OS watch existed. Anything that changed in between would never
        // be reported, so scan once more now that changes are being watched.
        tokio::task::spawn_blocking(move || {
            pipeline.process(watch::Batch { paths: Default::default(), rescan: true })
        });
        handle
    });

    let shutdown_state = state.clone();
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            // Tell every SSE stream to say `bye`, and never wait longer than 2 s for the rest.
            // send_replace stores the value even when no stream is subscribed yet.
            shutdown_state.shutdown.send_replace(true);
            tokio::spawn(async {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                std::process::exit(0);
            });
        })
        .await
        .map_err(|e| Failure { code: 1, message: e.to_string() })?;
    Ok(())
}

/// Binds the first free port from `DEFAULT_PORT` on, and only when every one of those is busy an OS-chosen
/// port. Any other bind error (for example a permission problem) is reported at once.
async fn bind_default(host: IpAddr) -> Result<tokio::net::TcpListener, String> {
    bind_from(host, DEFAULT_PORT, PORT_TRIES).await
}

async fn bind_from(host: IpAddr, start: u16, tries: u16) -> Result<tokio::net::TcpListener, String> {
    for offset in 0..tries {
        let Some(port) = start.checked_add(offset) else { break };
        match tokio::net::TcpListener::bind(SocketAddr::new(host, port)).await {
            Ok(l) => return Ok(l),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(e) => return Err(format!("cannot bind {}: {e}", SocketAddr::new(host, port))),
        }
    }
    tokio::net::TcpListener::bind(SocketAddr::new(host, 0))
        .await
        .map_err(|e| format!("cannot bind {}: {e}", SocketAddr::new(host, 0)))
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod port_tests {
    use super::*;

    /// UT-22: the default port falls through to the next free one; an explicit `0` is never used here.
    #[tokio::test]
    async fn ut_22_busy_default_port_moves_to_the_next_free_one() {
        let host = IpAddr::V4(Ipv4Addr::LOCALHOST);
        // a free start port: let the OS choose one, then keep it occupied
        let busy = tokio::net::TcpListener::bind(SocketAddr::new(host, 0)).await.unwrap();
        let start = busy.local_addr().unwrap().port();
        let next = bind_from(host, start, 5).await.unwrap();
        let got = next.local_addr().unwrap().port();
        assert_ne!(got, start, "must not reuse the busy port");
        assert!(got > start && got < start + 5, "moved to the next free port, got {got}");
    }

    #[tokio::test]
    async fn ut_22_all_tries_busy_falls_back_to_an_os_port() {
        let host = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let busy = tokio::net::TcpListener::bind(SocketAddr::new(host, 0)).await.unwrap();
        let start = busy.local_addr().unwrap().port();
        let got = bind_from(host, start, 1).await.unwrap().local_addr().unwrap().port();
        assert_ne!(got, start);
        assert_ne!(got, 0);
    }
}

