//! Everything a planned write needs about its collection and caller: grants, field rules, the filters of its
//! target, and the checks and read backs MongoDB evaluates on the written documents.

use std::sync::Arc;
use std::time::Duration;

use canopy_mongo::mongodb::bson::{self, RawDocumentBuf};
use canopy_mongo::mongodb::options::WriteConcern;
use canopy_mongo::mongodb::{ClientSession, Collection, Database};
use canopy_mongo::to_bson;
use canopy_policy::{
    Clause, Compiled, FieldAccess, Operation, PolicyEngine, RequestContext, Role, TEXT_SEARCH_DENIED,
    denied_paths, denies_text_search, immutable_violations, project_readable, to_projection,
};
use canopy_protocol::bson::decode_document;
use canopy_protocol::ejson::canonical_string;
use canopy_protocol::json::write_json_string;
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};
use canopy_query::{FilterContext, ParseFilterOptions, QueryLimits, parse_filter};

use crate::errors::internal;
use crate::fail;

pub(crate) type DriverError = canopy_mongo::mongodb::error::Error;

/// Where a step of a write runs: in the session of a transaction, in a session outside one (a fast path,
/// which needs the session only for the cluster time of its write), or in none. Reads use the session only
/// inside a transaction: on a fast path they run on their own, after a write acknowledged by a majority.
pub(crate) struct Session<'s> {
    pub(crate) inner: Option<&'s mut ClientSession>,
    pub(crate) transaction: bool,
    /// Whether the read back of a single document that needs no check waits for the end of the batch.
    pub(crate) defer: bool,
    /// The `_id`s whose read back waits, filled by [`Scope::verify`] when `defer` is set.
    pub(crate) queued: Vec<Value>,
}

impl<'s> Session<'s> {
    /// The session of a transaction.
    pub(crate) fn transaction(inner: &'s mut ClientSession) -> Session<'s> {
        Session { inner: Some(inner), transaction: true, defer: false, queued: Vec::new() }
    }

    /// A session outside a transaction.
    pub(crate) fn fast(inner: &'s mut ClientSession) -> Session<'s> {
        Session { inner: Some(inner), transaction: false, defer: false, queued: Vec::new() }
    }

    /// No session.
    pub(crate) fn none() -> Session<'static> {
        Session { inner: None, transaction: false, defer: false, queued: Vec::new() }
    }

    /// The session reads run in: the transaction's, or none.
    pub(crate) fn reading(&mut self) -> Option<&mut ClientSession> {
        if self.transaction { self.inner.as_deref_mut() } else { None }
    }
}

/// A readable document a write returns, `None` where the caller cannot read it.
pub(crate) type Returned = Option<Document>;

pub(crate) fn value_of(raw: &bson::RawDocument) -> Result<Document, CanopyError> {
    decode_document(raw.as_bytes())
}

pub(crate) fn key(value: &Value) -> String {
    canonical_string(value).unwrap_or_default()
}

/// A key two `_id`s share only when MongoDB treats them as the same document, or `None` when this cannot be
/// told: strings by their bytes (a collection with a collation is the caller's concern), ObjectIds, and Int32,
/// Int64 and double numbers by value across their types (`NaN` equals `NaN`, `-0` equals `0`). Decimal128 and
/// the other types have no key.
pub(crate) fn id_key(id: &Value) -> Option<String> {
    match id {
        Value::String(text) => Some(format!("s{text}")),
        Value::ObjectId(bytes) => {
            Some(format!("o{}", bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>()))
        }
        Value::Int32(number) => Some(format!("n{number}")),
        Value::Int64(number) => Some(format!("n{number}")),
        Value::Double(number) if number.is_nan() => Some("nNaN".to_owned()),
        Value::Double(number) if number.is_infinite() => {
            Some(if *number > 0.0 { "n+inf" } else { "n-inf" }.to_owned())
        }
        Value::Double(number) if *number == 0.0 => Some("n0".to_owned()),
        Value::Double(number) if number.fract() == 0.0 => Some(format!("n{number:.0}")),
        Value::Double(number) => Some(format!("d{number}")),
        _ => None,
    }
}

/// The `$in` of a list of ids.
fn ids_in(ids: &[Value]) -> Value {
    let mut inner = Document::new();
    inner.insert("$in", Value::Array(ids.to_vec()));
    Value::Document(inner)
}

fn single(name: &str, value: Value) -> Document {
    let mut out = Document::new();
    out.insert(name, value);
    out
}

/// Everything a planned write needs about its collection and caller.
pub(crate) struct Scope {
    pub(crate) service: bool,
    pub(crate) engine: Arc<PolicyEngine>,
    pub(crate) ctx: RequestContext,
    pub(crate) name: String,
    pub(crate) explain: bool,
    pub(crate) db: Database,
    max_time: Duration,
    filter_limits: QueryLimits,
    readable: FieldAccess,
}

impl Scope {
    pub(crate) fn new(
        engine: Arc<PolicyEngine>,
        ctx: RequestContext,
        db: Database,
        name: &str,
        max_time: Duration,
        filter_limits: QueryLimits,
        explain: bool,
    ) -> Scope {
        let readable = engine.readable(name, &ctx);
        Scope {
            service: ctx.roles.contains(Role::SERVICE),
            engine,
            ctx,
            name: name.to_owned(),
            explain,
            db,
            max_time,
            filter_limits,
            readable,
        }
    }

