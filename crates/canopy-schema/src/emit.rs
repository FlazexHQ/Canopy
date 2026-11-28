use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use crate::typescript::{identifier, property, quote, sorted_schemas};
use crate::{CollectionSchema, ObjectShape, ScalarType, SchemaSource, Shape, js_cmp};

/// Options for writing an editable schema definition.
#[derive(Clone, Copy, Debug, Default)]
pub struct EmitOptions<'a> {
    /// Write JavaScript without a TypeScript module augmentation.
    pub js: bool,
    /// Module for builder imports. Defaults to canopy.js/schema.
    pub import_from: Option<&'a str>,
    /// Module to augment in TypeScript. Defaults to canopy.js.
    pub register_module: Option<&'a str>,
}

const RESERVED: &str = "arguments await break case catch class const continue debugger default delete do else enum eval \
    export extends false finally for function if implements import in instanceof interface let new \
    null package private protected public return static super switch this throw true try typeof \
    var void while with yield schema collection defineSchema t";
const REVIEW: &str = "inferred from sampled documents, review";

fn binding(name: &str, used: &HashSet<String>) -> String {
    static ACRONYM: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"([A-Z])([A-Z][a-z])").ok());
    static CAMEL: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"([a-z0-9])([A-Z])").ok());
    let expanded = ACRONYM.as_ref().map_or_else(|| name.into(), |re| re.replace_all(name, "$1 $2"));
    let expanded =
        CAMEL.as_ref().map_or_else(|| expanded.as_ref().into(), |re| re.replace_all(&expanded, "$1 $2"));
    let lower = expanded.to_lowercase();
    let mut camel = String::new();
    for part in lower.split(|c: char| !c.is_ascii_alphanumeric()).filter(|part| !part.is_empty()) {
        if camel.is_empty() {
            camel.push_str(part);
        } else {
            let mut chars = part.chars();
            camel.extend(chars.next().map(|c| c.to_ascii_uppercase()));
            camel.push_str(chars.as_str());
        }
    }
    if identifier(&camel) && !used.contains(&camel) {
        return camel;
    }
    let prefix = if !camel.is_empty() && !identifier(&camel) { "_" } else { "" };
    unique_binding(format!("{prefix}{camel}Collection"), |name| used.contains(name))
}

fn unique_binding(base: String, is_used: impl Fn(&str) -> bool) -> String {
    let mut name = base.clone();
    let mut suffix = 2;
    while is_used(&name) {
        name = format!("{base}{suffix}");
        suffix += 1;
    }
    name
}

fn note(notes: &mut Vec<String>, text: &str) {
    if !notes.iter().any(|note| note == text) {
        notes.push(text.to_owned());
    }
}

fn fields(shape: &ObjectShape, indent: &str, inferred: bool, root: bool) -> String {
    let inner = format!("{indent}  ");
    let mut fields: Vec<_> = shape.fields.iter().collect();
    fields.sort_by(|(a, _), (b, _)| (a != "_id").cmp(&(b != "_id")).then_with(|| js_cmp(a, b)));
    let mut lines = Vec::new();
    for (key, field) in fields {
        let id = root && key == "_id";
        if id && field.required && matches!(field.shape, Shape::Scalar { scalar: ScalarType::ObjectId, .. }) {
            continue;
        }
        let mut notes = Vec::new();
        let mut value = expression(&field.shape, &inner, inferred, &mut notes);
        if !id && !field.required {
            value.push_str(".optional()");
            if inferred {
                note(&mut notes, REVIEW);
            }
        }
        let key = if key == "__proto__" { "[\"__proto__\"]".to_owned() } else { property(key) };
        let comments: String = notes.iter().map(|note| format!(" // TODO(canopy pull): {note}")).collect();
        lines.push(format!("{inner}{key}: {value},{comments}"));
    }
    if lines.is_empty() { "{}".to_owned() } else { format!("{{\n{}\n{indent}}}", lines.join("\n")) }
}

fn expression(shape: &Shape, indent: &str, inferred: bool, notes: &mut Vec<String>) -> String {
    match shape {
        Shape::Any => "t.any()".to_owned(),
        Shape::Object(shape) => format!("t.object({})", fields(shape, indent, inferred, false)),
        Shape::Array(items) => format!("t.array({})", expression(items, indent, inferred, notes)),
        Shape::Union(members) => {
            let mut member_notes = Vec::new();
            let non_null: Vec<_> = members
                .iter()
                .filter(|shape| !matches!(shape, Shape::Scalar { scalar: ScalarType::Null, .. }))
                .map(|shape| expression(shape, indent, inferred, &mut member_notes))
                .collect();
            if non_null.is_empty() {
                if !members.is_empty() {
                    note(notes, "null has no builder");
                }
                return "t.any()".to_owned();
            }
            let collapsed = non_null.iter().any(|value| value == "t.any()");
            for text in member_notes {
                if !collapsed || text != REVIEW {
                    note(notes, &text);
                }
            }
            if collapsed {
                return "t.any()".to_owned();
            }
            let suffix = if non_null.len() == members.len() { "" } else { ".nullable()" };
            match non_null.as_slice() {
                [value] => format!("{value}{suffix}"),
                _ => format!("t.union({}){suffix}", non_null.join(", ")),
            }
        }
        Shape::Scalar { scalar, values } => match scalar {
            ScalarType::Null
            | ScalarType::Timestamp
            | ScalarType::Regex
            | ScalarType::MinKey
            | ScalarType::MaxKey
            | ScalarType::Javascript => {
                note(notes, &format!("{} has no builder", scalar.name()));
                "t.any()".to_owned()
            }
            ScalarType::BinData => "t.binary()".to_owned(),
            ScalarType::String => {
                let Some(values) = values.as_ref().filter(|values| !values.is_empty()) else {
                    return "t.string()".to_owned();
                };
                if inferred {
                    note(notes, REVIEW);
                }
                let mut values: Vec<_> = values.iter().collect();
                values.sort_by(|a, b| js_cmp(a, b));
                let values: Vec<_> = values.into_iter().map(|value| quote(value)).collect();
                format!("t.enum([{}])", values.join(", "))
            }
            scalar => format!("t.{}()", scalar.name()),
        },
    }
}

