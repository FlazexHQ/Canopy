//! Explain: why a request may or may not touch documents, as a report and as terminal text.

use std::collections::HashSet;
use std::sync::Mutex;

use canopy_protocol::ejson::stringify;
use canopy_protocol::{CanopyError, Document, Value};

use crate::engine::{Clause, Compiled, ExplainedPolicy, Explanation, PolicyEngine, PolicyVariableIssue};
use crate::fields::FieldAccess;
use crate::model::{Operation, PolicyKind, RequestContext, Role, Roles};
use crate::values::js_length;
use crate::variables::{VariableIssue, VariableIssueKind};

/// What to explain: one operation on one collection for a stated request context.
#[derive(Debug, Clone, PartialEq)]
pub struct ExplainRequest {
    /// The collection.
    pub collection: String,
    /// The operation.
    pub op: Operation,
    /// The request context.
    pub context: RequestContext,
    /// For reads: the caller's filter, combined with `USING(read)` into the effective filter.
    pub filter: Option<Document>,
}

/// Why a request may or may not touch documents: every policy with its outcome, the effective filter and the
/// field rules. It describes the policy structure and resolved claim values, so it is for admins only: the
/// CLI, Studio and callers with a secret key, never app users.
#[derive(Debug, Clone, PartialEq)]
pub struct AccessReport {
    /// The collection.
    pub collection: String,
    /// The operation.
    pub op: Operation,
    /// The roles of the request, sorted.
    pub roles: Vec<String>,
    /// Whether the request bypasses DLS.
    pub bypass: bool,
    /// Whether the collection is exposed.
    pub exposed: bool,
    /// Whether any permissive policy grants the operation to these roles (a write without one is `403`).
    pub granted: bool,
    /// `USING(op)`: which existing documents the operation may touch.
    pub using: Explanation,
    /// `CHECK(op)` for inserts and updates: what resulting documents must satisfy.
    pub check: Option<Explanation>,
    /// The filter the operation runs with: for reads the caller's filter AND `USING(read)`, for updates and
    /// deletes `USING(op)` AND `USING(read)`, for inserts `CHECK(insert)`.
    pub effective: Compiled,
    /// The fields the request may read.
    pub readable: FieldAccess,
    /// The fields the operation may write, for inserts and updates.
    pub writable: Option<FieldAccess>,
    /// The immutable paths of the collection.
    pub immutable: Vec<String>,
}

/// Explains how the engine decides one operation for a stated request context. Nothing is cached or logged.
pub fn explain_access(engine: &PolicyEngine, request: &ExplainRequest) -> Result<AccessReport, CanopyError> {
    let ExplainRequest { collection, op, context, .. } = request;
    let using = engine.explain(collection, *op, context, Clause::Using)?;
    let writes = matches!(op, Operation::Insert | Operation::Update);
    let check = if writes { Some(engine.explain(collection, *op, context, Clause::Check)?) } else { None };
    let effective = match op {
        Operation::Read => {
            engine.effective_read(collection, &request.filter.clone().unwrap_or_default(), context)?
        }
        Operation::Insert => engine.check(collection, Operation::Insert, context),
        _ => engine.target(collection, *op, context)?,
    };
    Ok(AccessReport {
        collection: collection.clone(),
        op: *op,
        roles: using.roles.clone(),
        bypass: using.bypass,
        exposed: using.exposed,
        granted: engine.has_grant(collection, *op, context),
        using,
        check,
        effective,
        readable: engine.readable(collection, context),
        writable: if writes { Some(engine.writable(collection, *op, context)) } else { None },
        immutable: engine.immutable(collection).to_vec(),
    })
}

fn variable_name(variable: &str) -> String {
    if let Some(claim) = variable.strip_prefix("$auth:") {
        return format!("claim {claim}");
    }
    if let Some(name) = variable.strip_prefix("$ctx:") {
        return format!("context lookup {name}");
    }
    "the request time".to_owned()
}

/// Describes a variable issue in words, without the value that caused it.
pub fn describe_issue(issue: &VariableIssue) -> String {
    let name = variable_name(&issue.variable);
    match issue.kind {
        VariableIssueKind::Missing => format!("{name} is missing or null (fails closed)"),
        VariableIssueKind::Shape => format!(
            "{name} has the wrong shape: a list under $in, $nin or $all, a single value elsewhere (fails closed)"
        ),
        VariableIssueKind::Coercion => {
            format!("{name} cannot be converted to the requested type (fails closed)")
        }
    }
}

