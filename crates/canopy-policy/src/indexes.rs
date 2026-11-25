use std::cmp::Reverse;
use std::collections::BTreeMap;

use canopy_protocol::json::{Json, write_json};
use canopy_protocol::{Document, Value};

use crate::values::{js_cmp, js_order};
use crate::{PolicySet, equality_fields};

/// A suggested ascending index and the clauses it serves.
#[derive(Debug, PartialEq, Eq)]
pub struct IndexAdvice {
    /// The collection to index.
    pub collection: String,
    /// The fields in index order.
    pub fields: Vec<String>,
    /// The policies and context lookups served by the index.
    pub reasons: Vec<String>,
}

fn same_set(a: &[String], b: &[String]) -> bool {
    a.len() == b.len() && a.iter().all(|field| b.contains(field))
}

fn covers(key: &[String], fields: &[String]) -> bool {
    key.get(..fields.len()).is_some_and(|prefix| same_set(prefix, fields))
}

fn ordered_keys(fields: &[String]) -> Vec<String> {
    js_order(fields.iter().cloned().map(|field| (field, ())).collect())
        .into_iter()
        .map(|(field, ())| field)
        .collect()
}

fn add_reason(reasons: &mut Vec<String>, reason: String) {
    if !reasons.contains(&reason) {
        reasons.push(reason);
    }
}

/// Suggests indexes for policy `using` and context lookup `where` clauses.
///
/// Supply existing collections as map keys and each collection's indexes as ordered field lists.
/// An index serves a suggestion when its leading fields have the same field set.
pub fn advise_indexes(set: &PolicySet, existing: &BTreeMap<String, Vec<Vec<String>>>) -> Vec<IndexAdvice> {
    let mut by_collection = BTreeMap::<&str, Vec<IndexAdvice>>::new();
    let mut add = |collection, fields: Vec<String>, reason| {
        if fields.is_empty() {
            return;
        }
        let suggestions = by_collection.entry(collection).or_default();
        if let Some(same) = suggestions.iter_mut().find(|entry| same_set(&entry.fields, &fields)) {
            add_reason(&mut same.reasons, reason);
        } else {
            suggestions.push(IndexAdvice {
                collection: String::from(collection),
                fields,
                reasons: vec![reason],
            });
        }
    };
    for def in set.collections() {
        for policy in &def.policies {
            if let Some(filter) = &policy.using {
                add(
                    def.collection.as_str(),
                    equality_fields(&Value::Document(filter.clone())),
                    format!("policy \"{}\"", policy.name),
                );
            }
        }
    }
    for (name, lookup) in set.contexts() {
        add(
            lookup.from.as_str(),
            equality_fields(&Value::Document(lookup.filter.clone())),
            format!("context lookup {name}"),
        );
    }

    let mut collections: Vec<_> = by_collection.into_iter().collect();
    collections.sort_by(|(a, _), (b, _)| js_cmp(a, b));
    let mut advice: Vec<IndexAdvice> = Vec::new();
    for (collection, mut needed) in collections {
        if !collection.starts_with("system.")
            && let Some(indexes) = existing.get(collection)
        {
            let indexes: Vec<_> = indexes.iter().map(|key| ordered_keys(key)).collect();
            needed.retain(|entry| !indexes.iter().any(|key| covers(key, &entry.fields)));
        }
        needed.sort_by_key(|entry| Reverse(entry.fields.len()));
        let mut targets: Vec<(Vec<String>, usize)> = Vec::new();
        for entry in needed {
            let fields = entry.fields.clone();
            let target = targets.iter().find(|(key, _)| covers(key, &fields)).map(|(_, target)| *target);
            if let Some(target) = target
                && let Some(into) = advice.get_mut(target)
            {
                for reason in entry.reasons {
                    add_reason(&mut into.reasons, reason);
                }
                targets.push((fields, target));
            } else {
                targets.push((fields, advice.len()));
                advice.push(entry);
            }
        }
    }
    advice
}

/// How to handle confirmation before creating indexes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexMode {
    /// Print suggestions and a summary.
    Advise,
    /// Create indexes after `--yes` or an affirmative reply.
    CreateConfirmed,
    /// Get the prompt for a terminal reply before creating indexes.
    CreatePrompt,
    /// Refuse creation when confirmation requires a terminal and none is available.
    CreateWithoutTerminal,
    /// Refuse creation after a negative reply.
    CreateDeclined,
}

