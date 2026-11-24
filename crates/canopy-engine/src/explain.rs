//! `o.explain` on `sub`: the access report of a subscription, in the shape the TypeScript server sends with the
//! first `ready`.

use canopy_policy::{
    ExplainRequest, Operation, PolicyEngine, RequestContext, access_report_document, explain_access,
};
use canopy_protocol::ejson::stringify;
use canopy_protocol::{CanopyError, Document, Value};
use canopy_query::{DEFAULT_LIMITS, QueryInput, QueryLimits, parse_query};

use crate::wire::SubQuery;

/// Whose access a `sub` asks to explain.
#[derive(Debug, Clone, PartialEq)]
pub enum Explain {
    /// The connection itself (`o.explain: true`).
    Own,
    /// A stated caller (`o.explain: { claims, roles, ctx }`).
    As {
        /// The caller's claims; `None` for an anonymous caller.
        claims: Option<Document>,
        /// The caller's roles besides `anon` or `authenticated`.
        roles: Vec<String>,
        /// The context lookup values; `None` resolves them like a connection of that caller would.
        ctx: Option<Document>,
    },
}

/// The caller's filter of a subscription query, parsed with the limits of a subscription.
pub(crate) fn caller_filter(q: &SubQuery, max_window: u32) -> Result<Document, CanopyError> {
    let limits = QueryLimits { max_limit: max_window, ..DEFAULT_LIMITS };
    let input = QueryInput {
        filter: q.filter.clone(),
        sort: q.sort.clone(),
        limit: q.limit.clone(),
        fields: q.fields.clone(),
    };
    Ok(parse_query(&input, &limits)?.filter.filter)
}

/// The `explain` member of `ready` for a read of `coll` by `context`, as relaxed EJSON text.
pub(crate) fn explain_read(
    engine: &PolicyEngine,
    coll: &str,
    filter: Document,
    context: RequestContext,
) -> Result<String, CanopyError> {
    let request =
        ExplainRequest { collection: coll.to_owned(), op: Operation::Read, context, filter: Some(filter) };
    let report = explain_access(engine, &request)?;
    stringify(&Value::Document(access_report_document(&report)?))
}
