//! Where file contents live. Keys are chosen by the storage (`<bucket>/<id>`), never by callers, and a key is
//! written once: replacing a file writes a new key and deletes the old one.

use std::future::Future;
use std::pin::Pin;

use canopy_protocol::CanopyError;
use futures_util::Stream;

/// A boxed future of a backend operation.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The content of a key, or one range of it, in chunks.
pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Vec<u8>, CanopyError>> + Send>>;

/// A byte range, both ends included, as in an HTTP `Range` header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ByteRange {
    /// The first byte.
    pub start: u64,
    /// The last byte.
    pub end: u64,
}

/// A part of a multipart upload, as the backend acknowledged it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploadedPart {
    /// The part number, from 1.
    pub part: u32,
    /// The etag the backend gave it.
    pub etag: String,
}

/// A store of file contents.
pub trait StorageBackend: Send + Sync {
    /// A name for logs and the admin API: `local`, `r2` or `s3`.
    fn kind(&self) -> &str;

    /// Stores the whole content of a key.
    fn put<'a>(
        &'a self,
        key: &'a str,
        body: Vec<u8>,
        content_type: &'a str,
    ) -> BoxFuture<'a, Result<(), CanopyError>>;

    /// Streams the content of a key, or one range of it. A missing key fails with `CANOPY_NOT_FOUND`.
    fn get<'a>(
        &'a self,
        key: &'a str,
        range: Option<ByteRange>,
    ) -> BoxFuture<'a, Result<ByteStream, CanopyError>>;

    /// Deletes a key; a missing key is not an error.
    fn delete<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), CanopyError>>;

    /// Starts a multipart upload of a key and returns its id.
    fn create_multipart<'a>(
        &'a self,
        key: &'a str,
        content_type: &'a str,
    ) -> BoxFuture<'a, Result<String, CanopyError>>;

    /// Stores one part (from 1); storing a part again replaces it. Returns its etag.
    fn put_part<'a>(
        &'a self,
        key: &'a str,
        upload_id: &'a str,
        part: u32,
        body: Vec<u8>,
    ) -> BoxFuture<'a, Result<String, CanopyError>>;

    /// Joins the parts, in order, into the content of the key.
    fn complete_multipart<'a>(
        &'a self,
        key: &'a str,
        upload_id: &'a str,
        parts: &'a [UploadedPart],
    ) -> BoxFuture<'a, Result<(), CanopyError>>;

    /// Drops the parts of an upload.
    fn abort_multipart<'a>(
        &'a self,
        key: &'a str,
        upload_id: &'a str,
    ) -> BoxFuture<'a, Result<(), CanopyError>>;

    /// Removes what an interrupted write left behind, and multipart uploads untouched since `older_than_ms`
    /// (milliseconds since the epoch). Returns how many entries it removed; stores that clean up by themselves
    /// remove nothing.
    fn sweep(&self, older_than_ms: i64) -> BoxFuture<'_, Result<u64, CanopyError>> {
        let _ = older_than_ms;
        Box::pin(async { Ok(0) })
    }
}
