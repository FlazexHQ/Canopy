//! The transactional write path of the Data API and realtime mutations. A write runs in a multi document
//! transaction: its target is `filter AND USING(op) AND USING(read)`, MongoDB applies the update, and MongoDB
//! itself evaluates `CHECK(op)` on the resulting documents before the commit, so update semantics are never
//! reimplemented here. The idempotency record of a mutation ID is written in the same transaction.
//!
//! A single document write without a mutation ID whose `check` cannot fail (and every single document delete)
//! runs as one atomic operation with majority write concern and no transaction. It mirrors the TypeScript
//! `WritePath` of `@canopy/rest`, whose responses, documents and idempotency records it reproduces.

mod plan;
mod request;
mod scope;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use canopy_engine::Ct;
use canopy_mongo::mongodb::bson::{self, doc};
use canopy_mongo::mongodb::error::PartialBulkWriteResult;
use canopy_mongo::mongodb::error::{
    ErrorKind, TRANSIENT_TRANSACTION_ERROR, UNKNOWN_TRANSACTION_COMMIT_RESULT, WriteFailure,
};
use canopy_mongo::mongodb::options::{
    InsertOneModel, ReadConcern, ReadPreference, SelectionCriteria, WriteConcern, WriteModel,
};
use canopy_mongo::mongodb::{Client, ClientSession, Database, Namespace};
use canopy_mongo::to_bson;
use canopy_policy::{Compiled, Operation, PolicyEngine, RequestContext, Role};
use canopy_protocol::ejson::canonical_string;
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};
use canopy_query::{DEFAULT_LIMITS, QueryLimits};
use ring::digest::{SHA256, digest};

use crate::caller::Caller;
use crate::errors::{from_driver_error, internal};
use crate::find::validate_collection_name;
use crate::policies::Policies;
use crate::writes::plan::{Grouped, Plan, plan_write};
use crate::writes::scope::{DriverError, Scope, Session, carried, custom, value_of};

pub use plan::{Outcome, WriteLimits};
pub use request::{IdType, WriteOp, WriteRequest, leaf_paths, merge_patch_to_update, parse_id, validate_id};

const MUTATION_ID_MIN: usize = 8;
const MUTATION_ID_MAX: usize = 128;
const DUPLICATE_KEY: i32 = 11000;
const DOCUMENT_VALIDATION_FAILURE: i32 = 121;
const INDEX_OPTIONS_CONFLICT: [i32; 2] = [85, 86];

/// Options of one write.
#[derive(Debug, Clone, Default)]
pub struct WriteOptions {
    /// The idempotency key (the client's mutation ID). A repeated key returns the stored result.
    pub mutation_id: Option<String>,
    /// Whether the result carries the written documents. Without them no document is read back.
    pub skip_documents: bool,
}

/// The outcome of a committed (or replayed) write.
#[derive(Debug, Clone, PartialEq)]
pub struct WriteResult {
    /// What the write did.
    pub outcome: Outcome,
    /// The cluster time of the commit, or for a replay a cluster time after it.
    pub ct: Ct,
    /// Whether the outcome is the stored one of an earlier write with the same mutation ID.
    pub replayed: bool,
}

/// The outcome of a committed (or replayed) atomic batch.
#[derive(Debug, Clone, PartialEq)]
pub struct BatchResult {
    /// What each operation did, in order.
    pub outcomes: Vec<Outcome>,
    /// The cluster time of the commit.
    pub ct: Ct,
    /// Whether the outcomes are the stored ones of an earlier batch with the same mutation ID.
    pub replayed: bool,
}

/// One operation of a batch that is not atomic: a write and its own idempotency key.
#[derive(Debug, Clone)]
pub struct BatchItem {
    /// The write.
    pub request: WriteRequest,
    /// Its idempotency key.
    pub mutation_id: Option<String>,
}

/// A committed write, as reported to the write observer: what realtime correlates its echoes with.
#[derive(Debug, Clone, PartialEq)]
pub struct WriteEvent {
    /// The subject of the caller.
    pub subject: String,
    /// The roles of the caller, sorted.
    pub roles: Vec<String>,
    /// The collection.
    pub collection: String,
    /// The operation.
    pub op: WriteOp,
    /// The `_id` of every document the write inserted, changed or deleted.
    pub ids: Vec<Value>,
    /// The cluster time of the commit.
    pub ct: Ct,
    /// The mutation ID, when the write had one.
    pub mutation_id: Option<String>,
}

type Observer = Arc<dyn Fn(&WriteEvent) + Send + Sync>;

/// What binds a mutation ID to its request: the collection, the operation and the fingerprint.
struct RecordKey {
    c: String,
    op: String,
    fp: String,
}

/// The transactional write path.
pub struct WritePath {
    client: Client,
    db: Database,
    meta: Database,
    policies: Policies,
    limits: WriteLimits,
    query_limits: QueryLimits,
    ttl_seconds: i64,
    explain_denials: bool,
    observer: Option<Observer>,
    indexes: Arc<AtomicBool>,
    bulk_support: Arc<AtomicU8>,
    collations: Arc<std::sync::Mutex<std::collections::HashMap<String, (Instant, bool)>>>,
}

/// Why a transaction stopped.
enum Stop {
    /// The mutation ID was recorded already.
    Replay,
    Failed(DriverError),
}

impl From<DriverError> for Stop {
    fn from(error: DriverError) -> Stop {
        Stop::Failed(error)
    }
}

impl WritePath {
    /// Creates a write path over the app database, with the idempotency records in `meta_database`.
    pub fn new(
        client: Client,
        database: &str,
        meta_database: &str,
        policies: Policies,
    ) -> Result<WritePath, CanopyError> {
        if database == meta_database {
            return Err(CanopyError::new(
                ErrorCode::ConfigInvalid,
                "The meta database must differ from the app database",
            ));
        }
        Ok(WritePath {
            db: client.database(database),
            meta: client.database(meta_database),
            client,
            policies,
            limits: WriteLimits::default(),
            query_limits: DEFAULT_LIMITS,
            ttl_seconds: 86_400,
            explain_denials: false,
            observer: None,
            indexes: Arc::new(AtomicBool::new(false)),
            bulk_support: Arc::new(AtomicU8::new(0)),
            collations: Arc::default(),
        })
    }

    /// Sets how long idempotency records live (one day by default).
    #[must_use]
    pub fn with_mutation_ttl(mut self, seconds: u64) -> WritePath {
        self.ttl_seconds = i64::try_from(seconds.max(1)).unwrap_or(i64::MAX);
        self
    }

