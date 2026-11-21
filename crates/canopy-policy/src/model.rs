//! The policy model: operations, kinds, roles, policies, field rules, context lookups and the request context.

use std::fmt;

use canopy_protocol::{Document, Value};

use crate::values::{js_cmp, js_order};

/// An operation a policy can grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Operation {
    /// `find`, `findOne`, `count`, `distinct`, `aggregate` and realtime subscriptions.
    Read,
    /// Inserts.
    Insert,
    /// Update operators, replacements and the update half of an upsert.
    Update,
    /// Deletes.
    Delete,
}

impl Operation {
    /// Every operation, in canonical order.
    pub const ALL: [Operation; 4] =
        [Operation::Read, Operation::Insert, Operation::Update, Operation::Delete];

    /// The stored name, such as `read`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Operation::Read => "read",
            Operation::Insert => "insert",
            Operation::Update => "update",
            Operation::Delete => "delete",
        }
    }

    /// Returns the operation with the given stored name.
    pub fn parse(text: &str) -> Option<Operation> {
        Operation::ALL.into_iter().find(|op| op.as_str() == text)
    }

    /// Whether a `using` clause applies to the operation: `read`, `update` and `delete`.
    pub const fn uses_using(self) -> bool {
        matches!(self, Operation::Read | Operation::Update | Operation::Delete)
    }

    /// Whether a `check` clause applies to the operation: `insert` and `update`.
    pub const fn uses_check(self) -> bool {
        matches!(self, Operation::Insert | Operation::Update)
    }
}

impl fmt::Display for Operation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How a policy combines with the others: permissive policies with OR, restrictive ones with AND.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PolicyKind {
    /// Combined with OR. Without any, the operation is denied.
    Permissive,
    /// Combined with AND.
    Restrictive,
}

impl PolicyKind {
    /// The stored name, `permissive` or `restrictive`.
    pub const fn as_str(self) -> &'static str {
        match self {
            PolicyKind::Permissive => "permissive",
            PolicyKind::Restrictive => "restrictive",
        }
    }

    /// Returns the kind with the given stored name.
    pub fn parse(text: &str) -> Option<PolicyKind> {
        match text {
            "permissive" => Some(PolicyKind::Permissive),
            "restrictive" => Some(PolicyKind::Restrictive),
            _ => None,
        }
    }
}

impl fmt::Display for PolicyKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Roles with a fixed meaning. `service` can never appear in a policy, because it bypasses DLS.
#[derive(Debug, Clone, Copy)]
pub struct Role;

impl Role {
    /// The base role of a caller with a publishable key and no user token.
    pub const ANON: &'static str = "anon";
    /// The base role of a caller with a valid user token.
    pub const AUTHENTICATED: &'static str = "authenticated";
    /// In a policy, matches every request role.
    pub const PUBLIC: &'static str = "public";
    /// The role of a secret key, which bypasses DLS.
    pub const SERVICE: &'static str = "service";
}

/// The reserved policy collection of storage: its policies apply to the metadata documents of stored files
/// (`bucket`, `path`, `owner`, `size`, `contentType`, `metadata`), never to an app collection, so the Data
/// API, GraphQL and realtime do not serve it.
pub const STORAGE_COLLECTION: &str = "storage.objects";

/// One policy in authoring form. Clauses are filter documents that may contain policy variables.
#[derive(Debug, Clone, PartialEq)]
pub struct PolicyDefinition {
    /// The name, unique within its collection.
    pub name: String,
    /// Whether it combines with OR or AND.
    pub kind: PolicyKind,
    /// The operations it covers.
    pub ops: Vec<Operation>,
    /// The roles it applies to; `public` means every role.
    pub roles: Vec<String>,
    /// Which existing documents the operations may touch.
    pub using: Option<Document>,
    /// What resulting documents must satisfy.
    pub check: Option<Document>,
}

/// A field rule: either the readable or writable paths, or the hidden ones. In `only`, `*` means every field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldRule {
    /// Only these paths, and what lies beneath them.
    Only(Vec<String>),
    /// Every path but these, what lies beneath them and their ancestors.
    Omit(Vec<String>),
}

/// Field rules keyed by role, with `default` for roles without an entry, in JavaScript property order.
pub type FieldRules = Vec<(String, FieldRule)>;

/// Which accesses a set of field rules governs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FieldKind {
    /// Reads.
    Read,
    /// Inserts, and updates when there are no `update` rules.
    Write,
    /// Updates.
    Update,
}

impl FieldKind {
    /// Every kind, in the order validation visits them.
    pub const ALL: [FieldKind; 3] = [FieldKind::Read, FieldKind::Write, FieldKind::Update];

    /// The stored name, such as `read`.
    pub const fn as_str(self) -> &'static str {
        match self {
            FieldKind::Read => "read",
            FieldKind::Write => "write",
            FieldKind::Update => "update",
        }
    }

    /// Returns the kind with the given stored name.
    pub fn parse(text: &str) -> Option<FieldKind> {
        FieldKind::ALL.into_iter().find(|kind| kind.as_str() == text)
    }
}

/// The field rules of one collection, keeping the order the kinds were declared in, which the collection
/// hash depends on.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CollectionFields {
    entries: Vec<(FieldKind, FieldRules)>,
}

impl CollectionFields {
    /// Creates empty field rules.
    pub fn new() -> CollectionFields {
        CollectionFields::default()
    }

