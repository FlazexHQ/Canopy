use canopy_matcher::projection::inclusion;
use canopy_matcher::{CompiledProjection, compile_projection};
use canopy_mongo::mongodb::bson::{self, RawDocumentBuf, doc};
use canopy_mongo::to_bson;
use canopy_policy::{Compiled, Operation, and, denied_paths};
use canopy_protocol::{CanopyError, DocRef, Value};
use canopy_query::{
    ParseUpdateOptions, QueryLimits, UpdateKind, parse_projection, parse_sort, parse_update,
    validate_stored_document,
};

use super::plan::{Outcome, Plan, Step, WriteLimits, run_update_many};
use super::request::{WriteOp, WriteRequest, leaf_paths, validate_id};
use super::scope::{DriverError, Scope, Session, custom, value_of};
use crate::{errors::internal, fail};

/// Selects documents by a caller filter inside the write transaction.
#[derive(Debug, Default)]
pub struct WriteSelection {
    /// The sort used to select the first matching document.
    pub sort: Option<Value>,
    /// Return the selected document before the write.
    pub before: bool,
    /// Return the document after the write.
    pub after: bool,
    /// A projection on the readable image.
    pub fields: Option<Value>,
    /// Insert if no document matches the authorized target.
    pub upsert: bool,
}

pub(super) struct Selected {
    target: Compiled,
    multi: bool,
    insert_filter: Option<bson::Document>,
    sort: Option<bson::Document>,
    update: Change,
    before: bool,
    after: bool,
    fields: Option<CompiledProjection>,
    check: Compiled,
    limits: QueryLimits,
}

enum Change {
    Delete,
    Update(bson::Document),
    Replace(bson::Document),
}

fn change(query: &QueryLimits, scope: &Scope, request: &WriteRequest) -> Result<Change, CanopyError> {
    if request.op() == WriteOp::Delete {
        return Ok(Change::Delete);
    }
    let input = request.get("update").unwrap_or(&Value::Undefined);
    let parsed = parse_update(input, &ParseUpdateOptions { allow_pipeline: scope.service, limits: *query })?;
    if parsed.kind == UpdateKind::Replacement {
        validate_id(parsed.update.get("_id"))?;
        scope.assert_replacement()?;
        return Ok(Change::Replace(to_bson(&parsed.update)?));
    }
    scope.assert_update_paths(&parsed.written_paths)?;
    Ok(Change::Update(to_bson(&parsed.update)?))
}

