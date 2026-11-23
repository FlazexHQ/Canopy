/// Limits on reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadLimits {
    /// Page size when the caller sets none.
    pub default_limit: u32,
    /// The largest page a caller may request.
    pub max_limit: u32,
    /// The largest `skip`. Cursors have no such limit.
    pub max_skip: u64,
    /// Time limit of each read, in milliseconds.
    pub max_time_ms: u64,
    /// The most values a `distinct` may return.
    pub max_distinct: u64,
    /// The most documents an aggregation may return.
    pub max_aggregate_results: u64,
    /// The most stages an aggregation may have, counting nested ones.
    pub max_pipeline_stages: usize,
}

impl Default for ReadLimits {
    fn default() -> ReadLimits {
        ReadLimits {
            default_limit: 100,
            max_limit: 1000,
            max_skip: 10_000,
            max_time_ms: 5000,
            max_distinct: 1000,
            max_aggregate_results: 1000,
            max_pipeline_stages: 20,
        }
    }
}
