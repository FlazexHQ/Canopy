//! `o.explain` on `sub`: the access report of a subscription, in the shape the TypeScript server sends with the
//! first `ready`.

use canopy_policy::{
    AccessReport, Compiled, ExplainRequest, ExplainedPolicy, Explanation, FieldAccess, Operation,
    PolicyEngine, RequestContext, explain_access, format_access_report,
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

fn text(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn strings(values: &[String]) -> Value {
    Value::Array(values.iter().map(|value| text(value)).collect())
}

fn compiled(result: &Compiled) -> Value {
    let mut out = Document::new();
    match result {
        Compiled::All => out.insert("kind", text("all")),
        Compiled::Deny => out.insert("kind", text("deny")),
        Compiled::Filter(filter) => {
            out.insert("kind", text("filter"));
            out.insert("filter", Value::Document(filter.clone()));
        }
    }
    Value::Document(out)
}

fn access(fields: &FieldAccess) -> Value {
    let mut out = Document::new();
    match fields {
        FieldAccess::All => out.insert("kind", text("all")),
        FieldAccess::Only(paths) => {
            out.insert("kind", text("only"));
            out.insert("paths", strings(paths));
        }
        FieldAccess::Omit(paths) => {
            out.insert("kind", text("omit"));
            out.insert("paths", strings(paths));
        }
    }
    Value::Document(out)
}

fn policy(explained: &ExplainedPolicy) -> Value {
    let mut out = Document::new();
    out.insert("name", text(&explained.name));
    out.insert("kind", text(explained.kind.as_str()));
    out.insert("applies", Value::Bool(explained.applies));
    if let Some(issue) = &explained.issue {
        let mut described = Document::new();
        described.insert("kind", text(issue.kind.as_str()));
        described.insert("variable", text(&issue.variable));
        out.insert("issue", Value::Document(described));
    }
    out.insert("reason", text(&explained.reason));
    if let Some(resolved) = &explained.resolved {
        out.insert("resolved", Value::Document(resolved.clone()));
    }
    Value::Document(out)
}

fn explanation(explained: &Explanation) -> Value {
    let mut out = Document::new();
    out.insert("collection", text(&explained.collection));
    out.insert("op", text(explained.op.as_str()));
    out.insert("clause", text(explained.clause.as_str()));
    out.insert("roles", strings(&explained.roles));
    out.insert("bypass", Value::Bool(explained.bypass));
    out.insert("exposed", Value::Bool(explained.exposed));
    out.insert("policies", Value::Array(explained.policies.iter().map(policy).collect()));
    out.insert("result", compiled(&explained.result));
    Value::Document(out)
}

/// The report as a document: the fields of the TypeScript `AccessReport` in its key order, then
/// `effectiveFilter` and the terminal `text`.
pub(crate) fn report_document(report: &AccessReport) -> Result<Document, CanopyError> {
    let mut out = Document::new();
    out.insert("collection", text(&report.collection));
    out.insert("op", text(report.op.as_str()));
    out.insert("roles", strings(&report.roles));
    out.insert("bypass", Value::Bool(report.bypass));
    out.insert("exposed", Value::Bool(report.exposed));
    out.insert("granted", Value::Bool(report.granted));
    out.insert("using", explanation(&report.using));
    if let Some(check) = &report.check {
        out.insert("check", explanation(check));
    }
    out.insert("effective", compiled(&report.effective));
    out.insert("readable", access(&report.readable));
    if let Some(writable) = &report.writable {
        out.insert("writable", access(writable));
    }
    out.insert("immutable", strings(&report.immutable));
    out.insert("effectiveFilter", Value::Document(report.effective.to_filter()));
    out.insert("text", text(&format_access_report(report)?));
    Ok(out)
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
    stringify(&Value::Document(report_document(&report)?))
}
