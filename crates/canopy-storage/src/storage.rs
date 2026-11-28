//! File storage with DLS: every stored file has a metadata document that the policies of the reserved collection
//! `storage.objects` apply to, as they apply to app documents. Reads need `USING(read)`; uploads need
//! `CHECK(insert)`, or `USING(update)` and `CHECK(update)` to replace a file; deletes need `USING(delete)`.
//! Checks run in MongoDB inside the transaction that writes the metadata, and content is stored under a fresh key
//! first, so a refused write leaves nothing behind.

use std::collections::HashMap;
use std::hash::{BuildHasher, BuildHasherDefault, DefaultHasher};
use std::sync::Arc;
use std::time::{Duration, Instant};

use canopy_data::{Caller, Policies, from_driver_error};
use canopy_mongo::mongodb::bson::oid::ObjectId;
use canopy_mongo::mongodb::bson::{Bson, DateTime, Document as BsonDocument, doc};
use canopy_mongo::mongodb::error::{
    Error as DriverError, ErrorKind, TRANSIENT_TRANSACTION_ERROR, UNKNOWN_TRANSACTION_COMMIT_RESULT,
    WriteFailure,
};
use canopy_mongo::mongodb::options::{Acknowledgment, ReadConcern, WriteConcern};
use canopy_mongo::mongodb::{Client, ClientSession, Collection};
use canopy_policy::{Compiled, Operation, PolicyEngine, Role, STORAGE_COLLECTION, project_readable};
use canopy_protocol::sha256::sha256_hex;
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};
use futures_util::StreamExt;
use ring::rand::{SecureRandom, SystemRandom};
use tokio::sync::{Mutex, Semaphore};

use crate::backend::{ByteRange, ByteStream, StorageBackend, UploadedPart};
use crate::paths::{check_path, check_type, is_bucket_name, media_type};
use crate::render::{ImageLimits, MAX_VARIANTS, Transform, check_source_size};
use crate::tokens::{SignedGrant, UrlSigner};

const MIB: u64 = 1024 * 1024;
const DUPLICATE_KEY: i32 = 11000;
const TRANSACTION_TIME: Duration = Duration::from_secs(30);

/// The settings of one bucket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BucketSettings {
    /// Whether anyone may read its files, without a policy.
    pub public: bool,
    /// The largest file, in bytes.
    pub max_file_size: u64,
    /// The content types it accepts (`image/png`, `image/*`); none accepts any.
    pub allowed_types: Vec<String>,
}

/// What the storage is built from.
pub struct StorageOptions {
    /// The MongoDB client.
    pub client: Client,
    /// The meta database, which holds `storage_objects`, `storage_uploads` and `storage_variants`.
    pub meta_database: String,
    /// The policies in force.
    pub policies: Policies,
    /// Where contents live.
    pub backend: Arc<dyn StorageBackend>,
    /// The buckets by name.
    pub buckets: HashMap<String, BucketSettings>,
    /// Image transformations, or disabled when absent.
    pub images: Option<ImageLimits>,
    /// Signs and checks signed URLs.
    pub signer: UrlSigner,
    /// The part size of resumable uploads, at least 5 MiB. Defaults to 8 MiB.
    pub part_size: u64,
    /// The largest resumable upload. Defaults to 5 GiB.
    pub max_upload_size: u64,
    /// How long a resumable upload may stay unfinished, in milliseconds. Defaults to a day.
    pub upload_ttl_ms: i64,
    /// The longest a signed URL may last, in seconds. Defaults to a week.
    pub max_signed_url_seconds: i64,
}

/// What an upload stores besides its content.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UploadOptions {
    /// The `Content-Type` sent with the file.
    pub content_type: String,
    /// Replaces a file at the same path instead of failing.
    pub upsert: bool,
    /// Metadata of the caller's choosing, kept as is.
    pub metadata: Option<BsonDocument>,
}

/// A requested byte range: from `start` to `end` (or the last byte), or the last `suffix` bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RangeRequest {
    /// `bytes=start-end` or `bytes=start-`.
    From {
        /// The first byte.
        start: u64,
        /// The last byte, when given.
        end: Option<u64>,
    },
    /// `bytes=-suffix`.
    Suffix(u64),
}

/// A file opened for reading.
pub struct OpenedObject {
    /// The metadata the caller may see.
    pub object: Document,
    /// The content, or the served range of it.
    pub body: ByteStream,
    /// The served range, when one was asked for.
    pub range: Option<ByteRange>,
}

/// The state of a resumable upload.
#[derive(Clone, Debug, PartialEq)]
pub struct UploadStatus {
    /// The upload id.
    pub id: String,
    /// The bucket.
    pub bucket: String,
    /// The file path.
    pub path: String,
    /// The size of the whole file.
    pub size: u64,
    /// The size of every part but the last.
    pub part_size: u64,
    /// How many parts the file has.
    pub part_count: u64,
    /// The parts stored so far, in order.
    pub parts: Vec<u32>,
    /// When the upload expires, in milliseconds since the epoch.
    pub expires_at: i64,
}

