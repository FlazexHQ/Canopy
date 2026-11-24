//! File storage under a local folder or a shared volume.

use std::future::Future;
use std::io::{self, ErrorKind, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use canopy_protocol::sha256::sha256_hex;
use canopy_protocol::{CanopyError, ErrorCode};
use futures_util::stream;
use tokio::fs::{self, File};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use uuid::Uuid;

use crate::backend::{BoxFuture, ByteRange, ByteStream, StorageBackend, UploadedPart};

const CHUNK_SIZE: usize = 64 * 1024;
const STALE_TEMPORARY: Duration = Duration::from_secs(3600);

/// Stores complete files in `objects`, multipart uploads in `uploads` and pending writes in `tmp`.
#[derive(Debug)]
pub struct LocalBackend {
    objects: PathBuf,
    uploads: PathBuf,
    tmp: PathBuf,
}

impl LocalBackend {
    /// Creates the folders and checks that the process can create and remove files in `tmp`.
    pub fn new(root: impl AsRef<Path>) -> Result<Self, CanopyError> {
        let root = root.as_ref();
        let absolute = std::path::absolute(if root.as_os_str().is_empty() { Path::new(".") } else { root })
            .map_err(|_| unwritable(root))?;
        let mut root = PathBuf::new();
        for component in absolute.components() {
            match component {
                Component::ParentDir => {
                    root.pop();
                }
                Component::CurDir => {}
                _ => root.push(component.as_os_str()),
            }
        }
        let backend =
            Self { objects: root.join("objects"), uploads: root.join("uploads"), tmp: root.join("tmp") };
        let initialize = || -> io::Result<()> {
            for folder in [&backend.objects, &backend.uploads, &backend.tmp] {
                std::fs::create_dir_all(folder)?;
            }
            let probe = backend.tmp.join(format!("{}.probe", Uuid::new_v4()));
            drop(std::fs::File::create_new(&probe)?);
            std::fs::remove_file(probe)
        };
        initialize().map_err(|_| unwritable(&root))?;
        Ok(backend)
    }

    fn object_path(&self, key: &str) -> Result<PathBuf, CanopyError> {
        let mut path = self.objects.clone();
        for segment in key.split('/') {
            if !valid_segment(segment) {
                return Err(internal(format!("The storage key {key} is not valid")));
            }
            path.push(segment);
        }
        Ok(path)
    }

    fn upload_folder(&self, id: &str) -> Result<PathBuf, CanopyError> {
        if id.len() != 36 || !id.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f' | b'-')) {
            return Err(not_found("No such upload"));
        }
        Ok(self.uploads.join(id))
    }

    async fn atomically<F, Write>(&self, target: &Path, write: Write) -> Result<(), CanopyError>
    where
        F: Future<Output = Result<File, CanopyError>>,
        Write: FnOnce(File) -> F,
    {
        let temporary = self.tmp.join(Uuid::new_v4().to_string());
        let file = File::create_new(&temporary).await.map_err(io_error)?;
        let result = async {
            let file = write(file).await?;
            file.sync_data().await.map_err(io_error)?;
            drop(file);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).await.map_err(io_error)?;
            }
            rename_into(&temporary, target).await.map_err(io_error)
        }
        .await;
        if result.is_err() {
            let _ = fs::remove_file(temporary).await;
        }
        result
    }

    async fn write_bytes(&self, target: &Path, body: &[u8]) -> Result<(), CanopyError> {
        self.atomically(target, |mut file| async move {
            file.write_all(body).await.map_err(io_error)?;
            file.flush().await.map_err(io_error)?;
            Ok(file)
        })
        .await
    }
}

impl StorageBackend for LocalBackend {
    fn kind(&self) -> &str {
        "local"
    }

