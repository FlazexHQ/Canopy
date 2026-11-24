//! Canopy's file storage in the data plane, as the TypeScript `@canopy/storage` package serves it: objects
//! described by documents of `storage.objects` under the storage policies, their contents in a backend, signed
//! URLs and resumable uploads.

pub mod backend;
pub mod http;
pub mod local;
pub mod paths;
pub mod s3;
pub mod storage;
pub mod tokens;
