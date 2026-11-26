use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

type Snapshot = BTreeMap<PathBuf, (Option<SystemTime>, u64)>;

/// Files of one folder compared by modification time and size on each poll. Polling needs no platform
/// watcher and sees saves through editors that replace the file.
pub(crate) struct Watched {
    dir: PathBuf,
    recursive: bool,
    keep: Box<dyn Fn(&Path) -> bool + Send>,
    last: Snapshot,
}

impl Watched {
    pub(crate) fn new(
        dir: PathBuf,
        recursive: bool,
        keep: impl Fn(&Path) -> bool + Send + 'static,
    ) -> Watched {
        let mut watched = Watched { dir, recursive, keep: Box::new(keep), last: Snapshot::new() };
        watched.last = watched.snapshot();
        watched
    }

    fn snapshot(&self) -> Snapshot {
        fn visit(dir: &Path, recursive: bool, keep: &dyn Fn(&Path) -> bool, out: &mut Snapshot) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                let Ok(metadata) = entry.metadata() else { continue };
                if metadata.is_dir() {
                    let name = entry.file_name();
                    if recursive && name != "node_modules" && !name.to_string_lossy().starts_with('.') {
                        visit(&path, recursive, keep, out);
                    }
                } else if keep(&path) {
                    out.insert(path, (metadata.modified().ok(), metadata.len()));
                }
            }
        }
        let mut out = Snapshot::new();
        visit(&self.dir, self.recursive, self.keep.as_ref(), &mut out);
        out
    }

    /// Whether a file was added, removed or written since the last call; waits until the folder has been
    /// quiet for `settle`, so an editor's save in several writes counts once.
    pub(crate) fn changed(&mut self, settle: Duration) -> bool {
        let mut current = self.snapshot();
        if current == self.last {
            return false;
        }
        for _ in 0..20 {
            std::thread::sleep(settle);
            let next = self.snapshot();
            if next == current {
                break;
            }
            current = next;
        }
        self.last = current;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::Watched;
    use std::time::Duration;

    #[test]
    fn sees_writes_additions_and_removals_once() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        std::fs::write(dir.path().join("a.ts"), "one")?;
        std::fs::create_dir(dir.path().join("nested"))?;
        let mut watched = Watched::new(dir.path().to_path_buf(), true, |path| {
            path.extension().is_some_and(|extension| extension == "ts")
        });
        assert!(!watched.changed(Duration::ZERO));
        std::fs::write(dir.path().join("a.ts"), "longer")?;
        assert!(watched.changed(Duration::ZERO));
        assert!(!watched.changed(Duration::ZERO));
        std::fs::write(dir.path().join("nested").join("b.ts"), "x")?;
        assert!(watched.changed(Duration::ZERO));
        std::fs::write(dir.path().join("ignored.md"), "x")?;
        assert!(!watched.changed(Duration::ZERO));
        std::fs::remove_file(dir.path().join("a.ts"))?;
        assert!(watched.changed(Duration::ZERO));
        Ok(())
    }
}
