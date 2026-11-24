//! A write as a caller asks for it, kept as the object the TypeScript handler builds, because the fingerprint of
//! an idempotency record hashes that object: its members and their order are part of the contract.

use canopy_protocol::ejson::{DecodeOptions, parse};
use canopy_protocol::{CanopyError, Document, Value};

use crate::fail;

/// The kind of a write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteOp {
    /// One document.
    Insert,
    /// Several documents.
    InsertMany,
    /// One document by `_id`, with update operators.
    Update,
    /// Every document a filter matches, with update operators.
    UpdateMany,
    /// One document by `_id`, as a whole.
    Replace,
    /// One document by `_id`.
    Delete,
    /// Every document a filter matches.
    DeleteMany,
}

impl WriteOp {
    /// The name of the operation, as requests and idempotency records spell it.
    pub const fn as_str(self) -> &'static str {
        match self {
            WriteOp::Insert => "insert",
            WriteOp::InsertMany => "insertMany",
            WriteOp::Update => "update",
            WriteOp::UpdateMany => "updateMany",
            WriteOp::Replace => "replace",
            WriteOp::Delete => "delete",
            WriteOp::DeleteMany => "deleteMany",
        }
    }

    /// The operation with this name.
    pub fn parse(name: &str) -> Option<WriteOp> {
        [
            WriteOp::Insert,
            WriteOp::InsertMany,
            WriteOp::Update,
            WriteOp::Replace,
            WriteOp::Delete,
            WriteOp::UpdateMany,
            WriteOp::DeleteMany,
        ]
        .into_iter()
        .find(|op| op.as_str() == name)
    }

    /// Whether the operation may touch several documents.
    pub const fn is_bulk(self) -> bool {
        matches!(self, WriteOp::InsertMany | WriteOp::UpdateMany | WriteOp::DeleteMany)
    }
}

/// A write requested by a caller: its operation, its collection, and the request object with every member in
/// the order the caller's route set it (`op` and `collection` first).
#[derive(Debug, Clone, PartialEq)]
pub struct WriteRequest {
    op: WriteOp,
    collection: String,
    object: Document,
}

impl WriteRequest {
    /// Starts a request; members are added in order with [`WriteRequest::with`].
    pub fn new(op: WriteOp, collection: &str) -> WriteRequest {
        let mut object = Document::new();
        object.insert("op", Value::String(op.as_str().to_owned()));
        object.insert("collection", Value::String(collection.to_owned()));
        WriteRequest { op, collection: collection.to_owned(), object }
    }

    /// Adds a member, such as `doc`, `id`, `update`, `where`, `filter`, `upsert` or `bulk`. An absent value
    /// (`Value::Undefined`) is not added, as an absent member of the TypeScript object is not.
    #[must_use]
    pub fn with(mut self, name: &str, value: Value) -> WriteRequest {
        if !matches!(value, Value::Undefined) {
            self.object.insert(name, value);
        }
        self
    }

    /// The operation.
    pub fn op(&self) -> WriteOp {
        self.op
    }

    /// The collection.
    pub fn collection(&self) -> &str {
        &self.collection
    }

    /// A member of the request.
    pub fn get(&self, name: &str) -> Option<&Value> {
        self.object.get(name)
    }

    /// The request object, as the fingerprint hashes it.
    pub fn object(&self) -> &Document {
        &self.object
    }
}

/// Converts a JSON merge patch into an update operator document: `null` members become `$unset`, nested
/// documents are merged member by member through dotted paths, and every other value is set as a whole.
pub fn merge_patch_to_update(patch: &Value) -> Result<Value, CanopyError> {
    let Value::Document(patch) = patch else {
        return fail("A merge patch must be an object; send PUT to replace a document");
    };
    let mut set = Document::new();
    let mut unset = Document::new();
    walk_patch(patch, "", &mut set, &mut unset)?;
    let mut update = Document::new();
    if !set.is_empty() {
        update.insert("$set", Value::Document(set));
    }
    if !unset.is_empty() {
        update.insert("$unset", Value::Document(unset));
    }
    if update.is_empty() {
        return fail("The merge patch changes nothing");
    }
    Ok(Value::Document(update))
}

fn walk_patch(
    value: &Document,
    prefix: &str,
    set: &mut Document,
    unset: &mut Document,
) -> Result<(), CanopyError> {
    for (key, member) in value.iter() {
        if key.is_empty() {
            return fail("Field names may not be empty");
        }
        if key.starts_with('$') || key.contains('.') {
            return fail(format!("Field names may not start with $ or contain dots: {key}"));
        }
        let path = if prefix.is_empty() { key.to_owned() } else { format!("{prefix}.{key}") };
        if path == "_id" {
            return fail("A merge patch cannot change _id");
        }
        match member {
            Value::Undefined => {}
            Value::Null => unset.insert(&path, Value::String(String::new())),
            Value::Document(inner) => walk_patch(inner, &path, set, unset)?,
            other => set.insert(&path, other.clone()),
        }
    }
    Ok(())
}