    pub(crate) fn coll(&self) -> Collection<bson::Document> {
        self.db.collection(&self.name)
    }

    fn raw(&self) -> Collection<RawDocumentBuf> {
        self.db.collection(&self.name)
    }

    pub(crate) fn readable(&self) -> &FieldAccess {
        &self.readable
    }

    /// The write concern of a write: majority outside a transaction, the transaction's inside one.
    pub(crate) fn write_concern(session: &Session<'_>) -> Option<WriteConcern> {
        (!session.transaction).then(WriteConcern::majority)
    }

    pub(crate) fn require_grant(&self, op: Operation) -> Result<(), CanopyError> {
        if self.engine.has_grant(&self.name, op, &self.ctx) {
            return Ok(());
        }
        let error = CanopyError::named(
            ErrorCode::Forbidden,
            "ForbiddenError",
            format!("No policy grants {} on '{}'", op.as_str(), self.name),
        );
        Err(self.explained(error, op, Clause::Using))
    }

    pub(crate) fn writable(&self, op: Operation) -> FieldAccess {
        self.engine.writable(&self.name, op, &self.ctx)
    }

    /// Parses a caller filter and rejects references to unreadable fields, which would leak them.
    fn caller_filter(&self, input: &Value, what: &str) -> Result<Document, CanopyError> {
        if !matches!(input, Value::Document(_)) {
            return fail(format!("{what} must be a document"));
        }
        let options = ParseFilterOptions {
            context: FilterContext::Filter,
            limits: self.filter_limits,
            ..ParseFilterOptions::default()
        };
        let parsed = parse_filter(input, &options)?;
        if denies_text_search(&self.readable, &parsed.filter) {
            return fail(TEXT_SEARCH_DENIED);
        }
        let denied = denied_paths(&self.readable, &parsed.paths);
        if !denied.is_empty() {
            return fail(format!("{what} may not reference unreadable fields: {}", denied.join(", ")));
        }
        Ok(parsed.filter)
    }

    /// The filter of a write by `_id`.
    pub(crate) fn by_id(&self, id: &Value) -> Compiled {
        Compiled::Filter(single("_id", id.clone()))
    }

    /// The filter of a bulk write.
    pub(crate) fn by_filter(&self, filter: &Value) -> Result<Compiled, CanopyError> {
        Ok(Compiled::Filter(self.caller_filter(filter, "The filter")?))
    }

    /// A compare and set precondition: `all` when there is none or it is empty.
    pub(crate) fn precondition(&self, condition: Option<&Value>) -> Result<Compiled, CanopyError> {
        let Some(condition) = condition else { return Ok(Compiled::All) };
        let parsed = self.caller_filter(condition, "where")?;
        Ok(if parsed.is_empty() { Compiled::All } else { Compiled::Filter(parsed) })
    }

    /// The driver filter of a compiled target. A denied target matches nothing.
    pub(crate) fn filter(&self, target: &Compiled) -> Result<bson::Document, CanopyError> {
        to_bson(&target.to_filter())
    }

    pub(crate) fn by_ids(&self, ids: &[Value], target: &Compiled) -> Result<bson::Document, CanopyError> {
        let mut and = Document::new();
        and.insert(
            "$and",
            Value::Array(vec![
                Value::Document(single("_id", ids_in(ids))),
                Value::Document(target.to_filter()),
            ]),
        );
        to_bson(&and)
    }