    /// Sets the write limits.
    #[must_use]
    pub fn with_limits(mut self, limits: WriteLimits) -> WritePath {
        self.limits = limits;
        self
    }

    /// Explains refused writes in `details.explain`. It reveals the policy structure, so it is for
    /// development only.
    #[must_use]
    pub fn with_explained_denials(mut self, explain: bool) -> WritePath {
        self.explain_denials = explain;
        self
    }

    /// Reports every committed write (each operation of a batch on its own) after its commit. Replays are not
    /// reported again.
    #[must_use]
    pub fn with_observer(mut self, observer: Arc<dyn Fn(&WriteEvent) + Send + Sync>) -> WritePath {
        self.observer = Some(observer);
        self
    }

    /// The write limits in force.
    pub fn limits(&self) -> &WriteLimits {
        &self.limits
    }

    fn scope(
        &self,
        engine: &Arc<PolicyEngine>,
        ctx: &RequestContext,
        collection: &str,
    ) -> Result<Scope, CanopyError> {
        validate_collection_name(collection)?;
        if !ctx.roles.contains(Role::SERVICE) && !engine.is_exposed(collection) {
            return Err(CanopyError::new(ErrorCode::NotFound, format!("Unknown collection '{collection}'")));
        }
        Ok(Scope::new(
            Arc::clone(engine),
            ctx.clone(),
            self.db.clone(),
            collection,
            Duration::from_millis(self.limits.max_time_ms),
            self.query_limits,
            self.explain_denials,
        ))
    }

    fn plan(
        &self,
        engine: &Arc<PolicyEngine>,
        ctx: &RequestContext,
        request: &WriteRequest,
    ) -> Result<Plan, CanopyError> {
        plan_write(&self.limits, &self.query_limits, self.scope(engine, ctx, request.collection())?, request)
    }

    /// Validates, authorizes and commits one write. Fails with `CANOPY_FORBIDDEN` when no policy grants the
    /// operation, `CANOPY_POLICY_VIOLATION` when a field rule or `check` refuses it, `CANOPY_CONFLICT` when
    /// `where` fails or the mutation ID belongs to another write, and `CANOPY_INVALID_QUERY`,
    /// `CANOPY_BULK_LIMIT`, `CANOPY_DUPLICATE_KEY` or `CANOPY_VALIDATION_FAILED`.
    pub async fn execute(
        &self,
        caller: &Caller,
        request: &WriteRequest,
        options: &WriteOptions,
    ) -> Result<WriteResult, CanopyError> {
        let service = caller.context.roles.contains(Role::SERVICE);
        validate_mutation_id(options.mutation_id.as_deref())?;
        let read = !options.skip_documents;
        let engine = self.policies.current();
        let plan = self.plan(&engine, &caller.context, request)?;
        if options.mutation_id.is_none() && plan.fast {
            let mut session = self
                .client
                .start_session()
                .causal_consistency(true)
                .await
                .map_err(|e| from_driver_error(&e, service))?;
            let mut fast = Session::fast(&mut session);
            let outcome = plan
                .run(&mut fast, read, &self.limits)
                .await
                .map_err(|error| write_error(&error, service))?;
            let ct = match outcome.ct {
                Some(ct) => ct,
                None => operation_time(&session)?,
            };
            self.report(caller, request, &outcome, ct, None);
            return Ok(WriteResult { outcome: Outcome { ct: None, ..outcome }, ct, replayed: false });
        }
        if options.mutation_id.is_none() {
            let mut session = self
                .client
                .start_session()
                .causal_consistency(true)
                .await
                .map_err(|e| from_driver_error(&e, service))?;
            let mut fast = Session::fast(&mut session);
            let direct =
                plan.run_direct(&mut fast, read).await.map_err(|error| write_error(&error, service))?;
            if let Some(outcome) = direct {
                let ct = match outcome.ct {
                    Some(ct) => ct,
                    None => operation_time(&session)?,
                };
                self.report(caller, request, &outcome, ct, None);
                return Ok(WriteResult { outcome: Outcome { ct: None, ..outcome }, ct, replayed: false });
            }
        }
        let key = RecordKey {
            c: request.collection().to_owned(),
            op: request.op().as_str().to_owned(),
            fp: match &options.mutation_id {
                Some(_) => fingerprint(caller, &Value::Document(request.object().clone()))?,
                None => String::new(),
            },
        };
        let (outcomes, ct, replayed) = self
            .transact(caller, &key, std::slice::from_ref(&plan), options.mutation_id.as_deref(), read, false)
            .await?;
        let outcome = outcomes
            .into_iter()
            .next()
            .ok_or_else(|| CanopyError::new(ErrorCode::Internal, "The write has no outcome"))?;
        if !replayed {
            self.report(caller, request, &outcome, ct, options.mutation_id.as_deref());
        }
        let outcome =
            if replayed && read { self.read_back(&engine, caller, request, outcome).await? } else { outcome };
        Ok(WriteResult { outcome: Outcome { ct: None, ..outcome }, ct, replayed })
    }

    /// Commits several writes in one transaction: each sees the effects of the ones before it, and the first
    /// failure aborts all of them. A mutation ID covers the whole batch. Errors name the operation that failed
    /// and carry `details.index`.
    pub async fn execute_batch(
        &self,
        caller: &Caller,
        requests: &[WriteRequest],
        options: &WriteOptions,
    ) -> Result<BatchResult, CanopyError> {
        validate_mutation_id(options.mutation_id.as_deref())?;
        if requests.is_empty() {
            return Err(CanopyError::invalid_query("A batch needs at least one operation"));
        }
        if requests.len() > self.limits.max_batch {
            return Err(CanopyError::new(
                ErrorCode::BulkLimit,
                format!("A batch may not have more than {} operations", self.limits.max_batch),
            ));
        }
        let engine = self.policies.current();
        let read = !options.skip_documents;
        let mut plans = Vec::with_capacity(requests.len());
        for (index, request) in requests.iter().enumerate() {
            plans.push(self.plan(&engine, &caller.context, request).map_err(|error| at_index(error, index))?);
        }
        let key = RecordKey {
            c: String::new(),
            op: "batch".to_owned(),
            fp: match &options.mutation_id {
                Some(_) => fingerprint(
                    caller,
                    &Value::Array(
                        requests.iter().map(|request| Value::Document(request.object().clone())).collect(),
                    ),
                )?,
                None => String::new(),
            },
        };
        let deferred = if read && requests.len() > 1 { self.deferrable(requests).await } else { Vec::new() };
        let (outcomes, ct, replayed) = self
            .transact_deferred(caller, &key, &plans, options.mutation_id.as_deref(), read, true, &deferred)
            .await?;
        if !replayed {
            for (request, outcome) in requests.iter().zip(&outcomes) {
                self.report(caller, request, outcome, ct, options.mutation_id.as_deref());
            }
        }
        let mut results = Vec::with_capacity(outcomes.len());
        for (request, outcome) in requests.iter().zip(outcomes) {
            let outcome = if replayed && read && !request.op().is_bulk() {
                self.read_back(&engine, caller, request, outcome).await?
            } else {
                outcome
            };
            results.push(Outcome { ct: None, ..outcome });
        }
        Ok(BatchResult { outcomes: results, ct, replayed })
    }

