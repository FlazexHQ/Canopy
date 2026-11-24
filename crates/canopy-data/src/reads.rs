use std::time::Duration;

use canopy_mongo::mongodb::bson::{Bson, RawDocumentBuf, doc};
use canopy_policy::{
    Compiled, FieldAccess, PipelineLimits, PolicyEngine, Role, SEARCH_STAGES, SecurePipelineOptions,
    TEXT_SEARCH_DENIED, can_access, denied_paths, denies_text_search, secure_pipeline,
};
use canopy_protocol::ejson::write_ejson;
use canopy_protocol::{CanopyError, DocRef, Document, ErrorCode, RawDocument, Value, ValueRef};
use canopy_query::{PathOptions, QueryInput, parse_query, validate_path};

use crate::caller::Caller;
use crate::errors::internal;
use crate::fail;
use crate::find::{ReadPath, validate_collection_name};
use crate::page::{CountMode, Encoding};
use crate::snapshot::{Output, Read, at_latest, estimated_count, in_snapshot};

/// The number of documents a caller can see that match a filter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CountResult {
    /// The number of documents.
    pub count: u64,
    /// Whether the number is exact rather than estimated from the collection metadata.
    pub exact: bool,
    /// The cluster time the count was read at.
    pub ct: canopy_engine::Ct,
}

/// The distinct values of a field among the documents a caller can see.
#[derive(Debug, Clone, PartialEq)]
pub struct DistinctResult {
    values: RawDocumentBuf,
    /// The snapshot the values were read at.
    pub ct: canopy_engine::Ct,
}

/// The documents a caller's aggregation returned, as the raw BSON MongoDB sent.
#[derive(Debug, Clone, PartialEq)]
pub struct AggregateResult {
    documents: Vec<RawDocumentBuf>,
    /// The cluster time the aggregation was read at.
    pub ct: canopy_engine::Ct,
}

fn number(count: u64) -> Value {
    #[allow(clippy::cast_precision_loss)]
    Value::from_js_number(count as f64)
}

fn with_ct(mut out: String, ct: canopy_engine::Ct) -> String {
    out.push_str(",\"ct\":\"");
    out.push_str(&ct.to_string());
    out.push_str("\"}");
    out
}

/// One document a caller can read, found by its `_id`.
#[derive(Debug, Clone, PartialEq)]
pub struct DocumentResult {
    /// The readable document, shaped by the caller's projection.
    pub document: Document,
    /// The cluster time the document was read at.
    pub ct: canopy_engine::Ct,
}

impl DocumentResult {
    /// The response body: `{ data: document, ct }` in the negotiated encoding.
    pub fn encode(&self, encoding: Encoding) -> Result<String, CanopyError> {
        let mut out = String::from("{\"data\":");
        write_ejson(
            &mut out,
            ValueRef::Document(DocRef::Owned(&self.document)),
            encoding == Encoding::Canonical,
        )?;
        Ok(with_ct(out, self.ct))
    }
}

impl CountResult {
    /// The response body: `{ data: { count, exact }, ct }` in the negotiated encoding.
    pub fn encode(&self, encoding: Encoding) -> Result<String, CanopyError> {
        let data: Document =
            [("count".to_owned(), number(self.count)), ("exact".to_owned(), Value::Bool(self.exact))]
                .into_iter()
                .collect();
        let mut out = String::from("{\"data\":");
        write_ejson(&mut out, ValueRef::Document(DocRef::Owned(&data)), encoding == Encoding::Canonical)?;
        Ok(with_ct(out, self.ct))
    }
}

impl DistinctResult {
    /// The number of values.
    pub fn len(&self) -> usize {
        self.values.as_ref().iter().count()
    }

