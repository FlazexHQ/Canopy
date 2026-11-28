//! The stored form of policies in `canopy.policies`: one document per collection with clauses as canonical
//! EJSON strings, the collection and bundle hashes, and the stored context lookups.

use canopy_protocol::ejson::{DecodeOptions, canonical_string, parse};
use canopy_protocol::sha256::sha256_hex;
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};

use crate::model::{
    CollectionFields, CollectionPolicies, ContextDefinitions, ContextLookup, FieldKind, FieldRule,
    FieldRules, Operation, PolicyDefinition, PolicyKind, strings_value,
};
use crate::values::{js_cmp, js_fields, js_number, js_order, js_ordered};

/// The `_id` of the stored context lookup declarations.
pub const CONTEXT_DOCUMENT_ID: &str = "_context";

/// One policy as stored in `canopy.policies`. Clauses are canonical EJSON strings.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredPolicy {
    /// The name.
    pub name: String,
    /// Whether it combines with OR or AND.
    pub kind: PolicyKind,
    /// The operations it covers.
    pub ops: Vec<Operation>,
    /// The roles it applies to.
    pub roles: Vec<String>,
    /// The `using` clause as canonical EJSON text.
    pub using: Option<String>,
    /// The `check` clause as canonical EJSON text.
    pub check: Option<String>,
}

/// The stored document of one collection, `_id` being the collection name.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredCollectionPolicies {
    /// The collection name.
    pub id: String,
    /// The version, increased by every publish.
    pub version: i64,
    /// Whether non service callers may reach the collection.
    pub exposed: bool,
    /// Whether the collection may be subscribed to.
    pub realtime: bool,
    /// The policies, in order.
    pub policies: Vec<StoredPolicy>,
    /// Field level rules.
    pub fields: Option<CollectionFields>,
    /// Paths only `service` may change after insert.
    pub immutable: Option<Vec<String>>,
    /// The SHA-256 of the canonical policy body, `sha256:` and 64 hexadecimal digits.
    pub hash: String,
    /// When it was published, in milliseconds since the epoch.
    pub updated_at: Option<i64>,
    /// Who published it.
    pub updated_by: Option<String>,
}

/// What [`to_stored`] records besides the policies.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StoredMeta {
    /// The version.
    pub version: i64,
    /// When it was published, in milliseconds since the epoch.
    pub updated_at: Option<i64>,
    /// Who published it.
    pub updated_by: Option<String>,
}

/// The error a malformed stored document raises, named after the TypeScript `TypeError` it corresponds to.
fn type_error(message: impl Into<String>) -> CanopyError {
    CanopyError::named(ErrorCode::Internal, "TypeError", message)
}

/// Canonical EJSON text of a clause, with its keys in the order the TypeScript packages see them.
pub(crate) fn canonical_clause(clause: &Document) -> Result<String, CanopyError> {
    canonical_string(&Value::Document(js_ordered(clause)))
}

#[allow(clippy::cast_precision_loss)]
fn js_integer(value: i64) -> Value {
    Value::from_js_number(value as f64)
}

fn field_rule_value(rule: &FieldRule) -> Value {
    let (key, paths) = match rule {
        FieldRule::Only(paths) => ("only", paths),
        FieldRule::Omit(paths) => ("omit", paths),
    };
    Value::Document([(key.to_owned(), strings_value(paths))].into_iter().collect())
}

pub(crate) fn fields_value(fields: &CollectionFields) -> Value {
    Value::Document(
        fields
            .iter()
            .map(|(kind, rules)| {
                let roles: Document = js_order(rules.clone())
                    .iter()
                    .map(|(role, rule)| (role.clone(), field_rule_value(rule)))
                    .collect();
                (kind.as_str().to_owned(), Value::Document(roles))
            })
            .collect(),
    )
}

fn ops_value(ops: &[Operation]) -> Value {
    Value::Array(ops.iter().map(|op| Value::String(op.as_str().to_owned())).collect())
}

fn stored_policy_value(policy: &StoredPolicy) -> Value {
    let mut document = Document::new();
    document.insert("name", Value::String(policy.name.clone()));
    document.insert("kind", Value::String(policy.kind.as_str().to_owned()));
    document.insert("ops", ops_value(&policy.ops));
    document.insert("roles", strings_value(&policy.roles));
    if let Some(using) = &policy.using {
        document.insert("using", Value::String(using.clone()));
    }
    if let Some(check) = &policy.check {
        document.insert("check", Value::String(check.clone()));
    }
    Value::Document(document)
}

