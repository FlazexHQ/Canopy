//! Keyset cursors: the sort keys of a page, the position a page ended at, the hash that ties a cursor to its
//! query and the filter that selects the documents after a position.

use canopy_matcher::path::split_path;
use canopy_matcher::{Bracket, Direction, SortKey, bracket_of};
use canopy_protocol::ejson::{
    DecodeOptions, base64_encode, canonical_string, forgiving_base64_decode, parse,
};
use canopy_protocol::sha256::sha256_hex;
use canopy_protocol::{CanopyError, DocRef, Document, RawDocument, Value};
use canopy_query::{DEFAULT_LIMITS, QueryKeyParts, canonical_query, validate_stored_document};

use crate::fail;

/// One key of a resolved sort, with the `_id` tie breaker included.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorKey {
    /// The dotted path.
    pub path: String,
    /// The direction.
    pub direction: Direction,
}

const MAX_CURSOR_LENGTH: usize = 4096;

/// The `$type` codes and aliases of each comparison bracket, in MongoDB's sort order. Null and missing are
/// matched with `null` equality instead, because `$type: 10` does not match a missing field. Arrays have no
/// entry: keyset pagination over array valued sort fields is undefined. `"number"` stands for the four
/// numeric types, and `2` and `14` are strings and symbols, which sort together.
const BRACKET_TYPES: [(Bracket, &[TypeCode]); 13] = [
    (Bracket::MinKey, &[TypeCode::Number(-1)]),
    (Bracket::Null, &[]),
    (Bracket::Number, &[TypeCode::Alias("number")]),
    (Bracket::String, &[TypeCode::Number(2), TypeCode::Number(14)]),
    (Bracket::Object, &[TypeCode::Number(3)]),
    (Bracket::BinData, &[TypeCode::Number(5)]),
    (Bracket::ObjectId, &[TypeCode::Number(7)]),
    (Bracket::Bool, &[TypeCode::Number(8)]),
    (Bracket::Date, &[TypeCode::Number(9)]),
    (Bracket::Timestamp, &[TypeCode::Number(17)]),
    (Bracket::Regex, &[TypeCode::Number(11)]),
    (Bracket::Code, &[TypeCode::Number(13)]),
    (Bracket::MaxKey, &[TypeCode::Number(127)]),
];

