//! Limits applied to untrusted queries.

/// Limits applied to untrusted queries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueryLimits {
    /// Maximum nesting of documents and arrays in a filter or update.
    pub max_depth: usize,
    /// Maximum number of keys and array elements in one query.
    pub max_nodes: usize,
    /// Maximum number of values in `$in`, `$nin` and `$all`.
    pub max_in_list: usize,
    /// Maximum length of a regular expression pattern, in UTF-16 code units as JavaScript counts them.
    pub max_regex_length: usize,
    /// Maximum length of a field path, in UTF-16 code units as JavaScript counts them.
    pub max_path_length: usize,
    /// Maximum number of sort keys.
    pub max_sort_keys: usize,
    /// Maximum number of projected paths.
    pub max_projection_paths: usize,
    /// Maximum `limit` a caller may request.
    pub max_limit: u32,
}

/// Defaults for user supplied queries.
pub const DEFAULT_LIMITS: QueryLimits = QueryLimits {
    max_depth: 16,
    max_nodes: 10_000,
    max_in_list: 1000,
    max_regex_length: 1024,
    max_path_length: 512,
    max_sort_keys: 8,
    max_projection_paths: 200,
    max_limit: 1000,
};

/// Limits for policy `using` clauses, which run in process on every candidate event.
pub const USING_LIMITS: QueryLimits = QueryLimits { max_depth: 12, max_regex_length: 256, ..DEFAULT_LIMITS };

impl Default for QueryLimits {
    fn default() -> QueryLimits {
        DEFAULT_LIMITS
    }
}