fn stored_policies(def: &CollectionPolicies) -> Result<Vec<StoredPolicy>, CanopyError> {
    def.policies
        .iter()
        .map(|policy| {
            Ok(StoredPolicy {
                name: policy.name.clone(),
                kind: policy.kind,
                ops: policy.ops.clone(),
                roles: policy.roles.clone(),
                using: policy.using.as_ref().map(canonical_clause).transpose()?,
                check: policy.check.as_ref().map(canonical_clause).transpose()?,
            })
        })
        .collect()
}

fn body(def: &CollectionPolicies) -> Result<Value, CanopyError> {
    let mut document = Document::new();
    document.insert("_id", Value::String(def.collection.clone()));
    document.insert("exposed", Value::Bool(def.exposed));
    document.insert("realtime", Value::Bool(def.realtime));
    document
        .insert("policies", Value::Array(stored_policies(def)?.iter().map(stored_policy_value).collect()));
    document.insert("fields", def.fields.as_ref().map_or(Value::Null, fields_value));
    document.insert("immutable", strings_value(def.immutable.as_deref().unwrap_or_default()));
    Ok(Value::Document(document))
}

/// The SHA-256 of the canonical policy body of a collection, used as its version hash.
pub fn hash_collection(def: &CollectionPolicies) -> Result<String, CanopyError> {
    Ok(format!("sha256:{}", sha256_hex(canonical_string(&body(def)?)?.as_bytes())))
}

/// Converts context lookups to the document stored under `lookups`.
pub fn contexts_value(contexts: &ContextDefinitions) -> Value {
    Value::Document(
        js_order(contexts.clone())
            .into_iter()
            .map(|(name, lookup)| {
                let mut document = Document::new();
                document.insert("from", Value::String(lookup.from));
                document.insert("where", Value::Document(js_ordered(&lookup.filter)));
                document.insert("select", Value::String(lookup.select));
                document.insert("max", Value::from_js_number(lookup.max));
                document.insert("ttl", Value::String(lookup.ttl));
                (name, Value::Document(document))
            })
            .collect(),
    )
}

/// The SHA-256 of the canonical context lookup declarations.
pub fn hash_contexts(contexts: &ContextDefinitions) -> Result<String, CanopyError> {
    Ok(format!("sha256:{}", sha256_hex(canonical_string(&contexts_value(contexts))?.as_bytes())))
}

/// The bundle version over all collection hashes, given as `(collection, hash)` pairs, and the context lookups.
pub fn hash_policy_set(
    hashes: &[(String, String)],
    contexts: &ContextDefinitions,
) -> Result<String, CanopyError> {
    let mut entries = hashes.to_vec();
    entries.sort_by(|(a, _), (b, _)| js_cmp(a, b));
    let collections = entries
        .into_iter()
        .map(|(name, hash)| Value::Array(vec![Value::String(name), Value::String(hash)]))
        .collect();
    let mut document = Document::new();
    document.insert("collections", Value::Array(collections));
    document.insert("contexts", contexts_value(contexts));
    Ok(format!("sha256:{}", sha256_hex(canonical_string(&Value::Document(document))?.as_bytes())))
}

/// Converts authoring form to the stored form.
pub fn to_stored(
    def: &CollectionPolicies,
    meta: &StoredMeta,
) -> Result<StoredCollectionPolicies, CanopyError> {
    Ok(StoredCollectionPolicies {
        id: def.collection.clone(),
        version: meta.version,
        exposed: def.exposed,
        realtime: def.realtime,
        policies: stored_policies(def)?,
        fields: def.fields.clone(),
        immutable: def.immutable.clone(),
        hash: hash_collection(def)?,
        updated_at: meta.updated_at,
        updated_by: meta.updated_by.clone(),
    })
}

