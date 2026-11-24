//! docs-browser entry point. T-2.0 provides the minimal CLI; the full CLI arrives in milestone M5.

use std::path::PathBuf;

use clap::Parser;
use docs_browser::resolve::Resolver;
use docs_browser::server::{router, AppState};

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

    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
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
