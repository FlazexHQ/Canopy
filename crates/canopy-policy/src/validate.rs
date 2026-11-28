//! Validation of policy definitions and context lookups, run when a policy set is compiled.

use std::collections::HashSet;

use canopy_protocol::ejson::js_trim;
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};
use canopy_query::{
    FilterContext, ParseFilterOptions, PathOptions, QueryLimits, USING_LIMITS, parse_filter, validate_path,
};

use crate::dates::is_duration;
use crate::model::{
    CollectionPolicies, ContextDefinitions, FieldKind, FieldRule, PolicyKind, Role, STORAGE_COLLECTION,
    context_lookup,
};
use crate::values::{js_fields, js_keys, js_string, json_stringify};

/// Policy size limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolicyLimits {
    /// Policies per collection.
    pub max_policies: usize,
    /// Bytes per clause, measured as the UTF-8 length of its JSON text.
    pub max_clause_bytes: usize,
    /// Clause nesting depth.
    pub max_depth: usize,
}

/// The limits every collection is validated against.
pub const POLICY_LIMITS: PolicyLimits =
    PolicyLimits { max_policies: 64, max_clause_bytes: 32_768, max_depth: 12 };

const COERCIONS: [&str; 6] = ["objectId", "string", "number", "bool", "date", "uuid"];
const PATH_OPTIONS: PathOptions = PathOptions { positional: false, max_length: 512 };

/// A `PolicyValidationError`: a policy definition breaks a validation rule.
pub fn policy_validation_error(collection: &str, message: &str) -> CanopyError {
    CanopyError::named(
        ErrorCode::InvalidQuery,
        "PolicyValidationError",
        format!("Invalid policies for collection '{collection}': {message}"),
    )
}

fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// `^[A-Za-z_][\w.-]{0,119}$`.
fn is_collection_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.first().is_some_and(|first| first.is_ascii_alphabetic() || *first == b'_')
        && bytes.len() <= 120
        && bytes[1..].iter().all(|byte| is_word(*byte) || *byte == b'.' || *byte == b'-')
}

/// `^[\w:.-]{1,64}$`.
fn is_role_name(role: &str) -> bool {
    (1..=64).contains(&role.len())
        && role.bytes().all(|byte| is_word(byte) || matches!(byte, b':' | b'.' | b'-'))
}

/// `^[\w-]+(?:\.[\w-]+)*$`.
pub(crate) fn is_claim_path(path: &str) -> bool {
    path.split('.')
        .all(|segment| !segment.is_empty() && segment.bytes().all(|byte| is_word(byte) || byte == b'-'))
}

/// `^[A-Za-z_]\w{0,63}$`.
pub(crate) fn is_lookup_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.first().is_some_and(|first| first.is_ascii_alphabetic() || *first == b'_')
        && bytes.len() <= 64
        && bytes.iter().all(|byte| is_word(*byte))
}

/// `^\d+[smhd]$`.
pub(crate) fn is_ttl(ttl: &str) -> bool {
    let bytes = ttl.as_bytes();
    bytes.len() >= 2
        && matches!(bytes[bytes.len() - 1], b's' | b'm' | b'h' | b'd')
        && bytes[..bytes.len() - 1].iter().all(u8::is_ascii_digit)
}

fn is_safe_integer(number: f64) -> bool {
    number.is_finite() && number.trunc() == number && number.abs() <= 9_007_199_254_740_991.0
}

