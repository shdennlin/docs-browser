//! File facts for the status bar: created and modified times, and, when the file lies in a git
//! repository, the branch, the last commit that touched it and whether it has uncommitted changes.
//!
//! Git is optional: when `git` is missing, the folder is not a repository, or a command is slow or
//! fails, the git part is simply left out. Commands run with a timeout, without a terminal prompt and
//! without optional locks, and never include an author e-mail.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

const GIT_TIMEOUT: Duration = Duration::from_millis(2000);
const MAX_SUBJECT: usize = 200;

#[derive(Debug, Serialize, PartialEq)]
pub struct CommitInfo {
    pub hash: String,
    /// Seconds since the Unix epoch.
    pub time: i64,
    pub subject: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct GitInfo {
    /// Branch name, or the short hash when HEAD is detached.
    pub branch: String,
    /// The last commit that changed the file; `None` for a file git has never seen.
    pub commit: Option<CommitInfo>,
    /// The file differs from its last commit (or is untracked).
    pub dirty: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct FileInfo {
    pub size: u64,
    /// Milliseconds since the Unix epoch.
    pub modified: Option<i64>,
    /// Birth time; `None` where the platform or file system does not record it.
    pub created: Option<i64>,
    pub git: Option<GitInfo>,
}

fn millis(t: SystemTime) -> Option<i64> {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).ok(),
        Err(e) => i64::try_from(e.duration().as_millis()).ok().map(|v| -v),
    }
}

/// Runs `git` in `dir` and returns its trimmed stdout when it exits successfully within the timeout.
fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "core.fsmonitor=false", "-c", "core.quotepath=false"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed() < GIT_TIMEOUT => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    let mut out = String::new();
    child.stdout.take()?.take(64 * 1024).read_to_string(&mut out).ok()?;
    Some(out.trim().to_string())
}

/// Whether the file differs from `HEAD` (an untracked file that is not ignored also counts).
///
/// This deliberately avoids `git status` and `git diff`: they run the clean filters named by a
/// repository's `.gitattributes` and config (`filter.<name>.clean` is an arbitrary command), so reading a
/// folder from an untrusted clone could run code. `rev-parse`, `hash-object --no-filters` and
/// `check-ignore` never run configured commands. The price: a file whose line endings git converts
/// (`core.autocrlf`, `eol` attributes) can show as changed.
fn is_dirty(dir: &Path, name: &str) -> bool {
    let spec = format!("HEAD:./{name}");
    match git(dir, &["rev-parse", "-q", "--verify", &spec]) {
        Some(blob) => match git(dir, &["hash-object", "--no-filters", "--", name]) {
            Some(now) => now != blob,
            None => false,
        },
        // not in HEAD: untracked (changed) unless ignored; `check-ignore -q` exits 0 when ignored
        None => git(dir, &["check-ignore", "-q", "--", name]).is_none(),
    }
}

fn git_info(path: &Path) -> Option<GitInfo> {
    let dir = path.parent()?;
    let name = path.file_name()?.to_str()?;
    // `symbolic-ref` also works before the first commit; it fails on a detached HEAD, which then shows
    // the short hash. Both failing means the folder is not a repository.
    let branch = match git(dir, &["symbolic-ref", "--short", "-q", "HEAD"]) {
        Some(b) if !b.is_empty() => b,
        _ => git(dir, &["rev-parse", "--short", "HEAD"])?,
    };
    let commit = git(dir, &["log", "-1", "--format=%h%x1f%ct%x1f%s", "--", name]).and_then(|line| {
        let mut parts = line.splitn(3, '\u{1f}');
        let hash = parts.next()?.to_string();
        let time = parts.next()?.parse::<i64>().ok()?;
        let subject: String = parts.next().unwrap_or("").chars().take(MAX_SUBJECT).collect();
        (!hash.is_empty()).then_some(CommitInfo { hash, time, subject })
    });
    Some(GitInfo { branch, commit, dirty: is_dirty(dir, name) })
}

/// Reads the facts for a file that the resolver has already approved.
pub fn read(path: &Path) -> Option<FileInfo> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    Some(FileInfo {
        size: meta.len(),
        modified: meta.modified().ok().and_then(millis),
        created: meta.created().ok().and_then(millis),
        git: git_info(path),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn sh(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"])
            .args(args)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "git {args:?} failed");
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("docs-browser-info-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn ut_19_plain_folder_has_times_and_no_git() {
        let d = tmp("plain");
        let f = d.join("a.md");
        fs::write(&f, "hello").unwrap();
        let info = read(&f).expect("info");
        assert_eq!(info.size, 5);
        assert!(info.modified.unwrap() > 0);
        // not inside a repository (the temp dir is outside any checkout)
        assert_eq!(info.git, None);
        assert!(read(&d).is_none(), "a directory has no file info");
        assert!(read(&d.join("missing.md")).is_none());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn ut_21_a_repository_filter_command_is_never_run() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let d = tmp("filter");
        sh(&d, &["init", "-q", "-b", "trunk"]);
        fs::write(d.join(".gitattributes"), "*.md filter=pwn\n").unwrap();
        let f = d.join("a.md");
        fs::write(&f, "# note\n").unwrap();
        sh(&d, &["add", "-A"]);
        sh(&d, &["commit", "-q", "-m", "init"]);
        let marker = d.join("PWNED");
        let clean = format!("sh -c 'touch {}; cat'", marker.display());
        sh(&d, &["config", "filter.pwn.clean", &clean]);
        fs::write(&f, "# nota\n").unwrap(); // same size, new content: git has to read the file
        let g = read(&f).unwrap().git.unwrap();
        assert!(g.dirty, "the change is still noticed");
        assert!(!marker.exists(), "the filter command ran");
        fs::write(&f, "# note\n").unwrap(); // back to the committed content
        assert!(!read(&f).unwrap().git.unwrap().dirty);
        assert!(!marker.exists(), "the filter command ran");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn ut_20_repository_reports_branch_commit_and_dirty() {
        if Command::new("git").arg("--version").output().is_err() {
            return; // git is optional
        }
        let d = tmp("repo");
        sh(&d, &["init", "-q", "-b", "trunk"]);
        let f = d.join("a.md");
        fs::write(&f, "one").unwrap();
        let untracked = read(&f).unwrap().git.unwrap();
        assert_eq!(untracked.branch, "trunk");
        assert!(untracked.commit.is_none() && untracked.dirty);
        sh(&d, &["add", "a.md"]);
        sh(&d, &["commit", "-q", "-m", "first note"]);
        let clean = read(&f).unwrap().git.unwrap();
        let c = clean.commit.expect("commit");
        assert_eq!(c.subject, "first note");
        assert!(c.time > 0 && !c.hash.is_empty());
        assert!(!clean.dirty);
        fs::write(&f, "two").unwrap();
        assert!(read(&f).unwrap().git.unwrap().dirty);
        let _ = fs::remove_dir_all(&d);
    }
}
