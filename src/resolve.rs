//! Path resolution and visibility rules (PRD sections 7.1 and 12.2).
//!
//! Every request path goes through [`Resolver::resolve`]. The resolver never percent-decodes:
//! it receives the string produced by axum's single decoding (spike T-0.9).

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

/// Folder names that are never visible, compared case-insensitively (PRD 7.1).
pub const IGNORED_NAMES: [&str; 5] = [".git", "node_modules", "dist", "build", ".cache"];

/// Extensions served by `/files/*`, compared case-insensitively (PRD 7.1).
pub const SERVED_EXTENSIONS: &[&str] = &[
    "html", "htm", "md", "markdown", "css", "js", "mjs", "svg", "png", "jpg", "jpeg", "gif",
    "webp", "avif", "ico", "bmp", "pdf", "woff", "woff2", "ttf", "otf",
];

/// Extensions listed in the tree and previewed as documents (PRD 7). Also used by search and by the
/// file argument, which stay on documents only.
pub const SUPPORTED_EXTENSIONS: &[&str] = &["md", "markdown", "html", "htm"];

/// Extensions listed in the tree (PRD 7.3): the documents, plus raster images and PDF, which the viewer
/// shows directly from `/files/*`. SVG is not listed: it can carry script, so it is served but not shown.
pub const LISTED_EXTENSIONS: &[&str] = &[
    "md", "markdown", "html", "htm", "png", "jpg", "jpeg", "gif", "webp", "avif", "pdf", "json",
    "yaml", "yml",
];

/// Text files previewed as plain text through `/api/file` only (PRD 7.4). They are not on the
/// `/files/*` whitelist, so the page cannot load them directly.
pub const PREVIEW_TEXT_EXTENSIONS: &[&str] = &["json", "yaml", "yml"];

/// Whether the tree and the watcher index a file: a whitelisted file, or a text preview.
pub fn is_indexed(path: &Path) -> bool {
    has_extension(path, SERVED_EXTENSIONS) || has_extension(path, PREVIEW_TEXT_EXTENSIONS)
}

/// Extensions accepted by `/api/file`.
pub const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endpoint {
    /// `/files/*`: whitelist of served extensions.
    Files,
    /// `/api/file`: Markdown files only.
    ApiFile,
    /// `/api/file` for previews: Markdown, plus the text previews (JSON and YAML).
    ApiText,
}

/// Why a path was refused. Every variant is a 404 on the wire except `UnsupportedType` (415).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Denied {
    Empty,
    Traversal(&'static str),
    NotFound,
    Permission,
    OutsideRoot,
    NotVisible,
    NotWhitelisted,
    NotRegularFile,
    UnsupportedType,
    Io(io::ErrorKind),
}