impl StoredCollectionPolicies {
    /// The document written to `canopy.policies`.
    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        document.insert("_id", Value::String(self.id.clone()));
        document.insert("version", js_integer(self.version));
        document.insert("exposed", Value::Bool(self.exposed));
        document.insert("realtime", Value::Bool(self.realtime));
        document.insert("policies", Value::Array(self.policies.iter().map(stored_policy_value).collect()));
        if let Some(fields) = &self.fields {
            document.insert("fields", fields_value(fields));
        }
        if let Some(immutable) = &self.immutable {
            document.insert("immutable", strings_value(immutable));
        }
        document.insert("hash", Value::String(self.hash.clone()));
        if let Some(at) = self.updated_at {
            document.insert("updatedAt", Value::DateTime(at));
        }
        if let Some(by) = &self.updated_by {
            document.insert("updatedBy", Value::String(by.clone()));
        }
        document
    }
}

impl CollectionPolicies {
    /// The authoring form as a document: `collection`, `exposed`, `realtime`, `policies` with their clauses as
    /// documents, then `fields` and `immutable` when set.
    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        document.insert("collection", Value::String(self.collection.clone()));
        document.insert("exposed", Value::Bool(self.exposed));
        document.insert("realtime", Value::Bool(self.realtime));
        let policies = self
            .policies
            .iter()
            .map(|policy| {
                let mut entry = Document::new();
                entry.insert("name", Value::String(policy.name.clone()));
                entry.insert("kind", Value::String(policy.kind.as_str().to_owned()));
                entry.insert("ops", ops_value(&policy.ops));
                entry.insert("roles", strings_value(&policy.roles));
                if let Some(using) = &policy.using {
                    entry.insert("using", Value::Document(js_ordered(using)));
                }
                if let Some(check) = &policy.check {
                    entry.insert("check", Value::Document(js_ordered(check)));
                }
                Value::Document(entry)
            })
            .collect();
        document.insert("policies", Value::Array(policies));
        if let Some(fields) = &self.fields {
            document.insert("fields", fields_value(fields));
        }
        if let Some(immutable) = &self.immutable {
            document.insert("immutable", strings_value(immutable));
        }
        document
    }
}

fn is_missing(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null | Value::Undefined))
}

fn strings(value: &Value, what: &str) -> Result<Vec<String>, CanopyError> {
    let fail = || type_error(format!("{what} must be an array of strings"));
    let Value::Array(items) = value else { return Err(fail()) };
    items.iter().map(|item| item.as_str().map(str::to_owned).ok_or_else(fail)).collect()
}

fn optional_string(value: Option<&Value>, what: &str) -> Result<Option<String>, CanopyError> {
    match value {
        None | Some(Value::Null | Value::Undefined) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(type_error(format!("{what} must be a string"))),
    }
}

fn list_or_empty(raw: &Document, key: &str, what: &str) -> Result<Vec<String>, CanopyError> {
    match raw.get(key) {
        value if is_missing(value) => Ok(Vec::new()),
        Some(value) => strings(value, what),
        None => Ok(Vec::new()),
    }
}

fn stored_policy(raw: &Value, collection: &str) -> Result<StoredPolicy, CanopyError> {
    let Value::Document(raw) = raw else {
        return Err(type_error(format!("A stored policy of '{collection}' must be a document")));
    };
    let Some(Value::String(name)) = raw.get("name") else {
        return Err(type_error(format!("A stored policy of '{collection}' needs a string name")));
    };
    let kind = raw
        .get("kind")
        .and_then(Value::as_str)
        .and_then(PolicyKind::parse)
        .ok_or_else(|| type_error(format!("Policy '{name}' has an unknown kind")))?;
    let mut ops = Vec::new();
    for op in list_or_empty(raw, "ops", &format!("The operations of policy '{name}'"))? {
        let parsed = Operation::parse(&op)
            .ok_or_else(|| type_error(format!("Policy '{name}' has the unknown operation '{op}'")))?;
        ops.push(parsed);
    }
    let using = optional_string(raw.get("using"), &format!("The using clause of policy '{name}'"))?;
    let check = optional_string(raw.get("check"), &format!("The check clause of policy '{name}'"))?;
    Ok(StoredPolicy {
        name: name.clone(),
        kind,
        ops,
        roles: list_or_empty(raw, "roles", &format!("The roles of policy '{name}'"))?,
        using,
        check,
    })
}