/// Validates the policies of one collection: clause and operation compatibility, roles, unique names, the
/// operator allowlists of each clause type, variable placement and the size limits. Fails with a
/// `PolicyValidationError` on the first problem.
pub fn validate_collection_policies(
    def: &CollectionPolicies,
    contexts: &ContextDefinitions,
) -> Result<(), CanopyError> {
    let fail = |message: &str| Err(policy_validation_error(&def.collection, message));
    if !is_collection_name(&def.collection) || def.collection.starts_with("system.") {
        return fail("the collection name is not valid");
    }
    if def.collection == STORAGE_COLLECTION && def.realtime {
        return fail("storage.objects holds storage policies and cannot be followed in realtime");
    }
    if def.policies.len() > POLICY_LIMITS.max_policies {
        return fail(&format!("at most {} policies are allowed", POLICY_LIMITS.max_policies));
    }
    let mut names: HashSet<&str> = HashSet::new();
    for policy in &def.policies {
        let place = format!("policy '{}'", policy.name);
        if js_trim(&policy.name).is_empty() {
            return fail("every policy needs a name");
        }
        if !names.insert(&policy.name) {
            return fail(&format!("the policy name '{}' is used twice", policy.name));
        }
        if !matches!(policy.kind, PolicyKind::Permissive | PolicyKind::Restrictive) {
            return fail(&format!("{place} has an unknown kind"));
        }
        if policy.ops.is_empty() {
            return fail(&format!("{place} needs at least one operation"));
        }
        if policy.roles.is_empty() {
            return fail(&format!("{place} needs at least one role"));
        }
        let distinct: HashSet<_> = policy.ops.iter().collect();
        if distinct.len() != policy.ops.len() {
            return fail(&format!("{place} lists an operation twice"));
        }
        for role in &policy.roles {
            if role == Role::SERVICE {
                return fail(&format!("{place} names the service role, which always bypasses DLS"));
            }
            if !is_role_name(role) {
                return fail(&format!("{place} has an invalid role name '{role}'"));
            }
        }
        let uses_using = policy.ops.iter().any(|op| op.uses_using());
        let uses_check = policy.ops.iter().any(|op| op.uses_check());
        if policy.using.is_some() && !uses_using {
            return fail(&format!("{place} covers only insert, so it may not have a using clause"));
        }
        if policy.check.is_some() && !uses_check {
            return fail(&format!("{place} covers only read or delete, so it may not have a check clause"));
        }
        for (kind, clause) in [("using", &policy.using), ("check", &policy.check)] {
            let Some(clause) = clause else { continue };
            let value = Value::Document(clause.clone());
            if json_stringify(&value).len() > POLICY_LIMITS.max_clause_bytes {
                return fail(&format!("{place} has a {kind} clause larger than 32 KiB"));
            }
            let using = kind == "using";
            let options = ParseFilterOptions {
                context: if using { FilterContext::Using } else { FilterContext::Check },
                limits: QueryLimits {
                    max_depth: POLICY_LIMITS.max_depth,
                    max_regex_length: if using { 256 } else { 1024 },
                    ..USING_LIMITS
                },
                variables: true,
                expressions: false,
            };
            if let Err(error) = parse_filter(&value, &options) {
                return fail(&format!("{place} has an invalid {kind} clause: {}", error.message()));
            }
            if let Err(message) = validate_variables(&value, contexts) {
                return fail(&format!("{place}: {message}"));
            }
        }
    }
    validate_fields(def)?;
    for path in def.immutable.as_deref().unwrap_or_default() {
        if validate_path(path, PATH_OPTIONS).is_err() {
            return fail(&format!("the immutable path '{path}' is not valid"));
        }
    }
    Ok(())
}