impl Denied {
    /// Short reason used in the `denied:` log line (PRD 9.3).
    pub fn reason(&self) -> &'static str {
        match self {
            Denied::Empty => "empty-path",
            Denied::Traversal(why) => why,
            Denied::NotFound => "not-found",
            Denied::Permission => "permission",
            Denied::OutsideRoot => "outside-root",
            Denied::NotVisible => "not-visible",
            Denied::NotWhitelisted => "not-whitelisted",
            Denied::NotRegularFile => "not-a-file",
            Denied::UnsupportedType => "unsupported-type",
            Denied::Io(_) => "io-error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    /// Canonical absolute path of the file to read.
    pub path: PathBuf,
    /// Canonical path relative to the root, `/` separated.
    pub canonical_rel: String,
    /// The listed (requested) path relative to the root, `/` separated.
    pub listed_rel: String,
}

#[derive(Debug, Clone)]
pub struct Resolver {
    root: PathBuf,
    include_hidden: bool,
    /// Extra names from `--ignore`, matched exactly against any path component. Added to
    /// `IGNORED_NAMES`; never removes anything from it.
    ignored: Vec<String>,
}

/// Lower-cased extension of `path`, if it has a UTF-8 one.
pub fn extension_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

pub fn has_extension(path: &Path, allowed: &[&str]) -> bool {
    extension_lower(path).map_or(false, |e| allowed.contains(&e.as_str()))
}

/// Visibility rule of PRD 7.1: no dot-prefixed component (unless `include_hidden`) and no
/// component equal, case-insensitively, to an ignored name, or exactly to a name given with
/// `--ignore`. Names that are not valid UTF-8 are never visible.
pub fn visible(rel: &Path, include_hidden: bool, ignored: &[String]) -> bool {
    for component in rel.components() {
        if let Component::Normal(name) = component {
            let Some(name) = name.to_str() else {
                return false;
            };
            let lower = name.to_ascii_lowercase();
            if IGNORED_NAMES.contains(&lower.as_str()) || ignored.iter().any(|n| n == name) {
                return false;
            }
            if name.starts_with('.') && !include_hidden {
                return false;
            }
        }
    }
    true
}

pub fn rel_to_string(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(n) => n.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

impl Resolver {
    /// `ROOT = canonicalize(directory)` (PRD 12.2 step 1).
    pub fn new(dir: &Path, include_hidden: bool) -> io::Result<Self> {
        let root = fs::canonicalize(dir)?;
        if !root.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::NotADirectory,
                "not a directory",
            ));
        }
        Ok(Resolver {
            root,
            include_hidden,
            ignored: Vec::new(),
        })
    }

    /// Adds `--ignore` names. The caller validates them (one path component, no separators).
    pub fn with_ignored(mut self, names: Vec<String>) -> Self {
        self.ignored = names;
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn include_hidden(&self) -> bool {
        self.include_hidden
    }

    pub fn ignored(&self) -> &[String] {
        &self.ignored
    }

    /// Resolves a request path (already decoded once by the HTTP layer) to a readable file.
    pub fn resolve(&self, input: &str, endpoint: Endpoint) -> Result<Resolved, Denied> {
        // Step 3: lexical rejection.
        if input.is_empty() {
            return Err(Denied::Empty);
        }
        if input.contains('\0') {
            return Err(Denied::Traversal("nul-byte"));
        }
        if input.contains('\\') {
            return Err(Denied::Traversal("backslash"));
        }
        let mut listed: PathBuf = PathBuf::new();
        for component in Path::new(input).components() {
            match component {
                Component::Normal(n) => listed.push(n),
                Component::CurDir => {}
                Component::ParentDir => return Err(Denied::Traversal("parent-dir")),
                Component::RootDir => return Err(Denied::Traversal("root-dir")),
                Component::Prefix(_) => return Err(Denied::Traversal("prefix")),
            }
        }
        if listed.as_os_str().is_empty() {
            return Err(Denied::NotRegularFile);
        }

        // Step 4: canonicalize resolves every symlink.
        let target = fs::canonicalize(self.root.join(&listed)).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => Denied::NotFound,
            io::ErrorKind::PermissionDenied => Denied::Permission,
            other => Denied::Io(other),
        })?;

        // Step 5: component-wise prefix check.
        let canonical_rel_path = match target.strip_prefix(&self.root) {
            Ok(rel) => rel.to_path_buf(),
            Err(_) => return Err(Denied::OutsideRoot),
        };

        // Step 6: both the listed and the canonical path must be visible.
        if !visible(&listed, self.include_hidden, &self.ignored)
            || !visible(&canonical_rel_path, self.include_hidden, &self.ignored)
        {
            return Err(Denied::NotVisible);
        }

        // Step 7: a regular file with an allowed extension.
        let meta = fs::metadata(&target).map_err(|e| match e.kind() {
            io::ErrorKind::PermissionDenied => Denied::Permission,
            io::ErrorKind::NotFound => Denied::NotFound,
            other => Denied::Io(other),
        })?;
        if !meta.is_file() {
            return Err(Denied::NotRegularFile);
        }
        match endpoint {
            Endpoint::Files => {
                if !has_extension(&listed, SERVED_EXTENSIONS)
                    || !has_extension(&target, SERVED_EXTENSIONS)
                {
                    return Err(Denied::NotWhitelisted);
                }
            }
            Endpoint::ApiText => {
                let listed_ok = has_extension(&listed, MARKDOWN_EXTENSIONS) || has_extension(&listed, PREVIEW_TEXT_EXTENSIONS);
                let target_ok = has_extension(&target, MARKDOWN_EXTENSIONS) || has_extension(&target, PREVIEW_TEXT_EXTENSIONS);
                if !listed_ok || !target_ok {
                    return Err(Denied::UnsupportedType);
                }
            }
            Endpoint::ApiFile => {
                if !has_extension(&listed, MARKDOWN_EXTENSIONS)
                    || !has_extension(&target, MARKDOWN_EXTENSIONS)
                {
                    return Err(Denied::UnsupportedType);
                }
            }
        }

        Ok(Resolved {
            path: target,
            canonical_rel: rel_to_string(&canonical_rel_path),
            listed_rel: rel_to_string(&listed),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestDir;
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    fn site(label: &str, include_hidden: bool) -> (TestDir, Resolver) {
        let dir = TestDir::new(label);
        dir.write("README.md", "# r");
        dir.write("docs/api.md", "# api");
        dir.write("docs/UPPER.MD", "# up");
        dir.write("docs/pic.PNG", "x");
        dir.write("docs/style.css", "x");
        dir.write("docs/data.json", "{}");
        dir.write("docs/noext", "x");
        dir.write("notes.txt", "t");
        dir.write(".env", "SECRET=1");
        dir.write(".hidden/note.md", "# h");
        dir.write(".git/config", "[core]");
        dir.write("node_modules/pkg/index.md", "# n");
        dir.mkdir("docs/dir.md");
        let resolver = Resolver::new(&dir.path, include_hidden).expect("resolver");
        (dir, resolver)
    }

    #[test]
    fn ut_01_traversal_inputs_are_denied() {
        let (_d, r) = site("ut01", false);
        let cases = [
            ("..", "parent-dir"),
            ("../x", "parent-dir"),
            ("docs/../../x", "parent-dir"),
            ("/etc/hosts", "root-dir"),
            ("docs\\..\\x", "backslash"),
            ("README.md\0x", "nul-byte"),
        ];
        for (input, why) in cases {
            for ep in [Endpoint::Files, Endpoint::ApiFile] {
                let got = r.resolve(input, ep);
                assert_eq!(got, Err(Denied::Traversal(why)), "input {input:?} via {ep:?}");
            }
        }
        // After axum's single decoding, a literal "%2e%2e" is just a file name that does not exist.
        assert_eq!(
            r.resolve("%2e%2e/%2e%2e/etc/hosts", Endpoint::Files),
            Err(Denied::NotFound)
        );
        assert_eq!(r.resolve("", Endpoint::Files), Err(Denied::Empty));
    }

    #[test]
    fn ut_02_sibling_prefix_directory_is_outside_root() {
        let outer = TestDir::new("ut02");
        outer.write("site/README.md", "# r");
        outer.write("site-evil/secret.md", "# secret");
        outer.symlink("../site-evil", "site/evil");
        let r = Resolver::new(&outer.path.join("site"), false).unwrap();
        assert_eq!(
            r.resolve("evil/secret.md", Endpoint::Files),
            Err(Denied::OutsideRoot)
        );
        assert!(r.resolve("README.md", Endpoint::Files).is_ok());
    }

    #[test]
    fn ut_03_symlink_inside_outside_and_dangling() {
        let outer = TestDir::new("ut03");
        outer.write("site/docs/a.md", "# a");
        outer.write("outside/o.md", "# o");
        outer.symlink("docs", "site/link-in");
        outer.symlink(outer.path.join("outside"), "site/link-out");
        outer.symlink("nowhere", "site/dangling");
        let r = Resolver::new(&outer.path.join("site"), false).unwrap();

        let ok = r.resolve("link-in/a.md", Endpoint::Files).unwrap();
        assert_eq!(ok.canonical_rel, "docs/a.md");
        assert_eq!(ok.listed_rel, "link-in/a.md");

        assert_eq!(
            r.resolve("link-out/o.md", Endpoint::Files),
            Err(Denied::OutsideRoot)
        );
        assert_eq!(
            r.resolve("dangling/x.md", Endpoint::Files),
            Err(Denied::NotFound)
        );
    }

    #[test]
    fn ut_25_ignore_names_match_exactly_at_any_depth_and_never_remove_defaults() {
        let extra = vec!["drafts".to_string()];
        // A listed name hides that component at any depth.
        assert!(!visible(&Path::new("drafts/a.md"), false, &extra));
        assert!(!visible(&Path::new("docs/drafts/a.md"), false, &extra));
        // Exact match only: a longer name, a substring or another case is not hidden.
        assert!(visible(&Path::new("docs/drafts-old/a.md"), false, &extra));
        assert!(visible(&Path::new("docs/my-drafts/a.md"), false, &extra));
        assert!(visible(&Path::new("Drafts/a.md"), false, &extra));
        // Names only ever add: the built-in list still applies with any `--ignore` list.
        for builtin in ["node_modules/x.md", "docs/.git/x", "docs/build/x.md", "dist/x.md", "docs/.cache/x.md"] {
            assert!(!visible(&Path::new(builtin), true, &extra), "{builtin} stays hidden");
        }
        // The file-level resolver applies the same rule to requests.
        let outer = TestDir::new("ut25");
        outer.write("drafts/a.md", "# a");
        outer.write("docs/drafts/b.md", "# b");
        outer.write("docs/keep.md", "# k");
        let r = Resolver::new(&outer.path, false).unwrap().with_ignored(extra.clone());
        assert_eq!(r.resolve("drafts/a.md", Endpoint::Files), Err(Denied::NotVisible));
        // A case variant reaches the same folder on a case-insensitive volume (macOS); the canonical
        // path check in step 6 must still refuse it.
        assert!(r.resolve("Drafts/a.md", Endpoint::Files).is_err(), "case variant of an ignored name");
        assert_eq!(r.resolve("docs/drafts/b.md", Endpoint::ApiFile), Err(Denied::NotVisible));
        assert!(r.resolve("docs/keep.md", Endpoint::ApiFile).is_ok());
        assert_eq!(r.ignored(), extra.as_slice());
    }

    #[test]
    fn ut_27_images_and_pdf_are_listed_and_served_but_svg_is_not_listed() {
        assert!(has_extension(Path::new("docs/pic.PNG"), LISTED_EXTENSIONS));
        assert!(has_extension(Path::new("a.pdf"), LISTED_EXTENSIONS));
        assert!(!has_extension(Path::new("a.svg"), LISTED_EXTENSIONS));
        assert!(has_extension(Path::new("a.json"), LISTED_EXTENSIONS));
        assert!(has_extension(Path::new("a.pdf"), SERVED_EXTENSIONS));
        assert!(!has_extension(Path::new("a.pdf"), MARKDOWN_EXTENSIONS));
    }

    #[test]
    fn ut_29_text_previews_are_api_only_and_never_on_the_files_whitelist() {
        let outer = TestDir::new("ut29");
        outer.write("docs/data.json", "{}");
        outer.write("docs/config.yaml", "a: 1");
        outer.write("docs/notes.md", "# n");
        outer.write("docs/pic.png", "x");
        let r = Resolver::new(&outer.path, false).unwrap();
        assert!(r.resolve("docs/data.json", Endpoint::ApiText).is_ok());
        assert!(r.resolve("docs/config.yaml", Endpoint::ApiText).is_ok());
        assert!(r.resolve("docs/notes.md", Endpoint::ApiText).is_ok());
        assert_eq!(r.resolve("docs/data.json", Endpoint::Files), Err(Denied::NotWhitelisted));
        assert_eq!(r.resolve("docs/config.yaml", Endpoint::Files), Err(Denied::NotWhitelisted));
        assert_eq!(r.resolve("docs/data.json", Endpoint::ApiFile), Err(Denied::UnsupportedType));
        assert_eq!(r.resolve("docs/pic.png", Endpoint::ApiText), Err(Denied::UnsupportedType));
        assert!(is_indexed(Path::new("a.json")));
        assert!(!is_indexed(Path::new("a.txt")));
    }

    #[test]
    fn ut_04_visible_rules_case_and_include_hidden() {
        let p = |s: &str| PathBuf::from(s);
        // Ordinary and nested paths are visible.
        assert!(visible(&p("docs/a.md"), false, &[]));
        // Dot names are hidden by default, visible with include_hidden.
        assert!(!visible(&p(".hidden/a.md"), false, &[]));
        assert!(visible(&p(".hidden/a.md"), true, &[]));
        // Ignored names are excluded in both modes, in any letter case.
        for name in ["node_modules", "Node_Modules", "NODE_MODULES", ".git", ".GIT", ".Git", "dist", "Build", ".CACHE"] {
            let path = p(&format!("{name}/x.md"));
            assert!(!visible(&path, false, &[]), "{name} default");
            assert!(!visible(&path, true, &[]), "{name} include_hidden");
        }
        // Ignored names as an inner component, and as part of a longer name (which is fine).
        assert!(!visible(&p("docs/node_modules/x.md"), true, &[]));
        assert!(visible(&p("docs/my_node_modules_notes/x.md"), false, &[]));
        assert!(visible(&p("distribution/x.md"), false, &[]));
    }

    #[test]
    fn ut_05_visibility_is_checked_on_the_canonical_path() {
        let dir = TestDir::new("ut05");
        dir.write(".git/config", "[core]");
        dir.write("node_modules/pkg/index.md", "# n");
        dir.symlink(".git", "public");
        dir.symlink("node_modules", "modules");
        for include_hidden in [false, true] {
            let r = Resolver::new(&dir.path, include_hidden).unwrap();
            assert_eq!(
                r.resolve("public/config", Endpoint::Files),
                Err(Denied::NotVisible),
                "public -> .git, include_hidden={include_hidden}"
            );
            assert_eq!(
                r.resolve("modules/pkg/index.md", Endpoint::Files),
                Err(Denied::NotVisible),
                "modules -> node_modules, include_hidden={include_hidden}"
            );
        }
    }

    #[test]
    fn ut_06_whitelist_and_extension_case() {
        let (_d, r) = site("ut06", true);
        // Case-insensitive extensions.
        assert!(r.resolve("docs/UPPER.MD", Endpoint::Files).is_ok());
        assert!(r.resolve("docs/pic.PNG", Endpoint::Files).is_ok());
        assert!(r.resolve("docs/style.css", Endpoint::Files).is_ok());
        // Not whitelisted, even though visible: json, txt, no extension, .env (include_hidden on).
        for input in ["docs/data.json", "notes.txt", "docs/noext", ".env"] {
            assert_eq!(
                r.resolve(input, Endpoint::Files),
                Err(Denied::NotWhitelisted),
                "{input}"
            );
        }
        // /api/file accepts Markdown only; a visible non-Markdown file is 415, not 404.
        assert!(r.resolve("docs/UPPER.MD", Endpoint::ApiFile).is_ok());
        assert_eq!(
            r.resolve("notes.txt", Endpoint::ApiFile),
            Err(Denied::UnsupportedType)
        );
        assert_eq!(
            r.resolve("docs/style.css", Endpoint::ApiFile),
            Err(Denied::UnsupportedType)
        );
        // include_hidden opens whitelisted files in dot folders, but never ignored folders.
        assert!(r.resolve(".hidden/note.md", Endpoint::Files).is_ok());
        assert_eq!(
            r.resolve(".git/config", Endpoint::Files),
            Err(Denied::NotVisible)
        );
        assert_eq!(
            r.resolve("node_modules/pkg/index.md", Endpoint::Files),
            Err(Denied::NotVisible)
        );
        // Default mode: dot folders stay closed.
        let closed = Resolver::new(r.root(), false).unwrap();
        assert_eq!(
            closed.resolve(".hidden/note.md", Endpoint::Files),
            Err(Denied::NotVisible)
        );
    }

    #[test]
    fn ut_07_directory_permission_and_non_utf8() {
        let (d, r) = site("ut07", false);
        // A directory (even one named like a Markdown file) is not a file.
        assert_eq!(
            r.resolve("docs/dir.md", Endpoint::ApiFile),
            Err(Denied::NotRegularFile)
        );
        assert_eq!(r.resolve("docs", Endpoint::Files), Err(Denied::NotRegularFile));
        assert_eq!(r.resolve(".", Endpoint::Files), Err(Denied::NotRegularFile));

        // A path component that is not valid UTF-8 is never visible.
        let bad = PathBuf::from(OsStr::from_bytes(b"docs/\xff\xfe.md"));
        assert!(!visible(&bad, true, &[]));

        // Permission denied: a directory without search permission.
        use std::os::unix::fs::PermissionsExt;
        d.write("locked/a.md", "# a");
        let locked = d.path.join("locked");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read_dir(&locked).is_ok() {
            // Running as root: permission checks are bypassed, so this sub-case cannot be tested.
            eprintln!("ut_07: skipping the permission sub-case (permission checks are bypassed)");
        } else {
            assert_eq!(
                r.resolve("locked/a.md", Endpoint::Files),
                Err(Denied::Permission)
            );
        }
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn ut_01_lexical_normalisation_is_safe() {
        let (_d, r) = site("ut01norm", false);
        // `.`, empty segments and a trailing slash are dropped before lookup (documented in PRD 12.2).
        for input in ["./README.md", "README.md/", "docs//api.md", "docs/./api.md"] {
            let got = r.resolve(input, Endpoint::Files).unwrap_or_else(|e| panic!("{input}: {e:?}"));
            assert!(
                got.listed_rel == "README.md" || got.listed_rel == "docs/api.md",
                "{input} -> {}",
                got.listed_rel
            );
        }
        // Normalisation never turns a denied path into an allowed one.
        assert_eq!(r.resolve("./.env", Endpoint::Files), Err(Denied::NotVisible));
        assert_eq!(r.resolve(".//.git/config", Endpoint::Files), Err(Denied::NotVisible));
        assert_eq!(r.resolve("./../x", Endpoint::Files), Err(Denied::Traversal("parent-dir")));
    }

    #[test]
    fn ut_06_file_symlinks_are_checked_on_the_target() {
        let outer = TestDir::new("ut06link");
        outer.write("site/docs/api.md", "# api");
        outer.write("site/docs/data.json", "{}");
        outer.write("site/.env", "SECRET=1");
        outer.write("site/.git/config", "[core]");
        outer.write("outside/o.md", "# o");
        outer.symlink("docs/data.json", "site/a.md"); // visible name, non-whitelisted target
        outer.symlink(".env", "site/b.md"); // target is a dot file
        outer.symlink(outer.path.join("outside/o.md"), "site/c.md"); // target outside the root
        outer.symlink(".git/config", "site/d.md"); // target inside an ignored folder
        outer.symlink("docs/api.md", "site/e.txt"); // allowed target, name not whitelisted
        outer.symlink("docs/api.md", "site/f.md"); // fully allowed file symlink

        for include_hidden in [false, true] {
            let r = Resolver::new(&outer.path.join("site"), include_hidden).unwrap();
            let label = format!("include_hidden={include_hidden}");

            // The canonical target's extension is checked, not only the link's name.
            assert_eq!(r.resolve("a.md", Endpoint::Files), Err(Denied::NotWhitelisted), "a.md {label}");
            assert_eq!(r.resolve("a.md", Endpoint::ApiFile), Err(Denied::UnsupportedType), "a.md api {label}");

            // A dot-file target is hidden by default; with include_hidden its extension still fails.
            let want_b = if include_hidden { Denied::NotWhitelisted } else { Denied::NotVisible };
            assert_eq!(r.resolve("b.md", Endpoint::Files), Err(want_b), "b.md {label}");

            // Outside the root, and inside an ignored folder: denied in both modes.
            assert_eq!(r.resolve("c.md", Endpoint::Files), Err(Denied::OutsideRoot), "c.md {label}");
            assert_eq!(r.resolve("d.md", Endpoint::Files), Err(Denied::NotVisible), "d.md {label}");

            // The listed name's extension must pass too (stricter than checking the target only).
            assert_eq!(r.resolve("e.txt", Endpoint::Files), Err(Denied::NotWhitelisted), "e.txt {label}");

            // An allowed file symlink resolves to its canonical target.
            let ok = r.resolve("f.md", Endpoint::Files).unwrap();
            assert_eq!(ok.canonical_rel, "docs/api.md", "f.md {label}");
            assert_eq!(ok.listed_rel, "f.md", "f.md {label}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn ut_07_linux_non_utf8_names_are_never_served() {
        // macOS refuses non-UTF-8 names, so this runs on Linux only.
        let dir = TestDir::new("ut07utf8");
        dir.write("ok.md", "# ok");
        let bad_name = OsStr::from_bytes(b"\xff\xfe.md");
        fs::write(dir.path.join(bad_name), "# bad").unwrap();
        std::os::unix::fs::symlink(bad_name, dir.path.join("alias.md")).unwrap();
        let r = Resolver::new(&dir.path, false).unwrap();

        // The link's target has a non-UTF-8 canonical name: never visible.
        assert_eq!(r.resolve("alias.md", Endpoint::Files), Err(Denied::NotVisible));
        assert!(r.resolve("ok.md", Endpoint::Files).is_ok());

        // The scanner lists neither the raw file nor the link to it.
        let tree = crate::tree::scan(&r);
        let listed: Vec<_> = tree.index.keys().cloned().collect();
        assert_eq!(listed, vec!["ok.md".to_string()]);
    }
}