fn field_rule(value: &Value, place: &str) -> Result<FieldRule, CanopyError> {
    let Value::Document(rule) = value else { return Err(type_error(format!("{place} must be a document"))) };
    let only = rule.get("only").filter(|value| !matches!(value, Value::Undefined));
    let omit = rule.get("omit").filter(|value| !matches!(value, Value::Undefined));
    match (only, omit) {
        (Some(only), None) => Ok(FieldRule::Only(strings(only, &format!("{place}.only"))?)),
        (None, Some(omit)) => Ok(FieldRule::Omit(strings(omit, &format!("{place}.omit"))?)),
        _ => Err(type_error(format!("{place} needs exactly one of only or omit"))),
    }
}

fn fields_from_stored(
    value: Option<&Value>,
    collection: &str,
) -> Result<Option<CollectionFields>, CanopyError> {
    let value = match value {
        None | Some(Value::Null | Value::Undefined) => return Ok(None),
        Some(Value::Document(value)) => value,
        Some(_) => return Err(type_error(format!("The field rules of '{collection}' must be a document"))),
    };
    let mut fields = CollectionFields::new();
    for (kind, rules) in js_fields(value) {
        let Some(kind) = FieldKind::parse(kind) else {
            return Err(type_error(format!(
                "The field rules of '{collection}' have the unknown kind '{kind}'"
            )));
        };
        let rules = match rules {
            Value::Undefined => continue,
            Value::Document(rules) => rules,
            _ => {
                return Err(type_error(format!(
                    "fields.{} of '{collection}' must be a document",
                    kind.as_str()
                )));
            }
        };
        let mut by_role: FieldRules = Vec::new();
        for (role, rule) in js_fields(rules) {
            let rule = field_rule(rule, &format!("fields.{}.{role} of '{collection}'", kind.as_str()))?;
            by_role.push((role.to_owned(), rule));
        }
        fields.insert(kind, by_role);
    }
    Ok(Some(fields))
}

struct StoredParts {
    collection: String,
    exposed: bool,
    realtime: bool,
    policies: Vec<StoredPolicy>,
    fields: Option<CollectionFields>,
    immutable: Option<Vec<String>>,
}

fn stored_parts(stored: &Document, collection: &str) -> Result<StoredParts, CanopyError> {
    let Some(Value::Array(policies)) = stored.get("policies") else {
        return Err(type_error(format!("Policies for '{collection}' must be an array")));
    };
    let immutable = stored.get("immutable");
    Ok(StoredParts {
        collection: collection.to_owned(),
        exposed: matches!(stored.get("exposed"), Some(Value::Bool(true))),
        realtime: matches!(stored.get("realtime"), Some(Value::Bool(true))),
        policies: policies.iter().map(|raw| stored_policy(raw, collection)).collect::<Result<_, _>>()?,
        fields: fields_from_stored(stored.get("fields"), collection)?,
        immutable: match immutable {
            value if is_missing(value) => None,
            Some(value) => Some(strings(value, &format!("The immutable fields of '{collection}'"))?),
            None => None,
        },
    })
}

fn stored_document(stored: &Value) -> Result<(&Document, &str), CanopyError> {
    let Value::Document(document) = stored else {
        return Err(type_error("A stored policy document must be a document"));
    };
    let Some(Value::String(collection)) = document.get("_id") else {
        return Err(type_error("A stored policy document needs a string _id"));
    };
    Ok((document, collection))
}

fn clause(text: Option<&String>, name: &str, kind: &str) -> Result<Option<Document>, CanopyError> {
    let Some(text) = text else { return Ok(None) };
    match parse(text, DecodeOptions::default())? {
        Value::Document(document) => Ok(Some(js_ordered(&document))),
        _ => Err(type_error(format!("Policy '{name}' has a {kind} clause that is not a document"))),
    }
}

