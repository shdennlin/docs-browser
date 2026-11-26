//! Records the short commit hash of an untagged build, for the footer (PRD 7.3). A tagged build records
//! nothing, and so does a build without git (for example from a crate archive).
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn main() {
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-changed=.git/refs");
    println!("cargo:rerun-if-changed=.git/packed-refs");
    let tagged = git(&["describe", "--tags", "--exact-match", "HEAD"]).is_some();
    let hash = if tagged { String::new() } else { git(&["rev-parse", "--short", "HEAD"]).unwrap_or_default() };
    println!("cargo:rustc-env=DOCS_BROWSER_BUILD_HASH={hash}");
}