fn collection_block(schema: &CollectionSchema, name: &str) -> (String, bool) {
    let body = fields(&schema.shape, "", schema.source == SchemaSource::Inferred, true);
    let collection = quote(&schema.name);
    (format!("export const {name} = collection({collection}, {body})"), body != "{}")
}

/// Writes an editable schema module in collection name order, using LF line endings.
pub fn emit_schema_file(schemas: &[CollectionSchema], options: &EmitOptions<'_>) -> String {
    let mut used: HashSet<_> = RESERVED.split_whitespace().map(str::to_owned).collect();
    let mut names = Vec::new();
    let mut blocks = Vec::new();
    let mut uses_fields = false;
    for schema in sorted_schemas(schemas) {
        let name = binding(&schema.name, &used);
        let (block, has_fields) = collection_block(schema, &name);
        uses_fields |= has_fields;
        used.insert(name.clone());
        names.push(name);
        blocks.push(block);
    }
    let mut imports = Vec::new();
    if !names.is_empty() {
        imports.push("collection");
    }
    imports.push("defineSchema");
    if uses_fields {
        imports.push("t");
    }
    let register = quote(options.register_module.unwrap_or("canopy.js"));
    let module = quote(options.import_from.unwrap_or("canopy.js/schema"));
    let mut header =
        "// Written by canopy pull. This file is yours now: edit it, review it and commit it.\n".to_owned();
    if !options.js {
        header.push_str(&format!("import type {{}} from {register}\n"));
    }
    header.push_str(&format!("import {{ {} }} from {module}", imports.join(", ")));
    blocks.insert(0, header);
    blocks.push(format!("export const schema = defineSchema({})", names.join(", ")));
    if !options.js {
        blocks.push(format!(
            "declare module {register} {{\n  interface Register {{\n    schema: typeof schema\n  }}\n}}"
        ));
    }
    format!("{}\n", blocks.join("\n\n"))
}

pub(crate) fn append_collection(source: &str, schema: &CollectionSchema) -> Option<String> {
    static DECLARATION: LazyLock<Option<Regex>> = LazyLock::new(|| {
        Regex::new(r"(?m)^export const schema = defineSchema\(\s*((?:[A-Za-z0-9_$]+\s*,\s*)*(?:[A-Za-z0-9_$]+\s*)?)\)").ok()
    });
    static IMPORT: LazyLock<Option<Regex>> = LazyLock::new(|| {
        Regex::new(r#"(?m)^import\s*\{([^{}]*)\}\s*from\s*(?:"(?:canopy\.js/schema|@canopy/schema/define)"|'(?:canopy\.js/schema|@canopy/schema/define)')"#).ok()
    });
    static BINDINGS: LazyLock<Option<Regex>> = LazyLock::new(|| {
        Regex::new(r"(?-u:\b)(?:const|let|var|function|class)\s+([A-Za-z0-9_]+)(?-u:\b)").ok()
    });
    let declaration = DECLARATION.as_ref()?.captures(source)?;
    let call = declaration.get(0)?;
    let existing = declaration.get(1)?.as_str();
    let mut args: Vec<_> = existing.split(',').map(str::trim).filter(|arg| !arg.is_empty()).collect();
    let imports = IMPORT.as_ref()?.captures(source)?.get(1)?;
    let reserved = RESERVED.split_whitespace().map(str::to_owned).collect();
    let name = unique_binding(binding(&schema.name, &reserved), |name| {
        args.contains(&name)
            || BINDINGS.as_ref().is_some_and(|re| {
                re.captures_iter(source).any(|cap| cap.get(1).is_some_and(|m| m.as_str() == name))
            })
    });
    let eol = if source.contains("\r\n") { "\r\n" } else { "\n" };
    let (definition, has_fields) = collection_block(schema, &name);
    let definition = definition.replace('\n', eol);
    args.push(&name);
    let mut builders: Vec<_> =
        imports.as_str().split(',').map(str::trim).filter(|item| !item.is_empty()).collect();
    let before = builders.len();
    if !builders.contains(&"collection") {
        builders.push("collection");
    }
    if has_fields && !builders.contains(&"t") {
        builders.push("t");
    }
    let mut output = source.to_owned();
    let replacement =
        format!("{definition}{eol}{eol}export const schema = defineSchema({})", args.join(", "));
    if builders.len() != before && imports.start() > call.start() {
        output.replace_range(imports.range(), &format!(" {} ", builders.join(", ")));
        output.replace_range(call.range(), &replacement);
    } else {
        output.replace_range(call.range(), &replacement);
        if builders.len() != before {
            output.replace_range(imports.range(), &format!(" {} ", builders.join(", ")));
        }
    }
    Some(output)
}