    /// The `_id`s of up to `limit` documents a target matches.
    pub(crate) async fn find_ids(
        &self,
        session: &mut Session<'_>,
        target: &Compiled,
        limit: i64,
    ) -> Result<Vec<Value>, DriverError> {
        let filter = self.filter(target).map_err(custom)?;
        let collection = self.raw();
        let find =
            collection.find(filter).projection(bson::doc! { "_id": 1 }).limit(limit).max_time(self.max_time);
        let documents = collect(find, session).await?;
        documents
            .iter()
            .map(|raw| value_of(raw).map(|mut doc| doc.remove("_id").unwrap_or(Value::Null)))
            .collect::<Result<Vec<_>, _>>()
            .map_err(custom)
    }

    /// A failed precondition on a document the caller can see is a conflict; an invisible one is not found.
    pub(crate) async fn assert_no_conflict(
        &self,
        session: &mut Session<'_>,
        visible: &Compiled,
    ) -> Result<(), DriverError> {
        if self.find_ids(session, visible, 1).await?.is_empty() {
            return Ok(());
        }
        Err(custom(CanopyError::named(
            ErrorCode::Conflict,
            "ConflictError",
            "The where precondition did not match",
        )))
    }

    /// Lets MongoDB evaluate `check` on the written documents and, when `read` is set, reads them back through
    /// `USING(read)` and the read field rules. Returns the documents in the order of `ids`, `None` for
    /// unreadable ones, or nothing when `read` is not set.
    pub(crate) async fn verify(
        &self,
        session: &mut Session<'_>,
        ids: &[Value],
        check: Option<&Compiled>,
        op: Operation,
        read: bool,
    ) -> Result<Option<Vec<Returned>>, DriverError> {
        if check == Some(&Compiled::Deny) {
            return Err(custom(self.violation(op)));
        }
        if ids.len() == 1 && matches!(check, None | Some(Compiled::All)) {
            if !read {
                return Ok(None);
            }
            if session.defer {
                session.queued.push(ids[0].clone());
                return Ok(Some(vec![None]));
            }
            return Ok(Some(vec![self.read_one(session, &ids[0]).await?]));
        }
        if !read {
            if let Some(Compiled::Filter(check)) = check
                && !ids.is_empty()
            {
                let mut nor = Document::new();
                nor.insert("$nor", Value::Array(vec![Value::Document(check.clone())]));
                let mut and = Document::new();
                and.insert(
                    "$and",
                    Value::Array(vec![Value::Document(single("_id", ids_in(ids))), Value::Document(nor)]),
                );
                let collection = self.raw();
                let count = collection
                    .count_documents(to_bson(&and).map_err(custom)?)
                    .limit(1)
                    .max_time(self.max_time);
                let failing = match session.reading() {
                    Some(inner) => count.session(inner).await?,
                    None => count.await?,
                };
                if failing > 0 {
                    return Err(custom(self.violation(op)));
                }
            }
            return Ok(None);
        }
        let facet = self.facets(ids, check, read, false).map_err(custom)?;
        if facet.is_empty() {
            return Ok(Some(ids.iter().map(|_| None).collect()));
        }
        let mut matched = Document::new();
        matched.insert("$match", Value::Document(single("_id", ids_in(ids))));
        let pipeline = vec![
            to_bson(&matched).map_err(custom)?,
            to_bson(&single("$facet", Value::Document(facet))).map_err(custom)?,
        ];
        let out = self.aggregate_one(session, pipeline).await?;
        self.outcome(out.as_ref(), ids, op).map_err(custom)
    }

    async fn aggregate_one(
        &self,
        session: &mut Session<'_>,
        pipeline: Vec<bson::Document>,
    ) -> Result<Option<Document>, DriverError> {
        let collection = self.raw();
        let aggregate = collection.aggregate(pipeline).max_time(self.max_time).with_type::<RawDocumentBuf>();
        let mut out = Vec::new();
        match session.reading() {
            Some(inner) => {
                let mut cursor = aggregate.session(&mut *inner).await?;
                while cursor.advance(inner).await? {
                    out.push(cursor.current().to_owned());
                }
            }
            None => {
                let mut cursor = aggregate.await?;
                while cursor.advance().await? {
                    out.push(cursor.current().to_owned());
                }
            }
        }
        out.first().map(|raw| value_of(raw)).transpose().map_err(custom)
    }

