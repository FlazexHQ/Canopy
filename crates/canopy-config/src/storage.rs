use std::collections::HashMap;
use std::fmt;

use canopy_protocol::json::{Json, write_json};
use serde::Deserialize;

/// A resolved file storage backend.
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum StorageBackend {
    /// The Local backend.
    Local {
        /// The directory holding the stored bytes.
        root: String,
    },
    /// The S3 backend.
    S3 {
        /// The optional S3 endpoint.
        endpoint: Option<String>,
        /// The signing region.
        region: String,
        /// The physical bucket.
        bucket: String,
        /// The access key ID.
        access_key_id: String,
        /// The secret access key.
        secret_access_key: String,
        /// The optional session credential.
        session_token: Option<String>,
        /// Whether to use path style addressing.
        force_path_style: Option<bool>,
        #[serde(default)]
        /// The prefix of every object key.
        prefix: String,
    },
    /// The R2 backend.
    R2 {
        /// The Cloudflare account ID.
        account_id: String,
        /// The physical bucket.
        bucket: String,
        /// The access key ID.
        access_key_id: String,
        /// The secret access key.
        secret_access_key: String,
        /// The optional jurisdiction.
        jurisdiction: Option<String>,
        #[serde(default)]
        /// The prefix of every object key.
        prefix: String,
    },
}

/// The settings of a logical bucket.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BucketSettings {
    /// Whether unauthenticated callers may download files.
    pub public: bool,
    /// The maximum file size in bytes.
    pub max_file_size: u64,
    /// The allowed MIME types.
    pub allowed_types: Vec<String>,
}

/// Settings for the image transformation routes.
#[derive(Clone, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageImages {
    /// Whether image transformations are enabled.
    pub enabled: bool,
    /// Maximum output width and height, in pixels.
    pub max_dimension: u32,
    /// Maximum source size, in bytes.
    pub max_source_size: u64,
}

impl Default for StorageImages {
    fn default() -> Self {
        Self { enabled: true, max_dimension: 2500, max_source_size: 25 * 1024 * 1024 }
    }
}

/// The storage API settings resolved by the launcher.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageSettings {
    /// The base HTTP path.
    #[serde(default = "default_path")]
    pub path: String,
    /// Logical buckets and their upload rules.
    pub buckets: HashMap<String, BucketSettings>,
    /// Image transformation settings.
    #[serde(default)]
    pub images: StorageImages,
    /// The backend holding the bytes.
    pub backend: StorageBackend,
    /// The master key of signed URLs, when shared with another process.
    pub signing_master_key: Option<String>,
    /// The maximum size of a resumable upload part, in bytes.
    #[serde(default = "default_part_size")]
    pub part_size: u64,
    /// The maximum size of a resumable upload, in bytes.
    #[serde(default = "default_max_upload_size")]
    pub max_upload_size: u64,
    /// The lifetime of an unfinished upload in milliseconds.
    #[serde(default = "default_upload_ttl")]
    pub upload_ttl_ms: i64,
    /// The maximum lifetime of a signed URL in seconds.
    #[serde(default = "default_signed_url_lifetime")]
    pub max_signed_url_seconds: i64,
}

impl fmt::Debug for StorageSettings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("StorageSettings").finish_non_exhaustive()
    }
}

fn default_path() -> String {
    "/storage/v1".to_owned()
}

fn default_part_size() -> u64 {
    8 * 1024 * 1024
}

fn default_max_upload_size() -> u64 {
    5 * 1024 * 1024 * 1024
}

fn default_upload_ttl() -> i64 {
    86_400_000
}

fn default_signed_url_lifetime() -> i64 {
    7 * 86_400
}

pub(super) fn settings(value: Option<&Json>) -> Result<Option<StorageSettings>, String> {
    let Some(value) = value.filter(|value| !matches!(value, Json::Bool(false))) else {
        return Ok(None);
    };
    let mut encoded = String::new();
    write_json(&mut encoded, value);
    let settings: StorageSettings =
        serde_json::from_str(&encoded).map_err(|_| "storage must contain valid settings".to_owned())?;
    if !settings.path.starts_with('/')
        || settings.path.trim_matches('/').is_empty()
        || settings.path.contains(['?', '#'])
    {
        return Err("storage.path must be an absolute HTTP path".to_owned());
    }
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    if settings.part_size < 5 * 1024 * 1024
        || settings.max_upload_size == 0
        || settings.images.max_dimension == 0
        || settings.images.max_source_size == 0
        || !(1..=MAX_SAFE_INTEGER).contains(&settings.upload_ttl_ms)
        || !(1..=MAX_SAFE_INTEGER).contains(&settings.max_signed_url_seconds)
        || settings.buckets.values().any(|bucket| bucket.max_file_size == 0)
    {
        return Err("storage limits are out of range".to_owned());
    }
    Ok(Some(settings))
}
