//! A write checked against the caller's policies and limits, ready to run: in a transaction, or on its own
//! when it is one atomic single document operation whose `check` cannot fail.

use canopy_engine::Ct;
use canopy_mongo::mongodb::bson::{self, oid::ObjectId};
use canopy_mongo::to_bson;
use canopy_policy::{Compiled, FieldAccess, Operation, and, check_implied, project_readable, to_projection};
use canopy_protocol::bson::encode_document;
use canopy_protocol::ejson::canonical_string;
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};
use canopy_query::{ParseUpdateOptions, QueryLimits, UpdateKind, parse_update, validate_stored_document};

use crate::errors::internal;
use crate::fail;
use crate::writes::request::{WriteOp, WriteRequest, leaf_paths, validate_id};
use crate::writes::scope::{DriverError, Returned, Scope, Session, custom, value_of};

/// The largest document checked through `$documents` before a single insert; larger ones are checked after.
const PRECHECK_MAX_BYTES: usize = 8 * 1024 * 1024;

/// What a write did, as stored with its idempotency record and returned to the caller.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Outcome {
    /// Documents matched.
    pub matched: u64,
    /// Documents changed.
    pub modified: u64,
    /// Documents deleted.
    pub deleted: u64,
    /// The `_id`s inserted, an upserted one included.
    pub inserted_ids: Vec<Value>,
    /// The `_id` an upsert inserted.
    pub upserted_id: Option<Value>,
    /// The `_id`s whose documents the write may have changed.
    pub changed_ids: Vec<Value>,
    /// For single document writes and inserts: the readable post image (the pre image for a delete), `None`
    /// where the caller cannot read it. Absent for bulk writes and when no document was asked for.
    pub documents: Option<Vec<Returned>>,
    /// Set by fast runs, which read after writing and report the time of the write itself.
    pub(crate) ct: Option<Ct>,
}

impl Outcome {
    fn inserted(ids: Vec<Value>, documents: Option<Vec<Returned>>) -> Outcome {
        Outcome { changed_ids: ids.clone(), inserted_ids: ids, documents, ..Outcome::default() }
    }

    fn upserted(id: Value, documents: Option<Vec<Returned>>) -> Outcome {
        Outcome {
            inserted_ids: vec![id.clone()],
            upserted_id: Some(id.clone()),
            changed_ids: vec![id],
            documents,
            ..Outcome::default()
        }
    }
}

/// The write limits a plan checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteLimits {
    /// Maximum documents an `updateMany` or `deleteMany` may touch.
    pub max_bulk: u64,
    /// Maximum documents in one `insertMany`.
    pub max_insert_many: usize,
    /// Time limit per operation, in milliseconds.
    pub max_time_ms: u64,
    /// Time after which a write that keeps hitting transient errors gives up, in milliseconds.
    pub transaction_timeout_ms: u64,
    /// Maximum operations in one batch.
    pub max_batch: usize,
}

impl Default for WriteLimits {
    fn default() -> WriteLimits {
        WriteLimits {
            max_bulk: 1000,
            max_insert_many: 1000,
            max_time_ms: 10_000,
            transaction_timeout_ms: 30_000,
            max_batch: 100,
        }
    }
}

/// How a planned write runs.
pub(crate) enum Step {
    Insert {
        documents: Vec<bson::Document>,
        values: Vec<Document>,
        ids: Vec<Value>,
        check: Compiled,
        precheck: bool,
    },
    UpdateById {
        id: Value,
        filter: bson::Document,
        visible: Compiled,
        conditional: bool,
        update: bson::Document,
        check: Option<Compiled>,
    },
    UpdateMany {
        target: Compiled,
        update: bson::Document,
        check: Compiled,
    },
    Replace {
        id: Value,
        filter: bson::Document,
        visible: Compiled,
        conditional: bool,
        replacement: bson::Document,
        update_check: Compiled,
        insert_check: Option<Compiled>,
        /// The replacement as MongoDB stores it, `_id` first, when its check may be evaluated before the write.
        prechecked: Option<Document>,
    },
    DeleteById {
        id: Value,
        filter: bson::Document,
        visible: Compiled,
        conditional: bool,
    },
    DeleteMany {
        target: Compiled,
    },
}

