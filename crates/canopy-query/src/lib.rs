//! Canopy's query validation in Rust: filters, sorts, projections, limits and updates from untrusted callers,
//! checked against an operator allowlist per context and against size limits, and the canonical text and hash
//! that identify a live query. It mirrors the TypeScript `@canopy/query` package; vectors recorded from that
//! package keep the two byte identical.

mod canonical;
mod filter;
mod limits;
mod paths;
mod query;
mod values;

pub use canonical::{QueryKeyParts, canonical_query, canonicalize_filter, query_hash};
pub use filter::{
    FilterContext, ParseFilterOptions, ParsedFilter, is_variable, parse_expression, parse_filter,
};
pub use limits::{DEFAULT_LIMITS, QueryLimits, USING_LIMITS};
pub use paths::{PathOptions, is_within, normalize_positional, paths_overlap, strip_indexes, validate_path};
pub use query::{
    ParseUpdateOptions, ParsedProjection, ParsedQuery, ParsedSort, ParsedUpdate, ProjectionMode, QueryInput,
    UpdateKind, parse_limit, parse_projection, parse_query, parse_sort, parse_update,
    validate_stored_document,
};
pub use values::js_property_order;