/// How the `{id}` path segment of a collection is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum IdType {
    /// 24 hexadecimal characters as an ObjectId, anything else as a string.
    #[default]
    Auto,
    /// An ObjectId.
    ObjectId,
    /// A UUID.
    Uuid,
    /// A string.
    String,
    /// A number.
    Number,
}

impl IdType {
    /// The id type with this name, as `idTypes` spells it.
    pub fn parse(name: &str) -> Option<IdType> {
        match name {
            "auto" => Some(IdType::Auto),
            "objectId" => Some(IdType::ObjectId),
            "uuid" => Some(IdType::Uuid),
            "string" => Some(IdType::String),
            "number" => Some(IdType::Number),
            _ => None,
        }
    }
}

fn is_hex24(text: &str) -> bool {
    text.len() == 24 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn is_number_text(text: &str) -> bool {
    let rest = text.strip_prefix('-').unwrap_or(text);
    let (mantissa, exponent) = match rest.find(['e', 'E']) {
        Some(at) => (&rest[..at], Some(&rest[at + 1..])),
        None => (rest, None),
    };
    let (whole, fraction) = match mantissa.find('.') {
        Some(at) => (&mantissa[..at], Some(&mantissa[at + 1..])),
        None => (mantissa, None),
    };
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    let whole_ok = whole == "0" || (digits(whole) && !whole.starts_with('0'));
    let fraction_ok = fraction.is_none_or(digits);
    let exponent_ok = exponent.is_none_or(|exp| digits(exp.strip_prefix(['+', '-']).unwrap_or(exp)));
    whole_ok && fraction_ok && exponent_ok
}

/// Reads an `_id` from a decoded path segment. A segment that starts with `{` or `"` is an EJSON value
/// whatever the id type, so ambiguous ids can always be addressed.
pub fn parse_id(segment: &str, id_type: IdType) -> Result<Value, CanopyError> {
    if segment.is_empty() {
        return fail("The id may not be empty");
    }
    if segment.starts_with('{') || segment.starts_with('"') {
        let options = DecodeOptions { max_depth: 4, max_nodes: 64 };
        let value = parse(segment, options)
            .map_err(|_| CanopyError::invalid_query("The id is not valid Extended JSON"))?;
        if matches!(value, Value::Document(_) | Value::Array(_)) {
            return fail("An EJSON id must be a single value such as {\"$oid\":\"…\"}");
        }
        return Ok(value);
    }
    match id_type {
        IdType::Auto if is_hex24(segment) => object_id(segment),
        IdType::Auto | IdType::String => Ok(Value::String(segment.to_owned())),
        IdType::ObjectId if is_hex24(segment) => object_id(segment),
        IdType::ObjectId => fail("The id must be 24 hexadecimal characters"),
        IdType::Uuid if is_uuid(segment) => {
            let text = format!("{{\"$uuid\":\"{segment}\"}}");
            parse(&text, DecodeOptions::default())
                .map_err(|_| CanopyError::invalid_query("The id must be a UUID"))
        }
        IdType::Uuid => fail("The id must be a UUID"),
        IdType::Number => match segment.parse::<f64>() {
            Ok(number) if is_number_text(segment) && number.is_finite() => Ok(Value::from_js_number(number)),
            _ => fail("The id must be a number"),
        },
    }
}

fn object_id(hex: &str) -> Result<Value, CanopyError> {
    parse(&format!("{{\"$oid\":\"{}\"}}", hex.to_lowercase()), DecodeOptions::default())
}

/// Refuses an `_id` that is an array, a regular expression or an operator document.
pub fn validate_id(id: Option<&Value>) -> Result<(), CanopyError> {
    match id {
        Some(Value::Array(_)) => fail("An _id may not be an array"),
        Some(Value::Regex(_)) => fail("An _id may not be a regular expression or an operator document"),
        Some(Value::Document(document)) if document.keys().any(|key| key.starts_with('$')) => {
            fail("An _id may not be a regular expression or an operator document")
        }
        _ => Ok(()),
    }
}

/// The leaf paths a document writes: every field that holds a value other than a subdocument, and every
/// array of documents walked into.
pub fn leaf_paths(document: &Document) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |path: String, out: &mut Vec<String>| {
        if !out.contains(&path) {
            out.push(path);
        }
    };
    fn walk(value: &Value, path: &str, out: &mut Vec<String>, add: &mut dyn FnMut(String, &mut Vec<String>)) {
        match value {
            Value::Array(items) => {
                let documents: Vec<&Value> =
                    items.iter().filter(|item| matches!(item, Value::Document(_))).collect();
                if documents.is_empty() || documents.len() < items.len() {
                    add(path.to_owned(), out);
                }
                for item in documents {
                    walk(item, path, out, add);
                }
            }
            Value::Document(document) => {
                let keys: Vec<(&str, &Value)> =
                    document.iter().filter(|(_, member)| !matches!(member, Value::Undefined)).collect();
                if keys.is_empty() {
                    add(path.to_owned(), out);
                }
                for (key, member) in keys {
                    walk(member, &format!("{path}.{key}"), out, add);
                }
            }
            _ => add(path.to_owned(), out),
        }
    }
    for (key, value) in document.iter() {
        if !matches!(value, Value::Undefined) {
            walk(value, key, &mut out, &mut add);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(text: &str) -> Value {
        parse(text, DecodeOptions::default()).unwrap_or(Value::Undefined)
    }

    #[test]
    fn merge_patches_set_unset_and_refuse_what_typescript_refuses() {
        assert_eq!(
            merge_patch_to_update(&value(r#"{"a":1,"b":null,"c":{"d":2,"e":null,"f":{}},"g":[1]}"#)),
            Ok(value(r#"{"$set":{"a":1,"c.d":2,"g":[1]},"$unset":{"b":"","c.e":""}}"#))
        );
        for (patch, message) in [
            ("[1]", "A merge patch must be an object; send PUT to replace a document"),
            ("{}", "The merge patch changes nothing"),
            (r#"{"c":{}}"#, "The merge patch changes nothing"),
            (r#"{"_id":1}"#, "A merge patch cannot change _id"),
            (r#"{"$set":{"a":1}}"#, "Field names may not start with $ or contain dots: $set"),
            (r#"{"a.b":1}"#, "Field names may not start with $ or contain dots: a.b"),
            (r#"{"":1}"#, "Field names may not be empty"),
        ] {
            assert_eq!(
                merge_patch_to_update(&value(patch)).err().map(|e| e.message().to_owned()),
                Some(message.to_owned()),
                "{patch}"
            );
        }
    }

    #[test]
    fn ids_are_read_by_type_and_ejson_always_wins() {
        let oid = value(r#"{"$oid":"6f1000000000000000000001"}"#);
        assert_eq!(parse_id("6f1000000000000000000001", IdType::Auto), Ok(oid.clone()));
        assert_eq!(parse_id("6F1000000000000000000001", IdType::Auto), Ok(oid.clone()));
        assert_eq!(parse_id("n1", IdType::Auto), Ok(Value::String("n1".to_owned())));
        assert_eq!(
            parse_id("6f1000000000000000000001", IdType::String),
            Ok(Value::String("6f1000000000000000000001".to_owned()))
        );
        assert_eq!(
            parse_id("\"6f1000000000000000000001\"", IdType::Auto),
            Ok(Value::String("6f1000000000000000000001".to_owned()))
        );
        assert_eq!(parse_id("{\"$numberLong\":\"7\"}", IdType::String), Ok(value(r#"{"$numberLong":"7"}"#)));
        assert_eq!(parse_id("3", IdType::Number), Ok(Value::from_js_number(3.0)));
        assert_eq!(parse_id("-2.5e1", IdType::Number), Ok(Value::from_js_number(-25.0)));
        for (segment, id_type, message) in [
            ("", IdType::Auto, "The id may not be empty"),
            ("x", IdType::ObjectId, "The id must be 24 hexadecimal characters"),
            ("x", IdType::Uuid, "The id must be a UUID"),
            ("01", IdType::Number, "The id must be a number"),
            ("1.", IdType::Number, "The id must be a number"),
            ("Infinity", IdType::Number, "The id must be a number"),
            ("{\"a\":1}", IdType::Auto, "An EJSON id must be a single value such as {\"$oid\":\"…\"}"),
            ("{nope", IdType::Auto, "The id is not valid Extended JSON"),
        ] {
            assert_eq!(
                parse_id(segment, id_type).err().map(|e| e.message().to_owned()),
                Some(message.to_owned()),
                "{segment}"
            );
        }
    }

    #[test]
    fn leaf_paths_walk_documents_and_arrays_of_documents() {
        let Value::Document(document) =
            value(r#"{"a":1,"b":{"c":2,"d":{}},"e":[{"f":1},{"g":2}],"h":[1,{"i":1}],"j":[]}"#)
        else {
            panic!("a document")
        };
        assert_eq!(leaf_paths(&document), ["a", "b.c", "b.d", "e.f", "e.g", "h", "h.i", "j"]);
    }

    #[test]
    fn ids_that_are_arrays_regexes_or_operators_are_refused() {
        assert!(validate_id(Some(&value("[1]"))).is_err());
        assert!(validate_id(Some(&value(r#"{"$regularExpression":{"pattern":"a","options":""}}"#))).is_err());
        assert!(validate_id(Some(&value(r#"{"$gt":1}"#))).is_err());
        assert!(validate_id(Some(&value(r#"{"a":1}"#))).is_ok());
        assert!(validate_id(None).is_ok());
    }
}
