//! Test helpers: a self-cleaning temporary directory (std only, no extra crates).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

pub struct TestDir {
    pub path: PathBuf,
}

impl TestDir {
    pub fn new(label: &str) -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "docs-browser-test-{}-{}-{}",
            std::process::id(),
            n,
            label
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create test dir");
        TestDir { path }
    }

    /// Writes `content` to `rel` (creating parent directories).
    pub fn write(&self, rel: &str, content: &str) -> PathBuf {
        let p = self.path.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(&p, content).expect("write file");
        p
    }

    pub fn mkdir(&self, rel: &str) -> PathBuf {
        let p = self.path.join(rel);
        fs::create_dir_all(&p).expect("mkdir");
        p
    }

    /// Creates a symlink at `rel` pointing to `target` (absolute or relative, as given).
    pub fn symlink(&self, target: impl AsRef<Path>, rel: &str) {
        let link = self.path.join(rel);
        if let Some(parent) = link.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        std::os::unix::fs::symlink(target.as_ref(), &link).expect("symlink");
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        // Restore permissions that a test may have removed, so cleanup can succeed.
        fn relax(p: &Path) {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = fs::symlink_metadata(p) {
                if meta.is_dir() {
                    let _ = fs::set_permissions(p, fs::Permissions::from_mode(0o755));
                    if let Ok(rd) = fs::read_dir(p) {
                        for e in rd.flatten() {
                            relax(&e.path());
                        }
                    }
                }
            }
        }
        relax(&self.path);
        let _ = fs::remove_dir_all(&self.path);
    }
}
