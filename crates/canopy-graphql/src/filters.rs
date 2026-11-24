//! GraphQL inputs turned into MongoDB documents: filters, sorts, update operators and inserted documents,
//! with GraphQL field names mapped back to document fields.

use crate::build::FieldMap;
use crate::values::Input;
use canopy_protocol::{Document, Value};

const OPERATORS: [(&str, &str); 11] = [
    ("eq", "$eq"),
    ("ne", "$ne"),
    ("gt", "$gt"),
    ("gte", "$gte"),
    ("lt", "$lt"),
    ("lte", "$lte"),
    ("in", "$in"),
    ("nin", "$nin"),
    ("exists", "$exists"),
    ("regex", "$regex"),
    ("options", "$options"),
];

/// The message of an input that is not a document where one is needed, as a field error reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotADocument(pub &'static str);

fn condition(ops: &[(String, Input)]) -> Option<Document> {
    let mut out = Document::new();
    let regex = ops.iter().any(|(name, _)| name == "regex");
    for (name, value) in ops {
        let Some((_, operator)) = OPERATORS.iter().find(|(key, _)| key == name) else { continue };
        if name == "options" && !regex {
            continue;
        }
        out.insert(*operator, value.to_value());
    }
    if out.is_empty() { None } else { Some(out) }
}

fn plain_document(value: &Value) -> Option<&Document> {
    match value {
        Value::Document(document) => Some(document),
        _ => None,
    }
}

/// Translates a filter input (`{ status: { eq: "active" }, or: [...] }`) into a MongoDB filter. `raw` holds an
/// Extended JSON filter that is added as is; the read and write paths validate every part like REST filters.
pub fn to_mongo_filter(input: Option<&Input>, map: &FieldMap) -> Result<Document, NotADocument> {
    let Some(Input::Object(fields)) = input else { return Ok(Document::new()) };
    let mut base = Document::new();
    let mut extra: Vec<Document> = Vec::new();
    for (key, value) in fields {
        if matches!(value, Input::Null) {
            continue;
        }
        if matches!(key.as_str(), "and" | "or" | "nor") {
            let parts = match value {
                Input::List(items) => items
                    .iter()
                    .map(|part| to_mongo_filter(Some(part), map).map(Value::Document))
                    .collect::<Result<Vec<_>, _>>()?,
                other => vec![Value::Document(to_mongo_filter(Some(other), map)?)],
            };
            if !parts.is_empty() {
                let mut part = Document::new();
                part.insert(format!("${key}"), Value::Array(parts));
                extra.push(part);
            }
            continue;
        }
        if key == "raw" {
            let raw = value.to_value();
            let Some(document) = plain_document(&raw) else {
                return Err(NotADocument("raw must be a filter document"));
            };
            if !document.is_empty() {
                extra.push(document.clone());
            }
            continue;
        }
        let (Some(field), Input::Object(ops)) = (map.get(key), value) else { continue };
        if let Some(ops) = condition(ops) {
            base.insert(field, Value::Document(ops));
        }
    }
    let mut parts = Vec::with_capacity(extra.len() + 1);
    if !base.is_empty() {
        parts.push(base);
    }
    parts.extend(extra);
    Ok(match parts.len() {
        0 => Document::new(),
        1 => parts.pop().unwrap_or_default(),
        _ => {
            let mut and = Document::new();
            and.insert("$and", Value::Array(parts.into_iter().map(Value::Document).collect()));
            and
        }
    })
}

/// Translates `[{ field: createdAt, direction: DESC }]` into `{ createdAt: -1 }`; `None` for no keys.
pub fn to_mongo_sort(input: Option<&Input>) -> Option<Document> {
    let Some(Input::List(keys)) = input else { return None };
    if keys.is_empty() {
        return None;
    }
    let mut out = Document::new();
    for key in keys {
        let Some(Input::Enum(field) | Input::String(field)) = key.get("field") else { continue };
        let descending = matches!(key.get("direction"), Some(Input::Enum(direction)) if direction == "DESC");
        out.insert(field, Value::Int32(if descending { -1 } else { 1 }));
    }
    Some(out)
}

fn rename_fields(fields: &[(String, Input)], map: &FieldMap) -> Document {
    let mut out = Document::new();
    for (key, value) in fields {
        if let Some(field) = map.get(key) {
            out.insert(field, value.to_value());
        }
    }
    out
}

fn merge(out: &mut Document, operator: &str, values: Document) {
    if values.is_empty() {
        return;
    }
    match out.get_mut(operator) {
        Some(Value::Document(existing)) => {
            for (key, value) in values.iter() {
                existing.insert(key, value.clone());
            }
        }
        _ => {
            out.insert(operator, Value::Document(values));
        }
    }
}