    /// Evaluates `check(insert)` and the read back on documents before they are inserted, through
    /// `$documents` on the target collection, so its default collation applies. Returns the failing ids
    /// (canonical EJSON) and the stored form of each document that passed `USING(read)`.
    pub(crate) async fn check_before(
        &self,
        documents: &[Document],
        check: &Compiled,
        read: bool,
    ) -> Result<(Vec<String>, Vec<(String, Document)>), DriverError> {
        let ids: Vec<Value> =
            documents.iter().map(|doc| doc.get("_id").cloned().unwrap_or(Value::Null)).collect();
        let facet = self.facets(&ids, Some(check), read, true).map_err(custom)?;
        if facet.is_empty() {
            return Ok((Vec::new(), Vec::new()));
        }
        let literal =
            single("$literal", Value::Array(documents.iter().cloned().map(Value::Document).collect()));
        let union = single(
            "$unionWith",
            Value::Document(single(
                "pipeline",
                Value::Array(vec![Value::Document(single("$documents", Value::Document(literal)))]),
            )),
        );
        let empty = single("$match", Value::Document(single("_id", ids_in(&[]))));
        let pipeline = vec![
            to_bson(&empty).map_err(custom)?,
            to_bson(&union).map_err(custom)?,
            to_bson(&single("$facet", Value::Document(facet))).map_err(custom)?,
        ];
        let out = self.aggregate_one(&mut Session::none(), pipeline).await?;
        let list = |name: &str| match out.as_ref().and_then(|doc| doc.get(name)) {
            Some(Value::Array(items)) => {
                items.iter().filter_map(|item| item.as_document().cloned()).collect()
            }
            _ => Vec::new(),
        };
        let bad: Vec<Document> = list("bad");
        let found: Vec<Document> = list("docs");
        Ok((
            bad.iter().map(|doc| key(doc.get("_id").unwrap_or(&Value::Null))).collect(),
            found.into_iter().map(|doc| (key(doc.get("_id").unwrap_or(&Value::Null)), doc)).collect(),
        ))
    }

    /// The readable form of each document among `found`, `None` where it is not there.
    pub(crate) fn readable_of(
        &self,
        documents: &[Document],
        found: &[(String, Document)],
        read: bool,
    ) -> Result<Option<Vec<Returned>>, CanopyError> {
        if !read {
            return Ok(None);
        }
        let mut out = Vec::with_capacity(documents.len());
        for doc in documents {
            let id = key(doc.get("_id").unwrap_or(&Value::Null));
            out.push(match found.iter().find(|(key, _)| *key == id) {
                Some((_, stored)) => Some(project_readable(&self.readable, stored)?),
                None => None,
            });
        }
        Ok(Some(out))
    }

    /// Reads several written documents back through `USING(read)` and the read field rules with one `find`, in
    /// the order of `ids`. A document is matched by its `_id` key, numbers by value across BSON types. When the
    /// `find` returns a document that matches no id, the ids without a match are read one at a time instead,
    /// so a readable document is never reported as unreadable.
    pub(crate) async fn read_many(
        &self,
        session: &mut Session<'_>,
        ids: &[Value],
    ) -> Result<Vec<Returned>, DriverError> {
        let filter = single("_id", ids_in(ids));
        let read =
            self.engine.effective_read(&self.name, &filter, &self.ctx).map_err(|_| custom(internal()))?;
        if read == Compiled::Deny {
            return Ok(ids.iter().map(|_| None).collect());
        }
        let collection = self.raw();
        let batch = u32::try_from(ids.len() + 1).unwrap_or(u32::MAX).max(2);
        let mut find =
            collection.find(self.filter(&read).map_err(custom)?).batch_size(batch).max_time(self.max_time);
        if let Some(projection) = to_projection(&self.readable) {
            find = find.projection(to_bson(&projection).map_err(custom)?);
        }
        let found = collect(find, session).await?;
        let mut by_key = std::collections::HashMap::new();
        for raw in &found {
            let doc = value_of(raw).map_err(custom)?;
            let id = doc.get("_id").cloned().unwrap_or(Value::Null);
            by_key.insert(id_key(&id).unwrap_or_else(|| key(&id)), doc);
        }
        let mut out: Vec<Returned> = Vec::with_capacity(ids.len());
        let mut missed = Vec::new();
        for (index, id) in ids.iter().enumerate() {
            match by_key.get(&id_key(id).unwrap_or_else(|| key(id))) {
                Some(doc) => out.push(Some(project_readable(&self.readable, doc).map_err(custom)?)),
                None => {
                    missed.push(index);
                    out.push(None);
                }
            }
        }
        if found.len() > ids.len() - missed.len() {
            for index in missed {
                out[index] = self.read_one(session, &ids[index]).await?;
            }
        }
        Ok(out)
    }

