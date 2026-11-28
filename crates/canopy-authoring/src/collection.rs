//! Collection schema documents: the shapes `canopy.js/schema` declares, `canopy pull` infers and type
//! generation reads.

use canopy_protocol::json::{Json, write_json_string};

use crate::pointer::Pointer;
use crate::{AuthoringCode, AuthoringError, Kind, check_schema, parse};

const CODE: AuthoringCode = AuthoringCode::SchemaInvalid;

fn quoted(text: &str) -> String {
    let mut out = String::new();
    write_json_string(&mut out, text);
    out
}

fn refuse(path: &Pointer, message: String) -> AuthoringError {
    AuthoringError::new(CODE, path.to_string(), message)
}

fn valid_collection_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('$') && !name.contains('\0') && !name.starts_with("system.")
}

/// The rules of declared shapes (source `config`): field names, string literals.
fn check_declared(shape: &Json, path: &mut Pointer) -> Result<(), AuthoringError> {
    match shape.get("kind") {
        Some(Json::String(kind)) if kind == "object" => {
            let Some(Json::Object(fields)) = shape.get("fields") else { return Ok(()) };
            for (name, field) in fields {
                path.push("fields");
                path.push(name);
                if name.is_empty() || name.starts_with('$') || name.contains('.') {
                    return Err(refuse(path, format!("{} is not a valid field name", quoted(name))));
                }
                if let Some(inner) = field.get("shape") {
                    path.push("shape");
                    check_declared(inner, path)?;
                    path.pop();
                }
                path.pop();
                path.pop();
            }
            Ok(())
        }
        Some(Json::String(kind)) if kind == "scalar" => {
            if let Some(Json::Array(values)) = shape.get("values")
                && (values.is_empty() || values.iter().any(|value| !matches!(value, Json::String(_))))
            {
                path.push("values");
                return Err(refuse(path, "t.enum() takes one or more strings".to_owned()));
            }
            Ok(())
        }
        Some(Json::String(kind)) if kind == "array" => match shape.get("items") {
            Some(items) => {
                path.push("items");
                check_declared(items, path)?;
                path.pop();
                Ok(())
            }
            None => Ok(()),
        },
        Some(Json::String(kind)) if kind == "union" => {
            if let Some(Json::Array(members)) = shape.get("of") {
                for (index, member) in members.iter().enumerate() {
                    path.push("of");
                    path.push(&index.to_string());
                    check_declared(member, path)?;
                    path.pop();
                    path.pop();
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn check_collections(document: &Json) -> Result<(), AuthoringError> {
    let Some(Json::Array(collections)) = document.get("collections") else { return Ok(()) };
    for (index, collection) in collections.iter().enumerate() {
        let mut path = Pointer::of(&["collections", &index.to_string()]);
        let Some(Json::String(name)) = collection.get("name") else { continue };
        if !valid_collection_name(name) {
            return Err(refuse(
                &path.child("name"),
                format!("{} is not a valid collection name", quoted(name)),
            ));
        }
        if collections[..index]
            .iter()
            .any(|earlier| matches!(earlier.get("name"), Some(Json::String(other)) if other == name))
        {
            return Err(refuse(&path.child("name"), format!("The schema declares {name} twice")));
        }
        if !matches!(collection.get("source"), Some(Json::String(source)) if source == "config") {
            continue;
        }
        let Some(shape) = collection.get("shape") else { continue };
        if let Some(Json::Bool(false)) =
            shape.get("fields").and_then(|fields| fields.get("_id")).and_then(|id| id.get("required"))
        {
            return Err(refuse(
                &path.child("shape").child("fields").child("_id").child("required"),
                format!("The _id of {name} cannot be optional"),
            ));
        }
        path.push("shape");
        check_declared(shape, &mut path)?;
    }
    Ok(())
}

/// Validates a version 1 collection schema document given as JSON. The rules of declared shapes (valid
/// field names, a required `_id`, string literals) apply to collections whose source is `config`; inferred
/// and validator shapes describe documents that already exist.
pub fn validate_collection_schema_json(document: &Json) -> Result<(), AuthoringError> {
    check_collections(document)?;
    check_schema(Kind::CollectionSchema, CODE, document)
}

/// Validates a version 1 collection schema document given as JSON text.
pub fn validate_collection_schema(text: &str) -> Result<(), AuthoringError> {
    validate_collection_schema_json(&parse(CODE, text)?)
}