fn pad_end(text: &str, width: usize) -> String {
    let length = js_length(text);
    let mut out = text.to_owned();
    for _ in length..width {
        out.push(' ');
    }
    out
}

fn policy_lines(explanation: &Explanation) -> Result<Vec<String>, CanopyError> {
    let relevant: Vec<&ExplainedPolicy> =
        explanation.policies.iter().filter(|policy| policy.applies || policy.issue.is_some()).collect();
    let skipped = explanation.policies.len() - relevant.len();
    let width = relevant.iter().map(|policy| js_length(&policy.name) + 2).max().unwrap_or(0);
    let mut lines = Vec::new();
    for kind in [PolicyKind::Permissive, PolicyKind::Restrictive] {
        let of_kind: Vec<&&ExplainedPolicy> = relevant.iter().filter(|policy| policy.kind == kind).collect();
        if of_kind.is_empty() {
            lines.push(format!("  {} (none)", pad_end(kind.as_str(), 11)));
            continue;
        }
        for policy in of_kind {
            let name = pad_end(&format!("\"{}\"", policy.name), width);
            let outcome = if policy.applies {
                format!(
                    "matches   {}",
                    stringify(&Value::Document(policy.resolved.clone().unwrap_or_default()))?
                )
            } else {
                let reason = policy.issue.as_ref().map_or_else(|| policy.reason.clone(), describe_issue);
                format!("no match  {reason}")
            };
            lines.push(format!("  {} {name}  {outcome}", pad_end(kind.as_str(), 11)));
        }
    }
    if skipped > 0 {
        let what = if skipped == 1 { "policy does" } else { "policies do" };
        lines.push(format!("  ({skipped} {what} not cover {} for these roles)", explanation.op));
    }
    Ok(lines)
}

fn describe_fields(label: &str, access: &FieldAccess) -> Option<String> {
    match access {
        FieldAccess::All => None,
        FieldAccess::Omit(paths) => Some(format!("{label} hidden: {}", paths.join(", "))),
        FieldAccess::Only(paths) => Some(format!("{label} limited to: {}", paths.join(", "))),
    }
}

fn verdict(report: &AccessReport) -> String {
    if report.bypass {
        return "service bypasses DLS: every document and field".to_owned();
    }
    if !report.exposed {
        return format!("{} is not exposed: denied for every role but service", report.collection);
    }
    if !report.granted {
        return format!("no permissive policy grants {} to these roles: denied", report.op);
    }
    if report.effective == Compiled::Deny {
        "no policy matches: denied".to_owned()
    } else {
        "allowed".to_owned()
    }
}

