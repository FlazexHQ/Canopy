use canopy_policy::RequestContext;

/// A caller of the Data API: the request context every policy is evaluated under (roles, verified claims and
/// resolved context lookups) and the subject that made the request.
#[derive(Debug, Clone, PartialEq)]
pub struct Caller {
    /// The request context.
    pub context: RequestContext,
    /// The subject (`sub`), or `anon` or `service`.
    pub subject: String,
}
