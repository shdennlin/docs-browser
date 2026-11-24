//! docs-browser entry point. T-2.0 provides the minimal CLI; the full CLI arrives in milestone M5.

use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;
use docs_browser::resolve::Resolver;
use docs_browser::server::{router, AppState};
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
    /// Address to bind
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    /// Make dot-prefixed files and folders visible and readable
    #[arg(long)]
    include_hidden: bool,
}

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

async fn run() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let resolver = Resolver::new(&cli.directory, cli.include_hidden)
        .map_err(|e| anyhow::anyhow!("directory not usable: {}: {e}", cli.directory.display()))?;
    let root = resolver.root().to_path_buf();

    let listener = tokio::net::TcpListener::bind((cli.host.as_str(), cli.port))
        .await
        .map_err(|e| anyhow::anyhow!("cannot bind {}:{}: {e}", cli.host, cli.port))?;
    let local = listener.local_addr()?;

    let state = AppState::new(resolver, local);
    eprintln!("Serving {} at http://{}", root.display(), local);

    // Live reload: if the OS watcher cannot start, the server keeps serving (PRD 8.5).
    let include_hidden = state.resolver.include_hidden();
    let live = watch::init_live(&state, &root, |r, tx| watch::start_watcher(r, include_hidden, tx));
    let _watcher_guard = live.map(|(handle, rx)| {
        tokio::spawn(watch::run(Arc::new(watch::Pipeline::new(state.clone())), rx));
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
        .await?;
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