/// A page of files.
#[derive(Clone, Debug, PartialEq)]
pub struct ObjectPage {
    /// The files the caller may read, by path.
    pub data: Vec<Document>,
    /// The path to list after for the next page.
    pub next: Option<String>,
}

/// What a listing asks for.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ListOptions {
    /// Only paths that start with it.
    pub prefix: Option<String>,
    /// At most this many files, from 1 to 1000. Defaults to 100.
    pub limit: Option<i64>,
    /// Only paths after it.
    pub after: Option<String>,
}

fn not_found(message: &str) -> CanopyError {
    CanopyError::named(ErrorCode::NotFound, "NotFoundError", message)
}

fn internal(error: impl std::fmt::Display) -> CanopyError {
    CanopyError::new(ErrorCode::Internal, format!("Storage failed: {error}"))
}

fn is_duplicate(error: &DriverError) -> bool {
    match error.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(write)) => write.code == DUPLICATE_KEY,
        ErrorKind::Command(command) => command.code == DUPLICATE_KEY,
        _ => false,
    }
}

fn now_ms() -> i64 {
    DateTime::now().timestamp_millis()
}

/// A random UUID version 4, as `crypto.randomUUID` makes.
fn random_uuid() -> Result<String, CanopyError> {
    let mut bytes = [0u8; 16];
    SystemRandom::new().fill(&mut bytes).map_err(|_| internal("no randomness"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = canopy_protocol::hex(&bytes);
    Ok(format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32]))
}

fn bson_filter(compiled: &Compiled) -> Result<BsonDocument, CanopyError> {
    canopy_mongo::to_bson(&compiled.to_filter())
}

fn to_canopy(document: &BsonDocument) -> Result<Document, CanopyError> {
    let bytes = document.to_vec().map_err(internal)?;
    canopy_protocol::bson::decode_document(&bytes)
}

/// The metadata of a stored object without `_id` and `key`, the fields every answer shows.
fn info(object: &BsonDocument) -> Result<Document, CanopyError> {
    let mut out = to_canopy(object)?;
    out.remove("_id");
    out.remove("key");
    Ok(out)
}

fn text<'a>(object: &'a BsonDocument, field: &str) -> Result<&'a str, CanopyError> {
    object.get_str(field).map_err(|_| internal(format!("a stored object has no {field}")))
}

fn size_of(object: &BsonDocument) -> u64 {
    match object.get("size") {
        Some(Bson::Int32(size)) => u64::try_from(*size).unwrap_or(0),
        Some(Bson::Int64(size)) => u64::try_from(*size).unwrap_or(0),
        Some(Bson::Double(size)) if *size >= 0.0 => *size as u64,
        _ => 0,
    }
}

/// A byte count as MongoDB stores numbers written from JavaScript: a 32 bit integer when it fits, else a double.
fn number(value: u64) -> Bson {
    match i32::try_from(value) {
        Ok(small) => Bson::Int32(small),
        Err(_) => Bson::Double(value as f64),
    }
}

/// Fits a requested range into a file of `size` bytes. Fails when no byte of the file is in it.
pub fn clamp(range: RangeRequest, size: u64) -> Result<ByteRange, CanopyError> {
    let unsatisfiable = || {
        CanopyError::new(ErrorCode::InvalidQuery, "The range is not satisfiable")
            .with_details(format!("{{\"rangeNotSatisfiable\":true,\"size\":{size}}}"))
    };
    match range {
        RangeRequest::Suffix(suffix) => {
            if suffix < 1 || size == 0 {
                return Err(unsatisfiable());
            }
            Ok(ByteRange { start: size.saturating_sub(suffix), end: size - 1 })
        }
        RangeRequest::From { start, end } => {
            let last = size.checked_sub(1).ok_or_else(unsatisfiable)?;
            let end = end.unwrap_or(last).min(last);
            if start >= size || start > end {
                return Err(unsatisfiable());
            }
            Ok(ByteRange { start, end })
        }
    }
}

/// The storage service.
pub struct Storage {
    options: StorageOptions,
    objects: Collection<BsonDocument>,
    uploads: Collection<BsonDocument>,
    variants: Collection<BsonDocument>,
    render_slots: Arc<Semaphore>,
    variant_locks: [Mutex<()>; 64],
}

impl Storage {
    /// Creates the storage. Fails when the part size is below 5 MiB.
    pub fn new(options: StorageOptions) -> Result<Storage, CanopyError> {
        if options.part_size < 5 * MIB {
            return Err(CanopyError::new(
                ErrorCode::Internal,
                "The part size of resumable uploads must be at least 5 MiB",
            ));
        }
        let meta = options.client.database(&options.meta_database);
        Ok(Storage {
            objects: meta.collection("storage_objects"),
            uploads: meta.collection("storage_uploads"),
            variants: meta.collection("storage_variants"),
            render_slots: Arc::new(Semaphore::new(2)),
            variant_locks: std::array::from_fn(|_| Mutex::new(())),
            options,
        })
    }

    /// The defaults of the optional settings: 8 MiB parts, 5 GiB uploads, a day for uploads, a week for
    /// signed URLs.
    pub fn default_limits() -> (u64, u64, i64, i64) {
        (8 * MIB, 5 * 1024 * MIB, 86_400_000, 7 * 86_400)
    }

