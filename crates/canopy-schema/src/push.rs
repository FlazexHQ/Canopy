use canopy_protocol::{Document, Value};

use crate::diff::{bson_type, sorted_schemas};
use crate::{CollectionSchema, ObjectShape, ScalarType, Shape, field_cmp, js_cmp};

/// Builds the MongoDB `$jsonSchema` definition for one shape.
pub fn to_validator(shape: &Shape) -> Document {
    match shape {
        Shape::Any => Document::new(),
        Shape::Scalar { scalar, values } => {
            let mut doc = typed(bson_type(*scalar));
            if *scalar == ScalarType::String
                && let Some(values) = values
            {
                doc.insert("enum", strings(values.iter().map(String::as_str)));
            }
            doc
        }
        Shape::Array(items) => {
            let mut doc = typed("array");
            doc.insert("items", Value::Document(to_validator(items)));
            doc
        }
        Shape::Object(object) => object_validator(object),
        Shape::Union(parts) => {
            if parts.iter().any(|part| matches!(part, Shape::Any)) {
                return Document::new();
            }
            let mut types = Vec::new();
            for part in parts {
                match part {
                    Shape::Scalar { scalar, values } if *scalar != ScalarType::String || values.is_none() => {
                        let name = bson_type(*scalar);
                        if !types.contains(&name) {
                            types.push(name);
                        }
                    }
                    _ => {
                        return [(
                            "anyOf".to_owned(),
                            Value::Array(
                                parts.iter().map(|part| Value::Document(to_validator(part))).collect(),
                            ),
                        )]
                        .into_iter()
                        .collect();
                    }
                }
            }
            [("bsonType".to_owned(), strings(types))].into_iter().collect()
        }
    }
}

fn strings<'a>(items: impl IntoIterator<Item = &'a str>) -> Value {
    Value::Array(items.into_iter().map(|item| Value::String(item.to_owned())).collect())
}

fn typed(name: &str) -> Document {
    [("bsonType".to_owned(), Value::String(name.to_owned()))].into_iter().collect()
}

fn object_validator(object: &ObjectShape) -> Document {
    let mut doc = typed("object");
    let mut fields: Vec<_> = object.fields.iter().collect();
    fields.sort_by(|(a, _), (b, _)| js_cmp(a, b));
    let required: Vec<_> =
        fields.iter().filter(|(_, field)| field.required).map(|(name, _)| name.as_str()).collect();
    if !required.is_empty() {
        doc.insert("required", strings(required));
    }
    fields.sort_by(|(a, _), (b, _)| field_cmp(a, b));
    let properties = fields
        .into_iter()
        .map(|(name, field)| (name.clone(), Value::Document(to_validator(&field.shape))))
        .collect();
    doc.insert("properties", Value::Document(properties));
    if !object.open {
        doc.insert("additionalProperties", Value::Bool(false));
    }
    doc
}

fn equal_documents(a: &Document, b: &Document) -> bool {
    a.len() == b.len() && a.iter().all(|(key, value)| b.get(key).is_some_and(|other| equal(value, other)))
}

fn equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Document(a), Value::Document(b)) => equal_documents(a, b),
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equal(a, b)),
        _ => a == b,
    }
}

/// A validator command to execute after confirmation.
#[derive(Debug, PartialEq)]
pub struct ValidatorChange {
    /// The MongoDB `create` or `collMod` command, including the validator.
    pub command: Document,
    /// The line to print after this command succeeds.
    pub applied_line: String,
}

/// The output and commands for `schema push`, ordered by collection name.
#[derive(Debug, PartialEq)]
pub struct SchemaPushPlan {
    /// Lines to print before asking for confirmation.
    pub logs: Vec<String>,
    /// The confirmation question when there are changes.
    pub question: Option<String>,
    /// Commands to execute only after confirmation or with `--yes`.
    pub changes: Vec<ValidatorChange>,
}

/// Compares proposed validators with the metadata from MongoDB.
/// An entry with no validator represents an existing collection without validation. An omitted entry
/// represents a collection that must be created.
pub fn schema_push(
    database: &str,
    declared: &[CollectionSchema],
    existing: &[(&str, Option<&Document>)],
) -> SchemaPushPlan {
    let mut logs = Vec::new();
    let mut changes = Vec::new();
    for schema in sorted_schemas(declared) {
        let name = &schema.name;
        let validator = [("$jsonSchema".to_owned(), Value::Document(object_validator(&schema.shape)))]
            .into_iter()
            .collect();
        let info = existing.iter().find(|(collection, _)| collection == name);
        if info.and_then(|(_, current)| *current).is_some_and(|current| equal_documents(current, &validator))
        {
            continue;
        }
        let (operation, line, applied_line) = if info.is_some() {
            ("collMod", format!("update validator of {name}"), format!("updated validator of {name}"))
        } else {
            ("create", format!("create {name}"), format!("created {name}"))
        };
        let command = [
            (operation.to_owned(), Value::String(name.clone())),
            ("validator".to_owned(), Value::Document(validator)),
        ]
        .into_iter()
        .collect();
        logs.push(line);
        changes.push(ValidatorChange { command, applied_line });
    }
    let question = if changes.is_empty() {
        logs.push("validators are up to date".to_owned());
        None
    } else {
        Some(format!("Apply these validators to {database}?"))
    };
    SchemaPushPlan { logs, question, changes }
}
