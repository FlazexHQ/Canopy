use std::collections::{HashMap, HashSet};

use canopy_protocol::json::write_json_string;

use crate::{CollectionSchema, Field, ObjectShape, ScalarType, Shape, js_cmp};

const BSON_IMPORTS: [&str; 8] =
    ["Binary", "BSONRegExp", "Decimal128", "Long", "MaxKey", "MinKey", "ObjectId", "Timestamp"];

/// Options for generating SDK types.
#[derive(Clone, Copy, Debug, Default)]
pub struct GenerateOptions<'a> {
    /// Module for BSON type imports. Defaults to Canopy.js.
    pub import_from: Option<&'a str>,
    /// A note in the header, such as the role used to restrict the schema.
    pub note: Option<&'a str>,
}

pub(crate) fn quote(value: &str) -> String {
    let mut output = String::new();
    write_json_string(&mut output, value);
    output
}

pub(crate) fn identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_alphabetic() || matches!(b, b'_' | b'$'))
        && bytes.all(|b| word(b) || b == b'$')
}

fn word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

pub(crate) fn property(value: &str) -> String {
    if identifier(value) { value.to_owned() } else { quote(value) }
}

pub(crate) fn sorted_schemas(schemas: &[CollectionSchema]) -> Vec<&CollectionSchema> {
    let mut schemas: Vec<_> = schemas.iter().collect();
    schemas.sort_by(|a, b| js_cmp(&a.name, &b.name));
    schemas
}

pub(crate) fn sorted_fields(shape: &ObjectShape) -> Vec<&(String, Field)> {
    let mut fields: Vec<_> = shape.fields.iter().collect();
    fields.sort_by(|(a, _), (b, _)| js_cmp(a, b));
    fields
}

fn scalar_type(scalar: ScalarType, values: Option<&[String]>) -> String {
    if scalar == ScalarType::String
        && let Some(values) = values.filter(|values| !values.is_empty())
    {
        return values.iter().map(|value| quote(value)).collect::<Vec<_>>().join(" | ");
    }
    match scalar {
        ScalarType::String => "string",
        ScalarType::Int | ScalarType::Double => "number",
        ScalarType::Long => "number | Long",
        ScalarType::Decimal => "Decimal128",
        ScalarType::Bool => "boolean",
        ScalarType::Date => "Date",
        ScalarType::ObjectId => "ObjectId",
        ScalarType::BinData | ScalarType::Uuid => "Binary",
        ScalarType::Null => "null",
        ScalarType::Timestamp => "Timestamp",
        ScalarType::Regex => "BSONRegExp",
        ScalarType::MinKey => "MinKey",
        ScalarType::MaxKey => "MaxKey",
        ScalarType::Javascript => "unknown",
    }
    .to_owned()
}

fn type_of(shape: &Shape, indent: &str) -> String {
    match shape {
        Shape::Any => "unknown".to_owned(),
        Shape::Scalar { scalar, values } => scalar_type(*scalar, values.as_deref()),
        Shape::Object(shape) => object_type(shape, indent, false),
        Shape::Array(item) => {
            let item = type_of(item, indent);
            if !item.is_empty() && item.bytes().all(word) {
                format!("{item}[]")
            } else {
                format!("({item})[]")
            }
        }
        Shape::Union(members) => {
            let mut parts = Vec::new();
            let mut seen = HashSet::new();
            for member in members {
                let ty = type_of(member, indent);
                let alternatives = if matches!(member, Shape::Scalar { .. }) {
                    ty.split(" | ").map(str::to_owned).collect()
                } else {
                    vec![ty]
                };
                parts.extend(alternatives.into_iter().filter(|part| seen.insert(part.clone())));
            }
            parts.join(" | ")
        }
    }
}

fn object_type(shape: &ObjectShape, indent: &str, optional_id: bool) -> String {
    if shape.fields.is_empty() {
        return "Record<string, unknown>".to_owned();
    }
    let inner = format!("{indent}  ");
    let lines = sorted_fields(shape)
        .into_iter()
        .map(|(name, field)| {
            let optional = if !field.required || (optional_id && name == "_id") { "?" } else { "" };
            format!("{inner}{}{optional}: {}", property(name), type_of(&field.shape, &inner))
        })
        .collect::<Vec<_>>();
    format!("{{\n{}\n{indent}}}", lines.join("\n"))
}

fn alias(name: &str) -> Option<String> {
    let mut alias = String::new();
    for part in name.split(|c: char| !c.is_ascii_alphanumeric()).filter(|part| !part.is_empty()) {
        let mut chars = part.chars();
        alias.extend(chars.next().map(|c| c.to_ascii_uppercase()));
        alias.push_str(chars.as_str());
    }
    (alias != "Database" && alias.starts_with(|c: char| c.is_ascii_uppercase())).then_some(alias)
}

fn contains_word(text: &str, name: &str) -> bool {
    text.split(|c: char| !c.is_ascii_alphanumeric() && c != '_').any(|part| part == name)
}

/// Emits the SDK's TypeScript Database interface and unambiguous collection aliases.
/// Each Insert type makes the root _id optional.
pub fn generate_types(schemas: &[CollectionSchema], options: &GenerateOptions<'_>) -> String {
    let schemas = sorted_schemas(schemas);
    let body: Vec<_> = schemas
        .iter()
        .map(|schema| {
            let document = object_type(&schema.shape, "    ", false);
            let insert = object_type(&schema.shape, "    ", true);
            format!("  {}: {{\n    Document: {document}\n    Insert: {insert}\n  }}", property(&schema.name))
        })
        .collect();
    let imports: Vec<_> =
        BSON_IMPORTS.into_iter().filter(|name| body.iter().any(|text| contains_word(text, name))).collect();
    let mut output = vec!["// Generated by canopy gen types. Do not edit.".to_owned()];
    if let Some(note) = options.note {
        output.push(format!("// {note}"));
    }
    if !imports.is_empty() {
        let module = quote(options.import_from.unwrap_or("canopy.js"));
        output.push(format!("import type {{ {} }} from {module}", imports.join(", ")));
        output.push(String::new());
    }
    output.push("export interface Database {".to_owned());
    output.extend(body);
    output.push("}".to_owned());

    let aliases: Vec<_> =
        schemas.iter().filter_map(|schema| Some((alias(&schema.name)?, &schema.name))).collect();
    let mut counts = HashMap::new();
    for (name, _) in &aliases {
        *counts.entry(name.clone()).or_insert(0) += 1;
    }
    let mut unique = aliases.into_iter().filter(|(name, _)| counts.get(name) == Some(&1)).peekable();
    if unique.peek().is_some() {
        output.push(String::new());
        output.extend(unique.map(|(name, collection)| {
            format!("export type {name} = Database[{}][\"Document\"]", quote(collection))
        }));
    }
    output.push(String::new());
    output.join("\n")
}
