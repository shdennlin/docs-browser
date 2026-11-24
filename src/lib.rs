//! docs-browser library: path resolution, visibility rules and the file tree scanner.

/// Writes one line to stderr and ignores failures: `eprintln!` panics when stderr is closed
/// (for example `2>&-` or a vanished pipe), which would crash the server or a request handler.
#[macro_export]
macro_rules! elog {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let _ = writeln!(std::io::stderr(), $($arg)*);
    }};
}

pub mod info;
pub mod resolve;
pub mod search;
pub mod server;
pub mod tree;
pub mod watch;

#[cfg(test)]
pub mod testutil;
