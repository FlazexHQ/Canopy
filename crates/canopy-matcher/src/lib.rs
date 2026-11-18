//! Canopy's in process MongoDB matcher in Rust: MongoDB query filters compiled to closures, sorts, projections,
//! BSON ordering across every type, equality keys and a linear time regular expression engine. It mirrors the TypeScript
//! `@canopy/matcher` package, and both are checked against MongoDB itself by the differential vectors.

pub mod compare;
pub mod equality;
pub mod errors;
pub mod filter;
pub mod numeric;
pub mod path;
pub mod projection;
pub mod regex;
pub mod sort;

pub use compare::{Bracket, BsonType, bracket_of, bson_type_of, compare_values, values_equal};
pub use errors::{is_unsupported, unsupported_query};
pub use filter::{CompiledFilter, compile_filter, is_matcher_safe};
pub use projection::{CompiledProjection, ProjectionMode, ProjectionNode, compile_projection};
pub use regex::{LinearRegex, compile_regex, is_linear_regex};
pub use sort::{CompiledSort, Direction, DocSortKey, SortKey, compile_sort, parse_sort, with_id_tie_breaker};