    /// The backend.
    pub fn backend(&self) -> &Arc<dyn StorageBackend> {
        &self.options.backend
    }

    /// The settings of a bucket. Fails with `CANOPY_NOT_FOUND` for a bucket that is not configured.
    pub fn bucket(&self, name: &str) -> Result<&BucketSettings, CanopyError> {
        is_bucket_name(name)
            .then(|| self.options.buckets.get(name))
            .flatten()
            .ok_or_else(|| not_found(&format!("No bucket is named {name}")))
    }

    fn engine(&self) -> Arc<PolicyEngine> {
        self.options.policies.current()
    }

    fn driver(&self, caller: &Caller) -> impl Fn(DriverError) -> CanopyError {
        let service = caller.context.roles.contains(Role::SERVICE);
        move |error| from_driver_error(&error, service)
    }

    fn read_filter(&self, caller: &Caller) -> Result<BsonDocument, CanopyError> {
        bson_filter(&self.engine().using(STORAGE_COLLECTION, Operation::Read, &caller.context))
    }

    async fn visible(
        &self,
        caller: &Caller,
        bucket: &str,
        path: &str,
    ) -> Result<Option<BsonDocument>, CanopyError> {
        let filter = doc! { "$and": [{ "bucket": bucket, "path": path }, self.read_filter(caller)?] };
        self.objects.find_one(filter).await.map_err(self.driver(caller))
    }

    fn check_file(&self, bucket: &str, path: &str, size: u64, content_type: &str) -> Result<(), CanopyError> {
        let settings = self.bucket(bucket)?;
        check_path(path)?;
        if size > settings.max_file_size {
            return Err(CanopyError::new(
                ErrorCode::PayloadTooLarge,
                format!("Files in {bucket} may not exceed {} bytes", settings.max_file_size),
            ));
        }
        check_type(content_type, &settings.allowed_types)
    }