#[derive(Debug, Clone, Copy)]
enum TypeCode {
    Number(i32),
    Alias(&'static str),
}

impl TypeCode {
    fn value(self) -> Value {
        match self {
            TypeCode::Number(code) => Value::Int32(code),
            TypeCode::Alias(name) => Value::String(name.to_owned()),
        }
    }
}

/// Reads the sort keys of a validated sort (directions `1` and `-1`) and appends `_id` ascending as the tie
/// breaker unless the sort already has it, as the queries sent to MongoDB do.
pub fn cursor_keys(sort: Option<&Document>) -> Vec<CursorKey> {
    let mut keys: Vec<CursorKey> = sort
        .into_iter()
        .flat_map(Document::iter)
        .map(|(path, direction)| CursorKey {
            path: path.to_owned(),
            direction: if matches!(direction, Value::Int32(-1)) {
                Direction::Descending
            } else {
                Direction::Ascending
            },
        })
        .collect();
    if !keys.iter().any(|key| key.path == "_id") {
        keys.push(CursorKey { path: "_id".to_owned(), direction: Direction::Ascending });
    }
    keys
}

/// The sort document sent to MongoDB for these keys.
pub fn sort_document(keys: &[CursorKey]) -> Document {
    keys.iter()
        .map(|key| {
            let direction = if key.direction == Direction::Ascending { 1 } else { -1 };
            (key.path.clone(), Value::Int32(direction))
        })
        .collect()
}

/// Reads the sort values of a document, the way MongoDB orders it. A missing value reads as `null`.
pub fn position_of(document: &RawDocument<'_>, keys: &[CursorKey]) -> Result<Vec<Value>, CanopyError> {
    keys.iter()
        .map(|key| {
            let sort_key =
                SortKey { path: key.path.clone(), parts: split_path(&key.path), direction: key.direction };
            let value = canopy_matcher::sort::sort_key_of(DocRef::Raw(*document), &sort_key)?.to_value();
            Ok(if matches!(value, Value::Undefined) { Value::Null } else { value })
        })
        .collect()
}

/// The hash that ties a cursor to its query: the collection, the caller's filter and the sort. It is the first
/// 32 hex digits of the SHA-256 of the canonical query.
pub fn cursor_query_hash(
    collection: &str,
    filter: &Document,
    keys: &[CursorKey],
) -> Result<String, CanopyError> {
    let text = canonical_query(&QueryKeyParts {
        collection: collection.to_owned(),
        filter: filter.clone(),
        sort: Some(sort_document(keys)),
        limit: None,
        projection: None,
    })?;
    let mut hash = sha256_hex(text.as_bytes());
    hash.truncate(32);
    Ok(hash)
}

fn to_base64_url(text: &str) -> String {
    base64_encode(text.as_bytes()).replace('+', "-").replace('/', "_").trim_end_matches('=').to_owned()
}

/// Encodes a position as an opaque cursor: base64url of canonical EJSON `{ s, q }`.
pub fn encode_cursor(values: &[Value], hash: &str) -> Result<String, CanopyError> {
    let mut document = Document::with_capacity(2);
    document.insert("s", Value::Array(values.to_vec()));
    document.insert("q", Value::String(hash.to_owned()));
    Ok(to_base64_url(&canonical_string(&Value::Document(document))?))
}

fn malformed() -> CanopyError {
    CanopyError::invalid_query("Malformed cursor")
}

fn from_base64_url(text: &str) -> Option<String> {
    let standard = text.replace('-', "+").replace('_', "/");
    String::from_utf8(forgiving_base64_decode(&standard)?).ok()
}

/// Decodes a cursor and checks that it belongs to the current query. Cursors are not signed: they only name a
/// position in a query the caller may already run, and DLS still applies to every page. Fails with an invalid
/// query error for anything malformed or minted for another query.
pub fn decode_cursor(cursor: &str, keys: &[CursorKey], hash: &str) -> Result<Vec<Value>, CanopyError> {
    if cursor.is_empty()
        || cursor.len() > MAX_CURSOR_LENGTH
        || !cursor.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(malformed());
    }
    let text = from_base64_url(cursor).ok_or_else(malformed)?;
    let decoded = parse(&text, DecodeOptions { max_depth: 16, max_nodes: 2000 }).map_err(|_| malformed())?;
    let Value::Document(decoded) = decoded else { return Err(malformed()) };
    let (Some(Value::Array(values)), Some(Value::String(query))) = (decoded.get("s"), decoded.get("q"))
    else {
        return Err(malformed());
    };
    if query != hash || values.len() != keys.len() {
        return fail("The cursor belongs to a different query");
    }
    for value in values {
        match value {
            Value::Array(_) => return Err(malformed()),
            Value::Document(_) => validate_stored_document(value, &DEFAULT_LIMITS)?,
            _ => {}
        }
    }
    Ok(values.clone())
}

fn single(path: &str, condition: Value) -> Document {
    [(path.to_owned(), condition)].into_iter().collect()
}

fn operator(name: &str, operand: Value) -> Value {
    Value::Document([(name.to_owned(), operand)].into_iter().collect())
}

fn is_nan_number(value: &Value) -> bool {
    match value {
        Value::Double(number) => number.is_nan(),
        Value::Decimal128(text) => text.to_ascii_lowercase().ends_with("nan"),
        _ => false,
    }
}