pub(super) fn plan(
    query: &QueryLimits,
    scope: Scope,
    request: &WriteRequest,
    selection: &WriteSelection,
    preserve_id: bool,
) -> Result<Plan, CanopyError> {
    let op = match request.op() {
        WriteOp::Delete => Operation::Delete,
        WriteOp::Update | WriteOp::UpdateMany | WriteOp::Replace => Operation::Update,
        _ => return fail("A filter selection requires an update or a single document delete"),
    };
    if selection.before && selection.after {
        return fail("A write can return only one image");
    }
    scope.require_grant(op)?;
    if selection.upsert {
        if op == Operation::Delete {
            return fail("A delete cannot upsert");
        }
        scope.require_grant(Operation::Insert)?;
    }
    let filter = request.get("filter").unwrap_or(&Value::Undefined);
    let base = scope.by_filter(filter)?;
    let using = scope.engine.target(&scope.name, op, &scope.ctx)?;
    let target = and(&[base.clone(), using])?;
    let insert_filter = if selection.upsert {
        // Force an insert while letting MongoDB derive equality fields from the caller filter.
        Some(doc! { "$and": [scope.filter(&base)?, doc! { "_id": { "$exists": false } }] })
    } else {
        None
    };
    let sort = selection.sort.as_ref().map(|sort| parse_sort(sort, query)).transpose()?;
    if let Some(sort) = &sort
        && !denied_paths(scope.readable(), &sort.paths).is_empty()
    {
        return fail("The sort may not reference unreadable fields");
    }
    let sort = sort.map(|sort| to_bson(&sort.sort)).transpose()?;
    let fields = selection.fields.as_ref().map(|fields| parse_projection(fields, query)).transpose()?;
    let fields = fields
        .map(|fields| {
            if fields.include_id && fields.projection.len() == 1 && fields.projection.contains_key("_id") {
                inclusion(Vec::new(), true)
            } else {
                compile_projection(&Value::Document(fields.projection))
            }
        })
        .transpose()?;
    let update = change(query, &scope, request)?;
    let multi = request.op() == WriteOp::UpdateMany;
    if multi
        && (!matches!(update, Change::Update(_)) || selection.before || selection.after || sort.is_some())
    {
        return fail("A multi document update requires operators and cannot select or return one document");
    }
    let check = scope.engine.check(&scope.name, Operation::Update, &scope.ctx);
    if !multi
        && !selection.upsert
        && !selection.before
        && !selection.after
        && selection.sort.is_none()
        && selection.fields.is_none()
        && let Some(id) = point_id(filter)
        && (!preserve_id || matches!(id, Value::ObjectId(_)))
        && !update.uses_matched_array_element()
    {
        let filter = scope.filter(&target)?;
        let id = id.clone();
        let step = match update {
            Change::Delete => Step::DeleteById { id, filter, visible: target, conditional: false },
            Change::Update(update) => Step::UpdateById {
                id,
                filter,
                visible: target,
                conditional: false,
                update,
                check: Some(check),
            },
            Change::Replace(replacement) => Step::Replace {
                id,
                filter,
                visible: target,
                conditional: false,
                replacement,
                update_check: check.clone(),
                insert_check: None,
                prechecked: None,
                check_of_replace: Some(check),
            },
        };
        return Ok(Plan { scope, step, fast: false });
    }
    Ok(Plan {
        scope,
        step: Step::Selected(Box::new(Selected {
            target,
            multi,
            insert_filter,
            sort,
            update,
            before: selection.before,
            after: selection.after,
            fields,
            check,
            limits: *query,
        })),
        fast: false,
    })
}

fn point_id(filter: &Value) -> Option<&Value> {
    let Value::Document(filter) = filter else { return None };
    if filter.len() != 1 {
        return None;
    }
    let id = match filter.get("_id")? {
        Value::Document(condition) if condition.len() == 1 && condition.contains_key("$eq") => {
            condition.get("$eq")?
        }
        id => id,
    };
    if validate_id(Some(id)).is_err() || matches!(id, Value::Undefined) {
        return None;
    }
    Some(id)
}

impl Change {
    // The authorized filter must not supply the array match for a positional update.
    fn uses_matched_array_element(&self) -> bool {
        let Self::Update(update) = self else { return false };
        update
            .values()
            .filter_map(bson::Bson::as_document)
            .any(|fields| fields.keys().any(|path| path.split('.').any(|part| part == "$")))
    }
}

