use std::sync::Arc;

use canopy_matcher::{
    CompiledFilter, CompiledProjection, CompiledSort, compile_filter, compile_projection, compile_sort,
    is_unsupported,
};
use canopy_policy::{
    FieldAccess, PolicyEngine, RequestContext, TEXT_SEARCH_DENIED, denied_paths, denies_text_search,
};
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};
use canopy_query::{DEFAULT_LIMITS, QueryInput, QueryKeyParts, parse_query, query_hash};

use crate::observer::{Kind, ObservedQuery};
use crate::wire::SubQuery;

/// How a subscription is served: the shared observer's key and query, and what its listener projects.
#[derive(Debug, Clone)]
pub struct Plan {
    /// The observer key; subscriptions with the same key share one observer.
    pub key: String,
    /// The query the observer keeps current.
    pub query: ObservedQuery,
    /// The observer type.
    pub kind: Kind,
    /// The compiled effective filter, for filter and window observers.
    pub matcher: Option<CompiledFilter>,
    /// The compiled sort with the `_id` tie breaker, for window observers.
    pub sort: Option<CompiledSort>,
    /// The subscription's projection.
    pub projection: Option<Arc<CompiledProjection>>,
}

fn access_descriptor(access: &FieldAccess) -> Value {
    let (kind, paths) = match access {
        FieldAccess::All => return Value::String("all".to_owned()),
        FieldAccess::Only(paths) => ("only", paths),
        FieldAccess::Omit(paths) => ("omit", paths),
    };
    let mut sorted = paths.clone();
    sorted.sort();
    let mut out = Document::new();
    out.insert(kind, Value::Array(sorted.into_iter().map(Value::String).collect()));
    Value::Document(out)
}

/// Plans a subscription for `ctx`: refuses unknown collections, text search a field rule forbids and unreadable
/// fields, applies the read policies, and picks the observer type the effective filter allows.
pub fn plan(
    engine: &PolicyEngine,
    ctx: &RequestContext,
    coll: &str,
    q: &SubQuery,
    max_window: u32,
) -> Result<Plan, CanopyError> {
    if !engine.is_realtime(coll) {
        return Err(CanopyError::new(ErrorCode::NotFound, format!("No realtime collection {coll}")));
    }
    let limits = canopy_query::QueryLimits { max_limit: max_window, ..DEFAULT_LIMITS };
    let input = QueryInput {
        filter: q.filter.clone(),
        sort: q.sort.clone(),
        limit: q.limit.clone(),
        fields: q.fields.clone(),
    };
    let parsed = parse_query(&input, &limits)?;
    let readable = engine.readable(coll, ctx);
    if denies_text_search(&readable, &parsed.filter.filter) {
        return Err(CanopyError::new(ErrorCode::InvalidQuery, TEXT_SEARCH_DENIED));
    }
    let denied = denied_paths(&readable, &parsed.paths);
    if !denied.is_empty() {
        return Err(CanopyError::new(
            ErrorCode::InvalidQuery,
            format!("The query references fields that are not readable: {}", denied.join(", ")),
        ));
    }
    let effective = engine.effective_read(coll, &parsed.filter.filter, ctx)?;
    let filter = effective.to_filter();
    let mut kind = if parsed.filter.matcher_safe {
        if parsed.limit.is_none() { Kind::Filter } else { Kind::Window }
    } else {
        Kind::Polling
    };
    let mut matcher = None;
    if kind != Kind::Polling {
        match compile_filter(&Value::Document(filter.clone())) {
            Ok(compiled) => matcher = Some(compiled),
            Err(error) if is_unsupported(&error) => kind = Kind::Polling,
            Err(error) => return Err(error),
        }
    }
    let sort_spec = parsed.sort.as_ref().map(|sort| sort.sort.clone());
    let sort = match (&kind, &sort_spec) {
        (Kind::Window, Some(spec)) => Some(compile_sort(&Value::Document(spec.clone()))?),
        (Kind::Window, None) => Some(compile_sort(&Value::Document(Document::new()))?),
        _ => None,
    };
    let projection = match &parsed.fields {
        Some(fields) => Some(Arc::new(compile_projection(&Value::Document(fields.projection.clone()))?)),
        None => None,
    };
    let mut projection_key = Document::new();
    projection_key.insert("readable", access_descriptor(&readable));
    projection_key.insert("type", Value::String(kind.as_str().to_owned()));
    let key = query_hash(&QueryKeyParts {
        collection: coll.to_owned(),
        filter: filter.clone(),
        sort: sort_spec.clone(),
        limit: parsed.limit,
        projection: Some(projection_key),
    })?;
    Ok(Plan {
        key,
        query: ObservedQuery {
            coll: coll.to_owned(),
            filter,
            sort: sort_spec,
            limit: parsed.limit,
            readable,
        },
        kind,
        matcher,
        sort,
        projection,
    })
}