/// Whether a `check` filter reads anything but the document it is evaluated on: a system variable other than
/// `$$ROOT`, `$$CURRENT` and `$$REMOVE`, such as `$$NOW`, whose value differs from one command to the next.
fn reads_clock(value: &Value) -> bool {
    match value {
        Value::String(text) => {
            let variable =
                text.strip_prefix("$$").filter(|rest| rest.starts_with(|c: char| c.is_ascii_uppercase()));
            variable.is_some_and(|rest| {
                !["ROOT", "CURRENT", "REMOVE"].iter().any(|name| {
                    rest.strip_prefix(name).is_some_and(|tail| tail.is_empty() || tail.starts_with('.'))
                })
            })
        }
        Value::Array(items) => items.iter().any(reads_clock),
        Value::Document(document) => document.iter().any(|(_, member)| reads_clock(member)),
        _ => false,
    }
}

/// A planned write and whether it may run without a transaction.
pub(crate) struct Plan {
    pub(crate) scope: Scope,
    pub(crate) step: Step,
    pub(crate) fast: bool,
}

/// Plans a write: checks it against the caller's policies and limits and returns how to run it.
pub(crate) fn plan_write(
    limits: &WriteLimits,
    query: &QueryLimits,
    scope: Scope,
    request: &WriteRequest,
) -> Result<Plan, CanopyError> {
    let missing = Value::Undefined;
    let member = |name: &str| request.get(name).unwrap_or(&missing);
    match request.op() {
        WriteOp::Insert => plan_insert(limits, query, scope, std::slice::from_ref(member("doc")), true),
        WriteOp::InsertMany => match member("docs") {
            Value::Array(docs) => plan_insert(limits, query, scope, docs, false),
            _ => fail("docs must be an array"),
        },
        WriteOp::Update => {
            plan_update(query, scope, Some(member("id")), None, member("update"), request.get("where"))
        }
        WriteOp::UpdateMany => {
            require_bulk(request.get("bulk"))?;
            plan_update(query, scope, None, Some(member("filter")), member("update"), None)
        }
        WriteOp::Replace => plan_replace(query, scope, request),
        WriteOp::Delete => plan_delete(scope, Some(member("id")), None, request.get("where")),
        WriteOp::DeleteMany => {
            require_bulk(request.get("bulk"))?;
            plan_delete(scope, None, Some(member("filter")), None)
        }
    }
}

fn require_bulk(flag: Option<&Value>) -> Result<(), CanopyError> {
    match flag {
        Some(Value::Bool(true)) => Ok(()),
        _ => fail("Writes to many documents must be requested with bulk: true"),
    }
}

fn bulk_limit(max: u64) -> CanopyError {
    CanopyError::new(ErrorCode::BulkLimit, format!("A bulk write may not touch more than {max} documents"))
}

/// The document with `_id` first, as MongoDB stores it, and a new ObjectId when it has none.
fn id_first(doc: &Document) -> Document {
    if doc.keys().next() == Some("_id") && !matches!(doc.get("_id"), Some(Value::Undefined)) {
        return doc.clone();
    }
    let id = match doc.get("_id") {
        Some(id) if !matches!(id, Value::Undefined) => id.clone(),
        _ => Value::ObjectId(ObjectId::new().bytes()),
    };
    let mut out = Document::new();
    out.insert("_id", id);
    for (key, value) in doc.iter() {
        if key != "_id" {
            out.insert(key, value.clone());
        }
    }
    out
}

