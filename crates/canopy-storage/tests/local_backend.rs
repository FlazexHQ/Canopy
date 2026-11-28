//! Filesystem behavior of the local storage backend.

use std::fs::{self, File};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use canopy_protocol::{CanopyError, ErrorCode};
use canopy_storage::backend::{ByteRange, StorageBackend, UploadedPart};
use canopy_storage::local::LocalBackend;
use futures_util::TryStreamExt;
use uuid::{Uuid, Version};

const KEY: &str = "bucket/image.bin";
const CONTENT_TYPE: &str = "application/octet-stream";

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

struct TestFolder(PathBuf);

impl TestFolder {
    fn new() -> TestResult<Self> {
        let path = std::env::temp_dir().join(format!("canopy-storage-{}", Uuid::new_v4()));
        fs::create_dir(&path)?;
        Ok(Self(path))
    }

    fn backend(&self) -> TestResult<LocalBackend> {
        Ok(LocalBackend::new(&self.0)?)
    }
}

impl Drop for TestFolder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

async fn read(backend: &LocalBackend, range: Option<ByteRange>) -> Result<Vec<u8>, CanopyError> {
    backend.get(KEY, range).await?.try_concat().await
}

fn assert_error<T>(result: Result<T, CanopyError>, code: ErrorCode, message: &str) {
    let error = result.err();
    assert_eq!(error.as_ref().map(CanopyError::code), Some(code));
    assert_eq!(error.as_ref().map(CanopyError::message), Some(message));
}

async fn part(backend: &LocalBackend, id: &str, part: u32, body: &[u8]) -> TestResult<UploadedPart> {
    let etag = backend.put_part(KEY, id, part, body.to_vec()).await?;
    Ok(UploadedPart { part, etag })
}

#[test]
fn rejects_a_root_that_cannot_hold_folders() -> TestResult {
    let folder = TestFolder::new()?;
    let root = folder.0.join("file");
    File::create(&root)?;
    assert_error(
        LocalBackend::new(&root),
        ErrorCode::Internal,
        &format!(
            "The storage folder {} is not writable; set storage.backend.root to a folder this process may write to",
            root.display()
        ),
    );
    Ok(())
}

#[tokio::test]
async fn round_trips_in_chunks() -> TestResult {
    let folder = TestFolder::new()?;
    let backend = folder.backend()?;
    assert_eq!(backend.kind(), "local");
    let body = b"Canopy".repeat(40_000);
    backend.put(KEY, body.clone(), CONTENT_TYPE).await?;
    let chunks: Vec<Vec<u8>> = backend.get(KEY, None).await?.try_collect().await?;
    assert!(chunks.len() > 1);
    assert_eq!(chunks.concat(), body);
    assert_eq!(fs::read(folder.0.join("objects").join(KEY))?, body);
    assert_eq!(fs::read_dir(folder.0.join("tmp"))?.count(), 0);
    Ok(())
}

#[tokio::test]
async fn reads_inclusive_ranges() -> TestResult {
    let folder = TestFolder::new()?;
    let backend = folder.backend()?;
    backend.put(KEY, b"abcdef".to_vec(), CONTENT_TYPE).await?;
    for (start, end, expected) in [
        (0, 0, &b"a"[..]),
        (5, 5, &b"f"[..]),
        (1, 3, &b"bcd"[..]),
        (0, 5, &b"abcdef"[..]),
        (4, 10, &b"ef"[..]),
        (6, 10, &b""[..]),
    ] {
        assert_eq!(read(&backend, Some(ByteRange { start, end })).await?, expected);
    }
    Ok(())
}

#[tokio::test]
async fn reports_missing_content() -> TestResult {
    let folder = TestFolder::new()?;
    let backend = folder.backend()?;
    assert_error(backend.get(KEY, None).await, ErrorCode::NotFound, "The file content is missing");
    backend.put("parent", vec![], CONTENT_TYPE).await?;
    assert_error(backend.get("parent/child", None).await, ErrorCode::NotFound, "The file content is missing");
    Ok(())
}

#[tokio::test]
async fn rejects_invalid_segments() -> TestResult {
    let folder = TestFolder::new()?;
    let backend = folder.backend()?;
    for key in ["..", "a//b", "con.txt", "a\\b", "a/.hidden", "a.", "COM0.bin", "Lpt9", "/a"] {
        let message = format!("The storage key {key} is not valid");
        assert_error(backend.get(key, None).await, ErrorCode::Internal, &message);
        assert_error(backend.put(key, vec![], CONTENT_TYPE).await, ErrorCode::Internal, &message);
        assert_error(backend.delete(key).await, ErrorCode::Internal, &message);
    }
    backend.put("a/COM10._-b", vec![], CONTENT_TYPE).await?;
    Ok(())
}

#[tokio::test]
async fn replaces_content_and_deletes_idempotently() -> TestResult {
    let folder = TestFolder::new()?;
    let backend = folder.backend()?;
    backend.put(KEY, b"original".to_vec(), CONTENT_TYPE).await?;
    backend.put(KEY, b"new".to_vec(), CONTENT_TYPE).await?;
    assert_eq!(read(&backend, None).await?, b"new");
    backend.delete(KEY).await?;
    backend.delete(KEY).await?;
    assert_error(backend.get(KEY, None).await, ErrorCode::NotFound, "The file content is missing");
    Ok(())
}