    /// Runs the operations of a batch that is not atomic one after the other, each as if it were sent alone:
    /// its own mutation ID, its own transaction or fast path, and its own result or error, which never stops
    /// the operations after it.
    ///
    /// Consecutive single document writes are sent together as one ordered client `bulkWrite` instead (MongoDB
    /// 8.0 or later), with their checks evaluated in one aggregation and their read backs in one `find` per
    /// collection around it. Only writes that cannot be told apart from running alone join a group: no mutation
    /// ID, no transaction, pairwise different documents. A write MongoDB refuses is sent again alone, so its error
    /// is the one it always had, and the writes after it form the next group. The writes of a group share the
    /// cluster time of their command, which is at or after the time of each of them.
    pub async fn execute_each(
        &self,
        caller: &Caller,
        items: &[BatchItem],
        skip_documents: bool,
    ) -> Vec<Result<WriteResult, CanopyError>> {
        let engine = self.policies.current();
        let mut results: Vec<Option<Result<WriteResult, CanopyError>>> = items.iter().map(|_| None).collect();
        let grouping = self.client_bulk_write().await;
        let mut next = 0;
        while next < items.len() {
            let members =
                if grouping { self.form_group(caller, &engine, items, next).await } else { Vec::new() };
            if members.len() < 2 {
                results[next] = Some(self.execute_item(caller, &items[next], skip_documents).await);
                next += 1;
                continue;
            }
            next += self.execute_group(caller, items, members, skip_documents, &mut results).await;
        }
        results
            .into_iter()
            .map(|result| {
                result.unwrap_or_else(|| {
                    Err(CanopyError::new(ErrorCode::Internal, "The batch operation has no outcome"))
                })
            })
            .collect()
    }

    async fn execute_item(
        &self,
        caller: &Caller,
        item: &BatchItem,
        skip_documents: bool,
    ) -> Result<WriteResult, CanopyError> {
        let options = WriteOptions { mutation_id: item.mutation_id.clone(), skip_documents };
        self.execute(caller, &item.request, &options).await
    }

    /// Whether the deployment runs MongoDB 8.0 or later (wire version 25), whose `bulkWrite` command writes to
    /// several namespaces. Read once from `hello`; a failed read means no, and is read again next time.
    async fn client_bulk_write(&self) -> bool {
        match self.bulk_support.load(Ordering::Acquire) {
            1 => return true,
            2 => return false,
            _ => {}
        }
        let Ok(hello) = self.client.database("admin").run_command(doc! { "hello": 1 }).await else {
            return false;
        };
        let wire = hello
            .get_i32("maxWireVersion")
            .map(i64::from)
            .or_else(|_| hello.get_i64("maxWireVersion"))
            .unwrap_or(0);
        let supported = wire >= BULK_WRITE_WIRE_VERSION;
        self.bulk_support.store(if supported { 1 } else { 2 }, Ordering::Release);
        supported
    }

    /// The operations from `start` that can be sent together: consecutive, planned without error, without a
    /// mutation ID, groupable, and on documents no earlier one of the group may touch.
    async fn form_group(
        &self,
        caller: &Caller,
        engine: &Arc<PolicyEngine>,
        items: &[BatchItem],
        start: usize,
    ) -> Vec<Member> {
        let mut members = Vec::new();
        let mut taken = GroupIds::default();
        let mut bytes = 0;
        for (index, item) in items.iter().enumerate().skip(start) {
            if item.mutation_id.is_some() {
                break;
            }
            let Ok(plan) = self.plan(engine, &caller.context, &item.request) else { break };
            let Some(group) = plan.grouped() else { break };
            let size = group.precheck.as_ref().map_or(0, |(_, doc)| {
                canopy_protocol::bson::encode_document(doc).map_or(usize::MAX, |bytes| bytes.len())
            });
            if bytes + size > GROUP_PRECHECK_BYTES {
                break;
            }
            let collated = if group.ids.iter().any(|id| matches!(id, Value::String(_))) {
                self.collated(item.request.collection()).await
            } else {
                false
            };
            if !taken.admit(item.request.collection(), &group.ids, collated) {
                break;
            }
            bytes += size;
            members.push(Member { index, plan, group });
        }
        members
    }