fn plan_insert(
    limits: &WriteLimits,
    query: &QueryLimits,
    scope: Scope,
    docs: &[Value],
    single: bool,
) -> Result<Plan, CanopyError> {
    if docs.is_empty() {
        return fail("There is nothing to insert");
    }
    if docs.len() > limits.max_insert_many {
        return Err(CanopyError::new(
            ErrorCode::BulkLimit,
            format!("An insert may not have more than {} documents", limits.max_insert_many),
        ));
    }
    scope.require_grant(Operation::Insert)?;
    let writable = scope.writable(Operation::Insert);
    let mut values = Vec::with_capacity(docs.len());
    for doc in docs {
        validate_stored_document(doc, query)?;
        let Value::Document(record) = doc else { return fail("A document must be an object") };
        if !scope.service && writable != FieldAccess::All {
            scope.assert_writable(&writable, &leaf_paths(record))?;
        }
        validate_id(record.get("_id"))?;
        values.push(id_first(record));
    }
    let check = scope.engine.check(&scope.name, Operation::Insert, &scope.ctx);
    if check == Compiled::Deny {
        return Err(scope.violation(Operation::Insert));
    }
    let documents = values.iter().map(to_bson).collect::<Result<Vec<_>, _>>()?;
    let size: usize =
        values.iter().map(|doc| encode_document(doc).map_or(usize::MAX, |bytes| bytes.len())).sum();
    let precheck = single && size <= PRECHECK_MAX_BYTES;
    let ids = values.iter().map(|doc| doc.get("_id").cloned().unwrap_or(Value::Null)).collect();
    let fast = single && (check == Compiled::All || precheck);
    Ok(Plan { scope, step: Step::Insert { documents, values, ids, check, precheck }, fast })
}

fn plan_update(
    query: &QueryLimits,
    scope: Scope,
    id: Option<&Value>,
    filter: Option<&Value>,
    raw_update: &Value,
    raw_where: Option<&Value>,
) -> Result<Plan, CanopyError> {
    scope.require_grant(Operation::Update)?;
    let parsed =
        parse_update(raw_update, &ParseUpdateOptions { allow_pipeline: scope.service, limits: *query })?;
    if parsed.kind == UpdateKind::Replacement {
        return fail("An update needs update operators; use replace for whole documents");
    }
    if parsed.written_paths.iter().any(|path| path == "_id" || path.starts_with("_id.")) {
        return fail("An update may not change _id");
    }
    if !scope.service {
        scope.assert_writable(&scope.writable(Operation::Update), &parsed.written_paths)?;
        scope.assert_mutable(&parsed.written_paths)?;
    }
    let base = match id {
        Some(id) => {
            validate_id(Some(id))?;
            scope.by_id(id)
        }
        None => scope.by_filter(filter.unwrap_or(&Value::Undefined))?,
    };
    let condition = scope.precondition(raw_where)?;
    let using = scope.engine.target(&scope.name, Operation::Update, &scope.ctx).map_err(|_| internal())?;
    let target = and(&[base.clone(), condition.clone(), using.clone()]).map_err(|_| internal())?;
    let check = scope.engine.check(&scope.name, Operation::Update, &scope.ctx);
    let update = to_bson(&parsed.update)?;
    let Some(id) = id else {
        return Ok(Plan { scope, step: Step::UpdateMany { target, update, check }, fast: false });
    };
    let implied = check == Compiled::All || check_implied(&check, &target, &parsed.written_paths)?;
    let visible = and(&[base, using]).map_err(|_| internal())?;
    let filter = scope.filter(&target)?;
    let step = Step::UpdateById {
        id: id.clone(),
        filter,
        visible,
        conditional: condition != Compiled::All,
        update,
        check: (!implied).then_some(check),
    };
    Ok(Plan { scope, step, fast: implied })
}

