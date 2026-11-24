//! Live reload pipeline (PRD 8): watcher, classification against the snapshot, tree rebuild,
//! then broadcast. The order is always "update state, then broadcast".

use std::collections::{BTreeSet, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use tokio::sync::mpsc;

use crate::resolve::{has_extension, rel_to_string, visible, Resolver, SERVED_EXTENSIONS};
use crate::server::AppState;
use crate::tree::{try_scan, TreeState};

/// Quiet period before a burst of events is processed (PRD 8.2).
pub const DEBOUNCE: Duration = Duration::from_millis(200);
/// A burst that never goes quiet is still processed after this long.
pub const MAX_WAIT: Duration = Duration::from_secs(1);

/// One message on `GET /api/events` (PRD 8.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum LiveEvent {
    Changed { path: String },
    Removed { path: String },
    Tree,
    Resync,
    Unavailable,
    Bye,
}

/// Debounced filesystem activity handed from the watcher thread to the state task.
#[derive(Debug, Default, Clone)]
pub struct Batch {
    pub paths: HashSet<PathBuf>,
    pub rescan: bool,
}

impl Batch {
    pub fn merge(&mut self, other: Batch) {
        self.paths.extend(other.paths);
        self.rescan |= other.rescan;
    }
}

/// Result of classifying a batch against the snapshot (PRD 8.2). Paths are listed paths.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Classified {
    pub changed: Vec<String>,
    pub removed: Vec<String>,
    pub tree_dirty: bool,
}

/// Classifies touched paths by looking at the filesystem, not at event kinds (the debouncer has none).
/// Event paths are real paths: they are mapped to root-relative paths lexically, because a deleted
/// path cannot be canonicalized, and `tree.aliases` maps them back to every listed path.
pub fn classify(resolver: &Resolver, tree: &TreeState, paths: &HashSet<PathBuf>) -> Classified {
    let root = resolver.root();
    let mut changed = BTreeSet::new();
    let mut removed = BTreeSet::new();
    let mut tree_dirty = false;

    for abs in paths {
        let Ok(rel) = abs.strip_prefix(root) else {
            continue; // outside the root
        };
        if !visible(rel, resolver.include_hidden()) {
            continue;
        }
        let rel_s = rel_to_string(rel);
        if rel_s.is_empty() {
            tree_dirty = true; // the root itself
            continue;
        }
        match std::fs::metadata(abs) {
            Ok(meta) if meta.is_dir() => tree_dirty = true,
            Ok(meta) => {
                if let Some(listed) = tree.aliases.get(&rel_s) {
                    changed.extend(listed.iter().cloned());
                } else if meta.is_file() && has_extension(rel, SERVED_EXTENSIONS) {
                    tree_dirty = true; // a new visible whitelisted file
                }
            }
            Err(_) => {
                if let Some(listed) = tree.aliases.get(&rel_s) {
                    removed.extend(listed.iter().cloned());
                    tree_dirty = true;
                } else {
                    // A removed directory: every indexed file below it is gone.
                    let prefix = format!("{rel_s}/");
                    let under: Vec<String> = tree
                        .aliases
                        .iter()
                        .filter(|(canonical, _)| canonical.starts_with(&prefix))
                        .flat_map(|(_, listed)| listed.iter().cloned())
                        .collect();
                    if !under.is_empty() {
                        removed.extend(under);
                        tree_dirty = true;
                    }
                }
            }
        }
    }
    Classified {
        changed: changed.into_iter().collect(),
        removed: removed.into_iter().collect(),
        tree_dirty,
    }
}

pub type ScanFn = Arc<dyn Fn(&Resolver) -> io::Result<TreeState> + Send + Sync>;

/// Processes merged batches: classify, rebuild if needed, swap the tree, then broadcast.
pub struct Pipeline {
    state: Arc<AppState>,
    scan: ScanFn,
    rebuilds: AtomicUsize,
}