#[tokio::test]
async fn completes_multipart_in_part_number_order() -> TestResult {
    let folder = TestFolder::new()?;
    let backend = folder.backend()?;
    for numbers in [[1, 2], [2, 1]] {
        let id = backend.create_multipart(KEY, CONTENT_TYPE).await?;
        assert_eq!(id.len(), 36);
        assert_eq!(Uuid::parse_str(&id)?.get_version(), Some(Version::Random));
        let mut parts = Vec::new();
        for number in numbers {
            let body = if number == 1 { &b"first"[..] } else { &b"second"[..] };
            parts.push(part(&backend, &id, number, body).await?);
        }
        backend.complete_multipart(KEY, &id, &parts).await?;
        assert_eq!(read(&backend, None).await?, b"firstsecond");
        assert!(!folder.0.join("uploads").join(id).exists());
    }
    Ok(())
}

#[tokio::test]
async fn replaces_part_and_returns_its_sha256() -> TestResult {
    let folder = TestFolder::new()?;
    let backend = folder.backend()?;
    let id = backend.create_multipart(KEY, CONTENT_TYPE).await?;
    part(&backend, &id, 1, b"original").await?;
    let replacement = part(&backend, &id, 1, b"abc").await?;
    assert_eq!(replacement.etag, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    backend.complete_multipart(KEY, &id, &[replacement]).await?;
    assert_eq!(read(&backend, None).await?, b"abc");
    Ok(())
}

#[tokio::test]
async fn missing_part_leaves_current_content_and_allows_retry() -> TestResult {
    let folder = TestFolder::new()?;
    let backend = folder.backend()?;
    backend.put(KEY, b"current".to_vec(), CONTENT_TYPE).await?;
    let id = backend.create_multipart(KEY, CONTENT_TYPE).await?;
    let first = part(&backend, &id, 1, b"first").await?;
    let missing = UploadedPart { part: 2, etag: String::new() };
    assert_error(
        backend.complete_multipart(KEY, &id, &[first.clone(), missing]).await,
        ErrorCode::Conflict,
        "Part 2 is missing",
    );
    assert_eq!(read(&backend, None).await?, b"current");
    assert_eq!(fs::read_dir(folder.0.join("tmp"))?.count(), 0);
    let second = part(&backend, &id, 2, b"second").await?;
    backend.complete_multipart(KEY, &id, &[first, second]).await?;
    assert_eq!(read(&backend, None).await?, b"firstsecond");
    Ok(())
}

#[tokio::test]
async fn abort_discards_parts_and_is_idempotent() -> TestResult {
    let folder = TestFolder::new()?;
    let backend = folder.backend()?;
    let id = backend.create_multipart(KEY, CONTENT_TYPE).await?;
    part(&backend, &id, 1, b"discard").await?;
    backend.abort_multipart(KEY, &id).await?;
    backend.abort_multipart(KEY, &id).await?;
    assert!(!folder.0.join("uploads").join(&id).exists());
    assert_error(backend.put_part(KEY, &id, 1, vec![]).await, ErrorCode::NotFound, "No such upload");
    assert_error(backend.get(KEY, None).await, ErrorCode::NotFound, "The file content is missing");
    Ok(())
}

#[tokio::test]
async fn validates_upload_ids_and_part_numbers() -> TestResult {
    let folder = TestFolder::new()?;
    let backend = folder.backend()?;
    for id in ["../tmp", "A1234567-89ab-cdef-0123-456789abcdef"] {
        assert_error(backend.put_part(KEY, id, 1, vec![]).await, ErrorCode::NotFound, "No such upload");
        assert_error(backend.complete_multipart(KEY, id, &[]).await, ErrorCode::NotFound, "No such upload");
        assert_error(backend.abort_multipart(KEY, id).await, ErrorCode::NotFound, "No such upload");
    }
    let id = backend.create_multipart(KEY, CONTENT_TYPE).await?;
    assert_error(backend.put_part(KEY, &id, 0, vec![]).await, ErrorCode::Internal, "Part numbers start at 1");
    backend.abort_multipart(KEY, &"-".repeat(36)).await?;
    Ok(())
}

#[tokio::test]
async fn sweeps_stale_entries_and_preserves_recent_ones() -> TestResult {
    let folder = TestFolder::new()?;
    let backend = folder.backend()?;
    let old_id = backend.create_multipart(KEY, CONTENT_TYPE).await?;
    part(&backend, &old_id, 1, b"expired").await?;
    let current_id = backend.create_multipart(KEY, CONTENT_TYPE).await?;
    let old_upload = folder.0.join("uploads").join(old_id);
    let current_upload = folder.0.join("uploads").join(current_id);
    let old_temp = folder.0.join("tmp").join("old");
    let current_temp = folder.0.join("tmp").join("current");
    let now = SystemTime::now();
    let old = now - Duration::from_secs(7200);
    File::create(&old_temp)?.set_modified(old)?;
    File::create(&current_temp)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.access_mode(0x0100).custom_flags(0x0200_0000);
    }
    options.open(&old_upload)?.set_modified(old)?;
    let cutoff = (now - Duration::from_secs(60)).duration_since(UNIX_EPOCH)?.as_millis();
    let cutoff = i64::try_from(cutoff)?;
    assert_eq!(backend.sweep(cutoff).await?, 2);
    assert!(!old_temp.exists());
    assert!(!old_upload.exists());
    assert!(current_temp.is_file());
    assert!(current_upload.is_dir());
    assert_eq!(backend.sweep(cutoff).await?, 0);
    Ok(())
}
