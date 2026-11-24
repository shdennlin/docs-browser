//! Full-text search over the visible Markdown and HTML files (PRD 11, `GET /api/search`).
//!
//! The search runs on demand, with no stored index. Every candidate goes through the same resolver as
//! `/files/*`, so the visibility rules, the extension whitelist and the symlink checks apply unchanged.

use std::collections::HashSet;

use serde::Serialize;

use crate::resolve::{has_extension, Endpoint, Resolver, SUPPORTED_EXTENSIONS};
use crate::tree::TreeState;

pub const MIN_QUERY_CHARS: usize = 2;
pub const MAX_QUERY_CHARS: usize = 200;
/// Files listed in one response.
pub const MAX_RESULT_FILES: usize = 100;
/// Matching lines shown per file.
pub const MAX_MATCHES_PER_FILE: usize = 3;
/// Files larger than this are skipped (the same cap as `/api/file`).
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// The search stops after reading this many bytes in total.
pub const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const CONTEXT_BEFORE: usize = 60;
const CONTEXT_AFTER: usize = 100;

/// One matching line, cut around the first hit: `before`, `hit` and `after` join to the snippet.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Match {
    pub line: usize,
    pub before: String,
    pub hit: String,
    pub after: String,
    pub more_before: bool,
    pub more_after: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileResult {
    /// The listed path (the first one, in sorted order, when a file is reachable through symlinks).
    pub path: String,
    /// Lines that contain the query (all of them, not only the ones shown).
    pub count: usize,
    pub matches: Vec<Match>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchResponse {
    pub query: String,
    pub results: Vec<FileResult>,
    /// True when a limit stopped the search before every file was read.
    pub truncated: bool,
    pub files_scanned: usize,
}

/// Why a query is refused (HTTP 400).
#[derive(Debug, PartialEq, Eq)]
pub enum BadQuery {
    TooShort,
    TooLong,
}

/// Trims the query and checks its length in characters.
pub fn validate(raw: &str) -> Result<String, BadQuery> {
    let q = raw.trim();
    let n = q.chars().count();
    if n < MIN_QUERY_CHARS {
        return Err(BadQuery::TooShort);
    }
    if n > MAX_QUERY_CHARS {
        return Err(BadQuery::TooLong);
    }
    Ok(q.to_string())
}

/// Removes `<...>` tags so that HTML is searched by its text. Newlines are kept, so line numbers stay
/// close to the source. Script and style bodies are not removed.
pub fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if in_tag => {
                if c == '\n' {
                    out.push('\n');
                }
            }
            _ => out.push(c),
        }
    }
    out
}

/// Cuts a snippet around the byte range `[pos, pos + len)` of `line`, at character boundaries.
fn snippet(line: &str, pos: usize, len: usize) -> Match {
    let before_all = &line[..pos];
    let after_all = &line[pos + len..];
    let before_chars: Vec<(usize, char)> = before_all.char_indices().collect();
    let (before, more_before) = if before_chars.len() > CONTEXT_BEFORE {
        (&before_all[before_chars[before_chars.len() - CONTEXT_BEFORE].0..], true)
    } else {
        (before_all, false)
    };
    let (after, more_after) = match after_all.char_indices().nth(CONTEXT_AFTER) {
        Some((i, _)) => (&after_all[..i], true),
        None => (after_all, false),
    };
    Match {
        line: 0,
        before: before.to_string(),
        hit: line[pos..pos + len].to_string(),
        after: after.to_string(),
        more_before,
        more_after,
    }
}

/// Searches one file's text. The comparison ignores ASCII case only, so byte offsets are the same in
/// the original and the folded text; letters outside ASCII (for example CJK) are matched exactly.
pub fn search_text(text: &str, needle_lower: &str) -> (usize, Vec<Match>) {
    let mut count = 0;
    let mut shown = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let folded = line.to_ascii_lowercase();
        if let Some(pos) = folded.find(needle_lower) {
            count += 1;
            if shown.len() < MAX_MATCHES_PER_FILE {
                let mut m = snippet(line, pos, needle_lower.len());
                m.line = i + 1;
                shown.push(m);
            }
        }
    }
    (count, shown)
}

