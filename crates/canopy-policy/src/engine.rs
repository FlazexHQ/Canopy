//! The policy compiler: a validated policy set, and the engine that turns it into `USING` and `CHECK` filters
//! for each request, as MongoDB filters and as in process matchers.

use std::collections::HashMap;
use std::fmt;

use canopy_matcher::{CompiledFilter, compile_filter};
use canopy_protocol::ejson::canonical_string;
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};

use crate::context::collect_names;
use crate::fields::{FieldAccess, field_access};
use crate::model::{
    CollectionPolicies, ContextDefinitions, FieldKind, Operation, PolicyDefinition, PolicyKind,
    RequestContext, Role, Roles, STORAGE_COLLECTION,
};
use crate::stored::{hash_collection, hash_policy_set};
use crate::validate::{validate_collection_policies, validate_contexts};
use crate::values::{js_keys, js_ordered, js_sort};
use crate::variables::{Resolution, VariableIssue, VariableIssueKind, resolve_clause};

/// The result of compiling a clause set for one request.
#[derive(Debug, Clone, PartialEq)]
pub enum Compiled {
    /// Every document.
    All,
    /// No document.
    Deny,
    /// The documents matching a filter.
    Filter(Document),
}

/// The filter that matches no document, `{ _id: { $in: [] } }`. Cheap for the planner.
pub fn deny_filter() -> Document {
    let inner: Document = [("$in".to_owned(), Value::Array(Vec::new()))].into_iter().collect();
    [("_id".to_owned(), Value::Document(inner))].into_iter().collect()
}

impl Compiled {
    /// Converts the result into a MongoDB filter.
    pub fn to_filter(&self) -> Document {
        match self {
            Compiled::All => Document::new(),
            Compiled::Deny => deny_filter(),
            Compiled::Filter(filter) => filter.clone(),
        }
    }

    /// Compiles the result into the in process matcher, which realtime evaluates on change events. It is the
    /// matcher of [`Compiled::to_filter`], so both forms come from one source.
    pub fn matcher(&self) -> Result<CompiledFilter, CanopyError> {
        compile_filter(&Value::Document(self.to_filter()))
    }

    /// The name of the kind: `all`, `deny` or `filter`.
    pub const fn kind(&self) -> &'static str {
        match self {
            Compiled::All => "all",
            Compiled::Deny => "deny",
            Compiled::Filter(_) => "filter",
        }
    }
}

/// Whether a clause set is `USING` or `CHECK`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Clause {
    /// Which existing documents an operation may touch.
    Using,
    /// What resulting documents must satisfy.
    Check,
}

impl Clause {
    /// `using` or `check`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Clause::Using => "using",
            Clause::Check => "check",
        }
    }
}

impl fmt::Display for Clause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A validated, immutable set of policies with its bundle hash.
#[derive(Debug, Clone, PartialEq)]
pub struct PolicySet {
    collections: Vec<CollectionPolicies>,
    index: HashMap<String, usize>,
    contexts: ContextDefinitions,
    hashes: Vec<(String, String)>,
    version: String,
}

impl PolicySet {
    /// The policies of a collection.
    pub fn collection(&self, name: &str) -> Option<&CollectionPolicies> {
        self.index.get(name).and_then(|position| self.collections.get(*position))
    }

    /// Every collection, in the order given.
    pub fn collections(&self) -> &[CollectionPolicies] {
        &self.collections
    }

    /// The context lookups.
    pub fn contexts(&self) -> &ContextDefinitions {
        &self.contexts
    }

    /// The hash of the canonical body of each collection, in the order given.
    pub fn hashes(&self) -> &[(String, String)] {
        &self.hashes
    }

    /// The bundle version: a hash over every collection hash and the context lookups.
    pub fn version(&self) -> &str {
        &self.version
    }
}

fn normalized(def: CollectionPolicies) -> CollectionPolicies {
    let policies = def
        .policies
        .into_iter()
        .map(|policy| PolicyDefinition {
            using: policy.using.as_ref().map(js_ordered),
            check: policy.check.as_ref().map(js_ordered),
            ..policy
        })
        .collect();
    let fields = def.fields.map(|fields| fields.iter().map(|(kind, rules)| (kind, rules.clone())).collect());
    CollectionPolicies { policies, fields, ..def }
}