fn plan_replace(query: &QueryLimits, scope: Scope, request: &WriteRequest) -> Result<Plan, CanopyError> {
    let upsert = matches!(request.get("upsert"), Some(Value::Bool(true)));
    scope.require_grant(Operation::Update)?;
    if upsert {
        scope.require_grant(Operation::Insert)?;
    }
    if upsert && request.get("where").is_some() {
        return fail("A replacement cannot combine where with upsert");
    }
    let doc = request.get("doc").unwrap_or(&Value::Undefined);
    validate_stored_document(doc, query)?;
    let Value::Document(doc) = doc else { return fail("A document must be an object") };
    let id = request.get("id").unwrap_or(&Value::Undefined);
    validate_id(Some(id))?;
    if let Some(own) = doc.get("_id")
        && !matches!(own, Value::Undefined)
        && canonical_string(own)? != canonical_string(id)?
    {
        return fail("The replacement _id must match the target _id");
    }
    if !scope.service {
        if scope.writable(Operation::Update) != FieldAccess::All
            || !scope.engine.immutable(&scope.name).is_empty()
        {
            return Err(CanopyError::named(
                ErrorCode::Forbidden,
                "ForbiddenError",
                format!(
                    "The field rules of '{}' do not allow replacing whole documents; send an update",
                    scope.name
                ),
            ));
        }
        if upsert {
            scope.assert_writable(&scope.writable(Operation::Insert), &leaf_paths(doc))?;
        }
    }
    let base = scope.by_id(id);
    let condition = scope.precondition(request.get("where"))?;
    let using = scope.engine.target(&scope.name, Operation::Update, &scope.ctx).map_err(|_| internal())?;
    let target = and(&[base.clone(), condition.clone(), using.clone()]).map_err(|_| internal())?;
    let visible = and(&[base, using]).map_err(|_| internal())?;
    let update_check = scope.engine.check(&scope.name, Operation::Update, &scope.ctx);
    let insert_check = upsert.then(|| scope.engine.check(&scope.name, Operation::Insert, &scope.ctx));
    let atomic_upsert = insert_check.as_ref().is_some_and(|check| *check == Compiled::All);
    let mut replacement = doc.clone();
    replacement.insert("_id", id.clone());
    let fast = update_check == Compiled::All && (insert_check.is_none() || atomic_upsert);
    let stored = id_first(&replacement);
    let prechecked = (!upsert
        && matches!(&update_check, Compiled::Filter(check) if !reads_clock(&Value::Document(check.clone())))
        && encode_document(&stored).is_ok_and(|bytes| bytes.len() <= PRECHECK_MAX_BYTES))
    .then_some(stored);
    let step = Step::Replace {
        id: id.clone(),
        filter: scope.filter(&target)?,
        visible,
        conditional: condition != Compiled::All,
        replacement: to_bson(&replacement)?,
        update_check,
        insert_check,
        prechecked,
    };
    Ok(Plan { scope, step, fast })
}

fn plan_delete(
    scope: Scope,
    id: Option<&Value>,
    filter: Option<&Value>,
    raw_where: Option<&Value>,
) -> Result<Plan, CanopyError> {
    scope.require_grant(Operation::Delete)?;
    let base = match id {
        Some(id) => {
            validate_id(Some(id))?;
            scope.by_id(id)
        }
        None => scope.by_filter(filter.unwrap_or(&Value::Undefined))?,
    };
    let condition = scope.precondition(raw_where)?;
    let using = scope.engine.target(&scope.name, Operation::Delete, &scope.ctx).map_err(|_| internal())?;
    let target = and(&[base.clone(), condition.clone(), using.clone()]).map_err(|_| internal())?;
    let Some(id) = id else { return Ok(Plan { scope, step: Step::DeleteMany { target }, fast: false }) };
    let visible = and(&[base, using]).map_err(|_| internal())?;
    let step = Step::DeleteById {
        id: id.clone(),
        filter: scope.filter(&target)?,
        visible,
        conditional: condition != Compiled::All,
    };
    Ok(Plan { scope, step, fast: true })
}

/// The cluster time of the write that just ran on a fast path, taken before any read back; `None` inside a
/// transaction, whose commit time is used instead.
fn fast_time(session: &Session<'_>) -> Result<Option<Ct>, DriverError> {
    if session.transaction {
        return Ok(None);
    }
    let time =
        session.inner.as_ref().and_then(|inner| inner.operation_time()).ok_or_else(|| custom(internal()))?;
    Ok(Some(Ct::from_parts(time.time, time.increment)))
}

