//! A file given on the command line (PRD 9): the served root is the nearest enclosing git repository
//! (a `.git` folder or file), or the file's own folder when there is none. The page then opens that
//! file with `?file=<path relative to the root>`.

use std::fs;
use std::path::{Path, PathBuf};

use crate::resolve::{has_extension, LISTED_EXTENSIONS};

#[derive(Debug, PartialEq)]
pub struct Entry {
    /// Canonical root to serve.
    pub root: PathBuf,
    /// The file relative to `root`, `/` separated.
    pub rel: String,
}

/// The nearest ancestor of `canon_file`'s folder that holds `.git`, else that folder. Walks the file
/// system only: no `git` command runs, so nothing configured by a repository is executed.
pub fn root_for_file(canon_file: &Path) -> PathBuf {
    let parent = canon_file.parent().unwrap_or(canon_file);
    parent
        .ancestors()
        .find(|dir| dir.join(".git").exists())
        .unwrap_or(parent)
        .to_path_buf()
}

/// Checks the argument and works out its root and relative path. The error text is for the user.
pub fn resolve_entry(input: &Path) -> Result<Entry, String> {
    let meta = fs::metadata(input).map_err(|e| format!("cannot read file: {e}"))?;
    if !meta.is_file() {
        return Err("not a file".to_string());
    }
    // The same types the tree lists (PRD 7.4): documents, images, PDF, JSON and YAML. SVG and the rest are refused.
    if !has_extension(input, LISTED_EXTENSIONS) {
        return Err("not a Markdown, HTML, image, PDF, JSON or YAML file".to_string());
    }
    let canon = fs::canonicalize(input).map_err(|e| format!("cannot read file: {e}"))?;
    let root = root_for_file(&canon);
    let rel_path = canon.strip_prefix(&root).map_err(|_| "file is outside its root".to_string())?;
    let mut parts = Vec::new();
    for c in rel_path.components() {
        parts.push(c.as_os_str().to_str().ok_or("file name is not valid UTF-8")?.to_string());
    }
    Ok(Entry { root, rel: parts.join("/") })
}

/// `base` (a URL ending in `/`) plus `?file=` and the relative path, percent-encoded per byte.
/// Slashes stay as they are; everything outside the unreserved set is encoded.
pub fn file_url(base: &str, rel: &str) -> String {
    let mut out = String::with_capacity(base.len() + rel.len() + 8);
    out.push_str(base);
    out.push_str("?file=");
    for b in rel.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("docs-browser-entry-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// UT-23: the root is the nearest `.git` above the file (a folder or a file, as in a worktree);
    /// without one it is the file's folder.
    #[test]
    fn ut_23_root_is_the_nearest_git_repository_or_the_file_folder() {
        let base = tmp("root");
        let repo = base.join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join("a/b")).unwrap();
        fs::write(repo.join("a/b/c.md"), "x").unwrap();
        let canon = fs::canonicalize(&repo).unwrap();
        let e = resolve_entry(&repo.join("a/b/c.md")).unwrap();
        assert_eq!(e, Entry { root: canon.clone(), rel: "a/b/c.md".into() });

        // a nested worktree-style `.git` file wins over the outer repository
        let wt = repo.join("wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), "gitdir: elsewhere\n").unwrap();
        fs::write(wt.join("n.md"), "x").unwrap();
        let e = resolve_entry(&wt.join("n.md")).unwrap();
        assert_eq!(e.root, fs::canonicalize(&wt).unwrap());
        assert_eq!(e.rel, "n.md");

        // no repository above: the file's own folder
        let plain = base.join("plain");
        fs::create_dir_all(&plain).unwrap();
        fs::write(plain.join("p.md"), "x").unwrap();
        let e = resolve_entry(&plain.join("p.md")).unwrap();
        assert_eq!(e.root, fs::canonicalize(&plain).unwrap());
        assert_eq!(e.rel, "p.md");

        // listed types are accepted; SVG and other types are refused, and so are missing files
        fs::write(plain.join("p.png"), "x").unwrap();
        assert_eq!(resolve_entry(&plain.join("p.png")).unwrap().rel, "p.png");
        fs::write(plain.join("p.svg"), "x").unwrap();
        assert!(resolve_entry(&plain.join("p.svg")).unwrap_err().contains("not a Markdown"));
        assert!(resolve_entry(&plain).unwrap_err().contains("not a file"));
        assert!(resolve_entry(&plain.join("missing.md")).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    /// UT-30: every type the viewer lists is accepted as a file argument; other types are refused.
    #[test]
    fn ut_30_file_argument_accepts_the_listed_types_only() {
        let base = std::env::temp_dir().join(format!("docs-browser-ut30-{}", std::process::id()));
        let plain = base.join("plain");
        fs::create_dir_all(&plain).unwrap();
        for name in ["a.md", "a.markdown", "a.html", "a.htm", "a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.avif", "a.pdf", "a.json", "a.yaml", "a.yml"] {
            fs::write(plain.join(name), "x").unwrap();
            assert!(resolve_entry(&plain.join(name)).is_ok(), "{name} is accepted");
        }
        for name in ["a.svg", "a.txt", "a.env", "a.js", "a"] {
            fs::write(plain.join(name), "x").unwrap();
            assert!(resolve_entry(&plain.join(name)).is_err(), "{name} is refused");
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// UT-24: the query value is percent-encoded per byte, slashes are kept, the base URL is kept.
    #[test]
    fn ut_24_file_url_encodes_the_relative_path() {
        assert_eq!(file_url("http://127.0.0.1:4747/", "a.md"), "http://127.0.0.1:4747/?file=a.md");
        assert_eq!(
            file_url("http://127.0.0.1:4747/", "docs/a b+c.md"),
            "http://127.0.0.1:4747/?file=docs/a%20b%2Bc.md"
        );
        assert_eq!(
            file_url("http://127.0.0.1:4747/", "中文/筆記.md"),
            "http://127.0.0.1:4747/?file=%E4%B8%AD%E6%96%87/%E7%AD%86%E8%A8%98.md"
        );
        assert_eq!(file_url("http://h/", "x~y_z-1.markdown"), "http://h/?file=x~y_z-1.markdown");
    }
}