    /// Runs a group and fills the result of each member. Returns how many operations are settled: all of them,
    /// or up to the write MongoDB refused, after which the operations have not been tried yet.
    async fn execute_group(
        &self,
        caller: &Caller,
        items: &[BatchItem],
        members: Vec<Member>,
        skip_documents: bool,
        results: &mut [Option<Result<WriteResult, CanopyError>>],
    ) -> usize {
        let service = caller.context.roles.contains(Role::SERVICE);
        let read = !skip_documents;
        let first = members[0].index;
        let mut refused: std::collections::HashMap<usize, CanopyError> = std::collections::HashMap::new();
        let mut declined: std::collections::HashSet<usize> = std::collections::HashSet::new();
        let mut checked: std::collections::HashMap<usize, Option<Vec<scope::Returned>>> =
            std::collections::HashMap::new();
        let mut units: Vec<(String, Operation, Vec<usize>)> = Vec::new();
        for (position, member) in members.iter().enumerate() {
            let Some((op, _)) = &member.group.precheck else { continue };
            let name = member.plan.scope.name.clone();
            match units.iter_mut().find(|(unit, unit_op, _)| *unit == name && unit_op == op) {
                Some((_, _, positions)) => positions.push(position),
                None => units.push((name, *op, vec![position])),
            }
        }
        for (_, op, positions) in &units {
            let lead = &members[positions[0]];
            let Some(check) = lead.plan.precheck_check() else { continue };
            let docs: Vec<Document> = positions
                .iter()
                .filter_map(|&position| members[position].group.precheck.as_ref().map(|(_, doc)| doc.clone()))
                .collect();
            let outcome = if *check == Compiled::Deny {
                Ok((
                    docs.iter().map(|doc| scope::key(doc.get("_id").unwrap_or(&Value::Null))).collect(),
                    Vec::new(),
                ))
            } else {
                lead.plan.scope.check_before(&docs, check, read).await
            };
            let (failed, found) = match outcome {
                Ok(outcome) => outcome,
                Err(error)
                    if matches!(error.kind.as_ref(), ErrorKind::Command(_)) && carried(&error).is_none() =>
                {
                    for member in &members {
                        results[member.index] =
                            Some(self.execute_item(caller, &items[member.index], skip_documents).await);
                    }
                    return members.len();
                }
                Err(error) => {
                    let failure = write_error(&error, service);
                    for member in &members {
                        results[member.index] = Some(Err(failure.clone()));
                    }
                    return members.len();
                }
            };
            for &position in positions {
                let member = &members[position];
                let Some((_, doc)) = &member.group.precheck else { continue };
                let id = scope::key(doc.get("_id").unwrap_or(&Value::Null));
                if failed.contains(&id) {
                    if *op == Operation::Insert {
                        refused.insert(member.index, member.plan.scope.violation(Operation::Insert));
                    } else {
                        declined.insert(member.index);
                    }
                } else {
                    let documents = member.plan.scope.readable_of(std::slice::from_ref(doc), &found, read);
                    checked.insert(member.index, documents.unwrap_or(None));
                }
            }
        }
        let cut = members.iter().position(|member| declined.contains(&member.index));
        let head = &members[..cut.unwrap_or(members.len())];
        let live: Vec<&Member> = head.iter().filter(|member| !refused.contains_key(&member.index)).collect();
        let mut settled = head.len();
        let mut session = match self.client.start_session().causal_consistency(true).await {
            Ok(session) => session,
            Err(error) => {
                let failure = from_driver_error(&error, service);
                for member in &members {
                    results[member.index] = Some(Err(failure.clone()));
                }
                return members.len();
            }
        };
        let mut verbose = None;
        let mut failure = None;
        if !live.is_empty() {
            let models: Vec<WriteModel> = live.iter().map(|member| member.group.model.clone()).collect();
            match self
                .client
                .bulk_write(models)
                .ordered(true)
                .write_concern(WriteConcern::majority())
                .verbose_results()
                .session(&mut session)
                .await
            {
                Ok(result) => verbose = Some(result),
                Err(error) => failure = Some(error),
            }
        }
        if failure.as_ref().is_some_and(unsupported_bulk_write) {
            self.bulk_support.store(2, Ordering::Release);
            for member in &members {
                results[member.index] =
                    Some(self.execute_item(caller, &items[member.index], skip_documents).await);
            }
            return members.len();
        }
        let ct = session.operation_time().map(|time| Ct::from_parts(time.time, time.increment));
        let bulk = failure.as_ref().and_then(|error| match error.kind.as_ref() {
            ErrorKind::BulkWrite(bulk) => Some(bulk),
            _ => None,
        });
        let partial = verbose.as_ref().or_else(|| match bulk.and_then(|bulk| bulk.partial_result.as_ref()) {
            Some(PartialBulkWriteResult::Verbose(result)) => Some(result),
            _ => None,
        });
        let failed_at = bulk.and_then(|bulk| bulk.write_errors.keys().min().copied());
        let concern = bulk
            .filter(|bulk| !bulk.write_concern_errors.is_empty())
            .map(|_| failure.as_ref().map_or_else(internal, |error| from_driver_error(error, service)));
        let mut finishing = Session::none();
        finishing.defer = true;
        let mut outcomes: Vec<(usize, Outcome)> = Vec::new();
        let mut queued: Vec<(usize, Value)> = Vec::new();
        for (position, member) in live.iter().enumerate() {
            if failed_at.is_some_and(|at| position >= at) {
                break;
            }
            let written = partial.and_then(|result| match &member.group.model {
                WriteModel::InsertOne(_) => result.insert_results.contains_key(&position).then_some((0, 0)),
                _ => result
                    .update_results
                    .get(&position)
                    .map(|update| (update.matched_count, update.modified_count)),
            });
            if let (Some(_), Some(concern)) = (written, &concern) {
                results[member.index] = Some(Err(concern.clone()));
                continue;
            }
            let (Some((matched, modified)), Some(_)) = (written, ct) else {
                results[member.index] = Some(Err(match &failure {
                    None => CanopyError::new(ErrorCode::Internal, "The bulk write has no result"),
                    Some(error) => from_driver_error(error, service),
                }));
                continue;
            };
            let before = finishing.queued.len();
            match member
                .plan
                .finish_grouped(&mut finishing, matched, modified, checked.remove(&member.index), read)
                .await
            {
                Ok(outcome) => {
                    queued.extend(finishing.queued[before..].iter().map(|id| (member.index, id.clone())));
                    outcomes.push((member.index, outcome));
                }
                Err(error) => results[member.index] = Some(Err(write_error(&error, service))),
            }
        }
        let mut names: Vec<&str> = Vec::new();
        for (index, _) in &queued {
            let name = members
                .iter()
                .find(|member| member.index == *index)
                .map_or("", |member| member.plan.scope.name.as_str());
            if !names.contains(&name) {
                names.push(name);
            }
        }
        for name in names {
            let waiting: Vec<&(usize, Value)> = queued
                .iter()
                .filter(|(index, _)| {
                    members.iter().any(|member| member.index == *index && member.plan.scope.name == name)
                })
                .collect();
            let Some(scope) =
                members.iter().find(|member| member.index == waiting[0].0).map(|member| &member.plan.scope)
            else {
                continue;
            };
            let ids: Vec<Value> = waiting.iter().map(|(_, id)| id.clone()).collect();
            match scope.read_many(&mut Session::none(), &ids).await {
                Ok(documents) => {
                    for ((index, _), document) in waiting.iter().zip(documents) {
                        if let Some((_, outcome)) = outcomes.iter_mut().find(|(member, _)| member == index) {
                            outcome.documents = Some(vec![document]);
                        }
                    }
                }
                Err(error) => {
                    let failure = write_error(&error, service);
                    for (index, _) in &waiting {
                        outcomes.retain(|(member, _)| member != index);
                        results[*index] = Some(Err(failure.clone()));
                    }
                }
            }
        }
        if let Some(ct) = ct {
            for (index, outcome) in outcomes {
                self.report(caller, &items[index].request, &outcome, ct, None);
                results[index] = Some(Ok(WriteResult { outcome, ct, replayed: false }));
            }
        }
        let alone = failed_at
            .and_then(|at| live.get(at).map(|member| member.index))
            .or_else(|| cut.map(|cut| members[cut].index));
        if let Some(index) = alone {
            results[index] = Some(self.execute_item(caller, &items[index], skip_documents).await);
            settled = index - first + 1;
        }
        for member in &members {
            if let Some(error) = refused.remove(&member.index)
                && member.index - first < settled
            {
                results[member.index] = Some(Err(error));
            }
        }
        settled
    }

