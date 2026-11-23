//! Canopy's data plane read execution: from a verified principal and a parsed request to a page of documents, a
//! count, the distinct values of a field or the result of a sanitized aggregation.
//! A caller is resolved with its context lookups, the read policy is compiled into the filter and the
//! authorized projection MongoDB runs, pages continue from keyset cursors, and one page costs one `find`
//! (plus a count when asked) in a snapshot session whose cluster time is reported with the page.
//!
//! It mirrors the TypeScript `@canopy/rest` read path. Every failure denies: a policy that cannot be
//! evaluated matches no document, a context lookup that fails leaves its policies unresolved, and an error
//! from MongoDB never yields a partial page.

mod caller;
mod contexts;
mod cursor;
mod errors;
mod find;
mod limits;
mod page;
mod policies;
mod reads;
mod snapshot;

pub use caller::Caller;
pub use contexts::ContextResolver;
pub use cursor::{
    CursorKey, cursor_keys, cursor_query_hash, decode_cursor, encode_cursor, keyset_filter, position_of,
    sort_document,
};
pub use errors::from_driver_error;
pub use find::{FindRequest, ReadPath, validate_collection_name};
pub use limits::ReadLimits;
pub use page::{CountMode, Encoding, FindPage};
pub use policies::Policies;
pub use reads::{AggregateResult, CountResult, DistinctResult};

use canopy_protocol::CanopyError;

pub(crate) fn fail<T>(message: impl Into<String>) -> Result<T, CanopyError> {
    Err(CanopyError::invalid_query(message))
}