    /// Whether there are no values.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The response body: `{ data: [values], ct }` in the negotiated encoding.
    pub fn encode(&self, encoding: Encoding) -> Result<String, CanopyError> {
        let raw = RawDocument::new(self.values.as_bytes())?;
        let values = raw.get("values").ok_or_else(internal)?;
        let mut out = String::from("{\"data\":");
        write_ejson(&mut out, values, encoding == Encoding::Canonical)?;
        Ok(with_ct(out, self.ct))
    }
}

impl AggregateResult {
    /// The number of documents.
    pub fn len(&self) -> usize {
        self.documents.len()
    }

    /// Whether the aggregation returned no document.
    pub fn is_empty(&self) -> bool {
        self.documents.is_empty()
    }

    /// The response body: `{ data: [documents], ct }` in the negotiated encoding.
    pub fn encode(&self, encoding: Encoding) -> Result<String, CanopyError> {
        let canonical = encoding == Encoding::Canonical;
        let mut out = String::from("{\"data\":[");
        for (index, document) in self.documents.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            let raw = RawDocument::new(document.as_bytes())?;
            write_ejson(&mut out, ValueRef::Document(DocRef::Raw(raw)), canonical)?;
        }
        out.push(']');
        Ok(with_ct(out, self.ct))
    }
}

struct Planned {
    engine: std::sync::Arc<PolicyEngine>,
    service: bool,
    readable: FieldAccess,
}

fn null_as_empty(value: Option<&Value>) -> Value {
    match value {
        None | Some(Value::Null | Value::Undefined) => Value::Document(Document::new()),
        Some(value) => value.clone(),
    }
}

impl ReadPath {
    fn plan(&self, caller: &Caller, name: &str) -> Result<Planned, CanopyError> {
        validate_collection_name(name)?;
        let engine = self.policies.current();
        let ctx = &caller.context;
        let service = ctx.roles.contains(Role::SERVICE);
        if !service && !engine.is_exposed(name) {
            return Err(CanopyError::new(ErrorCode::NotFound, format!("Unknown collection '{name}'")));
        }
        let readable = engine.readable(name, ctx);
        Ok(Planned { engine, service, readable })
    }

    /// The caller's filter, checked as the find filter is: a document that names only readable fields, and no
    /// `$text` unless every field is readable.
    fn filter(&self, planned: &Planned, filter: &Value) -> Result<Document, CanopyError> {
        if !matches!(filter, Value::Document(_)) {
            return fail("The filter must be a document");
        }
        let parsed = parse_query(
            &QueryInput { filter: Some(filter.clone()), sort: None, limit: None, fields: None },
            &self.query_limits,
        )?;
        if denies_text_search(&planned.readable, &parsed.filter.filter) {
            return fail(TEXT_SEARCH_DENIED);
        }
        let denied = denied_paths(&planned.readable, &parsed.paths);
        if !denied.is_empty() {
            return fail(format!("The query may not reference unreadable fields: {}", denied.join(", ")));
        }
        Ok(parsed.filter.filter)
    }

    fn max_time(&self) -> Duration {
        Duration::from_millis(self.limits.max_time_ms)
    }

    /// Counts the documents a caller can see that match `filter` (a missing or `null` filter matches every
    /// document). `Estimated` uses the collection metadata, which is only possible when nothing restricts the
    /// count: an empty filter and a read policy that admits every document. Otherwise the count is exact,
    /// because an estimate would reveal invisible documents.
    pub async fn count(
        &self,
        caller: &Caller,
        collection: &str,
        filter: Option<&Value>,
        mode: CountMode,
    ) -> Result<CountResult, CanopyError> {
        let planned = self.plan(caller, collection)?;
        let filter = self.filter(&planned, &null_as_empty(filter))?;
        let effective =
            planned.engine.effective_read(collection, &filter, &caller.context).map_err(|_| internal())?;
        if mode == CountMode::Estimated && effective == Compiled::All && filter.is_empty() {
            let (count, ct) =
                estimated_count(&self.client, &self.db, collection, self.max_time(), planned.service).await?;
            return Ok(CountResult { count, exact: false, ct });
        }
        let filter = effective.to_filter();
        let read = Read::Count { collection, filter: &filter, max_time: self.max_time() };
        match in_snapshot(&self.client, &self.db, &read, planned.service).await? {
            (Output::Count(count), ct) => Ok(CountResult { count, exact: true, ct }),
            _ => Err(internal()),
        }
    }