    /// Reads one written document back through `USING(read)` and the read field rules, or `None` when the
    /// caller cannot read it.
    pub(crate) async fn read_one(
        &self,
        session: &mut Session<'_>,
        id: &Value,
    ) -> Result<Returned, DriverError> {
        let filter = single("_id", Value::Document(single("$eq", id.clone())));
        let read =
            self.engine.effective_read(&self.name, &filter, &self.ctx).map_err(|_| custom(internal()))?;
        if read == Compiled::Deny {
            return Ok(None);
        }
        let collection = self.raw();
        let mut find = collection
            .find(self.filter(&read).map_err(custom)?)
            .limit(1)
            .batch_size(1)
            .max_time(self.max_time);
        if let Some(projection) = to_projection(&self.readable) {
            find = find.projection(to_bson(&projection).map_err(custom)?);
        }
        let documents = collect(find, session).await?;
        match documents.first() {
            None => Ok(None),
            Some(raw) => {
                Ok(Some(project_readable(&self.readable, &value_of(raw).map_err(custom)?).map_err(custom)?))
            }
        }
    }

    /// The `$facet` of a check and a read back over the documents with these ids. Failing documents are
    /// counted, or with `list_failing` listed by `_id`.
    fn facets(
        &self,
        ids: &[Value],
        check: Option<&Compiled>,
        read: bool,
        list_failing: bool,
    ) -> Result<Document, CanopyError> {
        let mut facet = Document::new();
        if let Some(Compiled::Filter(check)) = check
            && !ids.is_empty()
        {
            let nor = single("$nor", Value::Array(vec![Value::Document(check.clone())]));
            let second = if list_failing {
                single("$project", Value::Document(single("_id", Value::Int32(1))))
            } else {
                single("$count", Value::String("n".to_owned()))
            };
            facet.insert(
                "bad",
                Value::Array(vec![
                    Value::Document(single("$match", Value::Document(nor))),
                    Value::Document(second),
                ]),
            );
        }
        if read {
            let filter = single("_id", ids_in(ids));
            let read = self.engine.effective_read(&self.name, &filter, &self.ctx).map_err(|_| internal())?;
            if read != Compiled::Deny {
                let mut stages = vec![Value::Document(single("$match", Value::Document(read.to_filter())))];
                if let Some(projection) = to_projection(&self.readable) {
                    stages.push(Value::Document(single("$project", Value::Document(projection))));
                }
                facet.insert("docs", Value::Array(stages));
            }
        }
        Ok(facet)
    }

    /// Reads the result of [`Scope::facets`]: a failed check is a violation, else the readable documents.
    fn outcome(
        &self,
        out: Option<&Document>,
        ids: &[Value],
        op: Operation,
    ) -> Result<Option<Vec<Returned>>, CanopyError> {
        let bad = match out.and_then(|doc| doc.get("bad")) {
            Some(Value::Array(items)) => {
                items.first().and_then(|first| first.as_document()).and_then(|d| d.get("n")).cloned()
            }
            _ => None,
        };
        if bad.is_some_and(|count| !matches!(count, Value::Int32(0) | Value::Int64(0))) {
            return Err(self.violation(op));
        }
        let docs: Vec<&Document> = match out.and_then(|doc| doc.get("docs")) {
            Some(Value::Array(items)) => items.iter().filter_map(Value::as_document).collect(),
            _ => Vec::new(),
        };
        let mut result = Vec::with_capacity(ids.len());
        for id in ids {
            let wanted = key(id);
            result.push(
                match docs.iter().find(|doc| key(doc.get("_id").unwrap_or(&Value::Null)) == wanted) {
                    Some(doc) => Some(project_readable(&self.readable, doc)?),
                    None => None,
                },
            );
        }
        Ok(Some(result))
    }

    /// The refusal of a write whose result fails a `check` clause.
    pub(crate) fn violation(&self, op: Operation) -> CanopyError {
        let error = CanopyError::named(
            ErrorCode::PolicyViolation,
            "PolicyViolationError",
            format!(
                "The resulting document does not satisfy the {} check for collection '{}'",
                op.as_str(),
                self.name
            ),
        );
        self.explained(error, op, Clause::Check)
    }