/// Translates an update input (`{ set, unset, inc, raw }`) into an update document. `raw` holds Extended JSON
/// update operators, merged with the typed ones.
pub fn to_mongo_update(input: Option<&Input>, map: &FieldMap) -> Result<Document, NotADocument> {
    let mut out = Document::new();
    if let Some(Input::Object(set)) = input.and_then(|input| input.get("set")) {
        merge(&mut out, "$set", rename_fields(set, map));
    }
    if let Some(Input::Object(inc)) = input.and_then(|input| input.get("inc")) {
        merge(&mut out, "$inc", rename_fields(inc, map));
    }
    if let Some(Input::List(names)) = input.and_then(|input| input.get("unset")) {
        let mut unset = Document::new();
        for name in names {
            if let Input::Enum(field) | Input::String(field) = name {
                unset.insert(field, Value::String(String::new()));
            }
        }
        merge(&mut out, "$unset", unset);
    }
    match input.and_then(|input| input.get("raw")) {
        None | Some(Input::Null) => {}
        Some(raw) => {
            let raw = raw.to_value();
            let Some(document) = plain_document(&raw) else {
                return Err(NotADocument("raw must be an update document"));
            };
            for (operator, values) in document.iter() {
                match values {
                    Value::Document(values) => merge(&mut out, operator, values.clone()),
                    other => {
                        out.insert(operator, other.clone());
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Builds a document from an insert input: typed fields renamed, over the open `_extra` fields.
pub fn to_mongo_document(input: &Input, map: &FieldMap) -> Result<Value, NotADocument> {
    let Input::Object(fields) = input else { return Ok(input.to_value()) };
    let typed = rename_fields(fields, map);
    match input.get("_extra") {
        None | Some(Input::Null) => Ok(Value::Document(typed)),
        Some(extra) => {
            let extra = extra.to_value();
            let Some(document) = plain_document(&extra) else {
                return Err(NotADocument("_extra must be a document"));
            };
            let mut out = document.clone();
            for (key, value) in typed.iter() {
                out.insert(key, value.clone());
            }
            Ok(Value::Document(out))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_protocol::ejson::canonical_string;

    fn map(pairs: &[(&str, &str)]) -> FieldMap {
        FieldMap {
            fields: pairs.iter().map(|(gql, field)| ((*gql).to_owned(), (*field).to_owned())).collect(),
        }
    }

    fn object(fields: Vec<(&str, Input)>) -> Input {
        Input::Object(fields.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
    }

    fn text(document: &Document) -> String {
        canonical_string(&Value::Document(document.clone())).unwrap_or_default()
    }

    #[test]
    fn filters_map_fields_and_combine_logical_parts() {
        let fields = map(&[("_id", "_id"), ("first_name", "first-name"), ("done", "done")]);
        let input = object(vec![
            ("or", Input::List(vec![object(vec![("done", object(vec![("eq", Input::Bool(true))]))])])),
            (
                "first_name",
                object(vec![("eq", Input::String("a".into())), ("options", Input::String("i".into()))]),
            ),
            ("done", Input::Null),
            ("unknown", object(vec![("eq", Input::Int(1))])),
            ("raw", Input::Bson(Value::Document(Document::new()))),
        ]);
        let filter = to_mongo_filter(Some(&input), &fields).unwrap_or_default();
        assert_eq!(
            text(&filter),
            r#"{"$and":[{"first-name":{"$eq":"a"}},{"$or":[{"done":{"$eq":true}}]}]}"#,
            "options without regex is dropped, an empty raw is skipped"
        );
        let only_base =
            object(vec![("done", object(vec![("ne", Input::Null), ("exists", Input::Bool(true))]))]);
        assert_eq!(
            text(&to_mongo_filter(Some(&only_base), &fields).unwrap_or_default()),
            r#"{"done":{"$ne":null,"$exists":true}}"#
        );
        assert_eq!(to_mongo_filter(None, &fields), Ok(Document::new()));
        let not_document = object(vec![("raw", Input::Bson(Value::Int32(1)))]);
        assert_eq!(
            to_mongo_filter(Some(&not_document), &fields),
            Err(NotADocument("raw must be a filter document"))
        );
    }

    #[test]
    fn sorts_updates_and_documents_follow_the_typescript_translation() {
        let sort = Input::List(vec![
            object(vec![
                ("field", Input::Enum("createdAt".into())),
                ("direction", Input::Enum("DESC".into())),
            ]),
            object(vec![("field", Input::Enum("_id".into())), ("direction", Input::Enum("ASC".into()))]),
        ]);
        assert_eq!(
            text(&to_mongo_sort(Some(&sort)).unwrap_or_default()),
            r#"{"createdAt":{"$numberInt":"-1"},"_id":{"$numberInt":"1"}}"#
        );
        assert_eq!(to_mongo_sort(Some(&Input::List(Vec::new()))), None);

        let fields = map(&[("title", "title"), ("n", "count")]);
        let mut raw_set = Document::new();
        raw_set.insert("extra", Value::Bool(true));
        let mut raw = Document::new();
        raw.insert("$set", Value::Document(raw_set));
        raw.insert("$currentDate", Value::Bool(true));
        let update = object(vec![
            ("raw", Input::Bson(Value::Document(raw))),
            ("set", object(vec![("title", Input::String("x".into()))])),
            ("inc", object(vec![("n", Input::Int(2))])),
            ("unset", Input::List(vec![Input::Enum("count".into())])),
        ]);
        assert_eq!(
            text(&to_mongo_update(Some(&update), &fields).unwrap_or_default()),
            r#"{"$set":{"title":"x","extra":true},"$inc":{"count":{"$numberInt":"2"}},"$unset":{"count":""},"$currentDate":true}"#
        );

        let mut extra = Document::new();
        extra.insert("title", Value::String("hidden".into()));
        extra.insert("other", Value::Int32(1));
        let doc = object(vec![
            ("title", Input::String("typed".into())),
            ("_extra", Input::Bson(Value::Document(extra))),
        ]);
        assert_eq!(
            canonical_string(&to_mongo_document(&doc, &fields).unwrap_or(Value::Null)).unwrap_or_default(),
            r#"{"title":"typed","other":{"$numberInt":"1"}}"#,
            "typed fields override _extra in its position"
        );
    }
}