/// Validates policy definitions and context lookups and builds a [`PolicySet`]. Clauses are kept with their keys
/// in JavaScript property order, which is the order the TypeScript compiler sees them in.
pub fn create_policy_set(
    definitions: Vec<CollectionPolicies>,
    contexts: ContextDefinitions,
) -> Result<PolicySet, CanopyError> {
    let contexts: ContextDefinitions = contexts
        .into_iter()
        .map(|(name, lookup)| {
            let filter = js_ordered(&lookup.filter);
            (name, crate::model::ContextLookup { filter, ..lookup })
        })
        .collect();
    validate_contexts(&contexts)?;
    let mut collections = Vec::with_capacity(definitions.len());
    let mut index = HashMap::new();
    let mut hashes = Vec::with_capacity(definitions.len());
    for definition in definitions {
        if index.contains_key(&definition.collection) {
            return Err(CanopyError::new(
                ErrorCode::InvalidQuery,
                format!("Policies for '{}' are defined twice", definition.collection),
            ));
        }
        let definition = normalized(definition);
        validate_collection_policies(&definition, &contexts)?;
        hashes.push((definition.collection.clone(), hash_collection(&definition)?));
        index.insert(definition.collection.clone(), collections.len());
        collections.push(definition);
    }
    let version = hash_policy_set(&hashes, &contexts)?;
    Ok(PolicySet { collections, index, contexts, hashes, version })
}

/// A variable issue together with the policy it made drop out.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PolicyVariableIssue {
    /// What went wrong.
    pub kind: VariableIssueKind,
    /// The variable: `$auth:<path>`, `$ctx:<name>` or `$now`.
    pub variable: String,
    /// The collection of the policy.
    pub collection: String,
    /// The name of the policy.
    pub policy: String,
}

/// Hooks for observability. They must not panic.
pub trait EngineHooks: Send + Sync {
    /// Called when a variable makes its policy non matching.
    fn on_variable_issue(&self, _issue: &PolicyVariableIssue) {}

    /// Called when evaluation fails and the result is forced to DENY.
    fn on_evaluation_error(&self, _error: &CanopyError, _collection: &str, _op: Operation) {}
}

/// Hooks that do nothing.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoHooks;

impl EngineHooks for NoHooks {}

/// One line of an [`Explanation`].
#[derive(Debug, Clone, PartialEq)]
pub struct ExplainedPolicy {
    /// The name of the policy.
    pub name: String,
    /// Its kind.
    pub kind: PolicyKind,
    /// Whether it takes part in the result.
    pub applies: bool,
    /// Why it applies or not.
    pub reason: String,
    /// The resolved clause, when the policy applies.
    pub resolved: Option<Document>,
    /// The variable that made the policy drop out, when one did.
    pub issue: Option<VariableIssue>,
}

/// A human readable account of how a decision was reached, used by Studio and `canopy policies test`.
#[derive(Debug, Clone, PartialEq)]
pub struct Explanation {
    /// The collection.
    pub collection: String,
    /// The operation.
    pub op: Operation,
    /// The clause set explained.
    pub clause: Clause,
    /// The roles of the request, sorted.
    pub roles: Vec<String>,
    /// Whether the request bypasses DLS.
    pub bypass: bool,
    /// Whether the collection is exposed.
    pub exposed: bool,
    /// Every policy of the collection with its outcome, unless the request bypasses DLS.
    pub policies: Vec<ExplainedPolicy>,
    /// The result.
    pub result: Compiled,
}

fn is_empty_filter(filter: &Document) -> bool {
    filter.is_empty()
}

/// Drops filters equal to an earlier one. Equal filters have the same keys in the same order, so only filters
/// whose key lists collide are compared by their canonical text.
fn dedupe(filters: Vec<Document>) -> Result<Vec<Document>, CanopyError> {
    if filters.len() < 2 {
        return Ok(filters);
    }
    let shapes: Vec<String> = filters.iter().map(|filter| js_keys(filter).join("\u{0}")).collect();
    let repeated: Vec<bool> = shapes
        .iter()
        .enumerate()
        .map(|(index, shape)| shapes.iter().enumerate().any(|(other, same)| other != index && same == shape))
        .collect();
    if !repeated.contains(&true) {
        return Ok(filters);
    }
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::with_capacity(filters.len());
    for (index, filter) in filters.into_iter().enumerate() {
        if !repeated[index] {
            out.push(filter);
            continue;
        }
        let key = canonical_string(&Value::Document(filter.clone()))?;
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(filter);
    }
    Ok(out)
}