fn validate_fields(def: &CollectionPolicies) -> Result<(), CanopyError> {
    let Some(fields) = &def.fields else { return Ok(()) };
    for kind in FieldKind::ALL {
        let Some(rules) = fields.get(kind) else { continue };
        let kind = kind.as_str();
        for (role, rule) in rules {
            if role == Role::SERVICE {
                return Err(policy_validation_error(
                    &def.collection,
                    &format!("fields.{kind} names the service role"),
                ));
            }
            let (paths, only) = match rule {
                FieldRule::Only(paths) => (paths, true),
                FieldRule::Omit(paths) => (paths, false),
            };
            for path in paths {
                if path == "*" && only {
                    continue;
                }
                if validate_path(path, PATH_OPTIONS).is_err() {
                    return Err(policy_validation_error(
                        &def.collection,
                        &format!("fields.{kind}.{role} has the invalid path '{path}'"),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn validate_variables(clause: &Value, contexts: &ContextDefinitions) -> Result<(), String> {
    match clause {
        Value::Array(items) => items.iter().try_for_each(|item| validate_variables(item, contexts)),
        Value::Document(document) => validate_variable_document(document, contexts),
        _ => Ok(()),
    }
}

fn validate_variable_document(document: &Document, contexts: &ContextDefinitions) -> Result<(), String> {
    let keys = js_keys(document);
    if let Some(path) = document.get("$auth") {
        if !matches!(path, Value::String(path) if is_claim_path(path)) {
            return Err("$auth needs a dotted claim path".to_owned());
        }
        if keys.iter().any(|key| *key != "$auth" && *key != "as") {
            return Err("$auth only accepts an \"as\" option".to_owned());
        }
        match document.get("as") {
            None | Some(Value::Undefined) => {}
            Some(Value::String(coercion)) if COERCIONS.contains(&coercion.as_str()) => {}
            Some(other) => return Err(format!("unknown coercion \"{}\"", js_string(other))),
        }
        return Ok(());
    }
    if let Some(name) = document.get("$ctx") {
        let Value::String(name) = name else { return Err("$ctx needs a lookup name".to_owned()) };
        if keys.len() != 1 {
            return Err("$ctx needs a lookup name".to_owned());
        }
        if context_lookup(contexts, name).is_none() {
            return Err(format!("the context lookup '{name}' is not declared"));
        }
        return Ok(());
    }
    if let Some(spec) = document.get("$now") {
        let Value::Document(spec) = spec else { return Err("$now needs a document".to_owned()) };
        if keys.len() != 1 {
            return Err("$now needs a document".to_owned());
        }
        if spec.keys().any(|key| key != "offset") {
            return Err("$now only accepts an offset".to_owned());
        }
        match spec.get("offset") {
            None | Some(Value::Undefined) => {}
            Some(Value::String(offset)) if is_duration(offset) => {}
            Some(other) => return Err(format!("invalid ISO 8601 duration {}", js_string(other))),
        }
        return Ok(());
    }
    js_fields(document).into_iter().try_for_each(|(_, value)| validate_variables(value, contexts))
}

/// Validates context lookup declarations: names, source collections, `max`, the `select` path, the `where`
/// clause (only `$auth` variables, and at least one) and the `ttl`.
pub fn validate_contexts(contexts: &ContextDefinitions) -> Result<(), CanopyError> {
    for (name, lookup) in contexts {
        let fail = |message: &str| Err(policy_validation_error("_context", &format!("{name}: {message}")));
        if !is_lookup_name(name) {
            return fail("invalid lookup name");
        }
        if !is_collection_name(&lookup.from) {
            return fail("invalid source collection");
        }
        if !is_safe_integer(lookup.max) || lookup.max < 1.0 || lookup.max > 100_000.0 {
            return fail("max must be between 1 and 100000");
        }
        if validate_path(&lookup.select, PATH_OPTIONS).is_err() {
            return fail("invalid select path");
        }
        let value = Value::Document(lookup.filter.clone());
        let parsed = parse_filter(
            &value,
            &ParseFilterOptions {
                context: FilterContext::Using,
                variables: true,
                ..ParseFilterOptions::default()
            },
        )?;
        let text = json_stringify(&value);
        if text.contains("\"$ctx\"") || text.contains("\"$now\"") {
            return fail("only $auth variables are allowed in where");
        }
        if !parsed.has_variables {
            return fail("where must reference the subject through $auth");
        }
        if !is_ttl(&lookup.ttl) {
            return fail("ttl must look like 30s, 5m, 1h or 1d");
        }
    }
    Ok(())
}