    /// Returns the distinct values of a readable field among the documents a caller can see. Fails with an
    /// invalid query error when there are more than `max_distinct` values.
    pub async fn distinct(
        &self,
        caller: &Caller,
        collection: &str,
        field: Option<&Value>,
        filter: Option<&Value>,
    ) -> Result<DistinctResult, CanopyError> {
        let Some(Value::String(field)) = field else { return fail("field must be a string") };
        validate_path(
            field,
            PathOptions { positional: false, max_length: self.query_limits.max_path_length },
        )?;
        let planned = self.plan(caller, collection)?;
        if !can_access(&planned.readable, field) {
            return fail(format!("The field {field} is not readable"));
        }
        let filter = self.filter(&planned, &null_as_empty(filter))?;
        let effective =
            planned.engine.effective_read(collection, &filter, &caller.context).map_err(|_| internal())?;
        let filter = effective.to_filter();
        let read = Read::Distinct { collection, field, filter: &filter, max_time: self.max_time() };
        let (values, ct) = match in_snapshot(&self.client, &self.db, &read, planned.service).await? {
            (Output::Values(values), ct) => (values, ct),
            _ => return Err(internal()),
        };
        let max = self.limits.max_distinct;
        if values.len() > usize::try_from(max).unwrap_or(usize::MAX) {
            return fail(format!("The field has more than {max} distinct values; narrow the filter"));
        }
        let values =
            RawDocumentBuf::try_from(&doc! { "values": Bson::Array(values) }).map_err(|_| internal())?;
        Ok(DistinctResult { values, ct })
    }

    /// Runs a caller's aggregation pipeline after `secure_pipeline` has put the DLS prefix in front of it and
    /// rewritten its `$lookup` and `$unionWith` stages. Fails with an invalid query error for refused stages and
    /// expressions, and when the result has more than `max_aggregate_results` documents.
    pub async fn aggregate(
        &self,
        caller: &Caller,
        collection: &str,
        pipeline: Option<&Value>,
    ) -> Result<AggregateResult, CanopyError> {
        let planned = self.plan(caller, collection)?;
        let max = self.limits.max_aggregate_results;
        let search = self.search.contains(collection);
        let limits = PipelineLimits {
            max_stages: self.limits.max_pipeline_stages,
            max_sample: max,
            query: self.query_limits,
        };
        let pipeline = pipeline.cloned().unwrap_or(Value::Undefined);
        let mut secured = secure_pipeline(
            &planned.engine,
            collection,
            &pipeline,
            &caller.context,
            &limits,
            SecurePipelineOptions { search, max_search_results: max },
        )?;
        let searching = search
            && secured
                .first()
                .and_then(Document::first_key)
                .is_some_and(|name| SEARCH_STAGES.contains(&name));
        let limit: Document = [("$limit".to_owned(), number(max.saturating_add(1)))].into_iter().collect();
        secured.push(limit);
        let read = Read::Aggregate {
            collection,
            pipeline: &secured,
            max_time: self.max_time(),
            allow_disk_use: planned.service,
        };
        let result = if searching {
            at_latest(&self.client, &self.db, &read, planned.service).await?
        } else {
            in_snapshot(&self.client, &self.db, &read, planned.service).await?
        };
        let (documents, ct) = match result {
            (Output::Documents(documents), ct) => (documents, ct),
            _ => return Err(internal()),
        };
        if documents.len() as u64 > max {
            return fail(format!("The aggregation returned more than {max} documents; add a $limit stage"));
        }
        Ok(AggregateResult { documents, ct })
    }
}