pub fn search(resolver: &Resolver, tree: &TreeState, query: &str) -> SearchResponse {
    let needle = query.to_ascii_lowercase();
    let mut listed: Vec<&String> = tree
        .index
        .keys()
        .filter(|p| has_extension(std::path::Path::new(p.as_str()), SUPPORTED_EXTENSIONS))
        .collect();
    listed.sort();

    let mut results = Vec::new();
    let mut seen_files: HashSet<String> = HashSet::new();
    let mut scanned = 0usize;
    let mut total = 0u64;
    let mut truncated = false;

    for path in listed {
        // A file reachable through symlinks is searched once, under its first listed path.
        let Ok(resolved) = resolver.resolve(path, Endpoint::Files) else {
            continue;
        };
        if !seen_files.insert(resolved.canonical_rel.clone()) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&resolved.path) else {
            continue;
        };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        if total + meta.len() > MAX_TOTAL_BYTES {
            truncated = true;
            break;
        }
        let Ok(bytes) = std::fs::read(&resolved.path) else {
            continue;
        };
        total += bytes.len() as u64;
        scanned += 1;
        let text = String::from_utf8_lossy(&bytes);
        let is_html = path.to_ascii_lowercase().ends_with(".html") || path.to_ascii_lowercase().ends_with(".htm");
        let (count, matches) = if is_html {
            search_text(&strip_tags(&text), &needle)
        } else {
            search_text(&text, &needle)
        };
        if count > 0 {
            if results.len() >= MAX_RESULT_FILES {
                truncated = true;
                break;
            }
            results.push(FileResult { path: path.clone(), count, matches });
        }
    }
    SearchResponse { query: query.to_string(), results, truncated, files_scanned: scanned }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestDir;
    use crate::tree::scan;

    fn run(dir: &TestDir, include_hidden: bool, q: &str) -> SearchResponse {
        let resolver = Resolver::new(&dir.path, include_hidden).unwrap();
        let tree = scan(&resolver);
        search(&resolver, &tree, &validate(q).unwrap())
    }

    fn paths(r: &SearchResponse) -> Vec<String> {
        r.results.iter().map(|f| f.path.clone()).collect()
    }

    #[test]
    fn ut_17_search_finds_text_in_visible_markdown_and_html_only() {
        let dir = TestDir::new("ut17");
        dir.write("a.md", "# Title\nsecond line with a Needle here\nthird\n");
        dir.write("docs/b.html", "<p>The <b>needle</b> is\n<i>in</i> html</p>");
        dir.write("c.markdown", "no hit here\nNEEDLE twice needle\n");
        dir.write("notes.txt", "needle in an unsupported file type\n");
        dir.write("node_modules/pkg/x.md", "needle in an ignored folder\n");
        dir.write(".hidden/h.md", "needle in a hidden folder\n");
        dir.write("style.css", "needle in a stylesheet\n");

        let r = run(&dir, false, "needle");
        assert_eq!(paths(&r), vec!["a.md", "c.markdown", "docs/b.html"]);
        // Case-insensitive; the hit keeps the original spelling and the line number is 1-based.
        let a = &r.results[0].matches[0];
        assert_eq!((a.line, a.hit.as_str()), (2, "Needle"));
        assert_eq!(a.before, "second line with a ");
        assert_eq!(a.after, " here");
        // `count` is the number of matching lines, not of occurrences.
        assert_eq!(r.results[1].count, 1);
        // HTML is searched by its text: the hit inside <b>needle</b> is found, tags are not part of it.
        assert_eq!(r.results[2].matches[0].hit, "needle");
        assert!(!r.results[2].matches[0].after.contains('<'));
        assert!(!r.truncated);

        // include_hidden opens dot folders, never the ignore list.
        let r = run(&dir, true, "needle");
        assert_eq!(paths(&r), vec![".hidden/h.md", "a.md", "c.markdown", "docs/b.html"]);
    }

    #[test]
    fn ut_17_search_respects_symlinks_and_the_size_cap() {
        let outer = TestDir::new("ut17links");
        outer.write("site/docs/a.md", "the needle\n");
        outer.write("outside/o.md", "the needle outside the root\n");
        outer.symlink("docs", "site/link-in");
        outer.symlink(outer.path.join("outside"), "site/link-out");
        outer.symlink(".git", "site/public");
        outer.write("site/.git/c.md", "the needle in .git\n");
        // Larger than the cap: skipped even though it contains the needle.
        let big = "x".repeat((MAX_FILE_BYTES as usize) + 10) + " needle";
        outer.write("site/big.md", &big);
        let resolver = Resolver::new(&outer.path.join("site"), false).unwrap();
        let tree = scan(&resolver);
        let r = search(&resolver, &tree, "needle");
        // The file reachable through the in-root link is listed once, under the first path in sorted order;
        // nothing from outside the root, from .git or from the oversized file appears.
        assert_eq!(paths(&r), vec!["docs/a.md"]);
        assert_eq!(r.files_scanned, 1);
    }

    #[test]
    fn ut_17_snippets_are_cut_on_character_boundaries_and_capped() {
        let long_before = "漢".repeat(200);
        let long_after = "字".repeat(300);
        let dir = TestDir::new("ut17snip");
        dir.write("c.md", &format!("{long_before}needle{long_after}\nneedle again\nneedle 3\nneedle 4\nneedle 5\n"));
        let r = run(&dir, false, "needle");
        let f = &r.results[0];
        assert_eq!(f.count, 5);
        assert_eq!(f.matches.len(), MAX_MATCHES_PER_FILE);
        let m = &f.matches[0];
        assert_eq!(m.before.chars().count(), 60);
        assert_eq!(m.after.chars().count(), 100);
        assert!(m.more_before && m.more_after);
        assert!(!f.matches[1].more_before && !f.matches[1].more_after);
        // A non-ASCII query is matched exactly.
        let r = run(&dir, false, "漢漢漢");
        assert_eq!(r.results[0].count, 1);
    }

    #[test]
    fn ut_18_query_validation_and_result_limit() {
        assert_eq!(validate(" a "), Err(BadQuery::TooShort));
        assert_eq!(validate(""), Err(BadQuery::TooShort));
        assert_eq!(validate("ab"), Ok("ab".to_string()));
        assert_eq!(validate("  漢字  "), Ok("漢字".to_string()));
        assert_eq!(validate(&"x".repeat(201)), Err(BadQuery::TooLong));
        assert!(validate(&"x".repeat(200)).is_ok());

        let dir = TestDir::new("ut18");
        for i in 0..(MAX_RESULT_FILES + 5) {
            dir.write(&format!("f{i:03}.md"), "needle\n");
        }
        let r = run(&dir, false, "needle");
        assert_eq!(r.results.len(), MAX_RESULT_FILES);
        assert!(r.truncated);
        assert_eq!(strip_tags("a<b>c</b>\n<i\nx>d"), "ac\n\nd");
    }
}