    fn put<'a>(
        &'a self,
        key: &'a str,
        body: Vec<u8>,
        _content_type: &'a str,
    ) -> BoxFuture<'a, Result<(), CanopyError>> {
        Box::pin(async move { self.write_bytes(&self.object_path(key)?, &body).await })
    }

    fn get<'a>(
        &'a self,
        key: &'a str,
        range: Option<ByteRange>,
    ) -> BoxFuture<'a, Result<ByteStream, CanopyError>> {
        Box::pin(async move {
            let mut file = File::open(self.object_path(key)?).await.map_err(|error| match error.kind() {
                ErrorKind::NotFound | ErrorKind::NotADirectory => not_found("The file content is missing"),
                _ => io_error(error),
            })?;
            let limit = match range {
                Some(ByteRange { start, end }) => {
                    let span = end.checked_sub(start).ok_or_else(|| internal("Invalid byte range"))?;
                    file.seek(SeekFrom::Start(start)).await.map_err(io_error)?;
                    span.saturating_add(1)
                }
                None => u64::MAX,
            };
            let chunks = stream::try_unfold(file.take(limit), |mut reader| async move {
                let mut chunk = vec![0; CHUNK_SIZE];
                let read = reader.read(&mut chunk).await.map_err(io_error)?;
                chunk.truncate(read);
                Ok((read != 0).then_some((chunk, reader)))
            });
            Ok(Box::pin(chunks) as ByteStream)
        })
    }

    fn delete<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), CanopyError>> {
        Box::pin(async move { ignore_missing(fs::remove_file(self.object_path(key)?).await) })
    }

    fn create_multipart<'a>(
        &'a self,
        _key: &'a str,
        _content_type: &'a str,
    ) -> BoxFuture<'a, Result<String, CanopyError>> {
        Box::pin(async move {
            let id = Uuid::new_v4().to_string();
            fs::create_dir(self.upload_folder(&id)?).await.map_err(io_error)?;
            Ok(id)
        })
    }

    fn put_part<'a>(
        &'a self,
        _key: &'a str,
        upload_id: &'a str,
        part: u32,
        body: Vec<u8>,
    ) -> BoxFuture<'a, Result<String, CanopyError>> {
        Box::pin(async move {
            if part == 0 {
                return Err(internal("Part numbers start at 1"));
            }
            let folder = self.upload_folder(upload_id)?;
            fs::metadata(&folder).await.map_err(|_| not_found("No such upload"))?;
            self.write_bytes(&folder.join(part.to_string()), &body).await?;
            Ok(sha256_hex(&body))
        })
    }

    fn complete_multipart<'a>(
        &'a self,
        key: &'a str,
        upload_id: &'a str,
        parts: &'a [UploadedPart],
    ) -> BoxFuture<'a, Result<(), CanopyError>> {
        Box::pin(async move {
            let folder = self.upload_folder(upload_id)?;
            let mut ordered: Vec<_> = parts.iter().map(|part| part.part).collect();
            ordered.sort_unstable();
            self.atomically(&self.object_path(key)?, |mut target| {
                let folder = &folder;
                async move {
                    for part in ordered {
                        let mut source =
                            File::open(folder.join(part.to_string())).await.map_err(|error| {
                                if error.kind() == ErrorKind::NotFound {
                                    CanopyError::new(ErrorCode::Conflict, format!("Part {part} is missing"))
                                } else {
                                    io_error(error)
                                }
                            })?;
                        tokio::io::copy(&mut source, &mut target).await.map_err(io_error)?;
                    }
                    target.flush().await.map_err(io_error)?;
                    Ok(target)
                }
            })
            .await?;
            remove_entry(&folder).await
        })
    }

    fn abort_multipart<'a>(
        &'a self,
        _key: &'a str,
        upload_id: &'a str,
    ) -> BoxFuture<'a, Result<(), CanopyError>> {
        Box::pin(async move { remove_entry(&self.upload_folder(upload_id)?).await })
    }

    fn sweep(&self, older_than_ms: i64) -> BoxFuture<'_, Result<u64, CanopyError>> {
        Box::pin(async move {
            let now = SystemTime::now();
            let temporary = sweep_folder(&self.tmp, |modified| {
                now.duration_since(modified).is_ok_and(|age| age > STALE_TEMPORARY)
            })
            .await?;
            let uploads = sweep_folder(&self.uploads, |modified| {
                let nanos = match modified.duration_since(UNIX_EPOCH) {
                    Ok(age) => age.as_nanos() as i128,
                    Err(error) => -(error.duration().as_nanos() as i128),
                };
                nanos < i128::from(older_than_ms) * 1_000_000
            })
            .await?;
            Ok(temporary + uploads)
        })
    }
}

fn valid_segment(segment: &str) -> bool {
    let plain = |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-');
    let bytes = segment.as_bytes();
    if !bytes.first().copied().is_some_and(plain)
        || !bytes.last().copied().is_some_and(plain)
        || !bytes.iter().all(|&byte| plain(byte) || byte == b'.')
    {
        return false;
    }
    let stem = segment.split('.').next().unwrap_or_default().to_ascii_lowercase();
    !matches!(
        stem.as_bytes(),
        b"con" | b"prn" | b"aux" | b"nul" | [b'c', b'o', b'm', b'0'..=b'9'] | [b'l', b'p', b't', b'0'..=b'9']
    )
}

async fn rename_into(from: &Path, to: &Path) -> io::Result<()> {
    let mut delay = Duration::from_millis(20);
    for _ in 0..5 {
        match fs::rename(from, to).await {
            Err(error) if retryable_rename(&error) => tokio::time::sleep(delay).await,
            result => return result,
        }
        delay *= 2;
    }
    fs::rename(from, to).await
}

fn retryable_rename(error: &io::Error) -> bool {
    matches!(error.kind(), ErrorKind::PermissionDenied | ErrorKind::ResourceBusy)
        || (cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33)))
}

async fn remove_entry(path: &Path) -> Result<(), CanopyError> {
    let info = match fs::symlink_metadata(path).await {
        Ok(info) => info,
        Err(error) => return ignore_missing(Err(error)),
    };
    let kind = info.file_type();
    #[cfg(windows)]
    if std::os::windows::fs::FileTypeExt::is_symlink_dir(&kind) {
        return ignore_missing(fs::remove_dir(path).await);
    }
    if kind.is_dir() {
        ignore_missing(fs::remove_dir_all(path).await)
    } else {
        ignore_missing(fs::remove_file(path).await)
    }
}

async fn sweep_folder(folder: &Path, stale: impl Fn(SystemTime) -> bool) -> Result<u64, CanopyError> {
    let paths = async {
        let mut entries = fs::read_dir(folder).await?;
        let mut paths = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            paths.push(entry.path());
        }
        Ok::<_, io::Error>(paths)
    }
    .await
    .unwrap_or_default();
    let mut removed = 0;
    for path in paths {
        if let Ok(info) = fs::metadata(&path).await
            && info.modified().is_ok_and(&stale)
        {
            remove_entry(&path).await?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn ignore_missing(result: io::Result<()>) -> Result<(), CanopyError> {
    match result {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        result => result.map_err(io_error),
    }
}

fn unwritable(root: &Path) -> CanopyError {
    internal(format!(
        "The storage folder {} is not writable; set storage.backend.root to a folder this process may write to",
        root.display()
    ))
}

fn io_error(_: io::Error) -> CanopyError {
    internal("The local storage operation failed")
}

fn internal(message: impl Into<String>) -> CanopyError {
    CanopyError::new(ErrorCode::Internal, message)
}

fn not_found(message: &str) -> CanopyError {
    CanopyError::named(ErrorCode::NotFound, "NotFoundError", message)
}