impl Pipeline {
    pub fn new(state: Arc<AppState>) -> Self {
        Self::with_scan(state, Arc::new(|r| try_scan(r)))
    }

    pub fn with_scan(state: Arc<AppState>, scan: ScanFn) -> Self {
        Pipeline {
            state,
            scan,
            rebuilds: AtomicUsize::new(0),
        }
    }

    pub fn rebuild_count(&self) -> usize {
        self.rebuilds.load(Ordering::SeqCst)
    }

    pub fn process(&self, batch: Batch) {
        let old = self.state.tree.read().expect("tree lock").clone();
        let mut classified = classify(&self.state.resolver, &old, &batch.paths);
        if batch.rescan {
            classified.tree_dirty = true;
        }

        let mut swapped = false;
        if classified.tree_dirty {
            self.rebuilds.fetch_add(1, Ordering::SeqCst);
            match (self.scan)(&self.state.resolver) {
                Ok(new_tree) => {
                    *self.state.tree.write().expect("tree lock") = Arc::new(new_tree);
                    swapped = true;
                }
                Err(e) => {
                    // Keep serving the previous tree; the next event retries (PRD 8.3).
                    eprintln!("error: tree rebuild failed: {e}; keeping the previous tree");
                }
            }
        }

        // Broadcast only after the state is updated.
        if swapped {
            self.state.send_event(LiveEvent::Tree);
            if batch.rescan {
                self.state.send_event(LiveEvent::Resync);
            }
        }
        for path in classified.removed {
            self.state.send_event(LiveEvent::Removed { path });
        }
        for path in classified.changed {
            self.state.send_event(LiveEvent::Changed { path });
        }
    }
}

/// The state task: one consumer, so at most one rebuild runs at a time; everything that arrives while
/// a rebuild is running is merged into exactly one more.
pub async fn run(pipeline: Arc<Pipeline>, mut rx: mpsc::UnboundedReceiver<Batch>) {
    while let Some(mut merged) = rx.recv().await {
        // Debounce: keep merging until DEBOUNCE passes without a new batch (or MAX_WAIT is reached).
        let started = tokio::time::Instant::now();
        loop {
            while let Ok(more) = rx.try_recv() {
                merged.merge(more);
            }
            if started.elapsed() >= MAX_WAIT {
                break;
            }
            match tokio::time::timeout(DEBOUNCE, rx.recv()).await {
                Ok(Some(more)) => merged.merge(more),
                _ => break, // quiet period elapsed, or the channel closed
            }
        }
        let p = pipeline.clone();
        let _ = tokio::task::spawn_blocking(move || p.process(merged)).await;
    }
}

/// Keeps the OS watcher alive for as long as it is held.
pub struct WatcherHandle {
    _watcher: notify::RecommendedWatcher,
}

/// What a raw notify event means for the pipeline.
#[derive(Debug, PartialEq, Eq)]
pub enum Relevance {
    /// The paths were touched.
    Touched,
    /// Events were lost: rebuild everything.
    Rescan,
    /// Not a change (a read or an unrelated notification).
    Ignore,
}

/// Reads are not changes. On Linux, listing a directory (which the tree scan does) emits inotify
/// access events for that directory; treating them as changes made every rebuild trigger the next
/// one, forever (found in M4, Linux only). Everything else that names a path counts.
pub fn relevance(event: &Event) -> Relevance {
    if event.need_rescan() {
        return Relevance::Rescan;
    }
    match event.kind {
        EventKind::Access(_) => Relevance::Ignore,
        _ if event.paths.is_empty() => Relevance::Ignore,
        _ => Relevance::Touched,
    }
}