/// Converts a stored document back to authoring form. Its structure is checked here (an error named
/// `TypeError` on a malformed document); the result still has to pass validation through
/// [`crate::create_policy_set`] before it is used, so a tampered document is rejected rather than trusted.
pub fn from_stored(stored: &Value) -> Result<CollectionPolicies, CanopyError> {
    let (document, collection) = stored_document(stored)?;
    let parts = stored_parts(document, collection)?;
    let policies = parts
        .policies
        .into_iter()
        .map(|policy| {
            let using = clause(policy.using.as_ref(), &policy.name, "using")?;
            let check = clause(policy.check.as_ref(), &policy.name, "check")?;
            Ok(PolicyDefinition {
                name: policy.name,
                kind: policy.kind,
                ops: policy.ops,
                roles: policy.roles,
                using,
                check,
            })
        })
        .collect::<Result<_, CanopyError>>()?;
    Ok(CollectionPolicies {
        collection: parts.collection,
        exposed: parts.exposed,
        realtime: parts.realtime,
        policies,
        fields: parts.fields,
        immutable: parts.immutable,
    })
}

fn is_safe_integer(number: f64) -> bool {
    number.is_finite() && number.trunc() == number && number.abs() <= 9_007_199_254_740_991.0
}

/// Checks the structure of a document read from `canopy.policies` and returns it in its stored form, version
/// and hash included. Fails with an error named `TypeError` on a malformed document. The policies themselves
/// are validated when they are compiled.
#[allow(clippy::cast_possible_truncation)]
pub fn read_stored(stored: &Value) -> Result<StoredCollectionPolicies, CanopyError> {
    let (document, collection) = stored_document(stored)?;
    let parts = stored_parts(document, collection)?;
    let version = document
        .get("version")
        .and_then(js_number)
        .filter(|version| is_safe_integer(*version) && *version >= 0.0)
        .ok_or_else(|| type_error(format!("The stored policies of '{collection}' need a version")))?;
    let Some(Value::String(hash)) = document.get("hash") else {
        return Err(type_error(format!("The stored policies of '{collection}' need a hash")));
    };
    let updated_at = match document.get("updatedAt") {
        None | Some(Value::Null | Value::Undefined) => None,
        Some(Value::DateTime(at)) => Some(*at),
        Some(_) => return Err(type_error(format!("updatedAt of '{collection}' must be a date"))),
    };
    let updated_by = optional_string(document.get("updatedBy"), &format!("updatedBy of '{collection}'"))?;
    Ok(StoredCollectionPolicies {
        id: parts.collection,
        version: version as i64,
        exposed: parts.exposed,
        realtime: parts.realtime,
        policies: parts.policies,
        fields: parts.fields,
        immutable: parts.immutable,
        hash: hash.clone(),
        updated_at,
        updated_by,
    })
}

fn context_lookup_from(value: &Value, name: &str) -> Result<ContextLookup, CanopyError> {
    let Value::Document(lookup) = value else {
        return Err(type_error(format!("The context lookup '{name}' must be a document")));
    };
    let Some(Value::String(from)) = lookup.get("from") else {
        return Err(type_error(format!("The context lookup '{name}' needs a string from")));
    };
    let Some(Value::Document(filter)) = lookup.get("where") else {
        return Err(type_error(format!("The context lookup '{name}' needs a where document")));
    };
    let Some(Value::String(select)) = lookup.get("select") else {
        return Err(type_error(format!("The context lookup '{name}' needs a string select")));
    };
    let Some(max) = lookup.get("max").and_then(js_number) else {
        return Err(type_error(format!("The context lookup '{name}' needs a number max")));
    };
    let Some(Value::String(ttl)) = lookup.get("ttl") else {
        return Err(type_error(format!("The context lookup '{name}' needs a string ttl")));
    };
    Ok(ContextLookup {
        from: from.clone(),
        filter: js_ordered(filter),
        select: select.clone(),
        max,
        ttl: ttl.clone(),
    })
}

/// Checks the structure of context lookup declarations read from storage (the `lookups` field of the
/// `_context` document). Missing declarations are an empty set; anything else that is not a document of
/// lookups fails with an error named `TypeError`. The lookups are validated when they are compiled.
pub fn contexts_from_stored(lookups: Option<&Value>) -> Result<ContextDefinitions, CanopyError> {
    match lookups {
        None | Some(Value::Null | Value::Undefined) => Ok(Vec::new()),
        Some(Value::Document(lookups)) => js_fields(lookups)
            .into_iter()
            .map(|(name, lookup)| Ok((name.to_owned(), context_lookup_from(lookup, name)?)))
            .collect(),
        Some(_) => Err(type_error("The context lookups must be a document")),
    }
}
