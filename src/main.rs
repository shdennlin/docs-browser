// T-0.1 scaffold: proves the axum wildcard route syntax and an SSE route compile and run.
use axum::{
    extract::Path,
    response::sse::{Event, KeepAlive, Sse},
    routing::get,
    Router,
};
use std::convert::Infallible;
use std::time::Duration;
use tokio_stream::{wrappers::IntervalStream, StreamExt};

// SPIKE ONLY: echoes the raw path to prove wildcard routing. Replaced by the M2 handler,
// which sends every path through the M1 resolver.
async fn files(Path(path): Path<String>) -> String {
    path
}

async fn events() -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let stream = IntervalStream::new(tokio::time::interval(Duration::from_millis(200)))
        .map(|_| Ok(Event::default().data("tick")));
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let app = Router::new()
        .route("/files/{*path}", get(files))
        .route("/api/events", get(events));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:4190").await?;
    axum::serve(listener, app).await?;
    Ok(())
}