fn flatten_and(filters: Vec<Document>, out: &mut Vec<Document>) {
    for filter in filters {
        let nested = match filter.get("$and") {
            Some(Value::Array(items))
                if filter.len() == 1 && items.iter().all(|item| item.as_document().is_some()) =>
            {
                Some(items.iter().filter_map(|item| item.as_document().cloned()).collect::<Vec<_>>())
            }
            _ => None,
        };
        match nested {
            Some(parts) => flatten_and(parts, out),
            None if !is_empty_filter(&filter) => out.push(filter),
            None => {}
        }
    }
}

/// Combines results with AND: DENY wins, empty filters are dropped, nested `$and` is flattened and repeated
/// filters are kept once. Filters are put into JavaScript property order first.
pub fn and(parts: &[Compiled]) -> Result<Compiled, CanopyError> {
    if parts.contains(&Compiled::Deny) {
        return Ok(Compiled::Deny);
    }
    let mut flat = Vec::new();
    flatten_and(
        parts
            .iter()
            .filter_map(|part| match part {
                Compiled::Filter(filter) => Some(js_ordered(filter)),
                _ => None,
            })
            .collect(),
        &mut flat,
    );
    and_filters(flat)
}

fn and_filters(flat: Vec<Document>) -> Result<Compiled, CanopyError> {
    let mut filters = dedupe(flat)?;
    Ok(match filters.len() {
        0 => Compiled::All,
        1 => Compiled::Filter(filters.remove(0)),
        _ => Compiled::Filter(
            [("$and".to_owned(), Value::Array(filters.into_iter().map(Value::Document).collect()))]
                .into_iter()
                .collect(),
        ),
    })
}

fn combine(permissive: Vec<Document>, restrictive: Vec<Document>) -> Result<Compiled, CanopyError> {
    if permissive.is_empty() {
        return Ok(Compiled::Deny);
    }
    let any_of = if permissive.iter().any(is_empty_filter) {
        None
    } else {
        let mut unique = dedupe(permissive)?;
        Some(if unique.len() == 1 {
            unique.remove(0)
        } else {
            [("$or".to_owned(), Value::Array(unique.into_iter().map(Value::Document).collect()))]
                .into_iter()
                .collect()
        })
    };
    let mut flat = Vec::new();
    flatten_and(any_of.into_iter().chain(restrictive).collect(), &mut flat);
    and_filters(flat)
}

fn template(policy: &PolicyDefinition, clause: Clause) -> Document {
    let chosen = match clause {
        Clause::Check => policy.check.as_ref().or(policy.using.as_ref()),
        Clause::Using => policy.using.as_ref(),
    };
    chosen.cloned().unwrap_or_default()
}

fn grants(policy: &PolicyDefinition, roles: &Roles) -> bool {
    policy.roles.iter().any(|role| role == Role::PUBLIC || roles.contains(role))
}

/// Evaluates DLS for every entry point. Each request only substitutes variables into the validated clauses.
/// Any error yields DENY.
pub struct PolicyEngine {
    set: PolicySet,
    hooks: Box<dyn EngineHooks>,
}

impl fmt::Debug for PolicyEngine {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PolicyEngine").field("version", &self.set.version).finish_non_exhaustive()
    }
}

impl PolicyEngine {
    /// Creates an engine without hooks.
    pub fn new(set: PolicySet) -> PolicyEngine {
        PolicyEngine::with_hooks(set, Box::new(NoHooks))
    }

    /// Creates an engine that reports variable issues and evaluation errors to `hooks`.
    pub fn with_hooks(set: PolicySet, hooks: Box<dyn EngineHooks>) -> PolicyEngine {
        PolicyEngine { set, hooks }
    }

    /// The loaded policies.
    pub fn set(&self) -> &PolicySet {
        &self.set
    }

    /// The bundle version of the loaded policies.
    pub fn version(&self) -> &str {
        self.set.version()
    }

    /// Returns the policies of a collection, if any are defined.
    pub fn collection(&self, name: &str) -> Option<&CollectionPolicies> {
        self.set.collection(name)
    }

    /// Whether non service callers may reach the collection at all.
    pub fn is_exposed(&self, name: &str) -> bool {
        name != STORAGE_COLLECTION && self.set.collection(name).is_some_and(|def| def.exposed)
    }

    /// Whether the collection may be subscribed to.
    pub fn is_realtime(&self, name: &str) -> bool {
        name != STORAGE_COLLECTION && self.set.collection(name).is_some_and(|def| def.exposed && def.realtime)
    }