/// The clauses that select the documents after one value of one key: strictly after inside the value's own
/// bracket (NaN, which sorts before every other number but matches no comparison operator, is handled by
/// equality and by the range of all finite and infinite numbers), plus every bracket that sorts after it.
fn after_options(path: &str, value: &Value, direction: Direction) -> Result<Vec<Document>, CanopyError> {
    let bracket = bracket_of(value);
    if bracket == Bracket::Array {
        return fail("A cursor value may not be an array");
    }
    if bracket == Bracket::Regex {
        return fail(format!(
            "The cursor ends on a regular expression sort value in \"{path}\", which cannot be compared, so the next page cannot be read. Sort by a field without regular expression values, or filter those documents out."
        ));
    }
    let position = if matches!(bracket, Bracket::Missing | Bracket::Null) { Bracket::Null } else { bracket };
    let mut options: Vec<Document> = Vec::new();
    if !matches!(position, Bracket::Null | Bracket::MinKey | Bracket::MaxKey) {
        let nan = position == Bracket::Number && is_nan_number(value);
        if direction == Direction::Ascending {
            let bound = if nan {
                operator("$gte", Value::Double(f64::NEG_INFINITY))
            } else {
                operator("$gt", value.clone())
            };
            options.push(single(path, bound));
        } else if !nan {
            options.push(single(path, operator("$lt", value.clone())));
            if position == Bracket::Number {
                options.push(single(path, Value::Double(f64::NAN)));
            }
        }
    }
    let mut types: Vec<Value> = Vec::new();
    for (other, codes) in BRACKET_TYPES {
        let later = other > position;
        let skip = if direction == Direction::Ascending { !later } else { later || other == position };
        if skip {
            continue;
        }
        if other == Bracket::Null {
            options.push(single(path, Value::Null));
        } else {
            types.extend(codes.iter().map(|code| code.value()));
        }
    }
    if !types.is_empty() {
        options.push(single(path, operator("$type", Value::Array(types))));
    }
    Ok(options)
}

/// Equality on one value. A document is compared through `$eq`, because a plain document whose first field
/// starts with `$` would be read as operators rather than as the value.
fn equal_to(path: &str, value: &Value) -> Document {
    let condition =
        if matches!(value, Value::Document(_)) { operator("$eq", value.clone()) } else { value.clone() };
    single(path, condition)
}

/// The bound on the first key described at [`keyset_filter`], or `None` where it would bound nothing.
fn bound_of(key: &CursorKey, value: &Value) -> Option<Document> {
    let bracket = bracket_of(value);
    if matches!(bracket, Bracket::Missing | Bracket::Null | Bracket::MinKey | Bracket::MaxKey) {
        return None;
    }
    if bracket == Bracket::Number && is_nan_number(value) {
        return None;
    }
    let comparison = if key.direction == Direction::Ascending { "$lt" } else { "$gt" };
    Some(single(&key.path, operator("$not", operator(comparison, value.clone()))))
}

fn and_of(clauses: Vec<Document>) -> Document {
    single("$and", Value::Array(clauses.into_iter().map(Value::Document).collect()))
}

fn or_of(options: Vec<Document>) -> Document {
    single("$or", Value::Array(options.into_iter().map(Value::Document).collect()))
}

/// Builds the keyset filter that selects the documents after `values` in the order of `keys`: an `$or` over
/// each key of "equal on every earlier key and after on this one". "After" respects the direction and BSON
/// type order: comparison operators only match inside one type bracket, so values of the brackets that sort
/// later (or earlier, for a descending key) are matched by `$type`.
///
/// When the sort has more than the `_id` tie breaker, the filter is also ANDed with a bound on the first key
/// that every selected document satisfies (not greater than the position for a descending key, not less for an
/// ascending one). It selects nothing new, but it turns the one index scan the planner may choose for the `$or`
/// into a scan that starts at the position instead of at the start of the index prefix, whichever plan the
/// planner picks or has cached for the query shape.
pub fn keyset_filter(keys: &[CursorKey], values: &[Value]) -> Result<Document, CanopyError> {
    let null = Value::Null;
    let value_at = |index: usize| values.get(index).unwrap_or(&null);
    let mut branches: Vec<Document> = Vec::new();
    for (index, key) in keys.iter().enumerate() {
        let options = after_options(&key.path, value_at(index), key.direction)?;
        if options.is_empty() {
            continue;
        }
        if index == 0 {
            branches.extend(options);
            continue;
        }
        let mut clauses: Vec<Document> = keys[..index]
            .iter()
            .enumerate()
            .map(|(i, earlier)| equal_to(&earlier.path, value_at(i)))
            .collect();
        if options.len() == 1 {
            clauses.extend(options);
        } else {
            clauses.push(or_of(options));
        }
        branches.push(and_of(clauses));
    }
    if branches.is_empty() {
        return Ok(canopy_policy::deny_filter());
    }
    let after = if branches.len() == 1 { branches.remove(0) } else { or_of(branches) };
    let bound = match keys.first() {
        Some(first) if keys.len() > 1 => bound_of(first, value_at(0)),
        _ => None,
    };
    Ok(match bound {
        Some(bound) => and_of(vec![bound, after]),
        None => after,
    })
}