/// Starts the recursive watch on the canonical root with `follow_symlinks(false)` (PRD 8.1).
/// On any error the watcher is dropped entirely, so no half-registered watcher survives.
pub fn start_watcher(root: &Path, tx: mpsc::UnboundedSender<Batch>) -> Result<WatcherHandle, String> {
    let handler = move |result: notify::Result<Event>| match result {
        Ok(event) => match relevance(&event) {
            Relevance::Touched => {
                let _ = tx.send(Batch { paths: event.paths.into_iter().collect(), rescan: false });
            }
            Relevance::Rescan => {
                let _ = tx.send(Batch { paths: HashSet::new(), rescan: true });
            }
            Relevance::Ignore => {}
        },
        Err(e) => {
            eprintln!("warning: watcher error: {e}");
            let _ = tx.send(Batch { paths: HashSet::new(), rescan: true });
        }
    };
    let mut watcher = notify::RecommendedWatcher::new(
        handler,
        notify::Config::default().with_follow_symlinks(false),
    )
    .map_err(|e| describe(&e))?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| describe(&e))?;
    Ok(WatcherHandle { _watcher: watcher })
}

fn describe(e: &notify::Error) -> String {
    match e.kind {
        notify::ErrorKind::MaxFilesWatch => {
            "OS file watch limit reached. Raise fs.inotify.max_user_watches".to_string()
        }
        _ => e.to_string(),
    }
}