impl Selected {
    pub(super) async fn run(
        &self,
        scope: &Scope,
        session: &mut Session<'_>,
        limits: &WriteLimits,
    ) -> Result<Outcome, DriverError> {
        if self.multi
            && let Change::Update(update) = &self.update
        {
            let outcome =
                run_update_many(scope, session, &self.target, update, &self.check, limits.max_bulk).await?;
            return if outcome.matched == 0 { self.insert(scope, session).await } else { Ok(outcome) };
        }
        let raw = scope.db.collection::<RawDocumentBuf>(&scope.name);
        let mut find = raw
            .find_one(scope.filter(&self.target).map_err(custom)?)
            .projection(doc! { "_id": 1 })
            .max_time(scope.max_time);
        if let Some(sort) = &self.sort {
            find = find.sort(sort.clone());
        }
        let found = find.session(session.reading().ok_or_else(|| custom(internal()))?).await?;
        let Some(found) = found else {
            return self.insert(scope, session).await;
        };
        let id = value_of(&found).map_err(custom)?.remove("_id").ok_or_else(|| custom(internal()))?;
        let before = if self.before { scope.read_one(session, &id).await? } else { None };
        let key = bson::Bson::try_from(
            found.get("_id").map_err(|_| custom(internal()))?.ok_or_else(|| custom(internal()))?,
        )
        .map_err(|_| custom(internal()))?;
        let filter = doc! { "_id": { "$eq": key } };
        let coll = scope.coll();
        let inner = session.reading().ok_or_else(|| custom(internal()))?;
        let modified = match &self.update {
            Change::Delete => {
                let result = coll.delete_one(filter).session(inner).await?;
                return Ok(Outcome {
                    matched: result.deleted_count,
                    deleted: result.deleted_count,
                    documents: self.image(before),
                    changed_ids: vec![id],
                    ..Outcome::default()
                });
            }
            Change::Update(update) => {
                coll.update_one(filter, update.clone()).session(inner).await?.modified_count
            }
            Change::Replace(doc) => {
                coll.replace_one(filter, doc.clone()).session(inner).await?.modified_count
            }
        };
        let check = (modified > 0).then_some(&self.check);
        let after =
            scope.verify(session, std::slice::from_ref(&id), check, Operation::Update, self.after).await?;
        Ok(Outcome {
            matched: 1,
            modified,
            documents: self.image(before.or_else(|| after.and_then(|mut docs| docs.pop().flatten()))),
            changed_ids: if modified == 0 { Vec::new() } else { vec![id] },
            ..Outcome::default()
        })
    }

    async fn insert(&self, scope: &Scope, session: &mut Session<'_>) -> Result<Outcome, DriverError> {
        let Some(filter) = &self.insert_filter else { return Ok(Outcome::default()) };
        let check = scope.engine.check(&scope.name, Operation::Insert, &scope.ctx);
        if check == Compiled::Deny {
            return Err(custom(scope.violation(Operation::Insert)));
        }
        let coll = scope.coll();
        let inner = session.reading().ok_or_else(|| custom(internal()))?;
        let result = match &self.update {
            Change::Update(update) => {
                coll.update_one(filter.clone(), update.clone()).upsert(true).session(&mut *inner).await?
            }
            Change::Replace(doc) => {
                coll.replace_one(filter.clone(), doc.clone()).upsert(true).session(&mut *inner).await?
            }
            Change::Delete => return Err(custom(internal())),
        };
        let id = result.upserted_id.ok_or_else(|| custom(internal()))?;
        let raw = scope.db.collection::<RawDocumentBuf>(&scope.name);
        let inserted = raw
            .find_one(doc! { "_id": { "$eq": id } })
            .max_time(scope.max_time)
            .session(inner)
            .await?
            .ok_or_else(|| custom(internal()))?;
        let inserted = value_of(&inserted).map_err(custom)?;
        validate_stored_document(&Value::Document(inserted.clone()), &self.limits).map_err(custom)?;
        let key = inserted.get("_id");
        validate_id(key).map_err(custom)?;
        let key = key.cloned().ok_or_else(|| custom(internal()))?;
        scope.assert_writable(&scope.writable(Operation::Insert), &leaf_paths(&inserted)).map_err(custom)?;
        let after = scope
            .verify(session, std::slice::from_ref(&key), Some(&check), Operation::Insert, self.after)
            .await?;
        Ok(Outcome::upserted(key, self.image(after.and_then(|mut docs| docs.pop().flatten()))))
    }

    fn image(&self, document: Option<canopy_protocol::Document>) -> Option<Vec<super::scope::Returned>> {
        if !self.before && !self.after {
            return None;
        }
        let document = match (document, &self.fields) {
            (Some(document), Some(fields)) => Some(fields.apply(DocRef::Owned(&document))),
            (document, _) => document,
        };
        Some(vec![document])
    }
}