    /// Creates the TTL index of the idempotency records once.
    async fn ensure_indexes(&self, service: bool) -> Result<(), CanopyError> {
        if self.indexes.load(Ordering::Acquire) {
            return Ok(());
        }
        let mutations = self.meta.collection::<bson::Document>("mutations");
        let index = canopy_mongo::mongodb::IndexModel::builder()
            .keys(doc! { "at": 1 })
            .options(
                canopy_mongo::mongodb::options::IndexOptions::builder()
                    .name("ttl_at".to_owned())
                    .expire_after(Duration::from_secs(u64::try_from(self.ttl_seconds).unwrap_or(86_400)))
                    .build(),
            )
            .build();
        match mutations.create_index(index).await {
            Ok(_) => {}
            Err(error) => {
                let conflict = matches!(error.kind.as_ref(), ErrorKind::Command(command) if INDEX_OPTIONS_CONFLICT.contains(&command.code));
                if !conflict {
                    return Err(from_driver_error(&error, service));
                }
                self.meta
                    .run_command(doc! { "collMod": "mutations", "index": { "name": "ttl_at", "expireAfterSeconds": self.ttl_seconds } })
                    .await
                    .map_err(|error| from_driver_error(&error, service))?;
            }
        }
        self.indexes.store(true, Ordering::Release);
        Ok(())
    }

    /// Whether the collection has a default collation, which makes two different strings one `_id`. Read at most
    /// once a minute per collection; a failed lookup counts as a collation, so nothing is deferred on a guess.
    async fn collated(&self, name: &str) -> bool {
        if let Ok(known) = self.collations.lock()
            && let Some((at, collated)) = known.get(name)
            && at.elapsed() < Duration::from_secs(60)
        {
            return *collated;
        }
        let collated = match self.db.list_collections().filter(doc! { "name": name }).await {
            Ok(mut cursor) => {
                let mut found = false;
                while let Some(Ok(spec)) = futures_util::StreamExt::next(&mut cursor).await {
                    found |= spec.options.collation.is_some();
                }
                found
            }
            Err(_) => return true,
        };
        if let Ok(mut known) = self.collations.lock() {
            known.insert(name.to_owned(), (Instant::now(), collated));
        }
        collated
    }

    /// Which operations of an atomic batch may have their read back queued until the end of the transaction:
    /// the ones whose documents no later operation touches, so the document read at the end is the one the
    /// operation left. A later operation that names documents by a filter, or by an `_id` that may be the same
    /// document, rules it out; so does an `_id` without a key, and a string `_id` in a collection with a collation.
    async fn deferrable(&self, requests: &[WriteRequest]) -> Vec<bool> {
        let mut out = Vec::with_capacity(requests.len());
        for (index, request) in requests.iter().enumerate() {
            out.push(self.is_deferrable(index, requests, request).await);
        }
        out
    }

    async fn is_deferrable(&self, index: usize, requests: &[WriteRequest], request: &WriteRequest) -> bool {
        let Some(own) = ids_of(request) else { return false };
        if own.iter().any(|id| matches!(id, Value::String(_))) && self.collated(request.collection()).await {
            return false;
        }
        let mut mine = std::collections::HashSet::new();
        for id in &own {
            let Some(key) = scope::id_key(id) else { return false };
            mine.insert(key);
        }
        for later in &requests[index + 1..] {
            if later.collection() != request.collection() {
                continue;
            }
            let Some(theirs) = ids_of(later) else { return false };
            for other in &theirs {
                match scope::id_key(other) {
                    Some(key) if !mine.contains(&key) => {}
                    _ => return false,
                }
            }
        }
        true
    }

    async fn transact(
        &self,
        caller: &Caller,
        key: &RecordKey,
        plans: &[Plan],
        mutation_id: Option<&str>,
        read: bool,
        batch: bool,
    ) -> Result<(Vec<Outcome>, Ct, bool), CanopyError> {
        self.transact_deferred(caller, key, plans, mutation_id, read, batch, &[]).await
    }