/// Starts live reload through `start`. If it fails, the server keeps serving and records the reason,
/// which makes `/api/events` announce `unavailable` (PRD 8.5).
pub fn init_live<H>(
    state: &Arc<AppState>,
    root: &Path,
    start: impl FnOnce(&Path, mpsc::UnboundedSender<Batch>) -> Result<H, String>,
) -> Option<(H, mpsc::UnboundedReceiver<Batch>)> {
    let (tx, rx) = mpsc::unbounded_channel();
    match start(root, tx) {
        Ok(handle) => Some((handle, rx)),
        Err(reason) => {
            eprintln!("warning: live reload disabled: {reason}");
            *state.unavailable.write().expect("unavailable lock") = Some(reason);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestDir;
    use std::fs;
    use std::net::SocketAddr;
    use std::sync::atomic::AtomicBool;
    use tokio::sync::broadcast::error::TryRecvError;

    fn state_for(dir: &TestDir) -> Arc<AppState> {
        let resolver = Resolver::new(&dir.path, false).unwrap();
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        AppState::new(resolver, addr)
    }

    fn set(paths: &[PathBuf]) -> HashSet<PathBuf> {
        paths.iter().cloned().collect()
    }

    #[test]
    fn ut_12_classifier_follows_the_snapshot_table() {
        let dir = TestDir::new("ut12");
        dir.write("a.md", "# a");
        dir.write("docs/x.md", "# x");
        dir.write("docs/style.css", "h1{}");
        dir.write("node_modules/pkg/i.md", "# n");
        dir.symlink("docs", "link-in");
        let state = state_for(&dir);
        let root = state.resolver.root().to_path_buf();
        let tree = state.tree.read().unwrap().clone();
        let cls = |p: &[PathBuf]| classify(&state.resolver, &tree, &set(p));

        // in snapshot + exists -> changed (one event per listed alias); no rebuild needed
        let c = cls(&[root.join("docs/x.md")]);
        assert_eq!(c.changed, vec!["docs/x.md".to_string(), "link-in/x.md".to_string()]);
        assert!(c.removed.is_empty() && !c.tree_dirty);

        // assets are indexed: a CSS change is reported as changed
        assert_eq!(cls(&[root.join("docs/style.css")]).changed, vec!["docs/style.css", "link-in/style.css"]);

        // in snapshot + missing -> removed, and the tree is dirty
        fs::remove_file(root.join("a.md")).unwrap();
        let c = cls(&[root.join("a.md")]);
        assert_eq!(c.removed, vec!["a.md".to_string()]);
        assert!(c.tree_dirty && c.changed.is_empty());

        // not in snapshot + exists + visible + whitelisted -> tree dirty
        dir.write("fresh.md", "# f");
        let c = cls(&[root.join("fresh.md")]);
        assert!(c.tree_dirty && c.changed.is_empty() && c.removed.is_empty());

        // not in snapshot + missing -> ignored (created and removed inside one window)
        let c = cls(&[root.join("ghost.md")]);
        assert_eq!(c, Classified::default());

        // a created directory -> tree dirty
        dir.mkdir("newdir");
        assert!(cls(&[root.join("newdir")]).tree_dirty);

        // a removed directory -> every indexed file below it is removed
        fs::remove_dir_all(root.join("docs")).unwrap();
        let c = cls(&[root.join("docs")]);
        assert!(c.tree_dirty);
        assert!(c.removed.contains(&"docs/x.md".to_string()) && c.removed.contains(&"link-in/x.md".to_string()));

        // invisible paths and paths outside the root are dropped
        assert_eq!(cls(&[root.join("node_modules/pkg/i.md")]), Classified::default());
        assert_eq!(cls(&[PathBuf::from("/etc/hosts")]), Classified::default());
    }

    #[test]
    fn ut_12_reads_and_empty_events_do_not_count_as_changes() {
        use notify::event::{AccessKind, AccessMode, CreateKind, DataChange, Flag, ModifyKind, RemoveKind};
        let at = |kind| Event::new(kind).add_path(PathBuf::from("/root/docs"));
        assert_eq!(relevance(&at(EventKind::Access(AccessKind::Open(AccessMode::Any)))), Relevance::Ignore);
        assert_eq!(relevance(&at(EventKind::Access(AccessKind::Close(AccessMode::Read)))), Relevance::Ignore);
        assert_eq!(relevance(&at(EventKind::Access(AccessKind::Any))), Relevance::Ignore);
        assert_eq!(relevance(&at(EventKind::Create(CreateKind::File))), Relevance::Touched);
        assert_eq!(relevance(&at(EventKind::Modify(ModifyKind::Data(DataChange::Any)))), Relevance::Touched);
        assert_eq!(relevance(&at(EventKind::Remove(RemoveKind::File))), Relevance::Touched);
        assert_eq!(relevance(&Event::new(EventKind::Other)), Relevance::Ignore);
        assert_eq!(relevance(&Event::new(EventKind::Other).set_flag(Flag::Rescan)), Relevance::Rescan);
    }

    #[tokio::test]
    async fn ut_13_lagging_subscriber_gets_exactly_one_resync() {
        use futures_util::StreamExt;
        let (tx, rx) = tokio::sync::broadcast::channel::<LiveEvent>(1);
        let (_shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        for i in 0..100 {
            let _ = tx.send(LiveEvent::Changed { path: format!("f{i}.md") });
        }
        drop(tx);
        let events: Vec<LiveEvent> = crate::server::live_events(rx, shutdown_rx, None, None).collect().await;
        let resyncs = events.iter().filter(|e| **e == LiveEvent::Resync).count();
        assert_eq!(resyncs, 1, "events: {events:?}");
    }

    #[tokio::test]
    async fn ut_14_watcher_failure_keeps_serving_and_announces_unavailable() {
        use futures_util::StreamExt;
        let dir = TestDir::new("ut14");
        dir.write("a.md", "# a");
        let state = state_for(&dir);
        let started: Option<((), _)> = init_live(&state, &dir.path, |_, _| Err::<(), _>("injected failure".to_string()));
        assert!(started.is_none());
        assert_eq!(state.unavailable.read().unwrap().as_deref(), Some("injected failure"));
        // The server state is intact and /api/events starts with `unavailable`.
        assert!(!state.tree.read().unwrap().entries.is_empty());
        let rx = state.events.subscribe();
        let initial = state.unavailable.read().unwrap().as_ref().map(|_| LiveEvent::Unavailable);
        let (_s, shutdown_rx) = tokio::sync::watch::channel(true);
        let first = Box::pin(crate::server::live_events(rx, shutdown_rx, initial, None)).next().await;
        assert_eq!(first, Some(LiveEvent::Unavailable));
    }

    #[tokio::test]
    async fn ut_15_rebuilds_are_coalesced() {
        let dir = TestDir::new("ut15");
        dir.write("a.md", "# a");
        let state = state_for(&dir);
        let (tx, rx) = mpsc::unbounded_channel::<Batch>();
        let root = state.resolver.root().to_path_buf();
        let in_flight = Arc::new(AtomicUsize::new(0));
        let max_in_flight = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let (tx2, in_flight2, max2, calls2, root2) =
            (tx.clone(), in_flight.clone(), max_in_flight.clone(), calls.clone(), root.clone());
        let scan: ScanFn = Arc::new(move |resolver| {
            let now = in_flight2.fetch_add(1, Ordering::SeqCst) + 1;
            max2.fetch_max(now, Ordering::SeqCst);
            if calls2.fetch_add(1, Ordering::SeqCst) == 0 {
                // 10 more batches arrive while the first rebuild is running.
                for i in 0..10 {
                    // Each needs a rebuild: a real new file plus a rescan marker.
                    let name = format!("new{i}.md");
                    let _ = fs::write(root2.join(&name), "# n");
                    let _ = tx2.send(Batch { paths: set(&[root2.join(&name)]), rescan: i == 0 });
                }
            }
            let out = try_scan(resolver);
            in_flight2.fetch_sub(1, Ordering::SeqCst);
            out
        });
        let pipeline = Arc::new(Pipeline::with_scan(state, scan));
        // The first batch makes the tree dirty (a rescan).
        tx.send(Batch { paths: HashSet::new(), rescan: true }).unwrap();
        // 10 more queued before the task even starts: they merge into the first iteration.
        for _ in 0..10 {
            tx.send(Batch { paths: HashSet::new(), rescan: true }).unwrap();
        }
        drop(tx);
        let handle = tokio::spawn(run(pipeline.clone(), rx));
        // `tx2` inside the scan closure keeps the channel open until the pipeline is dropped.
        tokio::time::sleep(Duration::from_millis(1800)).await;
        handle.abort();
        // First iteration merged the 11 queued batches into one rebuild; the 10 that arrived during it
        // were merged into exactly one more.
        assert_eq!(pipeline.rebuild_count(), 2);
        assert_eq!(max_in_flight.load(Ordering::SeqCst), 1, "two rebuilds ran at once");
    }

    #[tokio::test]
    async fn ut_16_failed_rebuild_keeps_the_old_tree_and_the_next_event_retries() {
        let dir = TestDir::new("ut16");
        dir.write("a.md", "# a");
        let state = state_for(&dir);
        let mut events = state.events.subscribe();
        let fail = Arc::new(AtomicBool::new(true));
        let fail2 = fail.clone();
        let scan: ScanFn = Arc::new(move |resolver| {
            if fail2.load(Ordering::SeqCst) {
                Err(io::Error::new(io::ErrorKind::Other, "injected scan failure"))
            } else {
                try_scan(resolver)
            }
        });
        let pipeline = Pipeline::with_scan(state.clone(), scan);
        let before = state.tree.read().unwrap().clone();
        dir.write("b.md", "# b");
        let batch = Batch { paths: set(&[state.resolver.root().join("b.md")]), rescan: false };

        pipeline.process(batch.clone());
        let after_fail = state.tree.read().unwrap().clone();
        assert!(Arc::ptr_eq(&before, &after_fail), "the previous tree must stay");
        assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)), "no tree event after a failed rebuild");

        fail.store(false, Ordering::SeqCst);
        pipeline.process(batch);
        assert_eq!(pipeline.rebuild_count(), 2);
        assert_eq!(events.try_recv().unwrap(), LiveEvent::Tree);
        let names: Vec<String> = state.tree.read().unwrap().entries.iter().map(|e| e.name.clone()).collect();
        assert!(names.contains(&"b.md".to_string()), "{names:?}");
    }
}