    /// Sets the rules of a kind, keeping its position when it is already set. Role keys are put into
    /// JavaScript property order.
    pub fn insert(&mut self, kind: FieldKind, rules: FieldRules) {
        let rules = js_order(rules);
        match self.entries.iter_mut().find(|(existing, _)| *existing == kind) {
            Some(slot) => slot.1 = rules,
            None => self.entries.push((kind, rules)),
        }
    }

    /// The rules of a kind.
    pub fn get(&self, kind: FieldKind) -> Option<&FieldRules> {
        self.entries.iter().find(|(existing, _)| *existing == kind).map(|(_, rules)| rules)
    }

    /// The kinds and their rules, in declaration order.
    pub fn iter(&self) -> impl Iterator<Item = (FieldKind, &FieldRules)> {
        self.entries.iter().map(|(kind, rules)| (*kind, rules))
    }
}

impl FromIterator<(FieldKind, FieldRules)> for CollectionFields {
    fn from_iter<I: IntoIterator<Item = (FieldKind, FieldRules)>>(iter: I) -> CollectionFields {
        let mut fields = CollectionFields::new();
        for (kind, rules) in iter {
            fields.insert(kind, rules);
        }
        fields
    }
}

/// The policies of one collection in authoring form.
#[derive(Debug, Clone, PartialEq)]
pub struct CollectionPolicies {
    /// The collection name.
    pub collection: String,
    /// Whether non service callers may reach the collection.
    pub exposed: bool,
    /// Whether the collection may be subscribed to.
    pub realtime: bool,
    /// The policies, in order.
    pub policies: Vec<PolicyDefinition>,
    /// Field level rules.
    pub fields: Option<CollectionFields>,
    /// Paths only `service` may change after insert.
    pub immutable: Option<Vec<String>>,
}

impl CollectionPolicies {
    /// Creates a collection without policies, not exposed.
    pub fn new(collection: impl Into<String>) -> CollectionPolicies {
        CollectionPolicies {
            collection: collection.into(),
            exposed: false,
            realtime: false,
            policies: Vec::new(),
            fields: None,
            immutable: None,
        }
    }
}

/// A declared context lookup: the values at `select` of the documents of `from` matching `filter`, read with
/// service privileges.
#[derive(Debug, Clone, PartialEq)]
pub struct ContextLookup {
    /// The source collection in the app database.
    pub from: String,
    /// The `where` clause, which refers to the subject through `$auth` variables.
    pub filter: Document,
    /// The dotted path whose values make up the result.
    pub select: String,
    /// The most documents a result may hold; a larger result fails closed.
    pub max: f64,
    /// How long a result is cached, such as `30s`, `5m`, `1h` or `1d`.
    pub ttl: String,
}

/// Context lookups by name, in declaration order.
pub type ContextDefinitions = Vec<(String, ContextLookup)>;

/// Returns the lookup declared under `name`.
pub fn context_lookup<'a>(contexts: &'a ContextDefinitions, name: &str) -> Option<&'a ContextLookup> {
    contexts.iter().find(|(declared, _)| declared == name).map(|(_, lookup)| lookup)
}

/// The roles of a request: a set that keeps the order roles were added in.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Roles {
    roles: Vec<String>,
}

impl Roles {
    /// Creates an empty set.
    pub fn new() -> Roles {
        Roles::default()
    }

    /// Adds a role unless it is already present.
    pub fn insert(&mut self, role: impl Into<String>) {
        let role = role.into();
        if !self.contains(&role) {
            self.roles.push(role);
        }
    }

    /// Whether the set holds `role`.
    pub fn contains(&self, role: &str) -> bool {
        self.roles.iter().any(|existing| existing == role)
    }

    /// The roles in insertion order.
    pub fn iter(&self) -> impl ExactSizeIterator<Item = &str> {
        self.roles.iter().map(String::as_str)
    }

    /// The roles sorted by UTF-16 code unit, as JavaScript sorts strings.
    pub fn sorted(&self) -> Vec<String> {
        let mut roles = self.roles.clone();
        roles.sort_by(|a, b| js_cmp(a, b));
        roles
    }

    /// The number of roles.
    pub fn len(&self) -> usize {
        self.roles.len()
    }

    /// Whether the set is empty.
    pub fn is_empty(&self) -> bool {
        self.roles.is_empty()
    }
}

impl<S: Into<String>> FromIterator<S> for Roles {
    fn from_iter<I: IntoIterator<Item = S>>(iter: I) -> Roles {
        let mut roles = Roles::new();
        for role in iter {
            roles.insert(role);
        }
        roles
    }
}

/// The request context every evaluation runs under.
#[derive(Debug, Clone, PartialEq)]
pub struct RequestContext {
    /// Exactly one base role (`anon` or `authenticated`) plus custom roles, or `service` alone.
    pub roles: Roles,
    /// The verified token payload, or `None` for `anon`.
    pub claims: Option<Document>,
    /// Resolved context lookups. A missing name counts as a missing value.
    pub ctx: Option<Document>,
    /// The request time in milliseconds since the epoch, or for realtime the time the event is processed.
    pub now: i64,
}

impl RequestContext {
    /// Whether the request bypasses DLS.
    pub fn is_service(&self) -> bool {
        self.roles.contains(Role::SERVICE)
    }
}

pub(crate) fn strings_value(items: &[String]) -> Value {
    Value::Array(items.iter().map(|item| Value::String(item.clone())).collect())
}