    fn applicable<'a>(
        def: &'a CollectionPolicies,
        op: Operation,
        roles: &'a Roles,
        kind: PolicyKind,
    ) -> impl Iterator<Item = &'a PolicyDefinition> {
        def.policies
            .iter()
            .filter(move |policy| policy.kind == kind && policy.ops.contains(&op) && grants(policy, roles))
    }

    /// Whether any permissive policy grants `op` to the request's roles. Without one, writes are `403`.
    pub fn has_grant(&self, collection: &str, op: Operation, ctx: &RequestContext) -> bool {
        if ctx.is_service() {
            return true;
        }
        let Some(def) = self.set.collection(collection).filter(|def| def.exposed) else { return false };
        PolicyEngine::applicable(def, op, &ctx.roles, PolicyKind::Permissive).next().is_some()
    }

    /// `USING(op)` for one request: which existing documents the operation may touch.
    pub fn using(&self, collection: &str, op: Operation, ctx: &RequestContext) -> Compiled {
        self.evaluate(collection, op, ctx, Clause::Using)
    }

    /// `CHECK(op)` for one request: what resulting documents must satisfy. Meant for `insert` and `update`.
    pub fn check(&self, collection: &str, op: Operation, ctx: &RequestContext) -> Compiled {
        self.evaluate(collection, op, ctx, Clause::Check)
    }

    /// The target of an update or delete: `USING(op) AND USING(read)`, because a caller cannot modify what it
    /// cannot see.
    pub fn target(
        &self,
        collection: &str,
        op: Operation,
        ctx: &RequestContext,
    ) -> Result<Compiled, CanopyError> {
        and(&[self.using(collection, op, ctx), self.using(collection, Operation::Read, ctx)])
    }

    /// The effective read filter: the caller's filter AND `USING(read)`.
    pub fn effective_read(
        &self,
        collection: &str,
        user_filter: &Document,
        ctx: &RequestContext,
    ) -> Result<Compiled, CanopyError> {
        and(&[Compiled::Filter(user_filter.clone()), self.using(collection, Operation::Read, ctx)])
    }

    /// The fields the request may read.
    pub fn readable(&self, collection: &str, ctx: &RequestContext) -> FieldAccess {
        if ctx.is_service() {
            return FieldAccess::All;
        }
        let rules = self
            .set
            .collection(collection)
            .and_then(|def| def.fields.as_ref())
            .and_then(|f| f.get(FieldKind::Read));
        field_access(rules, &ctx.roles)
    }

    /// The fields the request may write. `update` rules override `write` rules for updates.
    pub fn writable(&self, collection: &str, op: Operation, ctx: &RequestContext) -> FieldAccess {
        if ctx.is_service() {
            return FieldAccess::All;
        }
        let fields = self.set.collection(collection).and_then(|def| def.fields.as_ref());
        let rules = fields.and_then(|fields| {
            if op == Operation::Update {
                fields.get(FieldKind::Update).or_else(|| fields.get(FieldKind::Write))
            } else {
                fields.get(FieldKind::Write)
            }
        });
        field_access(rules, &ctx.roles)
    }

    /// The context lookups the policies of `collections` may use for a request with these roles, or of every
    /// collection when `collections` is `None` (aggregations and batches), sorted. Empty for `service`.
    pub fn context_names(&self, collections: Option<&[&str]>, roles: &Roles) -> Vec<String> {
        if roles.contains(Role::SERVICE) || self.set.contexts.is_empty() {
            return Vec::new();
        }
        let mut names: Vec<String> = match collections {
            Some(collections) => collections.iter().map(|name| (*name).to_owned()).collect(),
            None => self.set.collections.iter().map(|def| def.collection.clone()).collect(),
        };
        js_sort(&mut names);
        let mut out: Vec<String> = Vec::new();
        for name in &names {
            let Some(def) = self.set.collection(name) else { continue };
            for policy in def.policies.iter().filter(|policy| grants(policy, roles)) {
                for clause in [&policy.using, &policy.check].into_iter().flatten() {
                    let mut found = Vec::new();
                    collect_names(&Value::Document(clause.clone()), &mut found);
                    for ctx in found {
                        if !out.contains(&ctx) {
                            out.push(ctx);
                        }
                    }
                }
            }
        }
        js_sort(&mut out);
        out
    }

    /// The immutable paths of a collection, which only `service` may change after insert.
    pub fn immutable(&self, collection: &str) -> &[String] {
        self.set.collection(collection).and_then(|def| def.immutable.as_deref()).unwrap_or_default()
    }

    fn evaluate(&self, collection: &str, op: Operation, ctx: &RequestContext, clause: Clause) -> Compiled {
        if ctx.is_service() {
            return Compiled::All;
        }
        match self.try_evaluate(collection, op, ctx, clause) {
            Ok(compiled) => compiled,
            Err(error) => {
                self.hooks.on_evaluation_error(&error, collection, op);
                Compiled::Deny
            }
        }
    }

    fn try_evaluate(
        &self,
        collection: &str,
        op: Operation,
        ctx: &RequestContext,
        clause: Clause,
    ) -> Result<Compiled, CanopyError> {
        let Some(def) = self.set.collection(collection).filter(|def| def.exposed) else {
            return Ok(Compiled::Deny);
        };
        let mut permissive = Vec::new();
        for policy in PolicyEngine::applicable(def, op, &ctx.roles, PolicyKind::Permissive) {
            if let Some(resolved) = self.resolve(def, policy, clause, ctx)? {
                permissive.push(resolved);
            }
        }
        if permissive.is_empty() {
            return Ok(Compiled::Deny);
        }
        let mut restrictive = Vec::new();
        for policy in PolicyEngine::applicable(def, op, &ctx.roles, PolicyKind::Restrictive) {
            match self.resolve(def, policy, clause, ctx)? {
                Some(resolved) => restrictive.push(resolved),
                None => return Ok(Compiled::Deny),
            }
        }
        combine(permissive, restrictive)
    }

    fn resolve(
        &self,
        def: &CollectionPolicies,
        policy: &PolicyDefinition,
        clause: Clause,
        ctx: &RequestContext,
    ) -> Result<Option<Document>, CanopyError> {
        match resolve_clause(&template(policy, clause), ctx)? {
            Resolution::Resolved(filter) => Ok(Some(filter)),
            Resolution::Unresolvable(issue) => {
                self.hooks.on_variable_issue(&PolicyVariableIssue {
                    kind: issue.kind,
                    variable: issue.variable,
                    collection: def.collection.clone(),
                    policy: policy.name.clone(),
                });
                Ok(None)
            }
        }
    }

    /// Explains how `USING(op)` or `CHECK(op)` is reached for a request.
    pub fn explain(
        &self,
        collection: &str,
        op: Operation,
        ctx: &RequestContext,
        clause: Clause,
    ) -> Result<Explanation, CanopyError> {
        let roles = ctx.roles.sorted();
        let def = self.set.collection(collection);
        let bypass = ctx.is_service();
        let result = self.evaluate(collection, op, ctx, clause);
        let mut policies = Vec::new();
        if let Some(def) = def.filter(|_| !bypass) {
            for policy in &def.policies {
                let for_op = policy.ops.contains(&op);
                let for_role = grants(policy, &ctx.roles);
                if !for_op || !for_role {
                    let reason = if for_op {
                        format!("not granted to roles {}", roles.join(", "))
                    } else {
                        format!("does not cover {op}")
                    };
                    policies.push(ExplainedPolicy {
                        name: policy.name.clone(),
                        kind: policy.kind,
                        applies: false,
                        reason,
                        resolved: None,
                        issue: None,
                    });
                    continue;
                }
                policies.push(match resolve_clause(&template(policy, clause), ctx)? {
                    Resolution::Resolved(filter) => ExplainedPolicy {
                        name: policy.name.clone(),
                        kind: policy.kind,
                        applies: true,
                        reason: "applies".to_owned(),
                        resolved: Some(filter),
                        issue: None,
                    },
                    Resolution::Unresolvable(issue) => {
                        let what = match issue.kind {
                            VariableIssueKind::Missing => "missing or null".to_owned(),
                            kind => format!("invalid ({kind})"),
                        };
                        ExplainedPolicy {
                            name: policy.name.clone(),
                            kind: policy.kind,
                            applies: false,
                            reason: format!("variable {} is {what}", issue.variable),
                            resolved: None,
                            issue: Some(issue),
                        }
                    }
                });
            }
        }
        Ok(Explanation {
            collection: collection.to_owned(),
            op,
            clause,
            roles,
            bypass,
            exposed: def.is_some_and(|def| def.exposed),
            policies,
            result,
        })
    }
}