    /// Writes a metadata document under the policies: inserts it, or replaces `existing`, and checks the result in
    /// the same transaction. With `dry_run` the transaction is always rolled back, to test a write early.
    async fn commit(
        &self,
        caller: &Caller,
        next: &BsonDocument,
        existing: Option<&BsonDocument>,
        dry_run: bool,
    ) -> Result<(), CanopyError> {
        let ctx = &caller.context;
        let engine = self.engine();
        let op = if existing.is_none() { Operation::Insert } else { Operation::Update };
        if !ctx.roles.contains(Role::SERVICE) && !engine.has_grant(STORAGE_COLLECTION, op, ctx) {
            return Err(CanopyError::named(
                ErrorCode::Forbidden,
                "ForbiddenError",
                format!("No storage policy grants {} to these roles", op.as_str()),
            ));
        }
        let target = match existing {
            Some(_) => Some(bson_filter(&engine.target(STORAGE_COLLECTION, Operation::Update, ctx)?)?),
            None => None,
        };
        let check = engine.check(STORAGE_COLLECTION, op, ctx);
        let check = match check {
            Compiled::All => None,
            other => Some(bson_filter(&other)?),
        };
        let id = next.get("_id").cloned().unwrap_or(Bson::Null);
        let driver = self.driver(caller);
        let mut session = self.options.client.start_session().await.map_err(&driver)?;
        let deadline = Instant::now() + TRANSACTION_TIME;
        loop {
            session
                .start_transaction()
                .read_concern(ReadConcern::majority())
                .write_concern(WriteConcern::builder().w(Acknowledgment::Majority).build())
                .await
                .map_err(&driver)?;
            let attempt = self
                .commit_body(&mut session, next, existing, target.as_ref(), check.as_ref(), &id, op)
                .await;
            match attempt {
                Ok(()) if dry_run => {
                    let _ = session.abort_transaction().await;
                    return Ok(());
                }
                Ok(()) => match commit_transaction(&mut session, deadline).await {
                    Ok(()) => return Ok(()),
                    Err(error)
                        if error.contains_label(TRANSIENT_TRANSACTION_ERROR) && Instant::now() < deadline => {
                    }
                    Err(error) => return Err(driver(error)),
                },
                Err(Failed::Driver(error)) => {
                    let _ = session.abort_transaction().await;
                    if error.contains_label(TRANSIENT_TRANSACTION_ERROR) && Instant::now() < deadline {
                        continue;
                    }
                    if is_duplicate(&error) {
                        return Err(CanopyError::named(
                            ErrorCode::Conflict,
                            "ConflictError",
                            "A file exists at this path; send x-upsert: true to replace it",
                        ));
                    }
                    return Err(driver(error));
                }
                Err(Failed::Canopy(error)) => {
                    let _ = session.abort_transaction().await;
                    return Err(error);
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn commit_body(
        &self,
        session: &mut ClientSession,
        next: &BsonDocument,
        existing: Option<&BsonDocument>,
        target: Option<&BsonDocument>,
        check: Option<&BsonDocument>,
        id: &Bson,
        op: Operation,
    ) -> Result<(), Failed> {
        match (existing, target) {
            (Some(existing), Some(target)) => {
                let key = existing.get("key").cloned().unwrap_or(Bson::Null);
                let filter = doc! { "$and": [{ "_id": id.clone(), "key": key }, target.clone()] };
                let replaced =
                    self.objects.find_one_and_replace(filter, next.clone()).session(&mut *session).await?;
                if replaced.is_none() {
                    return Err(Failed::Canopy(not_found("No such file")));
                }
            }
            _ => {
                self.objects.insert_one(next.clone()).session(&mut *session).await?;
            }
        }
        if let Some(check) = check {
            let filter = doc! { "$and": [{ "_id": id.clone() }, check.clone()] };
            let passes =
                self.objects.find_one(filter).projection(doc! { "_id": 1 }).session(&mut *session).await?;
            if passes.is_none() {
                return Err(Failed::Canopy(CanopyError::named(
                    ErrorCode::PolicyViolation,
                    "PolicyViolationError",
                    format!("The file does not satisfy the {} check of storage.objects", op.as_str()),
                )));
            }
        }
        Ok(())
    }

    /// The metadata document a write at `bucket/path` would store, replacing `existing` when given.
    fn next_object(
        caller: &Caller,
        bucket: &str,
        path: &str,
        existing: Option<&BsonDocument>,
        content: (&str, u64, &str, &str),
        metadata: Option<BsonDocument>,
    ) -> BsonDocument {
        let (key, size, content_type, etag) = content;
        let now = DateTime::now();
        let owner = match existing {
            Some(existing) => existing.get("owner").cloned().unwrap_or(Bson::Null),
            None => match caller.context.claims.as_ref().and_then(|claims| claims.get("sub")) {
                Some(Value::String(sub)) => Bson::String(sub.clone()),
                _ => Bson::Null,
            },
        };
        let metadata = metadata
            .map(Bson::Document)
            .or_else(|| existing.and_then(|existing| existing.get("metadata").cloned()))
            .unwrap_or_else(|| Bson::Document(BsonDocument::new()));
        doc! {
            "_id": existing.and_then(|existing| existing.get("_id").cloned()).unwrap_or_else(|| Bson::ObjectId(ObjectId::new())),
            "bucket": bucket,
            "path": path,
            "key": key,
            "size": number(size),
            "contentType": content_type,
            "etag": etag,
            "owner": owner,
            "metadata": metadata,
            "createdAt": existing.and_then(|existing| existing.get("createdAt").cloned()).unwrap_or(Bson::DateTime(now)),
            "updatedAt": now,
        }
    }

    async fn existing(
        &self,
        caller: &Caller,
        upsert: bool,
        bucket: &str,
        path: &str,
    ) -> Result<Option<BsonDocument>, CanopyError> {
        if !upsert {
            return Ok(None);
        }
        self.objects.find_one(doc! { "bucket": bucket, "path": path }).await.map_err(self.driver(caller))
    }

    /// Stores a whole file in one request.
    pub async fn upload(
        &self,
        caller: &Caller,
        bucket: &str,
        path: &str,
        body: Vec<u8>,
        options: UploadOptions,
    ) -> Result<Document, CanopyError> {
        self.check_file(bucket, path, body.len() as u64, &options.content_type)?;
        let existing = self.existing(caller, options.upsert, bucket, path).await?;
        let key = format!("{bucket}/{}", ObjectId::new().to_hex());
        let content_type = match media_type(&options.content_type) {
            media if media.is_empty() => "application/octet-stream".to_owned(),
            media => media,
        };
        let etag = sha256_hex(&body);
        let next = Storage::next_object(
            caller,
            bucket,
            path,
            existing.as_ref(),
            (&key, body.len() as u64, &content_type, &etag),
            options.metadata,
        );
        self.commit(caller, &next, existing.as_ref(), true).await?;
        self.options.backend.put(&key, body, &content_type).await?;
        if let Err(error) = self.commit(caller, &next, existing.as_ref(), false).await {
            let _ = self.options.backend.delete(&key).await;
            return Err(error);
        }
        if let Some(existing) = &existing {
            self.discard(text(existing, "key")?).await;
        }
        info(&next)
    }

    /// Deletes stored content and every cached variant of it. A failure leaves garbage, never an error.
    async fn discard(&self, key: &str) {
        let _ = self.options.backend.delete(key).await;
        let Ok(mut variants) = self.variants.find(doc! { "key": key }).projection(doc! { "_id": 1 }).await
        else {
            return;
        };
        while variants.advance().await.unwrap_or(false) {
            if let Ok(variant) = variants.deserialize_current()
                && let Ok(id) = variant.get_str("_id")
            {
                let _ = self.options.backend.delete(id).await;
            }
        }
        let _ = self.variants.delete_many(doc! { "key": key }).await;
    }

    fn readable(&self, caller: &Caller, object: &BsonDocument) -> Result<Document, CanopyError> {
        project_readable(&self.engine().readable(STORAGE_COLLECTION, &caller.context), &info(object)?)
    }

    /// The metadata of a file the caller may read. Fails with `CANOPY_NOT_FOUND` otherwise.
    pub async fn stat(&self, caller: &Caller, bucket: &str, path: &str) -> Result<Document, CanopyError> {
        let object = self.find_visible(caller, bucket, path).await?;
        self.readable(caller, &object)
    }

    async fn read(
        &self,
        object: &BsonDocument,
        range: Option<RangeRequest>,
    ) -> Result<OpenedObject, CanopyError> {
        let served = range.map(|range| clamp(range, size_of(object))).transpose()?;
        Ok(OpenedObject {
            object: info(object)?,
            body: self.options.backend.get(text(object, "key")?, served).await?,
            range: served,
        })
    }

    async fn find_visible(
        &self,
        caller: &Caller,
        bucket: &str,
        path: &str,
    ) -> Result<BsonDocument, CanopyError> {
        self.bucket(bucket)?;
        self.visible(caller, bucket, path).await?.ok_or_else(|| not_found("No such file"))
    }

    async fn find_public(&self, bucket: &str, path: &str) -> Result<BsonDocument, CanopyError> {
        if !self.bucket(bucket)?.public {
            return Err(not_found("No such file"));
        }
        self.objects
            .find_one(doc! { "bucket": bucket, "path": path })
            .await
            .map_err(|error| from_driver_error(&error, false))?
            .ok_or_else(|| not_found("No such file"))
    }

    async fn find_signed(&self, token: &str, bucket: &str, path: &str) -> Result<BsonDocument, CanopyError> {
        let grant = self.options.signer.verify(token, now_ms() as f64);
        if !grant.is_some_and(|grant| grant.bucket == bucket && grant.path == path) {
            return Err(CanopyError::new(
                ErrorCode::Unauthorized,
                "The signed URL is not valid or has expired",
            ));
        }
        self.bucket(bucket)?;
        self.objects
            .find_one(doc! { "bucket": bucket, "path": path })
            .await
            .map_err(|error| from_driver_error(&error, false))?
            .ok_or_else(|| not_found("No such file"))
    }

    /// Opens a file the caller may read.
    pub async fn open(
        &self,
        caller: &Caller,
        bucket: &str,
        path: &str,
        range: Option<RangeRequest>,
    ) -> Result<OpenedObject, CanopyError> {
        let object = self.find_visible(caller, bucket, path).await?;
        let opened = self.read(&object, range).await?;
        Ok(OpenedObject { object: self.readable(caller, &object)?, ..opened })
    }

    /// Opens a file of a public bucket, without a policy.
    pub async fn open_public(
        &self,
        bucket: &str,
        path: &str,
        range: Option<RangeRequest>,
    ) -> Result<OpenedObject, CanopyError> {
        let object = self.find_public(bucket, path).await?;
        self.read(&object, range).await
    }

    /// Opens the file a signed URL token grants.
    pub async fn open_signed(
        &self,
        token: &str,
        bucket: &str,
        path: &str,
        range: Option<RangeRequest>,
    ) -> Result<OpenedObject, CanopyError> {
        let object = self.find_signed(token, bucket, path).await?;
        self.read(&object, range).await
    }

    pub(crate) fn image_limits(&self) -> Option<ImageLimits> {
        self.options.images
    }

    pub(crate) async fn open_image(
        &self,
        caller: Option<&Caller>,
        token: Option<&str>,
        bucket: &str,
        path: &str,
        transform: Transform,
        limits: ImageLimits,
    ) -> Result<OpenedObject, CanopyError> {
        let mut object = match (caller, token) {
            (Some(caller), _) => self.find_visible(caller, bucket, path).await?,
            (None, Some(token)) => self.find_signed(token, bucket, path).await?,
            (None, None) => self.find_public(bucket, path).await?,
        };
        let key = text(&object, "key")?;
        let hash = transform.hash();
        let variant_key = format!("{key}.variants/{hash}");
        let source_type = text(&object, "contentType")?;
        let content_type = transform.output(source_type)?;
        check_source_size(size_of(&object), limits.max_source_size)?;

        let stripe =
            BuildHasherDefault::<DefaultHasher>::new().hash_one(key) as usize % self.variant_locks.len();
        let _lock = self.variant_locks[stripe].lock().await;
        let (size, body) =
            self.image_variant(key, &variant_key, source_type, content_type, transform, limits).await?;
        object.insert("etag", format!("{}-{hash}", text(&object, "etag")?));
        object.insert("contentType", content_type);
        object.insert("size", number(size));
        let object = match caller {
            Some(caller) => self.readable(caller, &object)?,
            None => info(&object)?,
        };
        Ok(OpenedObject { object, body, range: None })
    }

    async fn image_variant(
        &self,
        key: &str,
        variant_key: &str,
        source_type: &str,
        content_type: &str,
        transform: Transform,
        limits: ImageLimits,
    ) -> Result<(u64, ByteStream), CanopyError> {
        let selector = doc! { "_id": variant_key };
        let backend = &self.options.backend;
        if let Some(cached) = self
            .variants
            .find_one(selector.clone())
            .await
            .map_err(|error| from_driver_error(&error, false))?
        {
            match backend.get(variant_key, None).await {
                Ok(body) => return Ok((size_of(&cached), body)),
                Err(error) if error.code() == ErrorCode::NotFound => {
                    self.variants
                        .delete_one(selector.clone())
                        .await
                        .map_err(|error| from_driver_error(&error, false))?;
                }
                Err(error) => return Err(error),
            }
        }

        let slot = Arc::clone(&self.render_slots).acquire_owned().await.map_err(internal)?;
        let mut source = Vec::new();
        let mut chunks = backend.get(key, None).await?;
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk?;
            check_source_size(source.len() as u64 + chunk.len() as u64, limits.max_source_size)?;
            source.extend(chunk);
        }
        let source_type = source_type.to_owned();
        let (_slot, body) = tokio::task::spawn_blocking(move || {
            let body = transform.encode(&source, &source_type, limits)?;
            Ok::<_, CanopyError>((slot, body))
        })
        .await
        .map_err(internal)??;
        let size = body.len() as u64;

        if let Ok(count) = self.variants.count_documents(doc! { "key": key }).limit(MAX_VARIANTS).await
            && count < MAX_VARIANTS
            && backend.put(variant_key, body.clone(), content_type).await.is_ok()
        {
            let variant = doc! {
                "_id": variant_key,
                "key": key,
                "size": number(size),
                "contentType": content_type,
                "createdAt": DateTime::now(),
            };
            if self.variants.replace_one(selector, variant).upsert(true).await.is_err() {
                let _ = backend.delete(variant_key).await;
            } else if matches!(self.objects.count_documents(doc! { "key": key }).limit(1).await, Ok(0)) {
                self.discard(key).await;
            }
        }

        let stream = futures_util::stream::once(async move { Ok(body) });
        Ok((size, Box::pin(stream)))
    }

    /// A token that lets anyone read one file the caller may read, for `expires_in` seconds, and when it expires
    /// (milliseconds since the epoch).
    pub async fn sign(
        &self,
        caller: &Caller,
        bucket: &str,
        path: &str,
        expires_in: f64,
    ) -> Result<(String, i64), CanopyError> {
        let max = self.options.max_signed_url_seconds;
        if expires_in.fract() != 0.0 || expires_in < 1.0 || expires_in > max as f64 {
            return Err(CanopyError::invalid_query(format!(
                "expiresIn must be a number of seconds from 1 to {max}"
            )));
        }
        self.bucket(bucket)?;
        if self.visible(caller, bucket, path).await?.is_none() {
            return Err(not_found("No such file"));
        }
        let expires_at = now_ms() + expires_in as i64 * 1000;
        let token = self.options.signer.sign(&SignedGrant {
            bucket: bucket.to_owned(),
            path: path.to_owned(),
            expires_at: expires_at as f64,
        });
        Ok((token, expires_at))
    }

    /// Deletes a file the caller may delete.
    pub async fn remove(&self, caller: &Caller, bucket: &str, path: &str) -> Result<(), CanopyError> {
        self.bucket(bucket)?;
        let ctx = &caller.context;
        let engine = self.engine();
        if !ctx.roles.contains(Role::SERVICE) && !engine.has_grant(STORAGE_COLLECTION, Operation::Delete, ctx)
        {
            return Err(CanopyError::named(
                ErrorCode::Forbidden,
                "ForbiddenError",
                "No storage policy grants delete to these roles",
            ));
        }
        let target = bson_filter(&engine.target(STORAGE_COLLECTION, Operation::Delete, ctx)?)?;
        let removed = self
            .objects
            .find_one_and_delete(doc! { "$and": [{ "bucket": bucket, "path": path }, target] })
            .await
            .map_err(self.driver(caller))?
            .ok_or_else(|| not_found("No such file"))?;
        self.discard(text(&removed, "key")?).await;
        Ok(())
    }

    /// Lists the files of a bucket the caller may read, by path, after `after`.
    pub async fn list(
        &self,
        caller: &Caller,
        bucket: &str,
        options: &ListOptions,
    ) -> Result<ObjectPage, CanopyError> {
        self.bucket(bucket)?;
        let limit = options.limit.unwrap_or(100);
        if !(1..=1000).contains(&limit) {
            return Err(CanopyError::invalid_query("limit must be from 1 to 1000"));
        }
        let mut path = BsonDocument::new();
        if let Some(prefix) = options.prefix.as_deref().filter(|prefix| !prefix.is_empty()) {
            path.insert("$regex", format!("^{}", escape_regex(prefix)));
        }
        if let Some(after) = &options.after {
            path.insert("$gt", after.as_str());
        }
        let mut first = doc! { "bucket": bucket };
        if !path.is_empty() {
            first.insert("path", path);
        }
        let filter = doc! { "$and": [first, self.read_filter(caller)?] };
        let driver = self.driver(caller);
        let mut cursor =
            self.objects.find(filter).sort(doc! { "path": 1 }).limit(limit + 1).await.map_err(&driver)?;
        let mut found = Vec::new();
        while cursor.advance().await.map_err(&driver)? {
            found.push(cursor.deserialize_current().map_err(&driver)?);
        }
        let more = found.len() > usize::try_from(limit).unwrap_or(usize::MAX);
        found.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
        let next = if more {
            found.last().and_then(|last| last.get_str("path").ok()).map(str::to_owned)
        } else {
            None
        };
        let data = found.iter().map(|object| self.readable(caller, object)).collect::<Result<Vec<_>, _>>()?;
        Ok(ObjectPage { data, next })
    }

    /// Starts a resumable upload of `size` bytes. The write is checked now, and again when it completes.
    pub async fn create_upload(
        &self,
        caller: &Caller,
        bucket: &str,
        path: &str,
        size: f64,
        options: UploadOptions,
    ) -> Result<UploadStatus, CanopyError> {
        let max = self.options.max_upload_size;
        if size.fract() != 0.0 || size < 1.0 || size > 9_007_199_254_740_991.0 {
            return Err(CanopyError::invalid_query("size must be a positive number of bytes"));
        }
        let size = size as u64;
        if size > max {
            return Err(CanopyError::new(
                ErrorCode::PayloadTooLarge,
                format!("Uploads may not exceed {max} bytes"),
            ));
        }
        self.check_file(bucket, path, size, &options.content_type)?;
        let existing = self.existing(caller, options.upsert, bucket, path).await?;
        let key = format!("{bucket}/{}", ObjectId::new().to_hex());
        let content_type = match media_type(&options.content_type) {
            media if media.is_empty() => "application/octet-stream".to_owned(),
            media => media,
        };
        let metadata = options.metadata.clone();
        let next = Storage::next_object(
            caller,
            bucket,
            path,
            existing.as_ref(),
            (&key, size, &content_type, ""),
            metadata.clone(),
        );
        self.commit(caller, &next, existing.as_ref(), true).await?;
        let upload_id = self.options.backend.create_multipart(&key, &content_type).await?;
        let now = now_ms();
        let session = doc! {
            "_id": random_uuid()?,
            "bucket": bucket,
            "path": path,
            "subject": caller.subject.as_str(),
            "size": number(size),
            "contentType": content_type.as_str(),
            "metadata": metadata.unwrap_or_default(),
            "upsert": options.upsert,
            "key": key.as_str(),
            "uploadId": upload_id,
            "partSize": number(self.options.part_size),
            "parts": BsonDocument::new(),
            "createdAt": DateTime::from_millis(now),
            "expiresAt": DateTime::from_millis(now + self.options.upload_ttl_ms),
        };
        self.uploads.insert_one(session.clone()).await.map_err(self.driver(caller))?;
        status(&session)
    }

    async fn session(&self, caller: &Caller, id: &str) -> Result<BsonDocument, CanopyError> {
        let session = self.uploads.find_one(doc! { "_id": id }).await.map_err(self.driver(caller))?;
        match session {
            Some(session)
                if session.get_str("subject").is_ok_and(|subject| subject == caller.subject)
                    && session.get_datetime("expiresAt").is_ok_and(|at| at.timestamp_millis() > now_ms()) =>
            {
                Ok(session)
            }
            _ => Err(not_found("No such upload")),
        }
    }

    /// The parts of a resumable upload stored so far.
    pub async fn upload_status(&self, caller: &Caller, id: &str) -> Result<UploadStatus, CanopyError> {
        status(&self.session(caller, id).await?)
    }

    /// Stores one part of a resumable upload; every part but the last has exactly the part size.
    pub async fn put_part(
        &self,
        caller: &Caller,
        id: &str,
        part: f64,
        body: Vec<u8>,
    ) -> Result<UploadStatus, CanopyError> {
        let session = self.session(caller, id).await?;
        let (size, part_size) = (size_field(&session, "size"), size_field(&session, "partSize"));
        let count = size.div_ceil(part_size.max(1));
        if part.fract() != 0.0 || part < 1.0 || part > count as f64 {
            return Err(CanopyError::invalid_query(format!("The part number must be from 1 to {count}")));
        }
        let part = part as u64;
        let expected = if part < count { part_size } else { size - (count - 1) * part_size };
        if body.len() as u64 != expected {
            return Err(CanopyError::invalid_query(format!(
                "Part {part} must have {expected} bytes, not {}",
                body.len()
            )));
        }
        let length = body.len() as u64;
        let number_of_part = u32::try_from(part).map_err(internal)?;
        let etag = self
            .options
            .backend
            .put_part(text(&session, "key")?, text(&session, "uploadId")?, number_of_part, body)
            .await?;
        let updated = self
            .uploads
            .find_one_and_update(
                doc! { "_id": id },
                doc! { "$set": { format!("parts.{part}"): { "etag": etag, "size": number(length) } } },
            )
            .return_document(canopy_mongo::mongodb::options::ReturnDocument::After)
            .await
            .map_err(self.driver(caller))?
            .ok_or_else(|| not_found("No such upload"))?;
        status(&updated)
    }

    /// Joins the parts and stores the metadata document, checking the write again.
    pub async fn complete_upload(&self, caller: &Caller, id: &str) -> Result<Document, CanopyError> {
        let session = self.session(caller, id).await?;
        let (size, part_size) = (size_field(&session, "size"), size_field(&session, "partSize"));
        let count = size.div_ceil(part_size.max(1));
        let stored = session.get_document("parts").ok();
        let mut parts = Vec::new();
        for index in 1..=count {
            let etag = stored
                .and_then(|parts| parts.get_document(index.to_string()).ok())
                .and_then(|part| part.get_str("etag").ok())
                .ok_or_else(|| {
                    CanopyError::named(
                        ErrorCode::Conflict,
                        "ConflictError",
                        format!("Part {index} has not been uploaded"),
                    )
                })?;
            parts.push(UploadedPart { part: u32::try_from(index).map_err(internal)?, etag: etag.to_owned() });
        }
        let key = text(&session, "key")?.to_owned();
        self.options.backend.complete_multipart(&key, text(&session, "uploadId")?, &parts).await?;
        let (bucket, path) = (text(&session, "bucket")?, text(&session, "path")?);
        let upsert = session.get_bool("upsert").unwrap_or(false);
        let existing = self.existing(caller, upsert, bucket, path).await?;
        let joined: String = parts.iter().map(|part| part.etag.as_str()).collect();
        let etag = format!("{}-{count}", sha256_hex(joined.as_bytes()));
        let metadata = session.get_document("metadata").ok().cloned();
        let next = Storage::next_object(
            caller,
            bucket,
            path,
            existing.as_ref(),
            (&key, size, text(&session, "contentType")?, &etag),
            metadata,
        );
        let committed = self.commit(caller, &next, existing.as_ref(), false).await;
        let _ = self.uploads.delete_one(doc! { "_id": id }).await;
        if let Err(error) = committed {
            let _ = self.options.backend.delete(&key).await;
            return Err(error);
        }
        if let Some(existing) = &existing {
            self.discard(text(existing, "key")?).await;
        }
        info(&next)
    }

    /// Drops a resumable upload and its parts.
    pub async fn abort_upload(&self, caller: &Caller, id: &str) -> Result<(), CanopyError> {
        let session = self.session(caller, id).await?;
        self.options.backend.abort_multipart(text(&session, "key")?, text(&session, "uploadId")?).await?;
        self.uploads.delete_one(doc! { "_id": id }).await.map_err(self.driver(caller))?;
        Ok(())
    }

    /// Drops the parts of uploads that expired unfinished, and what interrupted writes left in the backend.
    /// Returns how many uploads were dropped.
    pub async fn sweep(&self, now: i64) -> Result<u64, CanopyError> {
        let ttl = self.options.upload_ttl_ms;
        let _ = self.options.backend.sweep(now - 2 * ttl).await;
        let mut cursor = self
            .uploads
            .find(doc! { "expiresAt": { "$lte": DateTime::from_millis(now) } })
            .limit(1000)
            .await
            .map_err(|error| from_driver_error(&error, true))?;
        let mut expired = Vec::new();
        while cursor.advance().await.map_err(|error| from_driver_error(&error, true))? {
            expired.push(cursor.deserialize_current().map_err(|error| from_driver_error(&error, true))?);
        }
        let mut dropped = 0;
        for session in expired {
            if let (Ok(key), Ok(upload)) = (session.get_str("key"), session.get_str("uploadId")) {
                let _ = self.options.backend.abort_multipart(key, upload).await;
            }
            let id = session.get("_id").cloned().unwrap_or(Bson::Null);
            if let Ok(removed) = self.uploads.delete_one(doc! { "_id": id }).await {
                dropped += removed.deleted_count;
            }
        }
        Ok(dropped)
    }
}

enum Failed {
    Driver(DriverError),
    Canopy(CanopyError),
}

impl From<DriverError> for Failed {
    fn from(error: DriverError) -> Failed {
        Failed::Driver(error)
    }
}

async fn commit_transaction(session: &mut ClientSession, deadline: Instant) -> Result<(), DriverError> {
    loop {
        match session.commit_transaction().await {
            Ok(()) => return Ok(()),
            Err(error)
                if error.contains_label(UNKNOWN_TRANSACTION_COMMIT_RESULT) && Instant::now() < deadline => {}
            Err(error) => return Err(error),
        }
    }
}

fn size_field(document: &BsonDocument, field: &str) -> u64 {
    match document.get(field) {
        Some(Bson::Int32(value)) => u64::try_from(*value).unwrap_or(0),
        Some(Bson::Int64(value)) => u64::try_from(*value).unwrap_or(0),
        Some(Bson::Double(value)) if *value >= 0.0 => *value as u64,
        _ => 0,
    }
}

fn status(session: &BsonDocument) -> Result<UploadStatus, CanopyError> {
    let (size, part_size) = (size_field(session, "size"), size_field(session, "partSize"));
    let mut parts: Vec<u32> = session
        .get_document("parts")
        .map(|parts| parts.keys().filter_map(|key| key.parse().ok()).collect())
        .unwrap_or_default();
    parts.sort_unstable();
    Ok(UploadStatus {
        id: text(session, "_id")?.to_owned(),
        bucket: text(session, "bucket")?.to_owned(),
        path: text(session, "path")?.to_owned(),
        size,
        part_size,
        part_count: size.div_ceil(part_size.max(1)),
        parts,
        expires_at: session.get_datetime("expiresAt").map(|at| at.timestamp_millis()).unwrap_or(0),
    })
}

/// Escapes text for a regular expression that matches it literally.
fn escape_regex(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}
