//! File tree scanner (PRD 7, 10.2, 10.3).
//!
//! Symlinks are handled manually: an in-root symlink is listed and followed, an out-of-root,
//! dangling or invisible one is skipped, and a directory symlink that points at the current
//! directory or one of its ancestors (a cycle) is omitted.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::resolve::{
    has_extension, rel_to_string, visible, Resolver, LISTED_EXTENSIONS, SERVED_EXTENSIONS,
};

/// Entry cap of PRD 7.2.
pub const MAX_ENTRIES: usize = 50_000;
/// Directory depth cap of PRD 7.2.
pub const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Directory,
    File,
}

/// One node of `GET /api/tree`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TreeEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: EntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<TreeEntry>,
}

/// Snapshot record of a visible, whitelisted file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileInfo {
    /// Canonical path relative to the root, `/` separated.
    pub canonical_rel: String,
}

/// The cached tree state (PRD 10.2): what `/api/tree` returns plus the snapshot index.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TreeState {
    pub entries: Vec<TreeEntry>,
    /// Listed path -> info, for every visible whitelisted file (assets included).
    pub index: HashMap<String, FileInfo>,
    /// Canonical relative path -> every listed path that leads to it.
    pub aliases: HashMap<String, Vec<String>>,
    pub truncated: bool,
}

pub fn scan(resolver: &Resolver) -> TreeState {
    scan_with_limits(resolver, MAX_ENTRIES, MAX_DEPTH)
}

/// Like [`scan`], but fails when the root itself cannot be listed, so that a live rebuild can keep the
/// previous tree instead of swapping in an empty one (PRD 8.3).
pub fn try_scan(resolver: &Resolver) -> std::io::Result<TreeState> {
    fs::read_dir(resolver.root())?;
    Ok(scan(resolver))
}

pub fn scan_with_limits(resolver: &Resolver, max_entries: usize, max_depth: usize) -> TreeState {
    let mut scanner = Scanner {
        resolver,
        max_entries,
        max_depth,
        count: 0,
        truncated: false,
        index: HashMap::new(),
        aliases: HashMap::new(),
    };
    let root = resolver.root().to_path_buf();
    let mut chain = vec![root.clone()];
    let entries = scanner.scan_dir(&root, "", &root, &mut chain, 0);
    TreeState {
        entries,
        index: scanner.index,
        aliases: scanner.aliases,
        truncated: scanner.truncated,
    }
}

struct Scanner<'a> {
    resolver: &'a Resolver,
    max_entries: usize,
    max_depth: usize,
    count: usize,
    truncated: bool,
    index: HashMap<String, FileInfo>,
    aliases: HashMap<String, Vec<String>>,
}