    #[allow(clippy::too_many_arguments)]
    async fn transact_deferred(
        &self,
        caller: &Caller,
        key: &RecordKey,
        plans: &[Plan],
        mutation_id: Option<&str>,
        read: bool,
        batch: bool,
        deferred: &[bool],
    ) -> Result<(Vec<Outcome>, Ct, bool), CanopyError> {
        let service = caller.context.roles.contains(Role::SERVICE);
        self.ensure_indexes(service).await?;
        let combined = match (plans, mutation_id) {
            ([plan], Some(id)) => match plan.with_idempotency() {
                Some(write) if self.client_bulk_write().await => Some((plan, id, write)),
                _ => None,
            },
            _ => None,
        };
        let deadline = Instant::now() + Duration::from_millis(self.limits.transaction_timeout_ms);
        let mut session =
            self.client.start_session().await.map_err(|error| from_driver_error(&error, service))?;
        let mut failed_at: Option<usize> = None;
        let result = loop {
            if Instant::now() > deadline {
                break Err(Stop::Failed(custom(CanopyError::new(
                    ErrorCode::Timeout,
                    "The write could not commit in time",
                ))));
            }
            let started = session
                .start_transaction()
                .read_concern(ReadConcern::snapshot())
                .write_concern(WriteConcern::majority())
                .selection_criteria(SelectionCriteria::ReadPreference(ReadPreference::Primary))
                .max_commit_time(Duration::from_millis(self.limits.max_time_ms))
                .await;
            if let Err(error) = started {
                break Err(Stop::Failed(error));
            }
            let attempt = if let Some((plan, id, write)) = &combined {
                failed_at = Some(0);
                self.run_with_idempotency(&mut session, caller, key, plan, id, write, read).await.map(
                    |outcome| {
                        failed_at = None;
                        vec![outcome]
                    },
                )
            } else {
                self.attempt(&mut session, caller, key, plans, mutation_id, read, deferred, &mut failed_at)
                    .await
            };
            match attempt {
                Ok(outcomes) => match commit(&mut session, deadline).await {
                    Ok(()) => break Ok(outcomes),
                    Err(error) if error.contains_label(TRANSIENT_TRANSACTION_ERROR) => {}
                    Err(error) => break Err(Stop::Failed(error)),
                },
                Err(stop) => {
                    let _ = session.abort_transaction().await;
                    match stop {
                        Stop::Failed(error)
                            if error.contains_label(TRANSIENT_TRANSACTION_ERROR)
                                && carried(&error).is_none() => {}
                        other => break Err(other),
                    }
                }
            }
        };
        match result {
            Ok(outcomes) => {
                let ct = operation_time(&session)?;
                Ok((outcomes, ct, false))
            }
            Err(stop) => {
                if let Some(id) = mutation_id {
                    if let Some((outcomes, ct)) = self.replay(id, caller, key).await? {
                        return Ok((outcomes, ct, true));
                    }
                    if matches!(stop, Stop::Replay) {
                        return Err(CanopyError::new(
                            ErrorCode::Unavailable,
                            "The mutation is being retried; send it again",
                        ));
                    }
                }
                let error = match stop {
                    Stop::Replay => internal(),
                    Stop::Failed(error) => write_error(&error, service),
                };
                Err(match failed_at {
                    Some(index) if batch => at_index(error, index),
                    _ => error,
                })
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_with_idempotency(
        &self,
        session: &mut ClientSession,
        caller: &Caller,
        key: &RecordKey,
        plan: &Plan,
        id: &str,
        (model, expected): &(WriteModel, Outcome),
        read: bool,
    ) -> Result<Outcome, Stop> {
        let mutations = self.meta.collection::<bson::Document>("mutations");
        let idempotency = InsertOneModel::builder()
            .namespace(Namespace { db: self.meta.name().to_owned(), coll: mutations.name().to_owned() })
            .document(record_of(id, caller, key, std::slice::from_ref(expected))?)
            .build();
        let written = self
            .client
            .bulk_write([model.clone(), idempotency.into()])
            .ordered(true)
            .verbose_results()
            .session(&mut *session)
            .await
            .map_err(|error| match error.kind.as_ref() {
                ErrorKind::BulkWrite(bulk)
                    if bulk.write_errors.get(&1).is_some_and(|write| write.code == DUPLICATE_KEY) =>
                {
                    Stop::Replay
                }
                _ => Stop::Failed(error),
            })?;
        let outcome =
            plan.finish_with_idempotency(&mut Session::transaction(session), &written, read).await?;
        let actual = stored_outcome(&outcome);
        let canonical = |value| canonical_string(value).map_err(custom);
        if canonical(&actual)? != canonical(&stored_outcome(expected))? {
            let mut fields = Document::new();
            if key.op == "batch" {
                fields.insert("results", Value::Array(vec![actual]));
            } else {
                fields.insert("result", actual);
            }
            let set = to_bson(&fields).map_err(custom)?;
            mutations.update_one(doc! { "_id": id }, doc! { "$set": set }).session(session).await?;
        }
        Ok(outcome)
    }

    #[allow(clippy::too_many_arguments)]
    async fn attempt(
        &self,
        session: &mut ClientSession,
        caller: &Caller,
        key: &RecordKey,
        plans: &[Plan],
        mutation_id: Option<&str>,
        read: bool,
        deferred: &[bool],
        failed_at: &mut Option<usize>,
    ) -> Result<Vec<Outcome>, Stop> {
        let mut outcomes = Vec::with_capacity(plans.len());
        let mut queued: Vec<(usize, Value)> = Vec::new();
        for (index, plan) in plans.iter().enumerate() {
            *failed_at = Some(index);
            let mut transaction = Session::transaction(session);
            transaction.defer = deferred.get(index).copied().unwrap_or(false);
            outcomes.push(plan.run(&mut transaction, read, &self.limits).await?);
            queued.extend(transaction.queued.drain(..).map(|id| (index, id)));
        }
        *failed_at = None;
        let mut collections: Vec<&str> = Vec::new();
        for (index, _) in &queued {
            let name = plans[*index].scope.name.as_str();
            if !collections.contains(&name) {
                collections.push(name);
            }
        }
        for name in collections {
            let members: Vec<&(usize, Value)> =
                queued.iter().filter(|(index, _)| plans[*index].scope.name == name).collect();
            let scope = &plans[members[0].0].scope;
            let ids: Vec<Value> = members.iter().map(|(_, id)| id.clone()).collect();
            let documents = scope.read_many(&mut Session::transaction(session), &ids).await?;
            for ((index, _), document) in members.iter().zip(documents) {
                outcomes[*index].documents = Some(vec![document]);
            }
        }
        if let Some(id) = mutation_id {
            let record = record_of(id, caller, key, &outcomes)?;
            let inserted = self
                .meta
                .collection::<bson::Document>("mutations")
                .insert_one(record)
                .session(&mut *session)
                .await;
            if let Err(error) = inserted {
                if duplicate_key(&error) {
                    return Err(Stop::Replay);
                }
                return Err(Stop::Failed(error));
            }
        }
        Ok(outcomes)
    }

    /// The stored outcomes of a committed mutation, or `None` when there is none.
    async fn replay(
        &self,
        id: &str,
        caller: &Caller,
        key: &RecordKey,
    ) -> Result<Option<(Vec<Outcome>, Ct)>, CanopyError> {
        let service = caller.context.roles.contains(Role::SERVICE);
        let driver = |error: DriverError| from_driver_error(&error, service);
        let mut session = self.client.start_session().causal_consistency(true).await.map_err(driver)?;
        let found = self
            .meta
            .collection::<bson::RawDocumentBuf>("mutations")
            .find_one(doc! { "_id": id })
            .read_concern(ReadConcern::majority())
            .session(&mut session)
            .await
            .map_err(driver)?;
        let Some(found) = found else { return Ok(None) };
        let record = value_of(&found)?;
        let text = |name: &str| record.get(name).and_then(Value::as_str).map(str::to_owned);
        if text("sub").as_deref() != Some(caller.subject.as_str()) {
            return Err(CanopyError::named(
                ErrorCode::Conflict,
                "ConflictError",
                "The mutation ID was used by another caller",
            ));
        }
        let fp = text("fp");
        if text("c").as_deref() != Some(key.c.as_str())
            || text("op").as_deref() != Some(key.op.as_str())
            || fp.is_some_and(|fp| fp != key.fp)
        {
            return Err(CanopyError::named(
                ErrorCode::Conflict,
                "ConflictError",
                "The mutation ID was used for a different write",
            ));
        }
        let stored = if key.op == "batch" {
            match record.get("results") {
                Some(Value::Array(results)) => Some(results.clone()),
                _ => None,
            }
        } else {
            record.get("result").map(|result| vec![result.clone()])
        };
        let Some(stored) = stored else {
            return Err(CanopyError::new(ErrorCode::Internal, "The idempotency record has no result"));
        };
        let ct = operation_time(&session)?;
        let outcomes = stored.iter().map(outcome_of).collect::<Result<Vec<_>, _>>()?;
        Ok(Some((outcomes, ct)))
    }

    /// The documents of a replayed write, read again because records keep no documents: the current readable
    /// version of each written document, `None` where it is gone or unreadable. A replayed delete has no pre
    /// image left to return.
    async fn read_back(
        &self,
        engine: &Arc<PolicyEngine>,
        caller: &Caller,
        request: &WriteRequest,
        outcome: Outcome,
    ) -> Result<Outcome, CanopyError> {
        if outcome.documents.is_some() {
            return Ok(outcome);
        }
        let ids = match request.op() {
            WriteOp::Insert | WriteOp::InsertMany => outcome.inserted_ids.clone(),
            WriteOp::Update | WriteOp::Replace => {
                if outcome.matched > 0 || outcome.upserted_id.is_some() {
                    vec![request.get("id").cloned().unwrap_or(Value::Null)]
                } else {
                    Vec::new()
                }
            }
            WriteOp::Delete => {
                return Ok(if outcome.deleted > 0 {
                    Outcome { documents: Some(vec![None]), ..outcome }
                } else {
                    outcome
                });
            }
            _ => return Ok(outcome),
        };
        if ids.is_empty() {
            return Ok(outcome);
        }
        let scope = self.scope(engine, &caller.context, request.collection())?;
        let documents = scope
            .verify(&mut Session::none(), &ids, None::<&Compiled>, Operation::Update, true)
            .await
            .map_err(|error| write_error(&error, scope.service))?;
        Ok(match documents {
            Some(documents) => Outcome { documents: Some(documents), ..outcome },
            None => outcome,
        })
    }

    fn report(
        &self,
        caller: &Caller,
        request: &WriteRequest,
        outcome: &Outcome,
        ct: Ct,
        mutation_id: Option<&str>,
    ) {
        let Some(observer) = &self.observer else { return };
        if outcome.changed_ids.is_empty() {
            return;
        }
        observer(&WriteEvent {
            subject: caller.subject.clone(),
            roles: caller.context.roles.sorted(),
            collection: request.collection().to_owned(),
            op: request.op(),
            ids: outcome.changed_ids.clone(),
            ct,
            mutation_id: mutation_id.map(str::to_owned),
        });
    }
}

async fn commit(session: &mut ClientSession, deadline: Instant) -> Result<(), DriverError> {
    loop {
        match session.commit_transaction().await {
            Ok(()) => return Ok(()),
            Err(error)
                if error.contains_label(UNKNOWN_TRANSACTION_COMMIT_RESULT) && Instant::now() < deadline => {}
            Err(error) => return Err(error),
        }
    }
}

fn operation_time(session: &ClientSession) -> Result<Ct, CanopyError> {
    let time = session
        .operation_time()
        .ok_or_else(|| CanopyError::new(ErrorCode::Internal, "The commit has no cluster time"))?;
    Ok(Ct::from_parts(time.time, time.increment))
}

/// The wire version of MongoDB 8.0, the first with a `bulkWrite` command across namespaces.
const BULK_WRITE_WIRE_VERSION: i64 = 25;

/// The most document bytes a group of writes checks in one `$documents` aggregation.
const GROUP_PRECHECK_BYTES: usize = 4 * 1024 * 1024;

/// The server errors that say the deployment has no client `bulkWrite` command, so nothing was written.
const UNSUPPORTED_COMMAND: [i32; 2] = [59, 115];

fn unsupported_bulk_write(error: &DriverError) -> bool {
    matches!(error.kind.as_ref(), ErrorKind::Command(command) if UNSUPPORTED_COMMAND.contains(&command.code))
}

/// An operation of a group of writes sent together: where it is in the batch, its plan, and how it joins.
struct Member {
    index: usize,
    plan: Plan,
    group: Grouped,
}

/// The `_id`s the writes of a group name, per collection. A write joins only when no write of the group may be
/// on the same document: its read back and precondition run after the whole group. An `_id` without a key,
/// which could be any document, rules out every other write on its collection.
#[derive(Default)]
struct GroupIds {
    taken: std::collections::HashMap<String, (std::collections::HashSet<String>, bool, usize)>,
}

impl GroupIds {
    fn admit(&mut self, collection: &str, ids: &[Value], collated: bool) -> bool {
        let entry = self.taken.entry(collection.to_owned()).or_default();
        if entry.1 {
            return false;
        }
        let keys: Vec<Option<String>> = ids
            .iter()
            .map(|id| if collated && matches!(id, Value::String(_)) { None } else { scope::id_key(id) })
            .collect();
        if keys.iter().any(Option::is_none) {
            if entry.2 > 0 {
                return false;
            }
            entry.1 = true;
        } else {
            let known: Vec<String> = keys.into_iter().flatten().collect();
            if known.iter().any(|key| entry.0.contains(key)) {
                return false;
            }
            entry.0.extend(known);
        }
        entry.2 += 1;
        true
    }
}

/// The `_id`s a request names, `None` when it names documents by a filter. Absent `_id`s are generated.
fn ids_of(request: &WriteRequest) -> Option<Vec<Value>> {
    let id_of = |doc: &Value| match doc {
        Value::Document(doc) => doc.get("_id").filter(|id| !matches!(id, Value::Undefined)).cloned(),
        _ => None,
    };
    match request.op() {
        WriteOp::Insert => Some(request.get("doc").and_then(id_of).into_iter().collect()),
        WriteOp::InsertMany => match request.get("docs") {
            Some(Value::Array(docs)) => Some(docs.iter().filter_map(id_of).collect()),
            _ => None,
        },
        WriteOp::Update | WriteOp::Replace | WriteOp::Delete => {
            Some(vec![request.get("id").cloned().unwrap_or(Value::Undefined)])
        }
        _ => None,
    }
}

/// Refuses a mutation ID that is not 8 to 128 URL safe characters.
fn validate_mutation_id(id: Option<&str>) -> Result<(), CanopyError> {
    let Some(id) = id else { return Ok(()) };
    let valid = (MUTATION_ID_MIN..=MUTATION_ID_MAX).contains(&id.len())
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if valid {
        Ok(())
    } else {
        Err(CanopyError::invalid_query(
            "A mutation ID must be 8 to 128 letters, digits, hyphens or underscores",
        ))
    }
}

/// Binds a mutation ID to one request: the same ID with another body or role set is another write.
fn fingerprint(caller: &Caller, request: &Value) -> Result<String, CanopyError> {
    let mut bound = Document::new();
    bound.insert("request", request.clone());
    bound.insert(
        "roles",
        Value::Array(caller.context.roles.sorted().into_iter().map(Value::String).collect()),
    );
    let text = canonical_string(&Value::Document(bound))?;
    Ok(URL_SAFE_NO_PAD.encode(digest(&SHA256, text.as_bytes())))
}

fn count(value: u64) -> Value {
    i32::try_from(value).map_or_else(|_| Value::from_js_number(value as f64), Value::Int32)
}

/// An outcome as an idempotency record keeps it: without documents, which are read again on replay.
fn stored_outcome(outcome: &Outcome) -> Value {
    let mut out = Document::new();
    out.insert("matched", count(outcome.matched));
    out.insert("modified", count(outcome.modified));
    out.insert("deleted", count(outcome.deleted));
    out.insert("insertedIds", Value::Array(outcome.inserted_ids.clone()));
    if let Some(id) = &outcome.upserted_id {
        out.insert("upsertedId", id.clone());
    }
    out.insert("changedIds", Value::Array(outcome.changed_ids.clone()));
    Value::Document(out)
}

fn record_of(
    id: &str,
    caller: &Caller,
    key: &RecordKey,
    outcomes: &[Outcome],
) -> Result<bson::Document, Stop> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis());
    let mut record = Document::new();
    record.insert("_id", Value::String(id.to_owned()));
    record.insert("sub", Value::String(caller.subject.clone()));
    record.insert("c", Value::String(key.c.clone()));
    record.insert("op", Value::String(key.op.clone()));
    record.insert("fp", Value::String(key.fp.clone()));
    record.insert("at", Value::DateTime(i64::try_from(now).unwrap_or(i64::MAX)));
    if key.op == "batch" {
        record.insert("results", Value::Array(outcomes.iter().map(stored_outcome).collect()));
    } else if let Some(first) = outcomes.first() {
        record.insert("result", stored_outcome(first));
    }
    to_bson(&record).map_err(|error| Stop::Failed(custom(error)))
}

fn number(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::Int32(n)) => u64::try_from(*n).unwrap_or(0),
        Some(Value::Int64(n)) => u64::try_from(*n).unwrap_or(0),
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Some(Value::Double(n)) if *n >= 0.0 => *n as u64,
        _ => 0,
    }
}