impl Plan {
    /// Runs a replacement without a transaction when it can: MongoDB evaluates the check on the replacement as
    /// it will be stored before anything is written, and the write is then one `replaceOne`. A check that fails
    /// is not an error yet (the target may be missing or invisible, or the write identical), so `None` is
    /// returned and nothing has been written: the caller runs the transaction, which decides exactly.
    pub(crate) async fn run_direct(
        &self,
        session: &mut Session<'_>,
        read: bool,
    ) -> Result<Option<Outcome>, DriverError> {
        let Step::Replace {
            id,
            filter,
            visible,
            conditional,
            replacement,
            update_check,
            prechecked: Some(stored),
            ..
        } = &self.step
        else {
            return Ok(None);
        };
        let scope = &self.scope;
        let (failed, found) = scope.check_before(std::slice::from_ref(stored), update_check, read).await?;
        if !failed.is_empty() {
            return Ok(None);
        }
        let documents = scope.readable_of(std::slice::from_ref(stored), &found, read).map_err(custom)?;
        let coll = scope.coll();
        let action = coll
            .replace_one(filter.clone(), replacement.clone())
            .upsert(false)
            .optional(Scope::write_concern(session), |a, c| a.write_concern(c));
        let result = match session.inner.as_deref_mut() {
            Some(inner) => action.session(inner).await?,
            None => action.await?,
        };
        let ct = fast_time(session)?;
        if result.matched_count == 0 {
            if *conditional {
                scope.assert_no_conflict(session, visible).await?;
            }
            return Ok(Some(Outcome { ct, ..Outcome::default() }));
        }
        let modified = result.modified_count > 0;
        Ok(Some(Outcome {
            matched: result.matched_count,
            modified: result.modified_count,
            changed_ids: if modified { vec![id.clone()] } else { Vec::new() },
            documents,
            ct,
            ..Outcome::default()
        }))
    }

