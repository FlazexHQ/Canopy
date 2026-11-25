use canopy_matcher::is_linear_regex;
use canopy_protocol::{Document, Value};
use canopy_query::strip_indexes;

use crate::{
    CollectionPolicies, ContextDefinitions, FieldKind, FieldRule, Operation, PolicyKind, Role, claim_paths,
    equality_fields,
};

/// Additional information used by collection lint rules.
#[derive(Default)]
pub struct LintEnvironment<'a> {
    /// Roles emitted by configured issuers.
    pub known_roles: Option<&'a [String]>,
    /// Indexed field prefixes by collection.
    pub indexes: &'a [(String, Vec<Vec<String>>)],
    /// Sampled field paths by collection.
    pub fields: &'a [(String, Vec<String>)],
}

/// One authoring diagnostic, in the wire format used by the admin API.
#[derive(Debug, Clone, PartialEq)]
pub struct LintFinding {
    /// Stable lint rule identifier.
    pub rule: &'static str,
    /// Whether the finding is an error, warning or informational.
    pub severity: &'static str,
    /// Collection affected by the finding.
    pub collection: String,
    /// Policy affected by the finding, when applicable.
    pub policy: Option<String>,
    /// Human readable diagnostic.
    pub message: String,
}

impl LintFinding {
    /// Encodes the finding in TypeScript field order.
    pub fn to_value(&self) -> Value {
        let mut out = Document::new();
        let policy_first = self.policy.as_ref().filter(|_| self.rule != "unknown-field");
        if let Some(policy) = policy_first {
            out.insert("collection", Value::String(self.collection.clone()));
            out.insert("policy", Value::String(policy.clone()));
        }
        out.insert("rule", Value::String(self.rule.to_owned()));
        out.insert("severity", Value::String(self.severity.to_owned()));
        if policy_first.is_none() {
            out.insert("collection", Value::String(self.collection.clone()));
            if let Some(policy) = &self.policy {
                out.insert("policy", Value::String(policy.clone()));
            }
        }
        out.insert("message", Value::String(self.message.clone()));
        Value::Document(out)
    }
}

fn nonlinear_regexes<'a>(value: &'a Value, patterns: &mut Vec<&'a str>) {
    let mut check = |pattern: &'a str, options: &str| {
        if !is_linear_regex(pattern, options) {
            patterns.push(pattern);
        }
    };
    match value {
        Value::Regex(regex) => check(&regex.pattern, &regex.options),
        Value::Document(document) => {
            if let Some(pattern) = document.get("$regex").and_then(Value::as_str) {
                check(pattern, document.get("$options").and_then(Value::as_str).unwrap_or_default());
            }
            for (_, item) in document.iter() {
                nonlinear_regexes(item, patterns);
            }
        }
        Value::Array(items) => {
            for item in items {
                nonlinear_regexes(item, patterns);
            }
        }
        _ => {}
    }
}

fn clause_paths<'a>(clause: &'a Document, paths: &mut Vec<&'a str>) {
    for (key, value) in clause.iter() {
        if matches!(key, "$and" | "$or" | "$nor") {
            for item in value.as_array().unwrap_or_default() {
                if let Some(item) = item.as_document() {
                    clause_paths(item, paths);
                }
            }
        } else if !key.starts_with('$') && !paths.contains(&key) {
            paths.push(key);
        }
    }
}

type Add<'a> = dyn FnMut(&'static str, &'static str, Option<&str>, String) + 'a;

const KINDS: [FieldKind; 3] = [FieldKind::Read, FieldKind::Write, FieldKind::Update];

fn lint_fields(definition: &CollectionPolicies, known: &[String], add: &mut Add<'_>) {
    let known: Vec<_> = known.iter().map(|path| strip_indexes(path)).collect();
    let mut report = |path: &str, location: &str, policy: Option<&str>| {
        let normalized = strip_indexes(path);
        if normalized != "_id"
            && !normalized.starts_with("_id.")
            && !known.iter().any(|other| canopy_query::paths_overlap(other, &normalized))
        {
            add(
                "unknown-field",
                "warn",
                policy,
                format!(
                    "{location} names the field {path}, which no sampled document of {} has",
                    definition.collection
                ),
            );
        }
    };
    for policy in &definition.policies {
        for (location, clause) in [("where", &policy.using), ("check", &policy.check)] {
            if let Some(clause) = clause {
                let mut paths = Vec::new();
                clause_paths(clause, &mut paths);
                for path in paths {
                    report(path, location, Some(&policy.name));
                }
            }
        }
    }
    for kind in KINDS {
        if let Some(rules) = definition.fields.as_ref().and_then(|fields| fields.get(kind)) {
            for (role, rule) in rules {
                let (mode, paths) = match rule {
                    FieldRule::Only(paths) => ("only", paths),
                    FieldRule::Omit(paths) => ("omit", paths),
                };
                for path in paths.iter().filter(|path| *path != "*") {
                    report(path, &format!("fields.{}.{role}.{mode}", kind.as_str()), None);
                }
            }
        }
    }
    for path in definition.immutable.as_deref().unwrap_or_default() {
        report(path, "immutable", None);
    }
}