/// Reads a stored outcome back into the form the write path returns.
fn outcome_of(stored: &Value) -> Result<Outcome, CanopyError> {
    let Value::Document(stored) = stored else { return Err(internal()) };
    let ids = |name: &str| match stored.get(name) {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    Ok(Outcome {
        matched: number(stored.get("matched")),
        modified: number(stored.get("modified")),
        deleted: number(stored.get("deleted")),
        inserted_ids: ids("insertedIds"),
        upserted_id: stored.get("upsertedId").cloned(),
        changed_ids: ids("changedIds"),
        ..Outcome::default()
    })
}

/// Adds the position of the failing operation of a batch to an error.
fn at_index(error: CanopyError, index: usize) -> CanopyError {
    let message = format!("Operation {index}: {}", error.message());
    let details = match error.details() {
        Some(details) if details.ends_with('}') && details.len() > 2 => {
            format!("{},\"index\":{index}}}", &details[..details.len() - 1])
        }
        _ => format!("{{\"index\":{index}}}"),
    };
    CanopyError::named(error.code(), error.name(), message).with_details(details)
}

fn duplicate_key(error: &DriverError) -> bool {
    write_code(error) == Some(DUPLICATE_KEY)
}

fn write_code(error: &DriverError) -> Option<i32> {
    match error.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(write)) => Some(write.code),
        ErrorKind::InsertMany(insert) => {
            insert.write_errors.as_ref().and_then(|errors| errors.first()).map(|e| e.code)
        }
        ErrorKind::Command(command) => Some(command.code),
        _ => None,
    }
}