/// Formats an [`AccessReport`] for a terminal:
///
/// ```text
/// todos, read, roles [authenticated]
///   permissive  "read own"                matches   {"ownerId":"u_alice"}
///   permissive  "read shared in my orgs"  no match  claim org_ids is missing or null (fails closed)
///   restrictive (none)
/// Effective filter: {"$and":[{"status":"active"},{"ownerId":"u_alice"}]}
/// Fields hidden: internalNotes
/// ```
pub fn format_access_report(report: &AccessReport) -> Result<String, CanopyError> {
    let mut lines =
        vec![format!("{}, {}, roles [{}]", report.collection, report.op, report.roles.join(", "))];
    if !report.bypass && report.exposed {
        match &report.check {
            Some(check) if report.op == Operation::Insert => {
                lines.push("check:".to_owned());
                lines.extend(policy_lines(check)?);
            }
            check => {
                if check.is_some() {
                    lines.push("using:".to_owned());
                }
                lines.extend(policy_lines(&report.using)?);
                if let Some(check) = check {
                    lines.push("check:".to_owned());
                    lines.extend(policy_lines(check)?);
                }
            }
        }
    }
    lines.push(format!("Result: {}", verdict(report)));
    lines.push(format!("Effective filter: {}", stringify(&Value::Document(report.effective.to_filter()))?));
    if let Some(read) = describe_fields("Fields", &report.readable) {
        lines.push(read);
    }
    if let Some(write) =
        report.writable.as_ref().and_then(|access| describe_fields("Writable fields", access))
    {
        lines.push(write);
    }
    if report.op == Operation::Update && !report.immutable.is_empty() && !report.bypass {
        lines.push(format!("Immutable: {}", report.immutable.join(", ")));
    }
    Ok(lines.join("\n"))
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

/// Encodes field access in the policy report format.
pub fn field_access_document(fields: &FieldAccess) -> Value {
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

/// Encodes a clause explanation in the policy report format.
pub fn explanation_document(explained: &Explanation) -> Value {
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

/// The report as a document, as the TypeScript server sends it: the fields of `AccessReport` in its key
/// order, then `effectiveFilter` and the terminal `text` of [`format_access_report`].
pub fn access_report_document(report: &AccessReport) -> Result<Document, CanopyError> {
    let mut out = Document::new();
    out.insert("collection", text(&report.collection));
    out.insert("op", text(report.op.as_str()));
    out.insert("roles", strings(&report.roles));
    out.insert("bypass", Value::Bool(report.bypass));
    out.insert("exposed", Value::Bool(report.exposed));
    out.insert("granted", Value::Bool(report.granted));
    out.insert("using", explanation_document(&report.using));
    if let Some(check) = &report.check {
        out.insert("check", explanation_document(check));
    }
    out.insert("effective", compiled(&report.effective));
    out.insert("readable", field_access_document(&report.readable));
    if let Some(writable) = &report.writable {
        out.insert("writable", field_access_document(writable));
    }
    out.insert("immutable", strings(&report.immutable));
    out.insert("effectiveFilter", Value::Document(report.effective.to_filter()));
    out.insert("text", text(&format_access_report(report)?));
    Ok(out)
}

/// Builds the request context of a stated caller: `anon` without claims, else `authenticated` plus roles, or
/// `service` alone when the roles name it.
pub fn explain_context(
    claims: Option<Document>,
    roles: &[String],
    ctx: Option<Document>,
    now: i64,
) -> RequestContext {
    let roles: Roles = if roles.iter().any(|role| role == Role::SERVICE) {
        [Role::SERVICE].into_iter().collect()
    } else {
        let base = if claims.is_none() { Role::ANON } else { Role::AUTHENTICATED };
        std::iter::once(base.to_owned()).chain(roles.iter().cloned()).collect()
    };
    RequestContext { roles, claims, ctx, now }
}

/// An `on_variable_issue` reporter for development servers that reports each distinct issue once: the
/// collection, the policy, the variable and the kind of problem, never the claim or context value. At most
/// `limit` distinct issues are remembered, so a flood of new ones cannot grow memory.
pub struct OnceVariableIssue<F: Fn(&str, &PolicyVariableIssue) + Send + Sync> {
    report: F,
    limit: usize,
    seen: Mutex<HashSet<PolicyVariableIssue>>,
}

impl<F: Fn(&str, &PolicyVariableIssue) + Send + Sync> OnceVariableIssue<F> {
    /// Creates a reporter that remembers at most `limit` distinct issues (the TypeScript default is 1000).
    pub fn new(report: F, limit: usize) -> OnceVariableIssue<F> {
        OnceVariableIssue { report, limit, seen: Mutex::new(HashSet::new()) }
    }

    /// Reports the issue unless it was reported before.
    pub fn report(&self, issue: &PolicyVariableIssue) {
        {
            let Ok(mut seen) = self.seen.lock() else { return };
            if seen.contains(issue) {
                return;
            }
            if seen.len() >= self.limit {
                seen.clear();
            }
            seen.insert(issue.clone());
        }
        let described = describe_issue(&VariableIssue { kind: issue.kind, variable: issue.variable.clone() });
        (self.report)(
            &format!("policy \"{}\" on {} did not match: {described}", issue.policy, issue.collection),
            issue,
        );
    }
}

impl<F: Fn(&str, &PolicyVariableIssue) + Send + Sync> crate::engine::EngineHooks for OnceVariableIssue<F> {
    fn on_variable_issue(&self, issue: &PolicyVariableIssue) {
        self.report(issue);
    }
}