/// One MongoDB operation and the line to print after it succeeds.
#[derive(Debug, PartialEq)]
pub struct IndexCreation {
    /// The command document to run on the application database.
    pub command: Document,
    /// The output line to print on success, without a newline.
    pub applied_line: String,
}

/// Output and database commands for an index invocation.
#[derive(Debug, Default, PartialEq)]
pub struct IndexPlan {
    /// Standard output lines to print before running commands, without newlines.
    pub logs: Vec<String>,
    /// Standard error lines, without newlines.
    pub errors: Vec<String>,
    /// The status to return if all planned commands succeed.
    pub exit_code: i32,
    /// The prompt to display if a terminal reply is needed, before replanning with its result.
    pub confirmation_question: Option<String>,
    /// Commands to run sequentially, each followed by its success line.
    pub creations: Vec<IndexCreation>,
}

fn shell_command(entry: &IndexAdvice) -> String {
    let mut line = String::from("db.getCollection(");
    write_json(&mut line, &Json::String(entry.collection.clone()));
    line.push_str(").createIndex(");
    let key = ordered_keys(&entry.fields).into_iter().map(|field| (field, Json::Number(1.0))).collect();
    write_json(&mut line, &Json::Object(key));
    line.push(')');
    line
}

fn creation(entry: &IndexAdvice) -> IndexCreation {
    let fields = ordered_keys(&entry.fields);
    let name = fields.iter().map(|field| format!("{field}_1")).collect::<Vec<_>>().join("_");
    let key = fields.into_iter().map(|field| (field, Value::Int32(1))).collect();
    let spec: Document =
        [("name".to_owned(), Value::String(name.clone())), ("key".to_owned(), Value::Document(key))]
            .into_iter()
            .collect();
    let command = [
        ("createIndexes".to_owned(), Value::String(entry.collection.clone())),
        ("indexes".to_owned(), Value::Array(vec![Value::Document(spec)])),
    ]
    .into_iter()
    .collect();
    IndexCreation { command, applied_line: format!("created {}.{name}", entry.collection) }
}

/// Plans the output and MongoDB commands for `indexes advise` or `indexes create`.
///
/// Include every collection reported by MongoDB in `existing`, even if it has no indexes.
/// Suggestions for absent collections are printed without scheduling a creation.
pub fn plan_indexes(
    database: &str,
    set: &PolicySet,
    existing: &BTreeMap<String, Vec<Vec<String>>>,
    mode: IndexMode,
) -> IndexPlan {
    let mut plan = IndexPlan::default();
    let advice = advise_indexes(set, existing);
    if advice.is_empty() {
        plan.logs.push("Every policy equality field is served by an index.".to_owned());
        return plan;
    }
    let (ready, absent): (Vec<_>, Vec<_>) =
        advice.into_iter().partition(|entry| existing.contains_key(&entry.collection));
    for entry in &ready {
        plan.logs.push(shell_command(entry));
        plan.logs.push(format!("  for {}", entry.reasons.join(", ")));
    }
    for entry in absent {
        plan.logs.push(format!(
            "{} does not exist yet; once it does, index {} (for {})",
            entry.collection,
            entry.fields.join(", "),
            entry.reasons.join(", "),
        ));
    }

    let count = ready.len();
    let noun = if count == 1 { "index" } else { "indexes" };
    match mode {
        IndexMode::Advise => {
            let suffix = if count > 0 { " Run canopy indexes create to build them." } else { "" };
            plan.logs.push(format!("{count} {noun} suggested on {database}.{suffix}"));
        }
        _ if count == 0 => {}
        IndexMode::CreateConfirmed => plan.creations = ready.iter().map(creation).collect(),
        IndexMode::CreatePrompt => {
            plan.confirmation_question = Some(format!("Create {count} {noun} on {database}?"))
        }
        IndexMode::CreateWithoutTerminal => {
            plan.exit_code = 1;
            plan.errors.push(
                "Not applied: no terminal to confirm on. Pass --yes to apply without a prompt.".to_owned(),
            );
        }
        IndexMode::CreateDeclined => {
            plan.exit_code = 1;
            plan.logs.push("Not applied.".to_owned());
        }
    }
    plan
}