/// Converts the failure of a write into a [`CanopyError`]: the error it carries, a duplicate key, a validator
/// refusal (whose reason only `service` callers see), or the read path's mapping.
fn write_error(error: &DriverError, service: bool) -> CanopyError {
    if let Some(carried) = carried(error) {
        return carried;
    }
    if let ErrorKind::BulkWrite(bulk) = error.kind.as_ref() {
        if let Some((_, write)) = bulk.write_errors.iter().min_by_key(|(index, _)| *index) {
            let command = doc! { "code": write.code, "errmsg": &write.message };
            if let Ok(command) = bson::deserialize_from_document(command) {
                return write_error(&ErrorKind::Command(command).into(), service);
            }
        } else if let Some(source) = std::error::Error::source(error).and_then(|e| e.downcast_ref()) {
            return write_error(source, service);
        }
    }
    match write_code(error) {
        Some(DUPLICATE_KEY) => {
            CanopyError::new(ErrorCode::DuplicateKey, "A document with the same unique key exists")
        }
        Some(DOCUMENT_VALIDATION_FAILURE) => {
            let failure = CanopyError::named(
                ErrorCode::ValidationFailed,
                "ValidationError",
                "The document failed the collection validator",
            );
            let reason = match error.kind.as_ref() {
                ErrorKind::Write(WriteFailure::WriteError(write)) => write.details.clone(),
                ErrorKind::InsertMany(insert) => insert
                    .write_errors
                    .as_ref()
                    .and_then(|errors| errors.first())
                    .and_then(|e| e.details.clone()),
                _ => None,
            };
            match reason {
                Some(reason) if service => {
                    let details = bson::RawDocumentBuf::try_from(&doc! { "reason": reason })
                        .ok()
                        .and_then(|raw| canopy_protocol::bson::decode_document(raw.as_bytes()).ok())
                        .and_then(|details| {
                            canopy_protocol::ejson::stringify(&Value::Document(details)).ok()
                        });
                    match details {
                        Some(details) => failure.with_details(details),
                        None => failure,
                    }
                }
                _ => failure,
            }
        }
        _ => from_driver_error(error, service),
    }
}