    /// Runs the write in `session` and reports what it did, with the readable documents when `read` is set.
    pub(crate) async fn run(
        &self,
        session: &mut Session<'_>,
        read: bool,
        limits: &WriteLimits,
    ) -> Result<Outcome, DriverError> {
        let scope = &self.scope;
        let concern = Scope::write_concern(session);
        let coll = scope.coll();
        let raw = scope.db.collection::<bson::RawDocumentBuf>(&scope.name);
        match &self.step {
            Step::Insert { documents, values, ids, check, precheck } => {
                let checked = if *precheck {
                    if *check == Compiled::Deny {
                        return Err(custom(scope.violation(Operation::Insert)));
                    }
                    let (failed, found) = scope.check_before(values, check, read).await?;
                    if !failed.is_empty() {
                        return Err(custom(scope.violation(Operation::Insert)));
                    }
                    Some(scope.readable_of(values, &found, read).map_err(custom)?)
                } else {
                    None
                };
                if let [document] = documents.as_slice() {
                    let insert = coll.insert_one(document).optional(concern, |a, c| a.write_concern(c));
                    match session.inner.as_deref_mut() {
                        Some(inner) => insert.session(inner).await?,
                        None => insert.await?,
                    };
                } else {
                    let insert = coll
                        .insert_many(documents)
                        .ordered(true)
                        .optional(concern, |a, c| a.write_concern(c));
                    match session.inner.as_deref_mut() {
                        Some(inner) => insert.session(inner).await?,
                        None => insert.await?,
                    };
                }
                let ct = fast_time(session)?;
                let documents = match checked {
                    Some(checked) => checked,
                    None => scope.verify(session, ids, Some(check), Operation::Insert, read).await?,
                };
                Ok(Outcome { ct, ..Outcome::inserted(ids.clone(), documents) })
            }
            Step::UpdateById { id, filter, visible, conditional, update, check } => {
                let action = coll
                    .update_one(filter.clone(), update.clone())
                    .optional(concern, |a, c| a.write_concern(c));
                let result = match session.inner.as_deref_mut() {
                    Some(inner) => action.session(inner).await?,
                    None => action.await?,
                };
                let ct = fast_time(session)?;
                if result.matched_count == 0 {
                    if *conditional {
                        scope.assert_no_conflict(session, visible).await?;
                    }
                    return Ok(Outcome { ct, ..Outcome::default() });
                }
                let modified = result.modified_count > 0;
                let checked = if modified { check.as_ref() } else { None };
                let documents =
                    scope.verify(session, std::slice::from_ref(id), checked, Operation::Update, read).await?;
                Ok(Outcome {
                    matched: result.matched_count,
                    modified: result.modified_count,
                    changed_ids: if modified { vec![id.clone()] } else { Vec::new() },
                    documents,
                    ct,
                    ..Outcome::default()
                })
            }
            Step::UpdateMany { target, update, check } => {
                let ids = scope
                    .find_ids(session, target, i64::try_from(limits.max_bulk + 1).unwrap_or(i64::MAX))
                    .await?;
                if ids.len() as u64 > limits.max_bulk {
                    return Err(custom(bulk_limit(limits.max_bulk)));
                }
                if ids.is_empty() {
                    return Ok(Outcome::default());
                }
                let action = coll.update_many(scope.by_ids(&ids, target).map_err(custom)?, update.clone());
                let result = match session.inner.as_deref_mut() {
                    Some(inner) => action.session(inner).await?,
                    None => action.await?,
                };
                if result.modified_count > 0 {
                    scope.verify(session, &ids, Some(check), Operation::Update, false).await?;
                }
                Ok(Outcome {
                    matched: result.matched_count,
                    modified: result.modified_count,
                    changed_ids: if result.modified_count > 0 { ids } else { Vec::new() },
                    ..Outcome::default()
                })
            }
            Step::Replace {
                id,
                filter,
                visible,
                conditional,
                replacement,
                update_check,
                insert_check,
                ..
            } => {
                let atomic_upsert = insert_check.as_ref() == Some(&Compiled::All);
                let action = coll
                    .replace_one(filter.clone(), replacement.clone())
                    .upsert(atomic_upsert)
                    .optional(concern.clone(), |a, c| a.write_concern(c));
                let result = match session.inner.as_deref_mut() {
                    Some(inner) => action.session(inner).await?,
                    None => action.await?,
                };
                let mut ct = fast_time(session)?;
                if result.upserted_id.is_some() {
                    let documents = scope
                        .verify(session, std::slice::from_ref(id), None, Operation::Insert, read)
                        .await?;
                    return Ok(Outcome { ct, ..Outcome::upserted(id.clone(), documents) });
                }
                if result.matched_count == 0 {
                    if *conditional {
                        scope.assert_no_conflict(session, visible).await?;
                    }
                    let Some(insert_check) = insert_check else {
                        return Ok(Outcome { ct, ..Outcome::default() });
                    };
                    if *insert_check == Compiled::Deny {
                        return Err(custom(scope.violation(Operation::Insert)));
                    }
                    let insert =
                        coll.insert_one(replacement.clone()).optional(concern, |a, c| a.write_concern(c));
                    match session.inner.as_deref_mut() {
                        Some(inner) => insert.session(inner).await?,
                        None => insert.await?,
                    };
                    ct = fast_time(session)?;
                    let documents = scope
                        .verify(
                            session,
                            std::slice::from_ref(id),
                            Some(insert_check),
                            Operation::Insert,
                            read,
                        )
                        .await?;
                    return Ok(Outcome { ct, ..Outcome::upserted(id.clone(), documents) });
                }
                let modified = result.modified_count > 0;
                let checked = if modified { Some(update_check) } else { None };
                let documents =
                    scope.verify(session, std::slice::from_ref(id), checked, Operation::Update, read).await?;
                Ok(Outcome {
                    matched: result.matched_count,
                    modified: result.modified_count,
                    changed_ids: if modified { vec![id.clone()] } else { Vec::new() },
                    documents,
                    ct,
                    ..Outcome::default()
                })
            }
            Step::DeleteById { id, filter, visible, conditional } => {
                if !read {
                    let action = coll.delete_one(filter.clone()).optional(concern, |a, c| a.write_concern(c));
                    let result = match session.inner.as_deref_mut() {
                        Some(inner) => action.session(inner).await?,
                        None => action.await?,
                    };
                    let ct = fast_time(session)?;
                    if result.deleted_count == 0 {
                        if *conditional {
                            scope.assert_no_conflict(session, visible).await?;
                        }
                        return Ok(Outcome { ct, ..Outcome::default() });
                    }
                    return Ok(Outcome {
                        matched: 1,
                        deleted: 1,
                        changed_ids: vec![id.clone()],
                        ct,
                        ..Outcome::default()
                    });
                }
                let mut action =
                    raw.find_one_and_delete(filter.clone()).optional(concern, |a, c| a.write_concern(c));
                if let Some(projection) = to_projection(scope.readable()) {
                    action = action.projection(to_bson(&projection).map_err(custom)?);
                }
                let deleted = match session.inner.as_deref_mut() {
                    Some(inner) => action.session(inner).await?,
                    None => action.await?,
                };
                let ct = fast_time(session)?;
                let Some(deleted) = deleted else {
                    if *conditional {
                        scope.assert_no_conflict(session, visible).await?;
                    }
                    return Ok(Outcome { ct, ..Outcome::default() });
                };
                let deleted = value_of(&deleted).map_err(custom)?;
                let changed = deleted.get("_id").cloned().unwrap_or(Value::Null);
                Ok(Outcome {
                    matched: 1,
                    deleted: 1,
                    changed_ids: vec![changed],
                    documents: Some(vec![Some(
                        project_readable(scope.readable(), &deleted).map_err(custom)?,
                    )]),
                    ct,
                    ..Outcome::default()
                })
            }
            Step::DeleteMany { target } => {
                let ids = scope
                    .find_ids(session, target, i64::try_from(limits.max_bulk + 1).unwrap_or(i64::MAX))
                    .await?;
                if ids.len() as u64 > limits.max_bulk {
                    return Err(custom(bulk_limit(limits.max_bulk)));
                }
                if ids.is_empty() {
                    return Ok(Outcome::default());
                }
                let action = coll.delete_many(scope.by_ids(&ids, target).map_err(custom)?);
                let result = match session.inner.as_deref_mut() {
                    Some(inner) => action.session(inner).await?,
                    None => action.await?,
                };
                Ok(Outcome {
                    matched: ids.len() as u64,
                    deleted: result.deleted_count,
                    changed_ids: ids,
                    ..Outcome::default()
                })
            }
        }
    }
}