    /// Refuses a write that sets fields the caller may not write.
    pub(crate) fn assert_writable(&self, access: &FieldAccess, paths: &[String]) -> Result<(), CanopyError> {
        let written: Vec<String> = paths.iter().filter(|path| *path != "_id").cloned().collect();
        let denied = denied_paths(access, &written);
        if denied.is_empty() {
            return Ok(());
        }
        let error = CanopyError::named(
            ErrorCode::PolicyViolation,
            "PolicyViolationError",
            format!("The caller may not write {} in collection '{}'", denied.join(", "), self.name),
        );
        Err(if self.explain { error.with_details(rule_details("fields.write", &denied)) } else { error })
    }

    /// Refuses a write that changes an immutable field.
    pub(crate) fn assert_mutable(&self, written: &[String]) -> Result<(), CanopyError> {
        let frozen = immutable_violations(written, self.engine.immutable(&self.name));
        if frozen.is_empty() {
            return Ok(());
        }
        let error = CanopyError::named(
            ErrorCode::PolicyViolation,
            "PolicyViolationError",
            format!("Immutable fields cannot be changed: {}", frozen.join(", ")),
        );
        Err(if self.explain { error.with_details(rule_details("immutable", &frozen)) } else { error })
    }

    /// Adds `details.explain` to a refusal when refusals are explained: the policies of the clause with their
    /// outcome and resolved filter.
    fn explained(&self, error: CanopyError, op: Operation, clause: Clause) -> CanopyError {
        if !self.explain {
            return error;
        }
        let Ok(explanation) = self.engine.explain(&self.name, op, &self.ctx, clause) else { return error };
        let mut explain = Document::new();
        explain.insert("collection", Value::String(self.name.clone()));
        explain.insert("op", Value::String(op.as_str().to_owned()));
        explain.insert("clause", Value::String(clause.as_str().to_owned()));
        explain.insert("roles", Value::Array(explanation.roles.iter().cloned().map(Value::String).collect()));
        let policies = explanation
            .policies
            .iter()
            .map(|policy| {
                let mut out = Document::new();
                out.insert("name", Value::String(policy.name.clone()));
                out.insert("kind", Value::String(policy.kind.as_str().to_owned()));
                out.insert("applies", Value::Bool(policy.applies));
                out.insert("reason", Value::String(policy.reason.clone()));
                if let Some(resolved) = &policy.resolved {
                    out.insert("filter", Value::Document(resolved.clone()));
                }
                Value::Document(out)
            })
            .collect();
        explain.insert("policies", Value::Array(policies));
        match canopy_protocol::ejson::stringify(&Value::Document(single("explain", Value::Document(explain))))
        {
            Ok(details) => error.with_details(details),
            Err(_) => error,
        }
    }
}

fn rule_details(rule: &str, fields: &[String]) -> String {
    let mut out = String::from("{\"explain\":{\"rule\":");
    write_json_string(&mut out, rule);
    out.push_str(",\"fields\":[");
    for (index, field) in fields.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_json_string(&mut out, field);
    }
    out.push_str("]}}");
    out
}

/// A driver error that carries a Canopy error, so the write path can stop a transaction with it.
pub(crate) fn custom(error: CanopyError) -> DriverError {
    DriverError::custom(Arc::new(error))
}

/// The Canopy error a driver error carries, if it carries one.
pub(crate) fn carried(error: &DriverError) -> Option<CanopyError> {
    error.get_custom::<Arc<CanopyError>>().map(|error| (**error).clone())
}

/// The documents of a find, inside the transaction of `session` when one runs.
pub(crate) async fn collect(
    find: canopy_mongo::mongodb::action::Find<'_, RawDocumentBuf>,
    session: &mut Session<'_>,
) -> Result<Vec<RawDocumentBuf>, DriverError> {
    let mut out = Vec::new();
    match session.reading() {
        Some(inner) => {
            let mut cursor = find.session(&mut *inner).await?;
            while cursor.advance(inner).await? {
                out.push(cursor.current().to_owned());
            }
        }
        None => {
            let mut cursor = find.await?;
            while cursor.advance().await? {
                out.push(cursor.current().to_owned());
            }
        }
    }
    Ok(out)
}
