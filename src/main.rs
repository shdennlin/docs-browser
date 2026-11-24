//! docs-browser entry point (PRD 9): flags, exit codes, startup messages, signals.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;
use docs_browser::resolve::Resolver;
use docs_browser::server::{escape_log, router, AppState};
use docs_browser::watch;

#[derive(Parser)]
#[command(name = "docs-browser", version, about = "Zero-config local browser for project documentation")]
struct Cli {
    /// Directory to serve
    #[arg(default_value = ".")]
    directory: PathBuf,
    /// TCP port (0 asks the OS for a free port)
    #[arg(long, default_value_t = 3000)]
    port: u16,
    /// Address to bind (an IP address, or `localhost`)
    #[arg(long, default_value = "127.0.0.1", value_parser = parse_host)]
    host: IpAddr,
    /// Open the page in the default browser
    #[arg(long)]
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

    match std::fs::metadata(&cli.directory) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => {
            return Err(Failure { code: 2, message: format!("not a directory: {}", shown(&cli.directory)) })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(Failure { code: 2, message: format!("directory not found: {}", shown(&cli.directory)) })
        }
        Err(e) => {
            return Err(Failure { code: 2, message: format!("cannot read directory: {}: {e}", shown(&cli.directory)) })
        }
    }
    // A directory that exists but cannot be listed would start and serve an empty tree in silence.
    if let Err(e) = std::fs::read_dir(&cli.directory) {
        return Err(Failure { code: 2, message: format!("cannot read directory: {}: {e}", shown(&cli.directory)) });
    }
    let resolver = Resolver::new(&cli.directory, cli.include_hidden).map_err(|e| Failure {
        code: 2,
        message: format!("cannot use directory: {}: {e}", shown(&cli.directory)),
    })?;
    let root = resolver.root().to_path_buf();

    let wanted = SocketAddr::new(cli.host, cli.port);
    let listener = tokio::net::TcpListener::bind(wanted)
        .await
        .map_err(|e| Failure { code: 1, message: format!("cannot bind {wanted}: {e}") })?;
    let local = listener.local_addr().map_err(|e| Failure { code: 1, message: e.to_string() })?;

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

    if cli.open {
        let url = docs_browser::server::browse_url(local);
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