impl Scanner<'_> {
    /// `read_from` is the lexical path to read (may go through a symlink); `canonical_dir` is the
    /// canonical path of that directory; `chain` holds the canonical paths of the directories on the
    /// current descent.
    fn scan_dir(
        &mut self,
        read_from: &Path,
        listed_prefix: &str,
        canonical_dir: &Path,
        chain: &mut Vec<PathBuf>,
        depth: usize,
    ) -> Vec<TreeEntry> {
        let Ok(read_dir) = fs::read_dir(read_from) else {
            return Vec::new();
        };
        let mut names: Vec<(String, PathBuf, fs::FileType)> = Vec::new();
        for entry in read_dir.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue; // names that are not valid UTF-8 are never listed
            };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            names.push((name, entry.path(), file_type));
        }
        names.sort_by(|a, b| a.0.cmp(&b.0));

        let include_hidden = self.resolver.include_hidden();
        let ignored = self.resolver.ignored();
        let root = self.resolver.root().to_path_buf();
        let mut out: Vec<TreeEntry> = Vec::new();

        for (name, path, file_type) in names {
            if self.truncated {
                break;
            }
            let listed = if listed_prefix.is_empty() {
                name.clone()
            } else {
                format!("{listed_prefix}/{name}")
            };
            if !visible(Path::new(&listed), include_hidden, ignored) {
                continue;
            }

            // Work out the canonical target and whether it is a directory.
            let (canonical, is_dir, is_symlink) = if file_type.is_symlink() {
                let Ok(target) = fs::canonicalize(&path) else {
                    continue; // dangling
                };
                let Ok(rel) = target.strip_prefix(&root) else {
                    continue; // outside the root
                };
                if !visible(rel, include_hidden, ignored) {
                    continue;
                }
                let Ok(meta) = fs::metadata(&target) else {
                    continue;
                };
                if !meta.is_dir() && !meta.is_file() {
                    continue; // FIFO, socket or device: never listed or indexed
                }
                (target.clone(), meta.is_dir(), true)
            } else if file_type.is_dir() {
                (canonical_dir.join(&name), true, false)
            } else if file_type.is_file() {
                (canonical_dir.join(&name), false, false)
            } else {
                continue;
            };

            if is_dir {
                if depth >= self.max_depth {
                    continue;
                }
                // Cycle: the target is the current directory or one of its ancestors.
                if is_symlink && chain.iter().any(|a| a == &canonical || a.starts_with(&canonical))
                {
                    continue;
                }
                self.count += 1;
                if self.count > self.max_entries {
                    self.truncated = true;
                    break;
                }
                chain.push(canonical.clone());
                let children = self.scan_dir(&path, &listed, &canonical, chain, depth + 1);
                chain.pop();
                if !children.is_empty() {
                    out.push(TreeEntry {
                        name,
                        kind: EntryKind::Directory,
                        path: None,
                        children,
                    });
                }
            } else {
                // Index every visible whitelisted file; list only the previewable ones.
                if !has_extension(Path::new(&name), SERVED_EXTENSIONS)
                    || !has_extension(&canonical, SERVED_EXTENSIONS)
                {
                    continue;
                }
                self.count += 1;
                if self.count > self.max_entries {
                    self.truncated = true;
                    break;
                }
                let canonical_rel = canonical
                    .strip_prefix(&root)
                    .map(rel_to_string)
                    .unwrap_or_default();
                self.aliases
                    .entry(canonical_rel.clone())
                    .or_default()
                    .push(listed.clone());
                self.index.insert(
                    listed.clone(),
                    FileInfo {
                        canonical_rel: canonical_rel.clone(),
                    },
                );
                if has_extension(Path::new(&name), LISTED_EXTENSIONS) {
                    out.push(TreeEntry {
                        name,
                        kind: EntryKind::File,
                        path: Some(listed),
                        children: Vec::new(),
                    });
                }
            }
        }

        // Directories before files, then by lower-cased name.
        out.sort_by(|a, b| {
            let ka = (a.kind != EntryKind::Directory, a.name.to_lowercase());
            let kb = (b.kind != EntryKind::Directory, b.name.to_lowercase());
            ka.cmp(&kb)
        });
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestDir;

    fn names(entries: &[TreeEntry]) -> Vec<String> {
        entries.iter().map(|e| e.name.clone()).collect()
    }

    fn find<'a>(entries: &'a [TreeEntry], path: &str) -> Option<&'a TreeEntry> {
        for e in entries {
            if e.path.as_deref() == Some(path) {
                return Some(e);
            }
            if let Some(found) = find(&e.children, path) {
                return Some(found);
            }
        }
        None
    }

    #[test]
    fn ut_08_cycles_are_omitted_and_depth_is_capped() {
        let dir = TestDir::new("ut08");
        dir.write("README.md", "# r");
        dir.write("a/page.md", "# p");
        dir.symlink("..", "loop/self"); // points at the root, an ancestor of loop/
        dir.symlink("../a", "a/b"); // points at its own parent
        let r = Resolver::new(&dir.path, false).unwrap();
        let tree = scan(&r);

        // The scan terminates, lists the real files and shows no cycle entry.
        assert!(find(&tree.entries, "README.md").is_some());
        assert!(find(&tree.entries, "a/page.md").is_some());
        assert!(!names(&tree.entries).contains(&"loop".to_string()), "loop/ holds only a cycle");
        let a = tree.entries.iter().find(|e| e.name == "a").unwrap();
        assert_eq!(names(&a.children), vec!["page.md".to_string()]);

        // Depth cap: a file 10 levels down is not listed with max_depth 4.
        let deep = TestDir::new("ut08deep");
        let mut rel = String::new();
        for i in 0..10 {
            rel.push_str(&format!("d{i}/"));
        }
        deep.write(&format!("{rel}deep.md"), "# deep");
        deep.write("top.md", "# top");
        let r = Resolver::new(&deep.path, false).unwrap();
        let tree = scan_with_limits(&r, 1000, 4);
        assert!(find(&tree.entries, "top.md").is_some());
        assert!(find(&tree.entries, &format!("{rel}deep.md")).is_none());
        let full = scan_with_limits(&r, 1000, 64);
        assert!(find(&full.entries, &format!("{rel}deep.md")).is_some());
    }

    #[test]
    fn ut_09_entry_cap_sets_truncated() {
        let dir = TestDir::new("ut09");
        for i in 0..20 {
            dir.write(&format!("f{i:02}.md"), "# f");
        }
        let r = Resolver::new(&dir.path, false).unwrap();
        let capped = scan_with_limits(&r, 5, 64);
        assert!(capped.truncated);
        assert!(capped.entries.len() <= 5);
        let full = scan_with_limits(&r, 100, 64);
        assert!(!full.truncated);
        assert_eq!(full.entries.len(), 20);
    }

    #[test]
    fn ut_10_aliases_link_listed_paths_to_one_canonical_path() {
        let dir = TestDir::new("ut10");
        dir.write("docs/x.md", "# x");
        dir.write("docs/style.css", "h1{}");
        dir.symlink("docs", "link-in");
        let r = Resolver::new(&dir.path, false).unwrap();
        let tree = scan(&r);

        let aliases = tree.aliases.get("docs/x.md").expect("aliases for docs/x.md");
        let mut sorted = aliases.clone();
        sorted.sort();
        assert_eq!(sorted, vec!["docs/x.md".to_string(), "link-in/x.md".to_string()]);
        assert_eq!(tree.index["link-in/x.md"].canonical_rel, "docs/x.md");
        // Assets are indexed (for change classification) but not listed in the tree.
        assert!(tree.index.contains_key("docs/style.css"));
        assert!(find(&tree.entries, "docs/style.css").is_none());
        assert!(find(&tree.entries, "link-in/x.md").is_some());
    }

    #[test]
    fn ut_11_pruning_sorting_and_skipped_entries() {
        let outer = TestDir::new("ut11");
        outer.write("site/zeta.md", "# z");
        outer.write("site/Alpha.md", "# a");
        outer.write("site/only-text/notes.txt", "t");
        outer.write("site/deep/er/est/found.md", "# f");
        outer.write("site/node_modules/pkg/index.md", "# n");
        outer.write("site/.hidden/h.md", "# h");
        outer.write("outside/o.md", "# o");
        outer.symlink(outer.path.join("outside"), "site/link-out");
        outer.symlink("missing", "site/dangling");
        let r = Resolver::new(&outer.path.join("site"), false).unwrap();
        let tree = scan(&r);

        let top = names(&tree.entries);
        // Directories first, then files by lower-cased name.
        assert_eq!(top, vec!["deep", "Alpha.md", "zeta.md"]);
        // A directory with no supported file at any depth is pruned; a deep match keeps its chain.
        assert!(find(&tree.entries, "deep/er/est/found.md").is_some());
        assert!(!top.contains(&"only-text".to_string()));
        // Ignored, hidden, out-of-root and dangling entries are absent.
        for absent in ["node_modules", ".hidden", "link-out", "dangling"] {
            assert!(!top.contains(&absent.to_string()), "{absent}");
        }
        // include_hidden opens the dot folder but never node_modules.
        let r2 = Resolver::new(&outer.path.join("site"), true).unwrap();
        let tree2 = scan(&r2);
        let top2 = names(&tree2.entries);
        assert!(top2.contains(&".hidden".to_string()));
        assert!(!top2.contains(&"node_modules".to_string()));
    }

    #[test]
    fn ut_09_default_caps_match_the_prd() {
        assert_eq!(MAX_ENTRIES, 50_000);
        assert_eq!(MAX_DEPTH, 64);
    }

    #[test]
    fn ut_11_special_file_symlinks_are_not_indexed() {
        let dir = TestDir::new("ut11fifo");
        dir.write("real.md", "# r");
        // The FIFO must carry a whitelisted extension, otherwise the extension check hides the bug.
        let fifo = dir.path.join("pipe.md");
        let made = std::process::Command::new("mkfifo").arg(&fifo).status();
        if !matches!(made, Ok(s) if s.success()) {
            eprintln!("ut_11: skipping the FIFO sub-case (mkfifo unavailable)");
            return;
        }
        dir.symlink("pipe.md", "fifo-link.md");
        let r = Resolver::new(&dir.path, false).unwrap();
        let tree = scan(&r);
        assert!(find(&tree.entries, "real.md").is_some());
        assert!(!tree.index.contains_key("fifo-link.md"));
        assert!(find(&tree.entries, "fifo-link.md").is_none());
        assert_eq!(
            r.resolve("fifo-link.md", crate::resolve::Endpoint::Files),
            Err(crate::resolve::Denied::NotRegularFile)
        );
    }
}