/// Applies a setting to a driver action only when it has a value.
trait Optional: Sized {
    fn optional<T>(self, value: Option<T>, apply: impl FnOnce(Self, T) -> Self) -> Self {
        match value {
            Some(value) => apply(self, value),
            None => self,
        }
    }
}

impl<T> Optional for T {}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_protocol::ejson::{DecodeOptions, parse};

    fn value(text: &str) -> Value {
        parse(text, DecodeOptions::default()).unwrap_or(Value::Undefined)
    }

    #[test]
    fn only_variables_other_than_the_document_read_the_clock() {
        for clock in
            [r#"{"$expr":{"$lt":["$at","$$NOW"]}}"#, r#"{"a":["$$CLUSTER_TIME"]}"#, r#"{"a":"$$ROOTS"}"#]
        {
            assert!(reads_clock(&value(clock)), "{clock}");
        }
        for document in [
            r#"{"ownerId":"u1"}"#,
            r#"{"$expr":{"$eq":["$$ROOT.a","$$CURRENT.b"]}}"#,
            r#"{"a":"$$REMOVE"}"#,
            r#"{"a":"$$now"}"#,
            r#"{"a":"$NOW"}"#,
        ] {
            assert!(!reads_clock(&value(document)), "{document}");
        }
    }
}