fn lint_definition(definition: &CollectionPolicies, env: &LintEnvironment<'_>, add: &mut Add<'_>) {
    if definition.exposed
        && !definition
            .policies
            .iter()
            .any(|policy| policy.kind == PolicyKind::Permissive && policy.ops.contains(&Operation::Read))
    {
        add(
            "exposed-without-read-policy",
            "warn",
            None,
            "The collection is exposed but no permissive policy grants read, so nobody can read it"
                .to_owned(),
        );
    }
    let indexes = env.indexes.iter().find(|(name, _)| name == &definition.collection);
    for policy in &definition.policies {
        let mut report = |rule, severity, message| add(rule, severity, Some(&policy.name), message);
        let writes: Vec<_> = policy
            .ops
            .iter()
            .copied()
            .filter(|op| matches!(op, Operation::Insert | Operation::Update | Operation::Delete))
            .collect();
        if policy.kind == PolicyKind::Permissive
            && !writes.is_empty()
            && policy.roles.iter().any(|role| matches!(role.as_str(), Role::PUBLIC | Role::ANON))
        {
            let clause = if writes.contains(&Operation::Insert) {
                policy.check.as_ref().or(policy.using.as_ref())
            } else {
                policy.using.as_ref()
            };
            if clause.is_none_or(Document::is_empty) {
                let ops = writes.iter().map(|op| op.as_str()).collect::<Vec<_>>().join(", ");
                report(
                    "public-allow-all",
                    "error",
                    format!("Anyone, including anon, may {ops} any document"),
                );
            }
        }
        for clause in [&policy.using, &policy.check].into_iter().flatten() {
            for path in claim_paths(&Value::Document(clause.clone())) {
                if path == "user_metadata" || path.starts_with("user_metadata.") {
                    report(
                        "user-editable-claim",
                        "error",
                        format!(
                            "The claim {path} can be edited by the user, so it must not drive authorization"
                        ),
                    );
                }
            }
        }
        if let Some(using) = &policy.using {
            let value = Value::Document(using.clone());
            let mut patterns = Vec::new();
            nonlinear_regexes(&value, &mut patterns);
            for pattern in patterns {
                report(
                    "regex-not-linear",
                    "error",
                    format!("The using regex /{pattern}/ needs backtracking and cannot run in process"),
                );
            }
        }
        if policy.ops.contains(&Operation::Update) && policy.check.is_none() && policy.using.is_some() {
            report("update-without-check", "info",
                "The using clause doubles as the update check, so an update may not move a document out of it".to_owned());
        }
        if let Some(known) = env.known_roles {
            for role in &policy.roles {
                if !matches!(role.as_str(), Role::PUBLIC | Role::ANON | Role::AUTHENTICATED)
                    && !known.contains(role)
                {
                    report("unreachable-role", "info", format!("No token issuer emits the role {role}"));
                }
            }
        }
        if let Some((_, indexes)) = indexes
            && let Some(using) = &policy.using
        {
            for field in equality_fields(&Value::Document(using.clone())) {
                if !indexes.iter().any(|index| index.first() == Some(&field)) {
                    report(
                        "missing-index",
                        "warn",
                        format!("No index starts with {field}, which this policy filters on for every query"),
                    );
                }
            }
        }
    }
    if let Some((_, known)) =
        env.fields.iter().find(|(name, fields)| name == &definition.collection && !fields.is_empty())
    {
        lint_fields(definition, known, add);
    }
    for kind in KINDS {
        if let Some(rules) = definition.fields.as_ref().and_then(|fields| fields.get(kind))
            && !rules.is_empty()
            && !rules.iter().any(|(role, _)| role == "default")
        {
            let roles = rules.iter().map(|(role, _)| role.as_str()).collect::<Vec<_>>().join(", ");
            add(
                "field-rules-partial",
                "warn",
                None,
                format!(
                    "fields.{} has rules for {roles} but no default, so every other role can access all fields",
                    kind.as_str()
                ),
            );
        }
    }
}

/// Runs the authoring lint rules in the same order as the TypeScript policy package.
pub fn lint_policies(
    definitions: &[CollectionPolicies],
    contexts: &ContextDefinitions,
    env: &LintEnvironment<'_>,
) -> Vec<LintFinding> {
    let mut findings = Vec::new();
    for definition in definitions {
        lint_definition(definition, env, &mut |rule, severity, policy, message| {
            findings.push(LintFinding {
                rule,
                severity,
                collection: definition.collection.clone(),
                policy: policy.map(str::to_owned),
                message,
            });
        });
    }
    for (name, lookup) in contexts {
        if !(1.0..=9_007_199_254_740_991.0).contains(&lookup.max) || lookup.max.fract() != 0.0 {
            findings.push(LintFinding {
                rule: "ctx-unbounded",
                severity: "error",
                collection: lookup.from.clone(),
                policy: None,
                message: format!("The context lookup {name} has no max"),
            });
        }
    }
    findings
}
